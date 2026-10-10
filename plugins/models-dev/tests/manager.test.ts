import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { HostSnapshotStore } from '../../../packages/core/src/plugin-services/snapshot-store';
import { PluginCommunicationStore } from '../../../packages/core/src/plugin-services/persistence';
import { ModelsDevCatalogManager, createControl } from '../server/control';
import { CatalogView, capabilitiesServiceOf, reconcileCatalogView } from '../server/local';
import { ModelsDevPlugin } from '../server/index';
import { MODELS_DEV_CAPABILITIES_SERVICE_ID, type ModelsDevCapabilitiesService } from '../contract';
import type { ControlHostContext, PluginChannelSnapshotRead, PluginInitContext } from '@jeffusion/bungee-core/plugin';

const smallCatalog = { openai: { id: 'openai', name: 'OpenAI', models: {
  'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', cost: { input: 1, output: 2 } },
} } };
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
class MemoryStorage implements PluginStorage {
  readonly values = new Map<string, unknown>();
  failStatus = false;
  async get<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async set(key: string, value: unknown): Promise<void> {
    if (this.failStatus && key === 'catalog:status:v1') throw new Error('injected metadata failure');
    if (key === 'catalog:v1') throw new Error('catalog KV writes must never happen');
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async keys(): Promise<string[]> { return [...this.values.keys()]; }
  async readStrict<T>(key: string): Promise<{ found: false } | { found: true; value: T }> {
    return this.values.has(key) ? { found: true, value: this.values.get(key) as T } : { found: false };
  }
  uncached(): PluginStorage { return this; }
}
function snapshotStore() {
  const db = new Database(':memory:'); databases.push(db);
  return new HostSnapshotStore(new PluginCommunicationStore(db).forNamespace('models-dev'), {
    owner: 'models-dev', id: 'models-dev.catalog.v1', schemaVersion: 1, maxVersions: 3, maxBytes: 4 * 1024 * 1024,
  });
}
function manager(storage: MemoryStorage, fetchImpl: typeof fetch, store = snapshotStore()) {
  const published: number[] = [];
  const injection = { failPublish: false };
  const instance = new ModelsDevCatalogManager(storage, {
    current: () => store.current(),
    publish(version, bytes) {
      if (injection.failPublish) throw new Error('injected snapshot failure');
      store.publish(version, bytes); published.push(version);
    },
  }, { fetch: fetchImpl, now: () => 1000, schedule: () => 0 as unknown as ReturnType<typeof setTimeout>, cancel: () => {} });
  return { instance, store, published, injection };
}
const okFetch = (catalog: unknown): typeof fetch => (async () => Response.json(catalog)) as typeof fetch;

describe('models-dev authoritative snapshot', () => {
  test('publishes one atomic record and never writes a catalog KV copy', async () => {
    const storage = new MemoryStorage();
    const { instance, store, published } = manager(storage, okFetch(smallCatalog));
    await instance.start(); await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 1, modelCount: 1, lastError: null,
      settings: { intervalHours: 24 }, nextRefreshAt: 1000 + 24 * 60 * 60 * 1000 });
    expect(storage.values.has('catalog:v1')).toBe(false);
    expect(published).toEqual([1]);
    const source = store.current()!;
    const record = JSON.parse(new TextDecoder().decode(await source.read(0, source.descriptor.size)));
    expect(record).toEqual({ version: 1, fetchedAt: 1000, catalog: smallCatalog });
    instance.stop();
  });
  test('network failure preserves the last version', async () => {
    let fail = false;
    const { instance, store } = manager(new MemoryStorage(), (async () => {
      if (fail) throw new Error('offline'); return Response.json(smallCatalog);
    }) as typeof fetch);
    await instance.start(); await instance.refresh(); fail = true; await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 1, state: 'stale', lastError: 'network' });
    expect(store.current()!.descriptor.version).toBe(1); instance.stop();
  });
  test('metadata write failure cannot split published and locally priced versions or poison retries', async () => {
    const storage = new MemoryStorage(); const { instance, store } = manager(storage, okFetch(smallCatalog));
    await instance.start(); await instance.refresh(); storage.failStatus = true;
    await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 2, lastSuccessAt: 1001, lastError: 'storage' });
    expect(store.current()!.descriptor.version).toBe(2);
    storage.failStatus = false; await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 3, lastSuccessAt: 1002, lastError: null });
    expect(store.current()!.descriptor.version).toBe(3); instance.stop();
  });
  test('failed snapshot commit keeps the old view and the retry can reuse the uncommitted version', async () => {
    const { instance, store, injection } = manager(new MemoryStorage(), okFetch(smallCatalog));
    await instance.start(); await instance.refresh(); injection.failPublish = true; await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 1, lastError: 'snapshot' });
    expect(store.current()!.descriptor.version).toBe(1);
    injection.failPublish = false; await instance.refresh();
    expect(instance.statusSnapshot()).toMatchObject({ version: 2, lastError: null }); instance.stop();
  });
  test('restart restores the committed snapshot even when status metadata is stale', async () => {
    const storage = new MemoryStorage();
    storage.values.set('catalog:settings:v2', { autoRefresh: true, intervalHours: 2, timeoutSeconds: 15 });
    const first = manager(storage, okFetch(smallCatalog));
    await first.instance.start(); await first.instance.refresh(); first.instance.stop();
    storage.values.set('catalog:status:v1', { lastSuccessAt: 0 });
    const second = manager(storage, okFetch({}), first.store); await second.instance.start();
    expect(second.instance.statusSnapshot()).toMatchObject({ version: 1, lastSuccessAt: 1000, modelCount: 1,
      settings: { intervalHours: 2 }, nextRefreshAt: 1000 + 2 * 60 * 60 * 1000 });
    expect(second.published).toEqual([]); second.instance.stop();
  });
  test('imports a legacy KV only once, then ignores it', async () => {
    const storage = new MemoryStorage();
    storage.values.set('catalog:v1', { version: 7, fetchedAt: 50, catalog: smallCatalog });
    const first = manager(storage, okFetch(smallCatalog)); await first.instance.start();
    expect(first.store.current()!.descriptor.version).toBe(7); first.instance.stop();
    storage.values.set('catalog:v1', { invalid: true });
    const second = manager(storage, okFetch({}), first.store); await second.instance.start();
    expect(second.instance.statusSnapshot()).toMatchObject({ version: 7, lastSuccessAt: 50, lastError: null });
    second.instance.stop();
  });
  test('corrupt persisted snapshot never falls back to a valid but different KV', async () => {
    const storage = new MemoryStorage(); const store = snapshotStore();
    store.publish(8, { version: 9, fetchedAt: 50, catalog: smallCatalog });
    storage.values.set('catalog:v1', { version: 7, fetchedAt: 50, catalog: smallCatalog });
    const { instance } = manager(storage, okFetch(smallCatalog), store); await instance.start();
    expect(instance.statusSnapshot()).toMatchObject({ state: 'failed', version: null, lastError: 'snapshot' });
    expect(store.current()!.descriptor.version).toBe(8); instance.stop();
  });
  test('rejects invalid settings without changing persisted settings', async () => {
    const { instance } = manager(new MemoryStorage(), okFetch(smallCatalog)); await instance.start();
    await expect(instance.configure({ autoRefresh: true, intervalHours: 0, timeoutSeconds: 15 })).rejects.toThrow('invalid_input');
    await expect(instance.configure({ autoRefresh: true, intervalHours: 1.5, timeoutSeconds: 15 })).rejects.toThrow('invalid_input');
    await expect(instance.configure({ autoRefresh: true, intervalHours: 25, timeoutSeconds: 15 })).rejects.toThrow('invalid_input');
    await expect(instance.configure({ autoRefresh: true, intervalHours: 24, timeoutSeconds: 15.5 })).rejects.toThrow('invalid_input');
    await expect(instance.configure({ autoRefresh: false, intervalHours: 5, timeoutSeconds: 120 })).resolves.toMatchObject({ settings: { timeoutSeconds: 120 } });
    instance.stop();
  });
  test('worker keeps its last complete catalog on invalid content or a version mismatch', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 3, fetchedAt: 50, catalog: smallCatalog }));
    const view = new CatalogView();
    const descriptor = { owner: 'models-dev', epoch: 1, version: 3, schemaVersion: 1, digest: 'sha256:fixture' as const, size: bytes.length, chunkBytes: 60000 };
    expect(reconcileCatalogView({ descriptor, bytes }, view)).toBe('applied');
    expect(reconcileCatalogView({ descriptor: { ...descriptor, version: 4 }, bytes }, view)).toBe('failed');
    expect(view.status()).toMatchObject({ state: 'stale', version: 3, modelCount: 1 });
    expect(reconcileCatalogView(null, view)).toBe('failed');
    expect(view.status().version).toBe(3);
  });
  test('controls and version change only when the same full catalog commits', async () => {
    const catalog = structuredClone(smallCatalog);
    Object.assign(catalog.openai.models['gpt-4o'], { reasoning: true, reasoning_options: [{ type: 'toggle' }] });
    const { instance, store, injection } = manager(new MemoryStorage(), okFetch(catalog));
    const service = capabilitiesServiceOf(instance.view);
    try {
      await instance.start(); await instance.refresh();
      expect(service.model({ provider: 'openai', model: 'gpt-4o' })).toMatchObject({
        catalogVersion: 1, reasoningOptions: [{ type: 'toggle' }], reasoningOptionsStatus: 'known',
      });
      Object.assign(catalog.openai.models['gpt-4o'], { name: 'Updated', reasoning_options: [{ type: 'effort', values: ['high'] }] });
      injection.failPublish = true; await instance.refresh();
      expect(service.model({ provider: 'openai', model: 'gpt-4o' })).toMatchObject({
        name: 'GPT-4o', catalogVersion: 1, reasoningOptions: [{ type: 'toggle' }],
      });
      expect(store.current()!.descriptor.version).toBe(1);
      injection.failPublish = false; await instance.refresh();
      expect(service.model({ provider: 'openai', model: 'gpt-4o' })).toMatchObject({
        name: 'Updated', catalogVersion: 2, reasoningOptions: [{ type: 'effort', values: ['high'] }],
      });
      expect(store.current()!.descriptor.version).toBe(2);
    } finally { await instance.stop(); }
  });
  test('real control and worker publish the same capability contract with no request-time fetch', async () => {
    const store = snapshotStore();
    const catalog = structuredClone(smallCatalog);
    Object.assign(catalog.openai.models['gpt-4o'], { reasoning: true, reasoning_options: [
      { type: 'effort', values: [null, 'default', 'high'] }, { type: 'toggle' }, { type: 'budget_tokens', min: -1, max: 4096 },
    ] });
    store.publish(1, { version: 1, fetchedAt: 50, catalog });
    const controlServices = new Map<string, unknown>(), workerServices = new Map<string, unknown>();
    let fetchCount = 0, current: PluginChannelSnapshotRead | null = null;
    let applied: (snapshot: PluginChannelSnapshotRead | null) => void = () => {};
    let subscriberStopped = false, timerStopped = false;
    const control = createControl({ storage: new MemoryStorage(), signal: new AbortController().signal,
      services: { publish: (id: string, _version: number, value: unknown) => controlServices.set(id, value),
        snapshot: { store: () => store, provide: () => {} },
      },
    } as unknown as ControlHostContext, {
      fetch: (async () => { fetchCount++; throw new Error('fixture forbids network'); }) as typeof fetch,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>, cancel: () => {},
    });
    const worker = new ModelsDevPlugin();
    try {
      await control.start!();
      await worker.init!({ logger: { info() {}, warn() {} }, services: {
        publish: (id: string, _version: number, value: unknown) => workerServices.set(id, value), onDispose: () => {},
        snapshot: { consume: () => ({
          current: () => current,
          onApplied: (listener: typeof applied) => { applied = listener; return () => { subscriberStopped = true; }; },
          sync: async () => {
            const source = store.current()!;
            current = { descriptor: source.descriptor, bytes: await source.read(0, source.descriptor.size) };
            applied(current);
          },
          status: () => ({ status: 'ready', error: null }),
          start: () => () => { timerStopped = true; },
        }) },
      } } as unknown as PluginInitContext);
      const controlService = controlServices.get(MODELS_DEV_CAPABILITIES_SERVICE_ID) as ModelsDevCapabilitiesService;
      const workerService = workerServices.get(MODELS_DEV_CAPABILITIES_SERVICE_ID) as ModelsDevCapabilitiesService;
      for (let read = 0; read < 3; read++) {
        const input = { provider: 'openai', model: 'gpt-4o' };
        expect(workerService.model(input)).toEqual(controlService.model(input));
        expect(workerService.model(input)).toMatchObject({ catalogVersion: 1, reasoningOptionsStatus: 'known',
          reasoningOptions: [{ type: 'effort', values: [null, 'default', 'high'] }, { type: 'toggle' },
            { type: 'budget_tokens', min: -1, max: 4096 }],
        });
      }
      expect(fetchCount).toBe(0);
    } finally { await worker.onDestroy!(); await control.dispose!(); }
    expect(subscriberStopped).toBe(true); expect(timerStopped).toBe(true);
  });
});
