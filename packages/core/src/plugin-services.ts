/** Public same-process plugin services. Cross-process callers require the host RPC adapter. */
export interface PluginServices {
  onDispose(cleanup: () => void): void;
  publish<T extends object>(serviceId: string, contractVersion: number, implementation: T): void;
  consume<T extends object>(provider: string, serviceId: string, contractVersion: number): Readonly<T>;
}
export interface PluginServiceDeclarations {
  readonly provides?: readonly {readonly id: string; readonly version: number; readonly process: 'worker'}[];
  readonly consumes?: readonly {readonly plugin: string; readonly id: string; readonly version: number; readonly process: 'worker'}[];
}

type Owner = {
  plugin: string; scope: string; dependencies: Readonly<Record<string, string>>;
  ready: boolean; retiring: boolean; revoked: boolean; cleaning: boolean; leases: number;
  pending: Set<Promise<unknown>>; waiters: Array<() => void>; cleanups: Set<() => void>;
};
type Publication = { owner: Owner; version: number; implementation: object };

export class PluginServiceHost {
  private contracts?: ReadonlyMap<string, PluginServiceDeclarations>;
  setDeclarations(contracts: ReadonlyMap<string, PluginServiceDeclarations>): void { this.contracts = new Map(contracts); }
  private owners = new Map<string, Owner>();
  private publications = new Map<string, Publication>();
  private key(plugin: string, scope: string): string { return `${plugin}\0${scope}`; }
  createContext(plugin: string, scope = 'global', dependencies: Readonly<Record<string, string>> = {}): PluginServices {
    const key = this.key(plugin, scope);
    if (this.owners.has(key)) throw new Error(`Service context already exists: ${plugin}/${scope}`);
    const owner: Owner = { plugin, scope, dependencies: Object.freeze({ ...dependencies }), ready: false, retiring: false, revoked: false, cleaning: false, leases: 0, pending: new Set(), waiters: [], cleanups: new Set() };
    this.owners.set(key, owner);
    const assertActive = (target = owner) => {
      if (target.revoked || (target.retiring && !target.cleaning && target.leases === 0 && target.pending.size === 0)) throw new Error(`Plugin service handle revoked: ${target.plugin}`);
    };
    const wrap = (value: unknown, provider: Owner, receiver?: object): any => {
      if (typeof value === 'function') return (...args: unknown[]) => {
        assertActive(); assertActive(provider);
        const guardArgument = (arg: unknown): unknown => {
          if (typeof arg === 'function') return (...callbackArgs: unknown[]) => {
            assertActive(); assertActive(provider);
            const result = Reflect.apply(arg, undefined, callbackArgs);
            if (result && typeof result.then === 'function') {
              const pending = Promise.resolve(result);
              owner.pending.add(pending); provider.pending.add(pending);
              void pending.finally(() => { owner.pending.delete(pending); provider.pending.delete(pending); this.notify(owner); this.notify(provider); }).catch(() => {});
              return pending;
            }
            return result;
          };
          if (Array.isArray(arg)) return Object.freeze(arg.map(guardArgument));
          if (arg && typeof arg === 'object') return Object.freeze(Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, guardArgument(value)])));
          return arg;
        };
        const guarded = args.map(guardArgument);
        const result = Reflect.apply(value, receiver, guarded);
        if (result && typeof result.then === 'function') {
          const pending = Promise.resolve(result).then(output => { assertActive(); assertActive(provider); return wrap(output, provider); });
          owner.pending.add(pending); provider.pending.add(pending);
          void pending.finally(() => { owner.pending.delete(pending); provider.pending.delete(pending); this.notify(owner); this.notify(provider); }).catch(() => {});
          return pending;
        }
        return wrap(result, provider);
      };
      if (Array.isArray(value)) return Object.freeze(value.map(item => wrap(item, provider)));
      if (value && typeof value === 'object') {
        // A fresh facade prevents access to implementation identity or mutable provider fields.
        const facade: Record<string, unknown> = {};
        for (const key of Object.keys(value)) Object.defineProperty(facade, key, {
          enumerable: true, get: () => { assertActive(); assertActive(provider); return wrap((value as any)[key], provider, value as object); },
        });
        return Object.freeze(facade);
      }
      return value;
    };
    return Object.freeze({
      onDispose: (cleanup: () => void) => { assertActive(); owner.cleanups.add(cleanup); },
      publish: <T extends object>(id: string, version: number, implementation: T) => {
        assertActive();
        if (this.contracts && !this.contracts.get(plugin)?.provides?.some(value => value.id === id && value.version === version)) throw new Error(`Undeclared plugin service publication: ${plugin}/${id}`);
        if (owner.scope !== 'global') throw new Error('Only global providers may publish services');
        if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid service contract version');
        const publicationKey = `${plugin}\0${id}`;
        if (this.publications.has(publicationKey)) throw new Error(`Service already published: ${plugin}/${id}`);
        this.publications.set(publicationKey, { owner, version, implementation });
      },
      consume: <T extends object>(provider: string, id: string, version: number): Readonly<T> => {
        assertActive();
        if (this.contracts && !this.contracts.get(plugin)?.consumes?.some(value => value.plugin === provider && value.id === id && value.version === version)) throw new Error(`Undeclared plugin service consumption: ${plugin} -> ${provider}/${id}`);
        if (!Object.hasOwn(owner.dependencies, provider)) throw new Error(`Undeclared plugin service dependency: ${plugin} -> ${provider}`);
        const publication = this.publications.get(`${provider}\0${id}`);
        if (!publication || !publication.owner.ready || publication.owner.retiring || publication.owner.revoked) throw new Error(`Plugin service not ready: ${provider}/${id}`);
        if (publication.version !== version) throw new Error(`Plugin service contract mismatch: ${provider}/${id}`);
        return wrap(publication.implementation, publication.owner);
      },
    });
  }
  markReady(plugin: string, scope = 'global'): void {
    const owner = this.requireOwner(plugin, scope);
    if (owner.retiring || owner.revoked) throw new Error(`Plugin service disposed: ${plugin}`);
    owner.ready = true;
  }
  /** Capture before admission; release only after all consumers finish old-request processing. */
  acquireLease(plugin: string, scope = 'global'): () => void {
    const owner = this.requireOwner(plugin, scope);
    if (!owner.ready || owner.retiring || owner.revoked) throw new Error(`Plugin service not ready: ${plugin}`);
    const retained = new Set<Owner>();
    const retain = (target: Owner): void => {
      if (retained.has(target)) return;
      if (!target.ready || target.retiring || target.revoked) throw new Error(`Plugin service not ready: ${target.plugin}`);
      retained.add(target);
      for (const dependency of Object.keys(target.dependencies)) {
        const provider = this.owners.get(this.key(dependency, 'global'));
        if (provider) retain(provider);
      }
    };
    retain(owner);
    for (const target of retained) target.leases++;
    let released = false;
    return () => { if (released) return; released = true; for (const target of retained) { target.leases--; this.notify(target); } };
  }

  references(plugin: string): ReadonlyArray<{ plugin: string; scope: string; leases: number }> {
    return [...this.owners.values()].filter(o => !o.revoked && (o.plugin === plugin || Object.hasOwn(o.dependencies, plugin)))
      .map(o => Object.freeze({ plugin: o.plugin, scope: o.scope, leases: o.leases }));
  }
  /** Stop admission immediately, preserve acquired handles until leases and calls drain. */
  async dispose(plugin: string, scope = 'global'): Promise<void> {
    const owner = this.requireOwner(plugin, scope);
    const hasPublications = [...this.publications.values()].some(publication => publication.owner === owner);
    if (hasPublications) {
      const dependents = [...this.owners.values()].filter(candidate => candidate !== owner && !candidate.revoked && (!candidate.retiring || candidate.leases > 0) && Object.hasOwn(candidate.dependencies, plugin));
      if (dependents.length) throw new Error(`Plugin service provider is referenced: ${plugin} <- ${dependents.map(candidate => `${candidate.plugin}/${candidate.scope}`).join(', ')}`);
    }
    owner.retiring = true;
    if (owner.leases || owner.pending.size) await new Promise<void>(resolve => owner.waiters.push(resolve));
    // Cleanup may invoke its cached unsubscribe handle after drain, before final revocation.
    owner.cleaning = true;
    try {
      for (const cleanup of owner.cleanups) cleanup();
      owner.cleanups.clear();
    } finally { owner.cleaning = false; }
    owner.revoked = true; owner.ready = false;
    for (const [key, publication] of this.publications) if (publication.owner === owner) this.publications.delete(key);
    this.owners.delete(this.key(plugin, scope));
  }
  private requireOwner(plugin: string, scope: string): Owner {
    const owner = this.owners.get(this.key(plugin, scope));
    if (!owner) throw new Error(`Missing plugin service context: ${plugin}/${scope}`);
    return owner;
  }
  private notify(owner: Owner): void {
    if (!owner.leases && !owner.pending.size) for (const resolve of owner.waiters.splice(0)) resolve();
  }
}

