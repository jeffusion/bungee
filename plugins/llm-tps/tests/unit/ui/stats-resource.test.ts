import { expect, test } from 'bun:test';
import type { TpsRange, TpsStatsResponse } from '../../../contract';
import { createTpsResources, validateStats, type TpsState } from '../../../ui/stats-resource';
import { endpointIdentity, endpointLabel, formatTps, rankedEndpoints, rankedModels } from '../../../ui/presentation';

function stats(range: TpsRange = '24h'): TpsStatsResponse {
  return { range, asOfMs: 1000, total: { tps: 20, outputTokens: 100, generationDurationMs: 5000,
    sampleCount: 2, estimatedSampleCount: 1 }, endpoints: [], models: [], history: [], reportingIncomplete: false };
}

test('plugin/range subscribers share requests, manual refreshes and one polling timer', async () => {
  const requests: { plugin: string; range: TpsRange; signal: AbortSignal; resolve: (data: TpsStatsResponse) => void }[] = [];
  const polls = new Set<() => void>();
  const resources = createTpsResources((plugin, range, signal) => new Promise(resolve => {
    requests.push({ plugin, range, signal, resolve });
  }), refresh => { polls.add(refresh); return () => { polls.delete(refresh); }; });
  const resource = resources.get('llm-tps', '24h');
  expect(resources.get('llm-tps', '24h')).toBe(resource);
  expect(resources.get('other', '24h')).not.toBe(resource);
  let state: TpsState | undefined;
  const stopFirst = resource.subscribe(next => { state = next; });
  const stopSecond = resource.subscribe(() => {});
  const stopThird = resource.subscribe(() => {});
  try {
    await Promise.resolve();
    expect(requests.length).toBe(1); expect(polls.size).toBe(1);
    const first = resource.refresh();
    expect(resource.refresh()).toBe(first);
    requests[0]!.resolve(stats()); await first;
    expect(state?.data?.total.tps).toBe(20);
    for (const tick of polls) tick();
    await Promise.resolve();
    expect(requests.length).toBe(2);
    stopFirst(); expect(requests[1]!.signal.aborted).toBe(false);
    stopSecond(); expect(requests[1]!.signal.aborted).toBe(false);
    stopThird(); expect(requests[1]!.signal.aborted).toBe(true);
    expect(polls.size).toBe(0);
    expect(resources.get('llm-tps', '24h')).not.toBe(resource);
    requests[1]!.resolve(stats());
  } finally { stopFirst(); stopSecond(); stopThird(); }
});

test('range changes and late cancelled responses cannot overwrite the new resource', async () => {
  const pending = new Map<TpsRange, (data: TpsStatsResponse) => void>();
  const signals = new Map<TpsRange, AbortSignal>();
  const resources = createTpsResources((_plugin, range, signal) => {
    signals.set(range, signal); return new Promise(resolve => pending.set(range, resolve));
  }, () => () => {});
  let oldState: TpsState | undefined, nextState: TpsState | undefined;
  const first = resources.get('llm-tps', '24h');
  const stopFirst = first.subscribe(next => { oldState = next; });
  await Promise.resolve(); stopFirst();
  const next = resources.get('llm-tps', '1h');
  const stopNext = next.subscribe(value => { nextState = value; });
  try {
    await Promise.resolve();
    expect(signals.get('24h')?.aborted).toBe(true);
    const ready = next.refresh(); pending.get('1h')!(stats('1h')); await ready;
    pending.get('24h')!(stats('24h')); await first.refresh();
    await Promise.resolve();
    expect(nextState?.data?.range).toBe('1h');
    expect(oldState?.data).toBeNull();
  } finally { stopNext(); }
});

test('failed and invalid refreshes clear the current value and successful retry recovers', async () => {
  let data = stats(), fail = false;
  const resources = createTpsResources(async () => { if (fail) throw new Error('offline'); return data; }, () => () => {});
  const resource = resources.get('llm-tps', '24h');
  let state: TpsState | undefined;
  const stop = resource.subscribe(value => { state = value; });
  try {
    await resource.refresh(); expect(state?.data?.total.tps).toBe(20);
    fail = true; await resource.refresh(); expect(state).toEqual({ data: null, busy: false, error: true });
    fail = false; data = { ...stats(), total: { ...stats().total, tps: Infinity } };
    await resource.refresh(); expect(state?.data).toBeNull(); expect(state?.error).toBe(true);
    data = stats(); await resource.refresh(); expect(state?.error).toBe(false); expect(state?.data).toBe(data);
  } finally { stop(); }
});

