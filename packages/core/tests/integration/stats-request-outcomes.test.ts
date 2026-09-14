import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = resolve(import.meta.dir, '../fixtures/stats-request-outcomes.fixture.ts');
const roots: string[] = [];
const databases: Database[] = [];

type AccessRow = {
  request_id: string;
  parent_request_id: string | null;
  status: number;
  request_type: string;
  success: number;
  protocol_outcome: string | null;
  is_failover_attempt: number;
  attempt_number: number | null;
};

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runScenario(scenario: string): Promise<{ result: Record<string, any>; rows: (path: string) => AccessRow[] }> {
  const root = await mkdtemp(join(tmpdir(), 'bungee-stats-outcomes-'));
  roots.push(root);
  const dbPath = join(root, 'access.db');
  const child = Bun.spawn([process.execPath, fixture, scenario], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BUN_ENV: 'test',
      BUNGEE_ACCESS_DB_PATH: dbPath,
      BUNGEE_FILE_LOG_DIR: join(root, 'logs'),
      BUNGEE_BODY_LOG_DIR: join(root, 'bodies'),
      BUNGEE_HEADER_LOG_DIR: join(root, 'headers'),
      DATA_DIR: join(root, 'stats'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exit = await Promise.race<number | 'timeout'>([
    child.exited,
    Bun.sleep(12_000).then(() => {
      child.kill();
      return 'timeout' as const;
    }),
  ]);
  const output = await stdout;
  const errors = await stderr;
  if (exit === 'timeout') throw new Error(`fixture timed out: ${scenario}\n${errors || output}`);
  expect(exit).toBe(0);
  const encoded = output.match(/RESULT:(.+)$/m)?.[1];
  if (!encoded) throw new Error(`fixture returned no result: ${errors || output}`);
  const database = new Database(dbPath);
  databases.push(database);
  return {
    result: JSON.parse(encoded),
    rows: (path) => database.prepare(`
      SELECT request_id, parent_request_id, status, request_type, success,
             protocol_outcome, is_failover_attempt, attempt_number
      FROM access_logs WHERE path = ? ORDER BY id
    `).all(path) as AccessRow[],
  };
}

describe('stats request outcomes over real HTTP', () => {
  test('records one final failed row when managed control is unavailable', async () => {
    const { result, rows } = await runScenario('managed');

    expect(result.status).toBe(503);
    expect(result.upstreamHits).toBe(0);
    const attempts = rows('/control-unavailable');
    expect(attempts).toEqual([expect.objectContaining({
      status: 503, request_type: 'final', success: 0, protocol_outcome: 'failed', is_failover_attempt: 1,
    })]);
    expect(attempts[0].parent_request_id).not.toBeNull();
    expect(result.stats).toMatchObject({ totalRequests: 1, successRequests: 0, failedRequests: 1 });
  }, 15_000);

  test('keeps real failover attempts in one successful chain', async () => {
    const { result, rows } = await runScenario('failover');
    const attempts = rows('/failover');

    expect(result.status).toBe(200);
    expect(result.upstreamHits).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(({ status, request_type, success, attempt_number }) => ({ status, request_type, success, attempt_number }))).toEqual([
      { status: 503, request_type: 'retry', success: 0, attempt_number: 1 },
      { status: 200, request_type: 'final', success: 1, attempt_number: 2 },
    ]);
    expect(new Set(attempts.map((row) => row.parent_request_id))).toEqual(new Set([attempts[0].parent_request_id]));
    expect(attempts[0].parent_request_id).not.toBeNull();
    expect(result.stats).toMatchObject({ totalRequests: 1, successRequests: 1, failedRequests: 0 });
  }, 15_000);

  test('marks a client-aborted SSE chain cancelled and failed', async () => {
    const { result, rows } = await runScenario('cancelled');

    expect(result.status).toBe(200);
    expect(rows('/cancelled')).toEqual([expect.objectContaining({
      status: 200, request_type: 'final', success: 0, protocol_outcome: 'cancelled',
    })]);
    expect(result.stats).toMatchObject({ totalRequests: 1, successRequests: 0, failedRequests: 1 });
  }, 15_000);

  test('does not leak roots before or after an attempt exception', async () => {
    const { result, rows } = await runScenario('edges');
    const before = rows('/before-attempt');
    const after = rows('/after-attempt');

    expect(result).toMatchObject({ before: 500, after: 503 });
    expect(before).toEqual([expect.objectContaining({ request_type: 'final', success: 0, parent_request_id: null })]);
    expect(after).toHaveLength(2);
    expect(after.map(({ request_type, parent_request_id }) => ({ request_type, parent_request_id }))).toEqual([
      { request_type: 'retry', parent_request_id: after[0].parent_request_id },
      { request_type: 'final', parent_request_id: after[0].parent_request_id },
    ]);
    expect(after[0].parent_request_id).not.toBeNull();
  }, 15_000);

  test('records client abort as one final attempt without selecting fallback', async () => {
    const { result, rows } = await runScenario('aborted');
    const attempts = rows('/aborted');

    expect(result).toMatchObject({ fallbackHits: 0, stats: { totalRequests: 1, failedRequests: 1 } });
    expect(attempts).toEqual([expect.objectContaining({ request_type: 'final', success: 0, parent_request_id: expect.any(String) })]);
  }, 15_000);

  test('returns real DTOs for every legal stats range and filter', async () => {
    const { result } = await runScenario('stats-api');
    const upstream = result.upstream.flat() as Array<{ status: number; body: { data: unknown[]; type?: string } }>;
    const logs = result.logs as Array<{ status: number; body: unknown }>;

    expect(upstream).toHaveLength(18);
    expect(upstream.every(({ status, body }) => status === 200 && Array.isArray(body.data))).toBeTrue();
    expect(upstream.filter(({ body }) => body.type !== undefined).map(({ body }) => body.type).sort()).toEqual([
      'all', 'all', 'all', 'failure', 'failure', 'failure', 'success', 'success', 'success',
    ]);
    expect(logs).toEqual([
      expect.objectContaining({ status: 200, body: expect.objectContaining({ totalRequests: 0 }) }),
      expect.objectContaining({ status: 200, body: expect.any(Array) }),
    ]);
  }, 15_000);
});
