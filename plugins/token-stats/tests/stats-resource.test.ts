import { expect, test } from 'bun:test';
import { createStatsResource, type StatsResponse, type StatsState } from '../ui/stats-resource';
const data: StatsResponse = { groupBy: 'model', estimatedCostUsd: null, data: [] };

test('subscribers share a pending read and the last unsubscribe aborts it', async () => {
  let calls = 0, stopped = 0;
  let signal: AbortSignal | undefined;
  let resolve!: (data: StatsResponse) => void;
  const resource = createStatsResource(requestSignal => {
    calls++; signal = requestSignal;
    return new Promise(done => { resolve = done; });
  }, () => { stopped++; });
  const first: StatsState[] = [], second: StatsState[] = [];
  const stopFirst = resource.subscribe(state => first.push(state));
  const stopSecond = resource.subscribe(state => second.push(state));
  await Promise.resolve();
  expect(calls).toBe(1);
  const refreshing = resource.refresh();
  resolve(data); await refreshing;
  expect(calls).toBe(1);
  expect(first.at(-1)?.data).toBe(data);
  expect(second.at(-1)?.data).toBe(data);
  stopFirst(); expect(signal?.aborted).toBe(false);
  stopSecond(); expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(1);
});

test('a failed refresh keeps the last snapshot and retry clears the error', async () => {
  let fail = false;
  const resource = createStatsResource(async () => { if (fail) throw new Error('offline'); return data; });
  let state: StatsState | undefined;
  const stop = resource.subscribe(next => { state = next; });
  try {
    await resource.refresh();
    fail = true; await resource.refresh();
    expect(state?.data).toBe(data);
    expect(state?.error).toBe('offline');
    fail = false; await resource.refresh();
    expect(state?.error).toBe(''); expect(state?.busy).toBe(false);
  } finally { stop(); }
});

test('late responses after unsubscribe do not publish to a new subscription', async () => {
  const resolves: ((data: StatsResponse) => void)[] = [];
  const resource = createStatsResource(() => new Promise(resolve => resolves.push(resolve)));
  const stop = resource.subscribe(() => {});
  await Promise.resolve(); stop();
  let state: StatsState | undefined;
  const stopAgain = resource.subscribe(next => { state = next; });
  try {
    await Promise.resolve();
    resolves[0]({ ...data, estimatedCostUsd: 123 });
    await Promise.resolve(); await Promise.resolve();
    expect(state?.data).toBeNull();
    const pending = resource.refresh(); resolves[1](data); await pending;
    expect(state?.data).toBe(data);
  } finally { stopAgain(); }
});
