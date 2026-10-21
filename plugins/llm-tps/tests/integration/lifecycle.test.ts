import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginScopeInfo, PluginStorage } from '@jeffusion/bungee-core/plugin';
import LlmTpsPlugin from '../../server/index';
import { createStorage, deferred, meteringContext, result } from '../helpers/context';

const stores: ReturnType<typeof createStorage>[] = [];
const plugins: InstanceType<typeof LlmTpsPlugin>[] = [];
afterEach(async () => { for (const plugin of plugins.splice(0)) await plugin.onDestroy(); for (const store of stores.splice(0)) store.close(); });
function store() { const value = createStorage(); stores.push(value); return value; }
function plugin() { const value = new LlmTpsPlugin(); plugins.push(value); return value; }

describe('route-bound TPS reporting', () => {
  test.each([undefined, { type: 'global' }, { type: 'service', routeId: 'route-a' }, { type: 'upstream', routeId: 'route-a' }, { type: 'route' }] as Array<PluginScopeInfo | undefined>)('rejects unsupported binding %j', async scope => {
    const { storage } = store(); const fixture = meteringContext(storage); fixture.context.scope = scope;
    await expect(plugin().init(fixture.context)).rejects.toThrow('requires a route binding');
    expect(fixture.subscriptions.size).toBe(0);
  });
  test('fails explicitly without observation capability', async () => {
    const fixture = meteringContext({} as PluginStorage);
    await expect(plugin().init(fixture.context)).rejects.toThrow('observation storage is unavailable');
  });
  test('filters actual route, excludes non-streaming, hashes URL endpoints, and drains on destroy', async () => {
    const { storage, adapter } = store(); const fixture = meteringContext(storage), instance = plugin(); const now = Date.now();
    await instance.init(fixture.context);
    fixture.emit(result({ routeId: 'other', attemptId: 'other' }));
    fixture.emit(result({ generationDurationMs: undefined, attemptId: 'non-stream' }));
    fixture.emit(result({ upstreamId: 'https://user:secret@example.test/v1', finishedAtMs: now }));
    await instance.onDestroy();
    expect(fixture.subscriptions.size).toBe(0);
    const stats = await adapter.queryStats({ range: '24h', asOfMs: now });
    expect(stats.total.sampleCount).toBe(1);
    expect(stats.endpoints[0]!.endpointId).toBe('endpoint-5faca2ba8e7b52bc');
    fixture.emit(result({ attemptId: 'after-destroy' }));
    expect((await adapter.queryStats({ range: '24h', asOfMs: Date.now() })).total.sampleCount).toBe(1);
  });
  test('two route instances share storage without cross-route duplication', async () => {
    const { storage, adapter } = store(); const a = meteringContext(storage), b = meteringContext(storage, { type: 'route', routeId: 'route-b' });
    const first = plugin(), second = plugin(); await first.init(a.context); await second.init(b.context);
    for (const fixture of [a, b]) { fixture.emit(result()); fixture.emit(result({ routeId: 'route-b', attemptId: 'attempt-b' })); }
    await first.onDestroy(); await second.onDestroy();
    expect((await adapter.queryStats({ range: '24h', asOfMs: Date.now() })).total.sampleCount).toBe(2);
  });
  test('service disposal stops later callbacks while accepted writes drain', async () => {
    const { storage, adapter } = store(); const fixture = meteringContext(storage), instance = plugin(); await instance.init(fixture.context);
    const callback = [...fixture.subscriptions][0]!;
    fixture.emit(result()); fixture.disposeServices();
    await callback.onResult(result({ attemptId: 'after-dispose' })); await instance.onDestroy();
    expect(fixture.subscriptions.size).toBe(0);
    expect((await adapter.queryStats({ range: '24h', asOfMs: Date.now() })).total.sampleCount).toBe(1);
  });
  test('write failure marks persistent incomplete state without throwing through the callback', async () => {
    const { storage } = store(); storage.invokeObservation = async () => { throw new Error('write failed'); };
    const fixture = meteringContext(storage), instance = plugin(); await instance.init(fixture.context);
    expect(() => fixture.emit(result())).not.toThrow(); await instance.onDestroy();
    expect(await storage.get<boolean>('reporting:incomplete')).toBe(true);
  });
  test('observation failures affect only the bound route', async () => {
    const { storage } = store(); const fixture = meteringContext(storage), instance = plugin(); await instance.init(fixture.context);
    fixture.fail(result({ routeId: 'other' })); await Promise.resolve();
    expect(await storage.get('reporting:incomplete')).toBeNull();
    fixture.fail(result()); await instance.onDestroy(); expect(await storage.get<boolean>('reporting:incomplete')).toBe(true);
  });
  test('real incomplete observation results mark the route without a subscription failure', async () => {
    const { storage } = store(); const fixture = meteringContext(storage), instance = plugin(); await instance.init(fixture.context);
    fixture.emit(result({ routeId: 'other', observationIncomplete: true, generationDurationMs: undefined }));
    await Promise.resolve();
    expect(await storage.get('reporting:incomplete')).toBeNull();
    fixture.emit(result({ observationIncomplete: true, generationDurationMs: undefined }));
    await instance.onDestroy();
    expect(await storage.get('reporting:incomplete')).toBe(true);
  });
  test('a later failure retries incomplete status after a transient status write failure', async () => {
    const { storage } = store(); const fixture = meteringContext(storage), instance = plugin();
    const set = storage.set.bind(storage); let attempts = 0;
    storage.uncached = () => storage;
    storage.set = async (...args) => { if (++attempts === 1) throw new Error('temporarily unavailable'); await set(...args); };
    await instance.init(fixture.context);
    fixture.emit(result({ observationIncomplete: true, generationDurationMs: undefined }));
    await Bun.sleep(0);
    fixture.emit(result({ observationIncomplete: true, generationDurationMs: undefined }));
    await instance.onDestroy();
    expect(attempts).toBe(2);
    expect(await storage.get('reporting:incomplete')).toBe(true);
  });
  test('bounds accepted writes to 256 and destroy waits for pending writes', async () => {
    const { storage, adapter } = store(); const gate = deferred<void>(); const invoke = storage.invokeObservation.bind(storage);
    storage.invokeObservation = async (operation, args) => { if (operation === 'recordSample') await gate.promise; return invoke(operation, args); };
    const fixture = meteringContext(storage), instance = plugin(); await instance.init(fixture.context);
    for (let index = 0; index < 257; index++) fixture.emit(result({ attemptId: `attempt-${index}` }));
    let destroyed = false; const pending = instance.onDestroy().then(() => { destroyed = true; });
    await Promise.resolve(); expect(destroyed).toBe(false); gate.resolve(); await pending;
    expect((await adapter.queryStats({ range: '24h', asOfMs: Date.now() })).total.sampleCount).toBe(256);
    expect(await storage.get<boolean>('reporting:incomplete')).toBe(true);
  });
});