test('last unsubscribe removes the snapshot and an old completion cannot publish after resubscribe', async () => {
  const pending: ((data: TpsStatsResponse) => void)[] = [];
  const resources = createTpsResources(() => new Promise(resolve => pending.push(resolve)), () => () => {});
  const resource = resources.get('llm-tps', '24h');
  const stop = resource.subscribe(() => {}); await Promise.resolve(); stop();
  let state: TpsState | undefined;
  const stopAgain = resource.subscribe(value => { state = value; });
  try {
    await Promise.resolve();
    pending[0]!(stats()); await Promise.resolve(); await Promise.resolve();
    expect(state?.data).toBeNull();
    const ready = resource.refresh(); pending[1]!(stats()); await ready;
    expect(state?.data?.range).toBe('24h');
  } finally { stopAgain(); }
});

test('finite values, range identity and estimated sample counts are validated', () => {
  expect(validateStats(stats(), '24h')).toEqual(stats());
  expect(() => validateStats(stats('1h'), '24h')).toThrow();
  const point = { ...stats().total, bucketStartMs: 0 };
  expect(() => validateStats({ ...stats(), history: [point, point] }, '24h')).toThrow();
  expect(() => validateStats({ ...stats(), history: [{ ...point, tps: Infinity }] }, '24h')).toThrow();
  expect(() => validateStats({ ...stats(), history: [{ ...point, bucketStartMs: -1 }] }, '24h')).toThrow();
  for (const patch of [{ tps: NaN }, { generationDurationMs: Infinity }, { sampleCount: -1 }, { estimatedSampleCount: 3 }]) {
    expect(() => validateStats({ ...stats(), total: { ...stats().total, ...patch } }, '24h')).toThrow();
  }
  for (const invalid of [NaN, Infinity, -1, null, undefined]) expect(formatTps(invalid)).toBe('—');
  expect(endpointIdentity('endpoint-abcdef1234567890')).toBe('endpoint-abcdef1234567890');
  expect(endpointIdentity('https://secret.example/path?key=secret')).toBe('endpoint');
  expect(endpointLabel('https://user:secret@api.example.com:8443/private?key=secret', 'endpoint-id')).toBe('api.example.com:8443');
  expect(endpointLabel(undefined, 'd541d5a5-d009-43ee-8d56-7cc4cc5c4084')).toBe('endpoint · d541d5a5');
  expect(endpointLabel('data:text/plain,secret', 'endpoint-id')).toBe('endpoint · endpoint');
  const row = { ...stats().total, routeId: 'route', endpointId: 'endpoint' };
  expect(rankedEndpoints([{ ...row, endpointId: 'slow', tps: 10 }, { ...row, endpointId: 'fast', tps: 30 },
    { ...row, endpointId: 'empty', tps: null }]).map(item => item.endpointId)).toEqual(['fast', 'slow', 'empty']);
});

test('model identities and aggregates are validated and ranked independently per route', () => {
  const row = { ...stats().total, routeId: 'a', model: 'shared' };
  const data = { ...stats(), models: [row] };
  expect(validateStats(data, '24h')).toBe(data);
  for (const patch of [{ model: '' }, { model: null }, { routeId: ' ' }, { tps: Infinity }, { estimatedSampleCount: 3 }]) {
    expect(() => validateStats({ ...stats(), models: [{ ...row, ...patch }] } as TpsStatsResponse, '24h')).toThrow();
  }
  expect(() => validateStats({ ...stats(), models: undefined } as unknown as TpsStatsResponse, '24h')).toThrow();
  expect(rankedModels([{ ...row, routeId: 'b', tps: 30 }, { ...row, model: 'slow', tps: 10 }, { ...row, tps: 30 }])
    .map(item => [item.routeId, item.model])).toEqual([['a', 'shared'], ['b', 'shared'], ['a', 'slow']]);
});
