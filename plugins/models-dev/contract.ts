/**
 * Public contract of the models-dev catalog provider.
 *
 * This is the ONLY file other plugins may import from models-dev. It contains the
 * declared service identity, the wire-contract snapshot literal and the data types
 * of the read surface; it never exposes the downloader, the private storage keys or
 * the internal catalog representation.
 *
 * Consumers must declare a real dependency on `models-dev` and consume the local
 * service for their own process. The service methods are synchronous and read an
 * already-loaded in-memory view: no per-request network or SQL is performed.
 */

/** Provider plugin name. Must match the manifest. */
export const MODELS_DEV_PLUGIN_NAME = 'models-dev';

/** The single upstream source; models-dev is the only component allowed to fetch it. */
export const MODELS_DEV_SOURCE_URL = 'https://models.dev/api.json';

/** Same-process local read service, published in both the control and worker processes. */
export const MODELS_DEV_CATALOG_SERVICE_ID = 'models-dev.catalog.v1';
export const MODELS_DEV_CATALOG_CONTRACT_VERSION = 1;

/** Versioned immutable snapshot of the full catalog, published by the control writer. */
export const MODELS_DEV_CATALOG_SNAPSHOT_ID = 'models-dev.catalog.snapshot.v1';
export const MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT_VERSION = 1;
/**
 * One atomic record keeps fetchedAt and the immutable catalog with its version.
 * The catalog remains unrestricted JSON so every upstream field is preserved.
 */
export const MODELS_DEV_CATALOG_SNAPSHOT_SCHEMA = Object.freeze({
  type: 'object', properties: {
    version: { type: 'number', integer: true, minimum: 1 },
    fetchedAt: { type: 'number', minimum: 0 },
    catalog: { type: 'json', maxBytes: 32 * 1024 * 1024 },
  },
} as const);
export const MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT = Object.freeze({
  id: MODELS_DEV_CATALOG_SNAPSHOT_ID,
  version: MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT_VERSION,
  content: MODELS_DEV_CATALOG_SNAPSHOT_SCHEMA,
});

/** Catalog availability is separate from whether the service is published. */
export type ModelsDevCatalogState = 'empty' | 'ready' | 'stale' | 'failed';

export interface ModelsDevCatalogStatus {
  readonly state: ModelsDevCatalogState;
  /** Monotonic published data version; `null` before the first successful load. */
  readonly version: number | null;
  readonly fetchedAt: number | null;
  readonly providerCount: number;
  readonly modelCount: number;
  /** Last failure reason; `null` after a fully successful load. */
  readonly error: string | null;
}

export interface ModelsDevProviderSummary {
  readonly provider: string;
  readonly name: string;
  /** Normalized upstream API base (`provider.api`), or `null` when models.dev declares none. */
  readonly api: string | null;
  readonly modelCount: number;
}

/** One selectable catalog model. `provider` is the pricing provider, never the protocol. */
export interface ModelsDevModelOption {
  readonly provider: string;
  readonly providerName: string;
  readonly model: string;
  readonly name: string;
}

export interface ModelsDevModelPage {
  readonly models: readonly ModelsDevModelOption[];
  readonly total: number;
  /** 1-based page actually returned. */
  readonly page: number;
  readonly pageSize: number;
}

/**
 * A resolved catalog entry. `tiered` means the entry carries additional
 * context-based price steps that this contract does not expand; callers must treat
 * a tiered entry as unknown above the documented threshold rather than guessing.
 */
export interface ModelsDevModelMatch {
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly tiered: boolean;
}

export interface ModelsDevProviderMatch {
  readonly provider: string;
}

/**
 * The declared local read surface. Implementations must be side-effect free and
 * must never throw for a miss/corruption of the current view: an unavailable
 * catalog returns an `empty`/`failed` status instead of a fabricated price.
 */
export interface ModelsDevCatalogService {
  status(): ModelsDevCatalogStatus;
  providers(): readonly ModelsDevProviderSummary[];
  modelOptions(input?: { readonly provider?: string; readonly search?: string; readonly page?: number; readonly pageSize?: number }): ModelsDevModelPage;
  /**
   * Resolve exactly one catalog entry for a client model name.
   *
   * `url` (when supplied) is canonicalized to host + path and matched against the
   * full catalog's `provider.api`; more than one candidate is ambiguous and returns
   * null. `pricingProvider` is a catalog provider id and takes priority over URL and
   * prefix inference. A model id present under several providers without an explicit
   * provider is ambiguous. Matching is exact and case-sensitive.
   */
  resolveModel(input: { readonly model: string; readonly pricingProvider?: string; readonly url?: string }): ModelsDevModelMatch | null;
  /** Resolve one provider from a real upstream URL via `provider.api`; ambiguous/none => null. */
  resolveProvider(input: { readonly url: string }): ModelsDevProviderMatch | null;
}
