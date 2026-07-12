import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { LogQueryService } from '../../src/api/logs';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT UNIQUE NOT NULL,
    timestamp INTEGER NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT,
    status INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    route_path TEXT,
    upstream TEXT,
    transformer TEXT,
    transformed_path TEXT,
    processing_steps TEXT,
    auth_success INTEGER DEFAULT 1,
    auth_level TEXT,
    error_message TEXT,
    req_body_id TEXT,
    resp_body_id TEXT,
    req_header_id TEXT,
    resp_header_id TEXT,
    original_req_header_id TEXT,
    original_req_body_id TEXT,
    is_failover_attempt INTEGER DEFAULT 0,
    parent_request_id TEXT,
    attempt_number INTEGER,
    attempt_upstream TEXT,
    request_type TEXT DEFAULT 'final',
    success INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
`;

function insertRow(
  db: Database,
  requestId: string,
  parentId: string | null,
  timestamp: number,
  status: number,
  duration: number,
  success: number,
  attemptNumber: number | null,
  requestType: string,
): void {
  db.run(
    `INSERT INTO access_logs (request_id, parent_request_id, timestamp, method, path, status, duration, success, is_failover_attempt, attempt_number, request_type, created_at)
     VALUES (?, ?, ?, 'GET', '/api/test', ?, ?, ?, ?, ?, ?, ?)`,
    [requestId, parentId, timestamp, status, duration, success, attemptNumber !== null ? 1 : 0, attemptNumber, requestType, timestamp],
  );
}

describe('stats chain dimension', () => {
  let db: Database;
  let logQueryService: LogQueryService;

  beforeAll(() => {
    db = new Database(':memory:');
    db.run(SCHEMA_SQL);
    logQueryService = new LogQueryService(db);
  });

  beforeEach(() => {
    db.run('DELETE FROM access_logs');
  });

  afterAll(() => {
    db.close();
  });

  it('T1: chain with 3 attempts (2 fail + 1 final success) → totalRequests=1, successRequests=1, failedRequests=0', async () => {
    const base = 1_000_000;
    insertRow(db, 'req-1', 'chain-1', base, 502, 60000, 0, 1, 'failover');
    insertRow(db, 'req-2', 'chain-1', base + 1000, 503, 60000, 0, 2, 'failover');
    insertRow(db, 'req-3', 'chain-1', base + 2000, 200, 100, 1, 3, 'final');

    const stats = await logQueryService.getStats(base - 1, base + 100000);

    expect(stats.totalRequests).toBe(1);
    expect(stats.successRequests).toBe(1);
    expect(stats.failedRequests).toBe(0);
  });

  it('T2: chain with 3 attempts (all fail) → totalRequests=1, successRequests=0, failedRequests=1', async () => {
    const base = 2_000_000;
    insertRow(db, 'req-4', 'chain-2', base, 502, 60000, 0, 1, 'failover');
    insertRow(db, 'req-5', 'chain-2', base + 1000, 503, 60000, 0, 2, 'failover');
    insertRow(db, 'req-6', 'chain-2', base + 2000, 503, 60000, 0, 3, 'final');

    const stats = await logQueryService.getStats(base - 1, base + 100000);

    expect(stats.totalRequests).toBe(1);
    expect(stats.successRequests).toBe(0);
    expect(stats.failedRequests).toBe(1);
  });

  it('T3: 2 separate chains (1 success + 1 fail) → totalRequests=2, successRequests=1, failedRequests=1', async () => {
    const base = 3_000_000;
    insertRow(db, 'chain-A', null, base, 200, 100, 1, null, 'final');
    insertRow(db, 'chain-B', null, base + 1000, 500, 100, 0, null, 'final');

    const stats = await logQueryService.getStats(base - 1, base + 100000);

    expect(stats.totalRequests).toBe(2);
    expect(stats.successRequests).toBe(1);
    expect(stats.failedRequests).toBe(1);
  });

  it('T4: chain wall-clock avgResponseTime (not attempt avg)', async () => {
    const base = 4_000_000;
    insertRow(db, 'req-7', 'chain-3', base, 502, 60000, 0, 1, 'failover');
    insertRow(db, 'req-8', 'chain-3', base + 65000, 503, 60000, 0, 2, 'failover');
    insertRow(db, 'req-9', 'chain-3', base + 130000, 200, 100, 1, 3, 'final');

    const stats = await logQueryService.getStats(base - 1, base + 200000);

    expect(stats.avgResponseTime).toBe(130100);
  });

  it('T5: chain without final row — fallback to last attempt status', async () => {
    const base = 5_000_000;
    insertRow(db, 'req-A', 'chain-4', base, 502, 30000, 0, 1, 'failover');
    insertRow(db, 'req-B', 'chain-4', base + 5000, 503, 30000, 0, 2, 'failover');

    const stats = await logQueryService.getStats(base - 1, base + 100000);

    expect(stats.totalRequests).toBe(1);
    expect(stats.successRequests).toBe(0);
    expect(stats.failedRequests).toBe(1);
  });

  it('T6: chain spanning two time buckets — assigned to bucket of first attempt via getTimeSeriesStats', async () => {
    const bucketSize = 60 * 1000;
    const bucketA = 6_000_000;
    const bucketB = bucketA + bucketSize;

    insertRow(db, 'req-10', 'chain-5', bucketA, 502, 30000, 0, 1, 'failover');
    insertRow(db, 'req-11', 'chain-5', bucketB + 500, 503, 30000, 0, 2, 'final');

    const series = await logQueryService.getTimeSeriesStats(bucketA - 1, bucketB + bucketSize, 'minute');

    const nonEmpty = series.filter(s => s.totalRequests > 0);
    expect(nonEmpty.length).toBe(1);
    expect(nonEmpty[0].timestamp).toBe(bucketA - (bucketA % bucketSize));
    expect(nonEmpty[0].totalRequests).toBe(1);
    expect(nonEmpty[0].failedRequests).toBe(1);
  });

  it('T7: getTimeSeriesStats returns multiple buckets with chain-level counts', async () => {
    const bucketSize = 60 * 1000;
    const bucketA = 7_000_000;
    const bucketB = bucketA + bucketSize;

    insertRow(db, 'chain-A', null, bucketA, 200, 100, 1, null, 'final');
    insertRow(db, 'chain-B', null, bucketB, 500, 200, 0, null, 'final');

    const series = await logQueryService.getTimeSeriesStats(bucketA - 1, bucketB + bucketSize, 'minute');

    const nonEmpty = series.filter(s => s.totalRequests > 0);
    expect(nonEmpty.length).toBe(2);
    const first = nonEmpty.find(s => s.timestamp === bucketA - (bucketA % bucketSize));
    const second = nonEmpty.find(s => s.timestamp === bucketB - (bucketB % bucketSize));
    expect(first?.totalRequests).toBe(1);
    expect(first?.successRequests).toBe(1);
    expect(second?.totalRequests).toBe(1);
    expect(second?.failedRequests).toBe(1);
  });
});
