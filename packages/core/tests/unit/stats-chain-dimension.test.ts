import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';

/**
 * getStats SQL (from packages/core/src/api/logs.ts lines 683-713)
 * Uses COALESCE(parent_request_id, request_id) to group by chain dimension.
 */
const GET_STATS_SQL = `
  WITH chain_rows AS (
    SELECT
      COALESCE(parent_request_id, request_id) AS chain_id,
      timestamp, duration, status,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(parent_request_id, request_id)
        ORDER BY
          CASE WHEN request_type = 'final' THEN 0 ELSE 1 END,
          CASE WHEN attempt_number IS NULL THEN -1 ELSE attempt_number END DESC,
          timestamp DESC,
          id DESC
      ) AS status_rank
    FROM access_logs
    WHERE timestamp >= ? AND timestamp <= ?
  ),
  chains AS (
    SELECT
      chain_id,
      MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
      (MAX(timestamp + duration) - MIN(timestamp)) AS chain_duration_ms
    FROM chain_rows
    GROUP BY chain_id
  )
  SELECT
    COUNT(*) AS total_requests,
    SUM(CASE WHEN chain_status < 400 THEN 1 ELSE 0 END) AS success_requests,
    SUM(CASE WHEN chain_status >= 400 THEN 1 ELSE 0 END) AS failed_requests,
    AVG(chain_duration_ms) AS avg_response_time
  FROM chains
`;

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE NOT NULL,
      timestamp INTEGER NOT NULL,

      -- Request basic information
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      query TEXT,
      status INTEGER NOT NULL,
      duration INTEGER NOT NULL,

      -- Business information
      route_path TEXT,
      upstream TEXT,
      transformer TEXT,
      transformed_path TEXT,

      -- Processing steps (JSON)
      processing_steps TEXT,

      -- Authentication information
      auth_success INTEGER DEFAULT 1,
      auth_level TEXT,

      -- Error information
      error_message TEXT,

      -- Body reference IDs (stored in separate files)
      req_body_id TEXT,
      resp_body_id TEXT,

      -- Header reference IDs (stored in separate files)
      req_header_id TEXT,
      resp_header_id TEXT,

      -- Original request references (before transformation)
      original_req_header_id TEXT,
      original_req_body_id TEXT,

      -- Failover tracking fields
      is_failover_attempt INTEGER DEFAULT 0,
      parent_request_id TEXT,
      attempt_number INTEGER,
      attempt_upstream TEXT,

      -- Request type classification (mutually exclusive)
      request_type TEXT DEFAULT 'final',

      -- Index fields
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
}

function getStats(db: Database, startTime: number, endTime: number): {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  avgResponseTime: number;
} {
  const result = db.prepare(GET_STATS_SQL).get(startTime, endTime) as {
    total_requests: number;
    success_requests: number;
    failed_requests: number;
    avg_response_time: number;
  };
  return {
    totalRequests: result.total_requests,
    successRequests: result.success_requests,
    failedRequests: result.failed_requests,
    avgResponseTime: result.avg_response_time ?? 0,
  };
}

describe('stats chain dimension', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  beforeEach(() => {
    db.run('DELETE FROM access_logs');
  });

  afterAll(() => {
    db.close();
  });

  it('T1: chain with 3 attempts (2 fail + 1 final success) → totalRequests=1, successRequests=1, failedRequests=0', () => {
    // Insert 3 rows: 2 failover attempts + 1 successful final
    const now = Date.now();
    db.run(`
      INSERT INTO access_logs (request_id, parent_request_id, timestamp, method, path, status, duration, success, is_failover_attempt, attempt_number, request_type, created_at)
      VALUES
        ('req-1', 'chain-1', ${now}, 'GET', '/api/test', 502, 60000, 0, 1, 1, 'failover', ${now}),
        ('req-2', 'chain-1', ${now + 1000}, 'GET', '/api/test', 503, 60000, 0, 1, 2, 'failover', ${now + 1000}),
        ('req-3', 'chain-1', ${now + 2000}, 'GET', '/api/test', 200, 100, 1, 0, 3, 'final', ${now + 2000})
    `);

    const stats = getStats(db, 0, now + 100000);

    expect(stats.totalRequests).toBe(1);
    expect(stats.successRequests).toBe(1);
    expect(stats.failedRequests).toBe(0);
  });

  it('T2: chain with 3 attempts (all fail) → totalRequests=1, successRequests=0, failedRequests=1', () => {
    const now = Date.now();
    db.run(`
      INSERT INTO access_logs (request_id, parent_request_id, timestamp, method, path, status, duration, success, is_failover_attempt, attempt_number, request_type, created_at)
      VALUES
        ('req-4', 'chain-2', ${now}, 'GET', '/api/test', 502, 60000, 0, 1, 1, 'failover', ${now}),
        ('req-5', 'chain-2', ${now + 1000}, 'GET', '/api/test', 503, 60000, 0, 1, 2, 'failover', ${now + 1000}),
        ('req-6', 'chain-2', ${now + 2000}, 'GET', '/api/test', 503, 60000, 0, 0, 3, 'final', ${now + 2000})
    `);

    const stats = getStats(db, 0, now + 100000);

    expect(stats.totalRequests).toBe(1);
    expect(stats.successRequests).toBe(0);
    expect(stats.failedRequests).toBe(1);
  });

  it('T3: 2 separate chains (1 success + 1 fail) → totalRequests=2, successRequests=1, failedRequests=1', () => {
    const now = Date.now();
    db.run(`
      INSERT INTO access_logs (request_id, parent_request_id, timestamp, method, path, status, duration, success, is_failover_attempt, attempt_number, request_type, created_at)
      VALUES
        ('chain-A', NULL, ${now}, 'GET', '/api/success', 200, 100, 1, 0, NULL, 'final', ${now}),
        ('chain-B', NULL, ${now + 1000}, 'GET', '/api/fail', 500, 100, 0, 0, NULL, 'final', ${now + 1000})
    `);

    const stats = getStats(db, 0, now + 100000);

    expect(stats.totalRequests).toBe(2);
    expect(stats.successRequests).toBe(1);
    expect(stats.failedRequests).toBe(1);
  });

  it('T4: chain with 3 attempts, avgResponseTime = chain wall-clock (not attempt avg)', () => {
    const now = Date.now();
    // Chain wall-clock: MAX(now+130000+100) - MIN(now) = 130100
    // Attempt avg: (60000 + 60000 + 100) / 3 ≈ 40033
    db.run(`
      INSERT INTO access_logs (request_id, parent_request_id, timestamp, method, path, status, duration, success, is_failover_attempt, attempt_number, request_type, created_at)
      VALUES
        ('req-7', 'chain-3', ${now}, 'GET', '/api/test', 502, 60000, 0, 1, 1, 'failover', ${now}),
        ('req-8', 'chain-3', ${now + 65000}, 'GET', '/api/test', 503, 60000, 0, 1, 2, 'failover', ${now + 65000}),
        ('req-9', 'chain-3', ${now + 130000}, 'GET', '/api/test', 200, 100, 1, 0, 3, 'final', ${now + 130000})
    `);

    const stats = getStats(db, 0, now + 200000);

    // chain wall-clock = MAX(130000+100) - MIN(0) = 130100
    expect(stats.avgResponseTime).toBe(130100);
  });
});