export const TOKEN_METERING_SERVICE_ID = 'token-metering.v1';
export const TOKEN_METERING_CONTRACT_VERSION = 1;
export type TokenMeteringSource = 'official' | 'estimated' | 'partial' | 'none';
export type TokenMeteringAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
export interface TokenMeteringResult {
  readonly requestId: string; readonly attemptId: string; readonly routeId: string; readonly upstreamId: string;
  readonly keyId?: string | null;
  readonly provider: string; readonly model?: string; readonly pricingProvider?: string;
  readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number;
  readonly inputSource: TokenMeteringSource; readonly outputSource: TokenMeteringSource;
  readonly inputAuthority: TokenMeteringAuthority; readonly outputAuthority: TokenMeteringAuthority;
  readonly complete: boolean; readonly observationIncomplete: boolean;
  readonly outcome: 'completed' | 'failed' | 'aborted'; readonly finishedAtMs: number; readonly settlementVersion: number;
}
export interface TokenMeteringSubscription {
  /** Omit for degradable all-request reporting; required consumers bind their admitted request. */
  readonly requestId?: string;
  readonly required?: boolean;
  readonly onResult: (result: TokenMeteringResult) => void | Promise<void>;
  readonly onFailure?: (error: unknown, result: TokenMeteringResult) => void | Promise<void>;
}
export interface TokenMeteringService {
  /** Final completion boundary: await this request's required settlement/failure callbacks before releasing its host lease. */
  drainRequest(requestId: string): Promise<void>;
  subscribe(subscription: TokenMeteringSubscription): () => void;
  prepareAttempt(input: Readonly<{ requestId: string; attemptId: string; routeId: string; upstreamId: string; url: string; body: unknown }>): Readonly<{ supported: boolean; provider?: string; model?: string; pricingProvider?: string }>;
  /** Consumer calls before request admission to pin demand; framework init also captures report subscriptions. */
  prepareRequest(requestId: string): boolean;
}

export const TOKEN_PRICING_SERVICE_ID = 'token-stats.pricing.v1';
export const TOKEN_PRICING_CONTRACT_VERSION = 1;
/** Costs are quantized to safe integer nanoUSD (1 USD = 1e9 nanoUSD); unknown remains null. */
export interface TokenPricingService {
  canPrice(input: Readonly<{ model?: string; pricingProvider?: string }>): Promise<boolean>;
  price(result: TokenMeteringResult): Promise<Readonly<{ costUsd: number | null; costNanoUsd: number | null }>>;
}
