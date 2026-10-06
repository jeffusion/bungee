/**
 * models-dev control plugin: the single network writer, refresh scheduler and
 * private persistence owner of the models.dev catalog. It publishes the versioned
 * snapshot and the control-process local read service, and exposes the management
 * HTTP API (settings/status/refresh/queries). No other component downloads.
 */

import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  PluginControl,
} from '../../../packages/core/src/plugin-control/contracts';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import {
  MODELS_DEV_CATALOG_SERVICE_ID,
  MODELS_DEV_CATALOG_CONTRACT_VERSION,
  MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT,
  MODELS_DEV_SOURCE_URL,
} from '../contract';
import { buildCatalogIndex } from './catalog';
import { downloadModelsDevCatalog } from './download';
import { CatalogView, catalogServiceOf, readCatalogSnapshot, type SnapshotSource } from './local';
import {
  DEFAULT_MODELS_DEV_SETTINGS, parseModelsDevSettings, readCatalogRecord, readModelsDevSettings, readPersistedStatus,
  writeModelsDevSettings, writePersistedStatus,
  type ModelsDevPersistedStatus, type ModelsDevSettings,
} from './store';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PAGE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_BYTES = 512;
const MAX_PAGE = 400;

export interface ModelsDevCatalogManagerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface CatalogPublisher {
  publish(version: number, bytes: Uint8Array): void;
  current(): SnapshotSource | null;
}

interface ManagerStatus {
  source: string;
  /** Availability of the current catalog view, separate from service publication. */
  state: 'empty' | 'ready' | 'stale' | 'failed';
  settings: ModelsDevSettings;
  refreshing: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRefreshAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  modelCount: number;
  providerCount: number;
  /** Published data version; `null` before the first successful load. */
  version: number | null;
}

/**
 * One control-process owner. The atomic Host snapshot is the only catalog truth.
 * Small status metadata may fail independently without undoing a committed catalog.
 */
