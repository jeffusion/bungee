import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = resolve(import.meta.dir, '../fixtures/stats-cleanup-terminal.fixture.ts');
const roots: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stats cleanup terminal handling', () => {
  test('handler cleanup-error branch injection records one terminal final attempt and stops fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-stats-cleanup-terminal-'));
    roots.push(root);
    const dbPath = join(root, 'access.db');
    const child = Bun.spawn([process.execPath, fixture], {
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
      Bun.sleep(10_000).then(() => {
        child.kill();
        return 'timeout' as const;
      }),
    ]);
    const [output, errors] = await Promise.all([stdout, stderr]);

    expect(exit, `${output}\n${errors}`).toBe(0);
    const encoded = output.match(/RESULT:(.+)$/m)?.[1];
    if (!encoded) throw new Error(`fixture returned no result: ${errors || output}`);
    const result = JSON.parse(encoded) as {
      status: number;
      proxyTargets: string[];
      stats: { totalRequests: number; successRequests: number; failedRequests: number };
    };

    expect(result.status).toBe(503);
    expect(result.proxyTargets).toEqual(['https://first.example.test']);
    expect(result.stats).toMatchObject({ totalRequests: 1, successRequests: 0, failedRequests: 1 });

    const database = new Database(dbPath);
    databases.push(database);
    const attempts = database.prepare(`
      SELECT request_id, parent_request_id, status, request_type, success, attempt_number
      FROM access_logs WHERE path = ? ORDER BY id
    `).all('/stats-cleanup-terminal') as Array<{
      request_id: string;
      parent_request_id: string | null;
      status: number;
      request_type: string;
      success: number;
      attempt_number: number | null;
    }>;

    expect(attempts).toEqual([expect.objectContaining({
      status: 503,
      request_type: 'final',
      success: 0,
      attempt_number: 1,
      parent_request_id: expect.any(String),
    })]);
    expect(attempts[0].request_id).not.toBe(attempts[0].parent_request_id);
    expect(new Set(attempts.map((attempt) => attempt.parent_request_id)).size).toBe(1);
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM access_logs WHERE path = ? AND parent_request_id IS NULL',
    ).get('/stats-cleanup-terminal')).toEqual({ count: 0 });
  }, 15_000);
});
