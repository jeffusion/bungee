import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TPS_RETENTION_MS, type TpsSample } from '../../contract';
import { createObservationAdapter } from '../../server/storage';
import { createStorage } from '../helpers/context';

const stores: ReturnType<typeof createStorage>[] = [];
const directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function store() { const value = createStorage(); stores.push(value); return value; }
function sample(patch: Partial<TpsSample> = {}): TpsSample {
  return { attemptId: 'attempt', requestId: 'request', routeId: 'route', endpointId: 'endpoint', model: 'model-shared', finishedAtMs: Date.now(), outputTokens: 100,
    generationDurationMs: 1000, outputSource: 'official', ...patch };
}

describe('TPS observation storage', () => {
  test('weights by duration, counts estimates, and sorts by descending TPS with stable ties', async () => {
    const { adapter } = store(); const now = Date.now();
    await adapter.recordSample(sample({ attemptId: 'a', endpointId: 'slow', outputTokens: 100, generationDurationMs: 1000, finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'b', endpointId: 'slow', outputTokens: 300, generationDurationMs: 9000, outputSource: 'estimated', finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'c', endpointId: 'fast', finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'd', endpointId: 'alpha', finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'e', endpointId: 'fast', routeId: 'aaa', finishedAtMs: now }));
    const stats = await adapter.queryStats({ range: '24h', asOfMs: now });
    expect(stats.total).toMatchObject({ outputTokens: 700, generationDurationMs: 13000, sampleCount: 5, estimatedSampleCount: 1 });
    expect(stats.total.tps!).toBeCloseTo(700 / 13, 10);
    expect(stats.endpoints.map(row => [row.routeId, row.endpointId, row.tps])).toEqual([
      ['aaa', 'fast', 100], ['route', 'alpha', 100], ['route', 'fast', 100], ['route', 'slow', 40],
    ]);
  });
  test.each(['1h', '12h', '24h'] as const)('uses inclusive %s boundaries and excludes future samples', async range => {
    const { adapter } = store(); const now = Date.now(); const hours = range === '1h' ? 1 : range === '12h' ? 12 : 24;
    const start = now - hours * 3600000;
    for (const [index, finishedAtMs] of [start - 1, start, now, now + 1].entries()) await adapter.recordSample(sample({ attemptId: `${index}`, finishedAtMs }));
    const stats = await adapter.queryStats({ range, asOfMs: now });
    expect(stats.total.sampleCount).toBe(2);
    expect(stats.models[0]!.sampleCount).toBe(2);
  });
  test('deduplicates across adapters sharing the database', async () => {
    const { access, adapter } = store(); const other = createObservationAdapter({ withDatabase: operation => operation(access) }); const now = Date.now();
    await Promise.all([adapter.recordSample(sample({ finishedAtMs: now })), other.recordSample(sample({ outputTokens: 999, finishedAtMs: now }))]);
    const stats = await other.queryStats({ range: '1h', asOfMs: now });
    expect(stats.total.outputTokens).toBe(100);
    expect(stats.models[0]).toMatchObject({ model: 'model-shared', outputTokens: 100, sampleCount: 1 });
  });
  test.each(['1h', '12h', '24h'] as const)('returns weighted %s history with gaps and inclusive window boundaries', async range => {
    const { adapter } = store();
    const bucketMs = range === '1h' ? 60000 : range === '12h' ? 1800000 : 3600000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs + 1000;
    const hours = range === '1h' ? 1 : range === '12h' ? 12 : 24;
    const start = now - hours * 3600000;
    for (const [attemptId, finishedAtMs, outputTokens, generationDurationMs] of [
      ['before', start - 1, 999, 1000], ['boundary', start, 20, 1000],
      ['a', now - bucketMs, 100, 1000], ['b', now - bucketMs, 300, 9000],
      ['current', now, 75, 1000], ['future', now + 1, 999, 1000],
    ] as const) await adapter.recordSample(sample({ attemptId, finishedAtMs, outputTokens, generationDurationMs }));
    const { history } = await adapter.queryStats({ range, asOfMs: now });
    expect(history[0]).toMatchObject({ bucketStartMs: Math.floor(start / bucketMs) * bucketMs, tps: 20, sampleCount: 1 });
    expect(history[1]).toMatchObject({ tps: null, sampleCount: 0 });
    expect(history.at(-2)).toMatchObject({ tps: 40, sampleCount: 2 });
    expect(history.at(-1)).toMatchObject({ bucketStartMs: Math.floor(now / bucketMs) * bucketMs, tps: 75, sampleCount: 1 });
    expect(history.reduce((sum, point) => sum + point.sampleCount, 0)).toBe(4);
  });
  test('persists samples and incomplete reporting across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bungee-tps-')); directories.push(directory);
    const accessPath = join(directory, 'access.db'), statePath = join(directory, 'plugin-state.db');
    const first = createStorage(new Database(accessPath), new Database(statePath));
    const now = Date.now();
    try { await first.adapter.recordSample(sample({ finishedAtMs: now })); await first.storage.set('reporting:incomplete', true); } finally { first.close(); }
    const reopened = createStorage(new Database(accessPath), new Database(statePath)); stores.push(reopened);
    const stats = await reopened.adapter.queryStats({ range: '24h', asOfMs: now });
    expect(stats.total.sampleCount).toBe(1);
    expect(stats.models[0]).toMatchObject({ model: 'model-shared', sampleCount: 1 });
    expect(await reopened.storage.readStrict('reporting:incomplete')).toEqual({ found: true, value: true });
  });
  test('cleans at most 500 expired rows per transaction', async () => {
    const { access, adapter } = store(); const expired = Date.now() - TPS_RETENTION_MS - 10000;
    const insert = access.query('INSERT INTO llm_tps_samples (attempt_id,request_id,route_id,endpoint_id,finished_at_ms,output_tokens,generation_duration_ms,output_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    access.transaction(() => { for (let index = 0; index < 501; index++) insert.run(`expired-${index}`, 'r', 'route', 'endpoint', expired, 1, 100, 'official'); })();
    await adapter.recordSample(sample());
    expect(access.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM llm_tps_samples').get()!.count).toBe(2);
  });
  test('returns null for empty window and zero for a valid zero output', async () => {
    const { adapter } = store(); const now = Date.now();
    expect((await adapter.queryStats({ range: '24h', asOfMs: now })).total.tps).toBeNull();
    await adapter.recordSample(sample({ outputTokens: 0, finishedAtMs: now }));
    expect((await adapter.queryStats({ range: '24h', asOfMs: now })).total.tps).toBe(0);
  });
  test('rejects unsafe records and corrupted persisted aggregates', async () => {
    const { access, adapter } = store(); const now = Date.now();
    await expect(adapter.recordSample(sample({ outputTokens: Number.MAX_SAFE_INTEGER + 1 }))).rejects.toThrow();
    await adapter.recordSample(sample({ outputTokens: Number.MAX_SAFE_INTEGER, finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'overflow', outputTokens: 1, finishedAtMs: now }));
    await expect(adapter.queryStats({ range: '24h', asOfMs: now })).rejects.toThrow();
    access.run('DELETE FROM llm_tps_samples');
    await adapter.recordSample(sample({ finishedAtMs: now }));
    access.run('PRAGMA ignore_check_constraints = ON');
    try { access.run('UPDATE llm_tps_samples SET generation_duration_ms = -1'); }
    finally { access.run('PRAGMA ignore_check_constraints = OFF'); }
    await expect(adapter.queryStats({ range: '24h', asOfMs: now })).rejects.toThrow();
  });
  test('models weight across endpoints, isolate routes, omit unknown identities and preserve attempt deduplication', async () => {
    const { adapter, access } = store(); const now = Date.now();
    await adapter.recordSample(sample({ attemptId: 'a', endpointId: 'first', finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'b', endpointId: 'second', outputTokens: 300, generationDurationMs: 9000, outputSource: 'estimated', finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'c', routeId: 'other', outputTokens: 90, finishedAtMs: now }));
    await adapter.recordSample(sample({ attemptId: 'd', model: 'model-fast', outputTokens: 150, finishedAtMs: now }));
    // An existing row with no model remains in total and endpoint aggregates.
    access.run('INSERT INTO llm_tps_samples (attempt_id,request_id,route_id,endpoint_id,finished_at_ms,output_tokens,generation_duration_ms,output_source) VALUES (?,?,?,?,?,?,?,?)',
      ['unknown', 'request', 'route', 'endpoint', now, 999, 1000, 'official']);
    await adapter.recordSample(sample({ attemptId: 'a', model: 'different', outputTokens: 999, finishedAtMs: now }));
    const stats = await adapter.queryStats({ range: '1h', asOfMs: now });
    expect(stats.models.map(row => [row.routeId, row.model, row.tps, row.sampleCount, row.estimatedSampleCount])).toEqual([
      ['route', 'model-fast', 150, 1, 0], ['other', 'model-shared', 90, 1, 0], ['route', 'model-shared', 40, 2, 1],
    ]);
    expect(stats.total.sampleCount).toBe(5);
    expect(stats.endpoints.reduce((sum, row) => sum + row.sampleCount, 0)).toBe(5);
  });
  test('models retain zero speeds, sort ties deterministically and reject invalid model names', async () => {
    const { adapter } = store(); const now = Date.now();
    for (const [attemptId, routeId, model, outputTokens] of [
      ['a', 'a', 'beta', 100], ['b', 'a', 'alpha', 100], ['c', 'b', 'alpha', 100], ['z', 'a', 'zero', 0],
    ] as const) await adapter.recordSample(sample({ attemptId, routeId, model, outputTokens, finishedAtMs: now }));
    expect((await adapter.queryStats({ range: '1h', asOfMs: now })).models.map(row => [row.routeId, row.model, row.tps])).toEqual([
      ['a', 'alpha', 100], ['a', 'beta', 100], ['b', 'alpha', 100], ['a', 'zero', 0],
    ]);
    await expect(adapter.recordSample(sample({ model: ' ' }))).rejects.toThrow();
  });
});