export class ModelsDevCatalogManager {
  readonly view = new CatalogView();
  private settings: ModelsDevSettings = { ...DEFAULT_MODELS_DEV_SETTINGS };
  private status: ModelsDevPersistedStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 };
  private refreshing = false;
  private nextRefreshAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private initialization: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly storage: PluginStorage, private readonly publisher: CatalogPublisher, private readonly options: ModelsDevCatalogManagerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await (this.initialization ??= this.restore());
  }

  statusSnapshot(): ManagerStatus {
    const catalog = this.view.status();
    return {
      source: MODELS_DEV_SOURCE_URL, state: catalog.state, settings: { ...this.settings }, refreshing: this.refreshing,
      lastAttemptAt: this.status.lastAttemptAt, lastSuccessAt: this.status.lastSuccessAt,
      nextRefreshAt: this.nextRefreshAt, lastError: this.status.lastError, consecutiveFailures: this.status.consecutiveFailures,
      modelCount: catalog.modelCount, providerCount: catalog.providerCount, version: catalog.version,
    };
  }

  async configure(settings: ModelsDevSettings): Promise<ManagerStatus> {
    await this.start();
    if (this.stopped) throw new Error('disposed');
    const parsed = parseModelsDevSettings(settings);
    await writeModelsDevSettings(this.storage, parsed);
    this.settings = parsed;
    this.schedule();
    return this.statusSnapshot();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    this.nextRefreshAt = null;
    this.refreshing = true;
    this.status.lastAttemptAt = this.now();
    const task = this.load().finally(() => { if (this.inFlight === task) this.inFlight = undefined; });
    this.inFlight = task;
    return task;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.controller?.abort();
    await Promise.allSettled([this.initialization, this.inFlight].filter((task): task is Promise<void> => task !== undefined));
  }

  private async restore(): Promise<void> {
    // Strict reads: a real SQL/parse failure must surface as an explicit error and
    // must never be silently downgraded to "no settings/catalog" (which a consumer
    // could misread as a fresh, priced catalog).
    try {
      this.settings = await readModelsDevSettings(this.storage);
    } catch {
      this.status.lastError = 'storage';
    }
    try {
      this.status = { ...this.status, ...await readPersistedStatus(this.storage) };
    } catch {
      this.status.lastError = 'storage';
    }
    try {
      let source = this.publisher.current();
      // A legacy KV is read ONLY before the first valid snapshot, never as a corruption fallback.
      if (source === null) {
        const legacy = await readCatalogRecord(this.storage);
        if (legacy !== null) {
          buildCatalogIndex(legacy);
          this.publisher.publish(legacy.version, new TextEncoder().encode(JSON.stringify(legacy)));
          source = this.publisher.current();
        }
      }
      const record = source === null ? null : await readCatalogSnapshot(source);
      if (record !== null) {
        const index = buildCatalogIndex(record);
        this.view.apply(index, this.status.lastError === null ? 'ready' : 'stale', this.status.lastError);
        this.status.lastSuccessAt = record.fetchedAt;
      } else {
        this.status.lastSuccessAt = null;
      }
    } catch {
      this.view.fail('snapshot');
      this.status.lastError = 'snapshot';
    }
    if (this.stopped) return;
    this.schedule();
  }

  private async load(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let timedOut = false;
    let phase: 'network' | 'storage' | 'snapshot' | 'invalid_catalog' = 'storage';
    try {
      // Observability metadata is not a prerequisite for updating the catalog.
      try { await writePersistedStatus(this.storage, this.status); } catch { this.status.lastError = 'storage'; }
      if (this.stopped) return;
      phase = 'network';
      const failure = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeout = (this.options.schedule ?? setTimeout)(() => { timedOut = true; controller.abort(); }, this.settings.timeoutSeconds * 1000);
      });
      const catalog = await Promise.race([
        downloadModelsDevCatalog({ ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: controller.signal }),
        failure,
      ]);
      if (this.stopped) return;
      phase = 'invalid_catalog';
      const version = (this.publisher.current()?.descriptor.version ?? 0) + 1;
      if (!Number.isSafeInteger(version)) throw new Error('catalog_version_overflow');
      const fetchedAt = Math.max(this.now(), (this.status.lastSuccessAt ?? -1) + 1);
      const record = { version, fetchedAt, catalog };
      // Validate the payload BEFORE any durable write, so an unreadable catalog is
      // never published nor persisted.
      const index = buildCatalogIndex(record);
      // The single atomic visibility point includes metadata and catalog bytes.
      phase = 'snapshot';
      this.publisher.publish(version, new TextEncoder().encode(JSON.stringify(record)));
      if (this.stopped) return;
      this.view.apply(index, 'ready', null);
      this.status.lastSuccessAt = fetchedAt;
      this.status.lastError = null;
      this.status.consecutiveFailures = 0;
    } catch (error) {
      if (this.stopped) return;
      this.status.lastError = timedOut ? 'timeout' : phase === 'invalid_catalog' ? 'invalid_catalog' : phase;
      this.status.consecutiveFailures += 1;
      // A failed refresh (network/snapshot/storage) keeps the last valid view.
      this.view.fail(this.status.lastError);
    } finally {
      if (timeout !== undefined) (this.options.cancel ?? clearTimeout)(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.controller === controller) this.controller = undefined;
      this.refreshing = false;
      if (!this.stopped) {
        this.schedule();
        try { await writePersistedStatus(this.storage, this.status); }
        catch { this.status.lastError = 'storage'; this.view.fail('storage'); }
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    this.nextRefreshAt = null;
    if (this.stopped || this.refreshing || !this.settings.autoRefresh) return;
    const interval = this.settings.intervalMinutes * 60_000;
    const due = this.status.consecutiveFailures
      ? this.now() + Math.min(interval, 60_000 * Math.min(15, 2 ** Math.min(this.status.consecutiveFailures - 1, 4)))
      : this.status.lastSuccessAt === null ? this.now() : Math.max(this.now(), this.status.lastSuccessAt + interval);
    this.nextRefreshAt = due;
    this.timer = (this.options.schedule ?? setTimeout)(() => { void this.refresh(); }, Math.max(0, due - this.now()));
  }
}

