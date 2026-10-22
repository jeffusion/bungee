import { afterEach, describe, expect, test } from 'bun:test';
import type { ControlApiHandlerContext, ControlHostContext, PluginControl, PluginStorage } from '@jeffusion/bungee-core/plugin';
import { createControl } from '../../server/control';
import { controlHost, createStorage, deferred } from '../helpers/context';

const stores: ReturnType<typeof createStorage>[] = [];
const controls: PluginControl[] = [];
afterEach(async () => { for (const control of controls.splice(0)) await control.dispose(); for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = createStorage(); stores.push(store);
  const abort = new AbortController(); const host = controlHost(store.storage, abort.signal);
  const control = createControl(host); controls.push(control);
  return { ...store, host, control, abort };
}
function invoke(control: PluginControl, host: ControlHostContext, query = '', requestSignal = new AbortController().signal) {
  const request = new Request(`http://localhost/stats${query}`, { signal: requestSignal });
  return Promise.resolve(control.api[0]!.invoke({ ...host, request, requestSignal } as ControlApiHandlerContext));
}

describe('TPS control API', () => {
  test('queries default window and merges persisted reporting status through strict read', async () => {
    const { storage, adapter, host, control } = setup();
    await adapter.recordSample({ attemptId: 'sample', requestId: 'request', routeId: 'route', endpointId: 'endpoint', upstreamHost: 'api.test:8443', model: 'model', finishedAtMs: Date.now(), outputTokens: 200, generationDurationMs: 1000, outputSource: 'estimated' });
    await storage.set('reporting:incomplete', true);
    storage.get = async () => { throw new Error('must use strict read'); };
    const response = await invoke(control, host);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ range: '24h', total: { tps: 200, sampleCount: 1, estimatedSampleCount: 1 },
      endpoints: [{ routeId: 'route', upstreamHost: 'api.test:8443', tps: 200, sampleCount: 1 }],
      models: [{ routeId: 'route', model: 'model', tps: 200, sampleCount: 1, estimatedSampleCount: 1 }], reportingIncomplete: true });
  });
  test.each(['?range=2h', '?range=', '?range=1h&range=1h', '?range=1h&range=24h', '?unknown=1'])('rejects invalid query %s', async query => {
    const { control, host } = setup(); expect((await invoke(control, host, query)).status).toBe(400);
  });
  test.each(['1h', '12h', '24h'])('accepts range %s', async range => {
    const { control, host } = setup(); const response = await invoke(control, host, `?range=${range}`);
    expect(response.status).toBe(200); expect((await response.json()).range).toBe(range);
  });
  test('rejects incorrect method', async () => {
    const { control, host } = setup();
    const response = await control.api[0]!.invoke({ ...host, request: new Request('http://localhost/stats', { method: 'POST' }), requestSignal: new AbortController().signal });
    expect(response.status).toBe(405);
  });
  test('returns storage error instead of successful empty stats', async () => {
    const { storage, control, host } = setup();
    storage.invokeObservation = async () => { throw new Error('query failure'); };
    // The production client captures the capability once, so create after replacing it.
    const failed = createControl(host); controls.push(failed);
    const response = await invoke(failed, host); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage_unavailable' });
    await control.dispose();
  });
  test.each(['throws', 'invalid'] as const)('does not hide strict flag read %s', async mode => {
    const { storage, control, host } = setup();
    storage.readStrict = async () => { if (mode === 'throws') throw new Error('state failure'); return { found: true, value: 'yes' } as never; };
    expect((await invoke(control, host)).status).toBe(503);
  });
  test('supports the documented optional strict-read capability', async () => {
    const { storage, host } = setup();
    const fallback = { ...storage, readStrict: undefined, get: storage.get.bind(storage), invokeObservation: storage.invokeObservation.bind(storage) } as unknown as PluginStorage;
    await storage.set('reporting:incomplete', true);
    const control = createControl({ ...host, storage: fallback }); controls.push(control);
    const response = await invoke(control, host); expect((await response.json()).reportingIncomplete).toBe(true);
  });
  test('cancels pending query when request aborts', async () => {
    const { storage, host } = setup(); const gate = deferred<never>(); storage.invokeObservation = async () => gate.promise;
    const control = createControl(host); controls.push(control); const request = new AbortController();
    const response = invoke(control, host, '', request.signal); request.abort();
    expect((await response).status).toBe(400);
  });
  test('cancels pending query when host disposes', async () => {
    const { storage, host, abort } = setup(); const gate = deferred<never>(); storage.invokeObservation = async () => gate.promise;
    const control = createControl(host); controls.push(control);
    const response = invoke(control, host); abort.abort(); expect((await response).status).toBe(409);
  });
  test('cancels pending query on explicit disposal', async () => {
    const { storage, host } = setup(); const gate = deferred<never>(); storage.invokeObservation = async () => gate.promise;
    const control = createControl(host); controls.push(control);
    const response = invoke(control, host); await control.dispose(); expect((await response).status).toBe(409);
  });
  test('rejects work after disposal and after host cancellation', async () => {
    const { control, host, abort } = setup(); await control.dispose();
    expect((await invoke(control, host)).status).toBe(409);
    abort.abort(); expect(() => control.start()).toThrow('disposed');
  });
  test('rejects a missing observation capability at startup', () => {
    expect(() => createControl(controlHost({} as PluginStorage))).toThrow('observation storage is unavailable');
  });
});
