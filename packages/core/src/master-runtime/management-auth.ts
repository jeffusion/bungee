import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { ManagementProvider, ManagementSubject } from '../plugin-extensions';
import type { PluginControlHost } from '../plugin-control';
import type { PluginDurableState } from '../plugin-durable-state';
export const MANAGEMENT_CAPABILITIES = ['config.read','config.write','logs.read','logs.body','keys.read','keys.write','plugins.read','plugins.toggle','plugins.code','auth.mode','self.password','self.logout'] as const;
export interface ManagementIdentity { readonly subject: ManagementSubject; readonly provider: ManagementProvider | null }
export class ManagementAuthentication {
  private readonly identities = new WeakMap<Request, ManagementIdentity>();
  private readonly knownProviders: Set<string>;
  constructor(private readonly host: PluginControlHost,
    private readonly aggregate: () => ConfigurationAggregateV2,
    providers: ReadonlySet<string>, private readonly managementOrigin?: string,
    private readonly selectionState?: PluginDurableState) {
    this.knownProviders = new Set(providers);
  }
  private persistedSelection: import('../plugin-durable-state').DurableRecord | null = null;
  async initialize(): Promise<void> {
    const stored = await this.selectionState?.get('selection') ?? null;
    const value = stored?.value as {providers?: unknown; selected?: unknown} | undefined;
    if (value && (!Array.isArray(value.providers) || value.providers.some(name => typeof name !== 'string')
      || (value.selected !== null && typeof value.selected !== 'string'))) throw new Error('management_selection_corrupt');
    for (const name of (value?.providers ?? []) as string[]) this.knownProviders.add(name);
    this.persistedSelection = stored;
    if (this.selectionState) await this.rememberSelection(this.aggregate(), false);
  }
  selected(aggregate = this.aggregate()): string | null {
    const names = aggregate.plugin_activations.filter(x => this.knownProviders.has(x.plugin_name));
    if (names.length > 1) throw new Error('multiple_management_providers');
    const persisted = this.persistedSelection?.value as {selected?: string | null} | undefined;
    if (arguments.length === 0 && persisted?.selected && names.length === 0) throw new Error('management_selection_mismatch');
    return names[0]?.plugin_name ?? null;
  }
  async rememberSelection(aggregate: ConfigurationAggregateV2, committed = true): Promise<void> {
    const previous = await this.selectionState?.get('selection');
    const selected = this.selected(aggregate);
    const old = previous?.value as {selected?: string | null} | undefined;
    const value = {providers: [...this.knownProviders].sort(), selected: committed || !previous ? selected : old?.selected ?? null};
    if (this.selectionState && JSON.stringify(previous?.value) !== JSON.stringify(value)) {
      const records = await this.selectionState.transact([{key:'selection',expectedVersion:previous?.version ?? 0,value}]);
      this.persistedSelection = records[0]!;
    } else this.persistedSelection = previous ?? null;

  }
  provider(name = this.selected()): ManagementProvider | null {
    if (name === null) return null;
    const handle = this.host.get(name);
    if (handle?.status !== 'ready' || !handle.admission || !handle.control.management) throw new Error('management_provider_unavailable');
    return handle.control.management;
  }
  async authenticate(request: Request, fresh = false): Promise<ManagementIdentity | null> {
    if (!fresh) { const existing = this.identities.get(request); if (existing) return existing; }
    const provider = this.provider();
    const subject = provider ? await provider.authenticate(request)
      : Object.freeze({ id: 'anonymous', provider: 'anonymous', capabilities: MANAGEMENT_CAPABILITIES });
    if (!subject) { this.identities.delete(request); return null; }
    const identity = { subject, provider }; this.identities.set(request, identity); return identity;
  }
  identity(request: Request): ManagementIdentity | null { return this.identities.get(request) ?? null; }
  publicOrigin(request: Request): string { return this.managementOrigin ?? new URL(request.url).origin; }
  async authorized(request: Request, capability: string): Promise<boolean> {
    const identity = this.identity(request);
    return !!identity && (identity.provider ? await identity.provider.authorize(identity.subject, capability) : true);
  }
  async recheck(request: Request): Promise<boolean> { return !!await this.authenticate(request, true); }
  validateWrite(request: Request): void {
    if (!this.identity(request)?.provider) return;
    if (!request.headers.has('cookie') || request.headers.has('authorization')) return;
    const identity = this.identity(request);
    if (!identity?.provider?.validateWrite) throw new Error('csrf_validation_unavailable');
    if (request.headers.get('origin') !== (this.managementOrigin ?? new URL(request.url).origin) || !request.headers.get('x-csrf-token')) throw new Error('invalid_csrf');
    identity.provider.validateWrite(request);
  }
}

export function parseManagementOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('BUNGEE_PUBLIC_ORIGIN must be an HTTPS origin or loopback HTTP origin');
  return url.origin;
}

/** Asynchronous identity and authorization preflight for a management mode change. */
export async function validateManagementTransition(
  request: Request, active: ConfigurationAggregateV2, next: ConfigurationAggregateV2,
  managementAuth: ManagementAuthentication | undefined, host: PluginControlHost,
): Promise<Response | null> {
  const before = managementAuth?.selected(active), after = managementAuth?.selected(next);
  if (before === after) return null;
  if (after) {
    const handle = host.get(after);
    if (handle?.status !== 'ready' || !handle.admission || !await handle.control.management?.hasIdentity()) return Response.json({error:'management_setup_failed'},{status:422});
  } else if (!managementAuth?.identity(request)?.provider || managementAuth.identity(request)?.subject.provider !== before || !await managementAuth.authorized(request, 'auth.mode')) {
    return Response.json({error:'unauthorized'},{status:401});
  }
  return null;
}

/** Bootstrap errors cross bundled plugin boundaries; only expose known safe codes. */
export function managementSetupFailure(error: unknown): Response {
  const code = error && typeof error === 'object' && 'code' in error ? (error as {code:unknown}).code : undefined;
  const statuses: Record<string,number> = {invalid_credentials:422,invalid_password:422,password_confirmation:422,invalid_input:422,bootstrap_conflict:409,version_conflict:409,provider_unavailable:503};
  if (typeof code === 'string' && Object.hasOwn(statuses,code)) return Response.json({error:code},{status:statuses[code]});
  return Response.json({error:'management_setup_failed'},{status:503});
}