function jsonResponse(value: unknown, status = 200, maxBytes = MAX_RESPONSE_BYTES): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    return new Response(JSON.stringify({ error: 'response_limit' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_input');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('invalid_input'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

class ModelsDevControl implements PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc = [] as const;
  private disposed = false;
  private readonly manager: ModelsDevCatalogManager;
  private readonly store: { publish(version: number, body: unknown | Uint8Array): unknown; current(): SnapshotSource | null; version(version: number): SnapshotSource | null };
  private readonly abortListener: () => void;

  constructor(private readonly host: ControlHostContext, options?: ModelsDevCatalogManagerOptions) {
    // The provider MUST obtain the Host's durable, chunked snapshot store. A host
    // without that capability is refused explicitly: there is no in-plugin fallback
    // storage that would hide a missing durable capability.
    const snapshot = host.services?.snapshot;
    if (snapshot === undefined || typeof snapshot.store !== 'function') {
      throw new Error('models-dev requires a durable host snapshot store capability');
    }
    const store = snapshot.store({ id: 'models-dev.catalog.v1', schemaVersion: 1, maxVersions: 3, maxBytes: 32 * 1024 * 1024 });
    if (store === null) throw new Error('models-dev requires a durable host snapshot store capability');
    this.store = store;
    this.manager = new ModelsDevCatalogManager(host.storage.uncached?.() ?? host.storage, {
      publish: (version, bytes) => { store.publish(version, bytes); }, current: () => store.current(),
    }, options);
    this.abortListener = () => { void this.dispose(); };
    if (host.signal.aborted) this.disposed = true;
    else host.signal.addEventListener('abort', this.abortListener, { once: true });
    snapshot.provide(MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT, {
      current: () => this.store.current(),
      version: (version: number) => this.store.version(version),
    });
    if (host.services !== undefined) {
      host.services.publish(MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION, catalogServiceOf(this.manager.view));
    }
    this.api = this.buildApi();
  }

  private assertAlive(signal?: AbortSignal): void {
    if (this.disposed || this.host.signal.aborted) throw new Error('disposed');
    if (signal?.aborted) throw new Error('request_cancelled');
  }

  private buildApi(): readonly ControlApiDeclaration[] {
    const invoke = (handler: (context: ControlApiHandlerContext) => Promise<Response> | Response) => async (context: ControlApiHandlerContext) => {
      try {
        this.assertAlive(context.requestSignal);
        return await handler(context);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error && error.message === 'invalid_input' ? 'invalid_input' : 'internal_error' }, 500);
      }
    };
    return [{
      path: '/catalog/status', methods: ['GET'], handler: 'getCatalogStatus',
      invoke: invoke(async () => { await this.manager.start(); return jsonResponse(this.manager.statusSnapshot()); }),
    }, {
      path: '/catalog/providers', methods: ['GET'], handler: 'getCatalogProviders',
      invoke: invoke(async () => jsonResponse({ providers: this.manager.view.providers() }, 200, MAX_PAGE_RESPONSE_BYTES)),
    }, {
      path: '/catalog/models', methods: ['GET'], handler: 'getCatalogModels',
      invoke: invoke(async (context) => {
        const query = parseModelQuery(context.request);
        if (query === null) return jsonResponse({ error: 'invalid_query' }, 400);
        await this.manager.start();
        return jsonResponse(this.manager.view.modelOptions(query), 200, MAX_PAGE_RESPONSE_BYTES);
      }),
    }, {
      path: '/catalog/settings', methods: ['PUT'], handler: 'configureCatalog',
      invoke: invoke(async (context) => {
        let settings: ModelsDevSettings;
        try { settings = parseModelsDevSettings(await readBody(context.request, 4096)); }
        catch { return jsonResponse({ error: 'invalid_input' }, 400); }
        return jsonResponse(await this.manager.configure(settings));
      }),
    }, {
      path: '/catalog/refresh', methods: ['POST'], handler: 'refreshCatalog',
      invoke: invoke(async () => {
        await this.manager.start();
        void this.manager.refresh();
        return jsonResponse(this.manager.statusSnapshot(), 202);
      }),
    }];
  }

  async start(): Promise<void> {
    this.assertAlive();
    await this.manager.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const stopped = this.manager.stop();
    this.host.signal.removeEventListener('abort', this.abortListener);
    await stopped;
  }
}

function parseModelQuery(request: Request): { provider?: string; search?: string; page?: number } | null {
  const params = new URL(request.url).searchParams;
  const encoder = new TextEncoder();
  for (const key of ['provider', 'search', 'page']) if (params.getAll(key).length > 1) return null;
  const provider = params.get('provider') ?? undefined;
  const search = params.get('search') ?? undefined;
  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  if ((provider !== undefined && encoder.encode(provider).byteLength > MAX_QUERY_BYTES)
    || (search !== undefined && encoder.encode(search).byteLength > MAX_QUERY_BYTES)
    || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) return null;
  return { provider, search, page };
}

export function createControl(context: ControlHostContext, options?: ModelsDevCatalogManagerOptions): PluginControl {
  return new ModelsDevControl(context, options);
}

export default { createControl } satisfies ControlPlugin;
