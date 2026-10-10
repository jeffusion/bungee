import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogQueryService } from '../../../src/api/logs';
import { StatsHandler } from '../../../src/api/handlers/stats';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../../helpers/test-budgets';

const schema = `CREATE TABLE access_logs (
  id INTEGER PRIMARY KEY, request_id TEXT UNIQUE, parent_request_id TEXT,
  timestamp INTEGER, duration INTEGER DEFAULT 10, status INTEGER,
  success INTEGER, protocol_outcome TEXT, request_type TEXT DEFAULT 'final',
  attempt_number INTEGER, upstream TEXT
)`;
const databases: Database[] = [];
const roots: string[] = [];
const base = 60_000;
const target = 'https://chatgpt.com';

afterEach(() => {
  for (const db of databases.splice(0)) db.close(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(path = ':memory:'): Database {
  const db = new Database(path);
  databases.push(db);
  return db;
}

function insert(db: Database, id: string, options: {
  status?: number; success?: number; outcome?: string | null; upstream?: string | null;
  parent?: string; type?: string; attempt?: number; timestamp?: number;
} = {}): void {
  db.run(`INSERT INTO access_logs
    (request_id, timestamp, status, success, protocol_outcome, upstream, parent_request_id, request_type, attempt_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id, options.timestamp ?? base, options.status ?? 200, options.success ?? 1,
    options.outcome ?? null, options.upstream === undefined ? target : options.upstream,
    options.parent ?? null, options.type ?? 'final', options.attempt ?? null,
  ]);
}

function service() {
  const db = database();
  db.exec(schema);
  return { db, query: new LogQueryService(db) };
}

describe('dashboard final outcomes', () => {
  test('counts interrupted streams, HTTP errors and failures after HTTP 200 as failed using the same classifier', async () => {
    const { db, query } = service();
    insert(db, 'completed', { outcome: 'completed' });
    // Protocol results win over a stale success flag in historical records.
    insert(db, 'protocol-error', { outcome: 'failed' });
    insert(db, 'incomplete', { outcome: 'incomplete' });
    insert(db, 'timeout', { outcome: 'failed', success: 0 });
    insert(db, 'cancelled', { outcome: 'cancelled' });
    insert(db, 'http-error', { status: 503, outcome: 'completed' });

    const snapshot = await query.getDashboardStats(base, base + 60_000, 'minute');
    expect(snapshot.timeSeries).toEqual([expect.objectContaining({
      totalRequests: 6, successRequests: 1, failedRequests: 5,
    })]);
    expect(snapshot.upstreams).toEqual([expect.objectContaining({
      totalRequests: 6, successRequests: 1, failedRequests: 5,
      status2xx: 5, status5xx: 1, failed2xx: 4,
      successRate: 16.67, failureRate: 83.33,
    })]);
    await expect(query.getStats(base, base + 60_000)).resolves.toMatchObject({
      totalRequests: 6, successRequests: 1, failedRequests: 5,
    });
    await expect(query.getUpstreamFailureStats(base, base + 60_000)).resolves.toMatchObject([
      { failedRequests: 5 },
    ]);
    await expect(query.getUpstreamStatusCodeStats(base, base + 60_000)).resolves.toMatchObject([
      { status2xx: 5, failed2xx: 4 },
    ]);
  });

  test('distribution filters preserve full outcome totals and rates', async () => {
    const { db, query } = service();
    insert(db, 'ok');
    insert(db, 'failed', { success: 0 });
    insert(db, 'cancel', { outcome: 'cancelled', success: 0 });
    for (const [type, count] of [['all', 3], ['success', 1], ['failure', 2]] as const) {
      await expect(query.getUnifiedUpstreamStats(base, base + 60_000, type)).resolves.toEqual([
        expect.objectContaining({ count, totalRequests: 3, successRequests: 1, failedRequests: 2, failureRate: 66.67 }),
      ]);
    }
  });

  test('counts a retried request once in history and each upstream attempt separately', async () => {
    const { db, query } = service();
    insert(db, 'first', { parent: 'chain', type: 'retry', attempt: 1, status: 503, success: 0 });
    insert(db, 'last', { parent: 'chain', attempt: 2, outcome: 'completed', upstream: 'https://fallback.example' });
    const snapshot = await query.getDashboardStats(base, base + 60_000, 'minute');
    expect(snapshot.timeSeries[0]).toMatchObject({ totalRequests: 1, successRequests: 1, failedRequests: 0 });
    expect(snapshot.upstreams.reduce((sum, row) => sum + row.totalRequests, 0)).toBe(2);
    expect(snapshot.upstreams.reduce((sum, row) => sum + row.failedRequests, 0)).toBe(1);
  });

  test('uses half-open windows, includes failures without an upstream only in client history, and keeps every upstream', async () => {
    const { db, query } = service();
    insert(db, 'before', { timestamp: base - 1 });
    insert(db, 'end', { timestamp: base + 60_000 });
    insert(db, 'no-upstream', { status: 401, success: 0, upstream: null });
    for (let i = 0; i < 12; i++) insert(db, `upstream-${i}`, { upstream: `https://upstream-${i}.example` });
    const snapshot = await query.getDashboardStats(base, base + 60_000, 'minute');
    expect(snapshot.timeSeries[0]).toMatchObject({ totalRequests: 13, failedRequests: 1 });
    expect(snapshot.upstreams).toHaveLength(12);
    expect(snapshot.upstreams.reduce((sum, row) => sum + row.totalRequests, 0)).toBe(12);
  });

  test('one read transaction prevents a concurrent worker write from appearing in only one panel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-dashboard-snapshot-'));
    roots.push(root);
    const path = join(root, 'access.db');
    const db = database(path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(schema);
    insert(db, 'old');
    const writer = database(path);
    const query = new LogQueryService(db);
    const originalQuery = db.query.bind(db);
    let inserted = false;
    const interception = spyOn(db, 'query').mockImplementation((sql: string) => {
      if (!inserted && sql.includes('WITH outcome_rows')) {
        inserted = true;
        insert(writer, 'new', { outcome: 'failed', success: 0 });
      }
      return originalQuery(sql);
    });
    try {
      const snapshot = await query.getDashboardStats(base, base + 60_000, 'minute');
      expect(inserted).toBeTrue();
      expect(snapshot.timeSeries[0].totalRequests).toBe(1);
      expect(snapshot.upstreams[0].totalRequests).toBe(1);
    } finally {
      interception.mockRestore();
    }
    const next = await query.getDashboardStats(base, base + 60_000, 'minute');
    expect(next.timeSeries[0].totalRequests).toBe(2);
    expect(next.upstreams[0].totalRequests).toBe(2);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('dashboard DTO shares one range, declares units and exposes complementary success and failure rates', async () => {
    const { db, query } = service();
    insert(db, 'ok', { timestamp: Date.now() - 1000 });
    insert(db, 'cancel', { timestamp: Date.now() - 1000, outcome: 'cancelled', success: 0 });
    const handler = new StatsHandler(query);
    const response = await handler.getDashboard(new Request('http://localhost/api/stats/dashboard?range=1h'));
    const dto = await response.json();
    expect(response.status).toBe(200);
    expect(dto.endTime - dto.startTime).toBe(3_600_000);
    expect(dto.units).toEqual({ history: 'request_chain', upstreams: 'upstream_attempt' });
    expect(dto.history.requests.reduce((sum: number, n: number) => sum + n, 0)).toBe(2);
    expect(dto.history.errors.reduce((sum: number, n: number) => sum + n, 0)).toBe(1);
    expect(dto.history).not.toHaveProperty('cancelled');
    expect(dto.history.successRate.map((rate: number, i: number) => rate + dto.history.failureRate[i])).toEqual(dto.history.requests.map(() => 100));
    expect(dto.upstreams[0]).toMatchObject({ successRate: 50, failureRate: 50 });
  });
});
