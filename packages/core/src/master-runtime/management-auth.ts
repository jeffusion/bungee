import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import type { ManagementProvider, ManagementSubject } from '../plugin-extensions';
import type { PluginControlHost } from '../plugin-control';
import type { ManagementProtection } from '../config-storage';
import { isPluginName } from '../config-storage/plugin-name';
export const MANAGEMENT_CAPABILITIES = ['config.read','config.write','logs.read','logs.body','keys.read','keys.write','plugins.read','plugins.toggle','plugins.code','auth.mode','self.password','self.logout'] as const;
export interface ManagementIdentity { readonly subject: ManagementSubject; readonly provider: ManagementProvider | null }
type IdentityEvidence = ManagementIdentity & { readonly generation: number; readonly epoch: number; readonly selected: string | null };
export type ManagementTransition = { readonly mutationId: string };

export class ManagementAuthentication {
  private readonly identities = new WeakMap<Request, IdentityEvidence>();
  private readonly requests = new WeakMap<Request, {generation:number; epoch:number}>();
  private epoch = 0;
  private transition: ManagementTransition | null = null;
  constructor(private readonly host: PluginControlHost,
    private readonly aggregate: () => ConfigurationAggregate,
    private readonly knownProviders: ReadonlySet<string>, private readonly managementOrigin?: string,
    private readonly protection?: () => ManagementProtection) {}

  private guard(): ManagementProtection {
    const guard = this.protection ? this.protection() : {required:false, selectedProvider:null, generation:0};
    if (!guard || typeof guard.required !== 'boolean' || !Number.isSafeInteger(guard.generation) || guard.generation < 0
      || (guard.required ? typeof guard.selectedProvider !== 'string' || !isPluginName(guard.selectedProvider) : guard.selectedProvider !== null)) {
      throw new Error('management_protection_invalid');
    }
    const selected = this.selection(this.aggregate(), guard.selectedProvider);
    if (selected !== guard.selectedProvider) throw new Error('management_selection_mismatch');
    return guard;
  }
  private selection(aggregate: ConfigurationAggregate, protectedProvider: string | null): string | null {
    const names = aggregate.plugin_activations.filter(x => this.knownProviders.has(x.plugin_name) || x.plugin_name === protectedProvider);
    if (names.length > 1) throw new Error('multiple_management_providers');
    return names[0]?.plugin_name ?? null;
  }
  selected(aggregate?: ConfigurationAggregate): string | null {
    const guard = this.guard();
    return aggregate ? this.selection(aggregate, guard.selectedProvider) : guard.selectedProvider;
  }
  provider(name = this.selected()): ManagementProvider | null {
    if (this.transition) throw new Error('management_transition_pending');
    if (name === null) return null;
    const handle = this.host.get(name);
    if (!this.knownProviders.has(name) || handle?.status !== 'ready' || !handle.admission || !handle.control.management) throw new Error('management_provider_unavailable');
    return handle.control.management;
  }
  /** Only the serialized mutation owns this token; an HTTP request cannot bypass the latch. */
  beginTransition(mutationId: string): ManagementTransition {
    if (this.transition) throw new Error('management_transition_pending');
    this.guard();
    this.epoch++;
    return this.transition = Object.freeze({mutationId});
  }
  completeTransition(transition: ManagementTransition): void {
    if (this.transition !== transition) throw new Error('management_transition_mismatch');
    this.guard();
    this.transition = null;
    this.epoch++;
  }
  capture(): () => boolean {
    const guard = this.guard(), epoch = this.epoch, provider = this.provider();
    return () => this.guard().generation === guard.generation && this.epoch === epoch
      && this.selected() === guard.selectedProvider && this.provider() === provider;
  }
  available(): boolean {
    try { this.provider(); return true; } catch { return false; }
  }
  async setupStatus(): Promise<'uninitialized' | 'ready'> {
    const selected = this.selected(), guard = this.guard(), epoch = this.epoch;
    const provider = this.provider(selected);
    if (!provider) return 'ready';
    const status = await provider.setupStatus();
    if (!['uninitialized','ready'].includes(status) || this.guard().generation !== guard.generation || this.epoch !== epoch
      || this.selected() !== selected || this.provider() !== provider) throw new Error('management_provider_unavailable');
    return status;
  }
  async authenticate(request: Request, fresh = false): Promise<ManagementIdentity | null> {
    const guard = this.guard(), epoch = this.epoch;
    const first = this.requests.get(request);
    if (first && (first.generation !== guard.generation || first.epoch !== epoch)) { this.identities.delete(request); return null; }
    this.requests.set(request, {generation:guard.generation, epoch});
    const provider = this.provider();
    if (!fresh) { const existing = this.identity(request); if (existing) return existing; }
    const subject = provider ? await provider.authenticate(request)
      : Object.freeze({ id: 'anonymous', provider: 'anonymous', capabilities: MANAGEMENT_CAPABILITIES });
    if (!subject || this.guard().generation !== guard.generation || this.epoch !== epoch || this.provider() !== provider) {
      this.identities.delete(request); return null;
    }
    const identity = { subject, provider, generation:guard.generation, epoch, selected:guard.selectedProvider };
    this.identities.set(request, identity); return identity;
  }
  identity(request: Request): ManagementIdentity | null {
    const identity = this.identities.get(request);
    if (!identity || this.transition) return null;
    const guard = this.guard();
    return identity.generation === guard.generation && identity.epoch === this.epoch && identity.selected === guard.selectedProvider
      && identity.provider === this.provider() ? identity : null;
  }
  publicOrigin(request: Request): string { return this.managementOrigin ?? new URL(request.url).origin; }
  async authorized(request: Request, capability: string): Promise<boolean> {
    const identity = this.identity(request);
    if (!identity) return false;
    const allowed = identity.provider ? await identity.provider.authorize(identity.subject, capability) : true;
    return allowed && this.identity(request) === identity;
  }
  async recheck(request: Request): Promise<boolean> { return !!await this.authenticate(request, true); }
  validateWrite(request: Request): void {
    const identity = this.identity(request);
    if (!identity) throw new Error('management_identity_expired');
    if (!identity.provider || !request.headers.has('cookie') || request.headers.has('authorization')) return;
    if (!identity.provider.validateWrite) throw new Error('csrf_validation_unavailable');
    if (request.headers.get('origin') !== this.publicOrigin(request) || !request.headers.get('x-csrf-token')) throw new Error('invalid_csrf');
    identity.provider.validateWrite(request);
  }
}

export function parseManagementOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol)) throw new Error('BUNGEE_PUBLIC_ORIGIN must be an HTTP or HTTPS origin');
  return url.origin;
}

/** Normal commits may enable protection once; changing a protected provider requires offline authority. */
export async function validateManagementTransition(
  _request: Request, _active: ConfigurationAggregate, next: ConfigurationAggregate,
  managementAuth: ManagementAuthentication | undefined, _host: PluginControlHost,
): Promise<Response | null> {
  if (!managementAuth) return Response.json({error:'management_uninitialized'},{status:503});
  const before = managementAuth.selected(), after = managementAuth.selected(next);
  if (before && before !== after) return Response.json({error:'management_protection_required'},{status:422});
  return null;
}
