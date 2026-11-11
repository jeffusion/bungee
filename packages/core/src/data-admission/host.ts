import { KeyedAdmissionState } from './keyed-state';
import { ANONYMOUS_PRINCIPAL, type DataPrincipal, type AdmissionRequirement, type AdmissionTarget, type IngressPlugin, type AdmissionDenial } from '../plugin-extensions';
import type { DurableJson } from '../plugin-durable-state';
import type { RateLimitWorkerIdentity } from '../rate-limit';
import { DataAdmissionError, normalizeAdmissionError } from './errors';
export { DataAdmissionError } from './errors';

export interface AdmissionPluginPublication {
  readonly name: string;
  readonly entry: string;
  readonly catalogHash: string;
  readonly policy: DurableJson;
}
export interface DataAdmissionPublication {
  readonly version: number;
  readonly admissionSequence?: number;
  readonly routeRequirements?: readonly AdmissionRequirement[];
  readonly plugins: readonly AdmissionPluginPublication[];
  readonly unblock?: readonly { readonly plugin: string; readonly keyId: string }[];
}
export interface AdmissionGrant {
  readonly requestId: string;
  readonly principal: DataPrincipal;
  readonly version: number;
  readonly snapshots: Readonly<Record<string, DurableJson>>;
}
interface PluginRuntime { publication: AdmissionPluginPublication; plugin: IngressPlugin; state: DurableJson; keyed?: KeyedAdmissionState; activatedAt?: number }
export interface PreparedDataAdmission { commit(): () => void; abort(): void }
export type CandidateDataAdmission = Pick<DataAdmissionPublication, 'plugins'> & {
  readonly routeRequirements: NonNullable<DataAdmissionPublication['routeRequirements']>;
};
interface StoredGrant { entryRouteId?: string; routeId: string; sourcePrincipal: DataPrincipal; worker: string; grant: AdmissionGrant; plugins: readonly PluginRuntime[]; expires: number | null }
function workerKey(worker: RateLimitWorkerIdentity): string {
  return JSON.stringify([worker.master_generation, worker.process_instance_id, worker.boot_nonce, worker.worker_slot]);
}
function deny(denial: AdmissionDenial): never { throw new DataAdmissionError(denial.status, denial.error, denial.retryAfter); }

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freezeJson(child); }
  return value;
}
/** All plans and the grant are committed synchronously, after every participant accepts. */
export class DataAdmissionHost {
  private publicationAdmissionSequence: number | undefined;
  private blocked = false;
  private readonly blockedScopes = new Set<string>();
  private version = 0;
  private routeRequirements: readonly AdmissionRequirement[] = [];
  private plugins: readonly PluginRuntime[] = [];
  private preparing: ReadonlyMap<PluginRuntime, PluginRuntime> | null = null;
  private grants = new Map<string, StoredGrant>();
  private publication: string | null = null;
  private previews = new Map<string, { target: AdmissionTarget; worker: string; version: number; expires: number }>();
  private disposed = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly options: {
    authorizeWorker(worker: RateLimitWorkerIdentity): 'active' | 'retired' | 'prepared' | 'unknown';
    catalogHash(admissionSequence?: number): string | null;
    admissionSequence?(): number | null;
    loadPlugin?(entry: string): Promise<{ createIngress(): IngressPlugin }>;
    clock?(): number;
  }) {}
  async publish(input: DataAdmissionPublication, assertAuthority?: () => void): Promise<{ version: number }> {
    if (!this.disposed && input.version === this.version && JSON.stringify(input) === this.publication) {
      assertAuthority?.();
      return this.status();
    }
    const prepared = await this.preparePublication(input, false, assertAuthority);
    assertAuthority?.();
    prepared.commit()();
    return this.status();
  }
  async preparePublication(input: DataAdmissionPublication, candidate: boolean, assertAuthority?: () => void,
    preparedCatalogHash?: string): Promise<PreparedDataAdmission> {
    if (this.disposed) throw new Error('admission host disposed');
    if (this.preparing !== null) throw new Error('candidate admission policy is already prepared');
    if (!Number.isSafeInteger(input.version) || input.version < 1 || !Array.isArray(input.plugins)) throw new Error('invalid admission publication');
    if (candidate && input.unblock !== undefined) throw new Error('candidate policy cannot unblock admission scopes');
    const serialized = JSON.stringify(input);
    if (serialized.length > 1_048_576) throw new Error('admission publication too large');
    if (input.version <= this.version) throw new Error('stale admission publication');
    input = structuredClone(input);
    const previousVersion = this.version;
    const catalogHash = preparedCatalogHash ?? this.options.catalogHash(input.admissionSequence);
    const assertCurrent = (checkCatalog = true) => {
      if (this.disposed) throw new Error('admission host disposed');
      if ((candidate && previousVersion !== this.version) || input.version <= this.version) throw new Error('stale admission publication');
      if (checkCatalog && catalogHash !== this.options.catalogHash(input.admissionSequence)) throw new Error('admission plugin catalog changed');
    };
    const names = new Set<string>();
    const loaded: PluginRuntime[] = [];
    for (const publication of input.plugins) {
      if (!publication.name || names.has(publication.name) || publication.catalogHash !== catalogHash
        || !publication.entry || publication.entry.includes('\0')) throw new Error('invalid admission plugin catalog evidence');
      names.add(publication.name);
      const module = await (this.options.loadPlugin ?? (entry => import(entry)))(publication.entry);
      assertAuthority?.();
      assertCurrent(preparedCatalogHash === undefined);
      if (typeof module.createIngress !== 'function') throw new Error('ingress plugin must export createIngress');
      const plugin = module.createIngress();
      if (typeof plugin.plan !== 'function' || typeof plugin.bodyRequirements !== 'function') throw new Error('invalid ingress plugin');
      loaded.push({ publication: plugin.keyedState ? freezeJson(publication) : publication, plugin, state: null,
        ...(plugin.keyedState ? {keyed: new KeyedAdmissionState(plugin.keyedState.capacity)} : {}) });
    }
    const requirements = input.routeRequirements;
    if (requirements !== undefined && (!Array.isArray(requirements) || requirements.some(r => !r.plugin || !Array.isArray(r.routeIds)
      || r.routeIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 256)))) throw new Error('invalid admission requirements');
    assertCurrent(preparedCatalogHash === undefined);
    if (preparedCatalogHash === undefined) return {
      commit: () => {
        assertCurrent();
        if (this.preparing !== null) throw new Error('candidate admission policy is already prepared');
        const plugins = this.reconcile(loaded);
        return () => this.activate(input, plugins, serialized, candidate);
      },
      abort() {},
    };
    if (this.preparing !== null) throw new Error('candidate admission policy is already prepared');
    const mirrored = new Map<PluginRuntime, PluginRuntime>();
    const plugins = this.reconcile(loaded, mirrored);
    this.preparing = mirrored;
    const abort = () => { if (this.preparing === mirrored) this.preparing = null; };
    return {
      commit: () => {
        assertCurrent();
        if (this.preparing !== mirrored) throw new Error('candidate admission policy was aborted');
        return () => {
          const now = this.now();
          for (const runtime of mirrored.keys()) this.sweepRuntime(runtime, now, runtime.keyed?.capacity);
          abort();
          this.activate(input, plugins, serialized, candidate);
        };
      },
      abort,
    };
  }
  private reconcileKey(runtime: PluginRuntime, previous: PluginRuntime, key: string, state: DurableJson, now: number,
    deferUntilActivation: boolean): {value: DurableJson; expires: number} {
    const adapter = runtime.plugin.keyedState!;
    const value = structuredClone(adapter.reconcile(state, structuredClone(adapter.policyForKey(runtime.publication.policy, key)), now,
      { previousActivation: previous.activatedAt!, deferUntilActivation }));
    return {value, expires: adapter.expiresAt(structuredClone(value))};
  }
  private reconcile(loaded: readonly PluginRuntime[], mirror?: Map<PluginRuntime, PluginRuntime>): readonly PluginRuntime[] {
    const now = this.now();
    return loaded.map(runtime => {
      const previous = this.plugins.find(p => p.publication.name === runtime.publication.name && p.publication.entry === runtime.publication.entry);
      const next = runtime.keyed
        ? { ...runtime, keyed: previous?.keyed?.reconcile((key, state) =>
          this.reconcileKey(runtime, previous, key, state, now, mirror !== undefined), now, runtime.keyed.capacity) ?? runtime.keyed }
        : { ...runtime, state: previous?.state ?? null };
      next.keyed?.sweep(now, next.keyed.capacity);
      if (previous && !!previous.keyed === !!next.keyed) mirror?.set(previous, next);
      return next;
    });
  }
  private activate(input: DataAdmissionPublication, plugins: readonly PluginRuntime[], serialized: string, candidate: boolean): void {
    this.publicationAdmissionSequence = input.admissionSequence;
    this.routeRequirements = input.routeRequirements ?? this.routeRequirements;
    // In-flight grants need plugin hooks and snapshots, never the mutable bucket store.
    const activatedAt = this.now();
    for (const runtime of plugins) runtime.activatedAt = activatedAt;
    this.plugins = plugins;
    if (plugins.some(runtime => runtime.keyed) && !this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.sweepKeyedState(), 1000);
      this.cleanupTimer.unref?.();
    } else if (!plugins.some(runtime => runtime.keyed) && this.cleanupTimer) {
      clearInterval(this.cleanupTimer); this.cleanupTimer = null;
    }
    this.version = input.version;
    if (!candidate) this.blocked = false;
    for (const scope of input.unblock ?? []) this.blockedScopes.delete(JSON.stringify([scope.plugin, scope.keyId]));
    this.publication = serialized;
  }
  private sweepRuntime(runtime: PluginRuntime, now: number, limit?: number): void {
    const staged = this.preparing?.get(runtime)?.keyed;
    runtime.keyed?.sweep(now, limit, key => staged?.delete(key));
    staged?.sweep(now, limit);
  }
  sweepKeyedState(): void { for (const runtime of this.plugins) this.sweepRuntime(runtime, this.now()); }
  dispose(): void { this.disposed = true; this.blocked = true; if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.cleanupTimer = null; this.plugins = []; this.preparing = null; this.grants.clear(); this.previews.clear(); }
  freeze(): void { this.blocked = true; }
  freezePluginKey(plugin: string, keyId: string): void {
    if (!plugin || !keyId || plugin.length > 128 || keyId.length > 128) throw new Error('invalid admission scope');
    this.blockedScopes.add(JSON.stringify([plugin, keyId]));
  }
  private now(): number { return (this.options.clock ?? Date.now)(); }
  status(): { version: number; blocked: boolean } { return { version: this.version, blocked: this.blocked }; }
  authenticate(request: Request): DataPrincipal {
    for (const runtime of this.plugins) {
      try {
        const principal = runtime.plugin.authenticate?.(request, structuredClone(runtime.publication.policy), this.now());
        if (principal) return Object.freeze({...principal});
      } catch { /* Protected-route admission independently fails closed. */ }
    }
    return ANONYMOUS_PRINCIPAL;
  }
  /** Policy inspection performs identity/protection checks without planning or debiting. */
  inspect(target: AdmissionTarget, worker: RateLimitWorkerIdentity): {policyVersion:number;requirements:Record<string,{request:'none'|'json-read'}>} {
    const principal = this.resolveTargetIdentity(target,worker);
    const requirements: Record<string,{request:'none'|'json-read'}> = {};
    for (const runtime of this.plugins) {
      if (typeof runtime.plugin.bodyRequirements !== 'function') throw new DataAdmissionError(503,'admission_body_requirements_missing');
      const demand = runtime.plugin.bodyRequirements({...target,principal,now:this.now()},structuredClone(runtime.publication.policy));
      if (!demand || !['none','json-read'].includes(demand.request)) throw new DataAdmissionError(503,'admission_body_requirements_invalid');
      requirements[runtime.publication.name] = demand;
    }
    return {policyVersion:this.version,requirements};
  }
  /** Access-only stage: no plan, preview ticket, state write or model reservation. */
  authorize(target: AdmissionTarget, worker: RateLimitWorkerIdentity, expectedVersion: number): {policyVersion:number} {
    if (expectedVersion !== this.version) throw new DataAdmissionError(409,'admission_version_changed');
    const principal = this.resolveTargetIdentity(target,worker);
    for (const runtime of this.plugins) if (runtime.plugin.authorize) {
      let denial: AdmissionDenial | null;
      try { denial = runtime.plugin.authorize({...target,principal,now:this.now()},structuredClone(runtime.publication.policy)); }
      catch (error) { throw normalizeAdmissionError(error) ?? new DataAdmissionError(503,'route_authorization_unavailable'); }
      if (denial) deny(denial);
    }
    return {policyVersion:this.version};
  }
  private resolveTargetIdentity(target: AdmissionTarget, worker: RateLimitWorkerIdentity): DataPrincipal {
    if (this.blocked) throw new DataAdmissionError(503,'admission_state_unavailable');
    if (this.publicationAdmissionSequence !== undefined && this.options.admissionSequence?.() !== this.publicationAdmissionSequence) throw new DataAdmissionError(503,'admission_worker_set_changed');
    if (this.options.authorizeWorker(worker) !== 'active') throw new DataAdmissionError(503,'admission_worker_not_active');
    for (const requirement of this.routeRequirements) if ((requirement.routeIds.includes(target.routeId) || !!target.entryRouteId && requirement.routeIds.includes(target.entryRouteId))
      && !this.plugins.some(runtime=>runtime.publication.name === requirement.plugin && runtime.plugin.resolveIdentity)) throw new DataAdmissionError(503,'route_protection_unavailable');
    let principal = ANONYMOUS_PRINCIPAL;
    for (const runtime of this.plugins) if (runtime.plugin.resolveIdentity) {
      try { principal = runtime.plugin.resolveIdentity({...target,now:this.now()},structuredClone(runtime.publication.policy)); }
      catch (error) { throw normalizeAdmissionError(error) ?? new DataAdmissionError(503,'route_protection_unavailable'); }
    }
    if (principal.domain === 'anonymous' && this.routeRequirements.some(requirement=>(requirement.routeIds.includes(target.routeId) || !!target.entryRouteId && requirement.routeIds.includes(target.entryRouteId)))) throw new DataAdmissionError(503,'route_protection_unavailable');
    return principal;
  }
  admit(target: AdmissionTarget, worker: RateLimitWorkerIdentity, preview = false, expectedVersion?: number): AdmissionGrant {
    if (expectedVersion !== undefined && expectedVersion !== this.version) throw new DataAdmissionError(409, 'admission_version_changed');
    for (const [id, grant] of this.grants) if (grant.expires !== null && grant.expires <= this.now()) this.grants.delete(id);
    const previous = this.grants.get(target.requestId);
    if (previous) {
      this.assertGrant(previous, target, worker);
      return previous.grant;
    }
    if (this.blocked) throw new DataAdmissionError(503, 'admission_state_unavailable');
    if (this.publicationAdmissionSequence !== undefined && this.options.admissionSequence?.() !== this.publicationAdmissionSequence) throw new DataAdmissionError(503, 'admission_worker_set_changed');
    if (this.options.authorizeWorker(worker) !== 'active') throw new DataAdmissionError(503, 'admission_worker_not_active');
    for (const requirement of this.routeRequirements) {
      if ((requirement.routeIds.includes(target.routeId) || !!target.entryRouteId && requirement.routeIds.includes(target.entryRouteId)) && !this.plugins.some(p => p.publication.name === requirement.plugin && p.plugin.resolveIdentity)) {
        throw new DataAdmissionError(503, 'route_protection_unavailable');
      }
    }
    let principal = ANONYMOUS_PRINCIPAL;
    for (const runtime of this.plugins) if (runtime.plugin.resolveIdentity) {
      try { principal = runtime.plugin.resolveIdentity({...target, now: this.now()}, structuredClone(runtime.publication.policy)); }
      catch (error) {
        const denial = normalizeAdmissionError(error);
        if (denial) throw denial;
        throw new DataAdmissionError(503, 'route_protection_unavailable');
      }
    }
    if (principal.domain === 'anonymous' && this.routeRequirements.some(r => (r.routeIds.includes(target.routeId) || !!target.entryRouteId && r.routeIds.includes(target.entryRouteId)))) throw new DataAdmissionError(503, 'route_protection_unavailable');
    const ticket = this.previews.get(target.requestId);
    if (!preview && expectedVersion !== undefined && (!ticket || ticket.version !== this.version || ticket.expires <= this.now()
      || ticket.worker !== workerKey(worker) || ticket.target.attemptId !== target.attemptId
      || ticket.target.url !== target.url || ticket.target.model !== target.model || ticket.target.routeId !== target.routeId || ticket.target.entryRouteId !== target.entryRouteId
      || JSON.stringify(ticket.target.principal) !== JSON.stringify(principal)
      || ticket.target.serviceId !== target.serviceId || ticket.target.upstreamId !== target.upstreamId)) {
      throw new DataAdmissionError(409, 'admission_preview_changed');
    }
    // The prepare snapshot pins the request's admission time across slow I/O/month boundaries.
    // Credential expiration is independently checked with the current clock above.
    const nowTarget = Object.freeze({ ...target, principal, now: !preview && ticket ? ticket.target.now : this.now() });
    const staged: { runtime: PluginRuntime; state: DurableJson | undefined; snapshot: DurableJson; expires?: number }[] = [];
    for (const runtime of this.plugins) {
      const adapter = runtime.plugin.keyedState;
      const key = nowTarget.principal.keyId;
      const plan = runtime.plugin.plan(adapter ? {...nowTarget, now: this.now()} : nowTarget,
        structuredClone(adapter ? adapter.policyForKey(runtime.publication.policy, key) : runtime.publication.policy),
        structuredClone(runtime.keyed ? runtime.keyed.get(key) : runtime.state), runtime.activatedAt);
      if (this.blockedScopes.has(JSON.stringify([runtime.publication.name, nowTarget.principal.keyId])) && plan.snapshot != null) {
        throw new DataAdmissionError(503, 'plugin_state_unavailable');
      }
      if (plan.denial) deny(plan.denial);
      const state = plan.state === undefined ? undefined : structuredClone(plan.state);
      const expires = state !== undefined && adapter ? adapter.expiresAt(state) : undefined;
      if (expires !== undefined && !Number.isFinite(expires)) throw new DataAdmissionError(503, 'plugin_state_unavailable');
      if (state !== undefined && runtime.keyed && !runtime.keyed.hasRoom(key)) {
        this.sweepRuntime(runtime, this.now(), runtime.keyed.capacity);
        if (!runtime.keyed.hasRoom(key)) throw new DataAdmissionError(503, 'admission_key_capacity');
      }
      staged.push({ runtime, state, expires, snapshot: structuredClone(plan.snapshot ?? null) });
    }
    const snapshots = Object.fromEntries(staged.map(p => [p.runtime.publication.name, p.snapshot]));
    const grant = Object.freeze({ requestId: target.requestId, principal: Object.freeze({ ...principal }), version: this.version, snapshots: Object.freeze(snapshots) });
    if (preview) {
      for (const [id, previous] of this.previews) if (previous.expires <= this.now()) this.previews.delete(id);
      if (this.previews.size >= 10000) throw new DataAdmissionError(503, 'admission_prepare_capacity');
      this.previews.set(target.requestId, { target: nowTarget, worker: workerKey(worker), version: this.version, expires: this.now() + 15000 });
      return grant;
    }
    if (this.grants.size >= 100000) throw new DataAdmissionError(503, 'admission_capacity');
    const mirrored: { runtime: PluginRuntime; value: DurableJson; expires?: number }[] = [];
    const key = nowTarget.principal.keyId;
    for (const plan of staged) {
      const next = this.preparing?.get(plan.runtime);
      if (!next || plan.state === undefined) continue;
      if (!next.keyed) { mirrored.push({ runtime: next, value: plan.state }); continue; }
      try {
        const now = this.now();
        const {value, expires} = this.reconcileKey(next, plan.runtime, key, structuredClone(plan.state), now, true);
        if (!next.keyed.hasRoom(key)) next.keyed.sweep(now, next.keyed.capacity);
        if (!Number.isFinite(expires) || !next.keyed.hasRoom(key)) throw new Error('candidate keyed state is unavailable');
        mirrored.push({ runtime: next, value, expires });
      } catch {
        throw new DataAdmissionError(503, 'admission_policy_preparing');
      }
    }
    // No awaits between the last policy check and these writes.
    for (const plan of staged) if (plan.state !== undefined) {
      if (plan.runtime.keyed) plan.runtime.keyed.set(nowTarget.principal.keyId, plan.state, plan.expires!);
      else plan.runtime.state = plan.state;
    }
    for (const plan of mirrored) {
      if (plan.runtime.keyed) plan.runtime.keyed.set(key, plan.value, plan.expires!);
      else plan.runtime.state = plan.value;
    }
    this.previews.delete(target.requestId);
    this.grants.set(target.requestId, { entryRouteId:target.entryRouteId, routeId: target.routeId, sourcePrincipal: structuredClone(target.principal), worker: workerKey(worker), grant, plugins: this.plugins.map(runtime => ({publication: runtime.publication, plugin: runtime.plugin, state: null})), expires: null });
    return grant;
  }
  beforeAttempt(target: AdmissionTarget, worker: RateLimitWorkerIdentity): AdmissionGrant {
    const stored = this.grants.get(target.requestId);
    if (!stored) throw new DataAdmissionError(403, 'admission_grant_missing');
    this.assertGrant(stored, target, worker);
    for (const runtime of stored.plugins) {
      const denial = runtime.plugin.beforeAttempt?.({...target, principal: stored.grant.principal}, structuredClone(stored.grant.snapshots[runtime.publication.name] ?? null));
      if (denial) deny(denial);
    }
    return stored.grant;
  }
  release(requestId: string, worker: RateLimitWorkerIdentity): void {
    const stored = this.grants.get(requestId);
    if (stored && stored.worker !== workerKey(worker)) throw new DataAdmissionError(403, 'admission_identity_mismatch');
    // Keep the decision until every signed retry deadline has expired.
    if (stored) stored.expires = this.now() + 15000;
  }
  private assertGrant(stored: StoredGrant, target: AdmissionTarget, worker: RateLimitWorkerIdentity): void {
    if (stored.worker !== workerKey(worker) || stored.routeId !== target.routeId || stored.entryRouteId !== target.entryRouteId || JSON.stringify(stored.sourcePrincipal) !== JSON.stringify(target.principal)
      || !['active', 'retired'].includes(this.options.authorizeWorker(worker))) throw new DataAdmissionError(403, 'admission_identity_mismatch');
  }
}
