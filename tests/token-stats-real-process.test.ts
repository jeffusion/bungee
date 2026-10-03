import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLitePluginStorage } from '../packages/core/src/plugin-storage';
import { withTokenStatsMetering } from '../plugins/token-stats/server/storage';
import { migration as pluginStorageMigration } from '../packages/core/src/migrations/versions/002_add_plugin_storage';
import { migration as tokenStatsMigration } from '../packages/core/src/migrations/versions/005_token_stats_metering';
import type { TokenStatsAttempt } from '../packages/core/src/plugin.types';

const TIMEOUT_MS = 20_000;
const LOCK_HOLD_MS = 500;

interface RunningProcess {
  child: ChildProcess;
  pid: number | undefined;
  stdout: string;
  stderr: string;
  exit: Promise<number>;
  waitForText(text: string): Promise<void>;
}

function startProcess(source: string, args: string[]): RunningProcess {
  const child = spawn(process.execPath, ['-e', source, ...args], {
    cwd: resolve(import.meta.dir, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result: RunningProcess = {
    child,
    pid: child.pid,
    stdout: '',
    stderr: '',
    exit: Promise.resolve(-1),
    waitForText: async () => {},
  };
  const textWaiters: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    result.stdout += chunk.toString();
    for (let i = textWaiters.length - 1; i >= 0; i--) {
      const waiter = textWaiters[i]!;
      if (result.stdout.includes(waiter.text)) {
        textWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { result.stderr += chunk.toString(); });
  result.exit = new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child process timed out pid=${child.pid}\nstdout=${result.stdout}\nstderr=${result.stderr}`));
    }, TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`child process failed code=${code} signal=${signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`));
      else resolveExit(code);
    });
  });
  result.waitForText = (text) => {
    if (result.stdout.includes(text)) return Promise.resolve();
    return new Promise<void>((resolveText, rejectText) => {
      const timer = setTimeout(() => {
        const index = textWaiters.findIndex((waiter) => waiter.text === text);
        if (index >= 0) textWaiters.splice(index, 1);
        rejectText(new Error(`did not observe child output ${JSON.stringify(text)}\nstdout=${result.stdout}\nstderr=${result.stderr}`));
      }, TIMEOUT_MS);
      textWaiters.push({ text, resolve: () => { clearTimeout(timer); resolveText(); }, reject: rejectText });
    });
  };
  return result;
}

function makeAttempt(overrides: Partial<TokenStatsAttempt> = {}): TokenStatsAttempt {
  return {
    attempt_id: crypto.randomUUID(), request_id: 'shared-request', finished_at_ms: Date.now(),
    route_id: '/real-process', upstream_id: 'upstream-a', provider: 'openai', outcome: 'completed', model: 'gpt-4o-mini',
    input_tokens: 1, output_tokens: 0, input_source: 'usage', output_source: 'usage',
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, observation_incomplete: false, ...overrides,
  };
}

async function initializeDatabase(databasePath: string): Promise<void> {
  const db = new Database(databasePath, { create: true, readwrite: true, strict: true });
  try {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    pluginStorageMigration.up(db);
    tokenStatsMigration.up(db);
  } finally { db.close(); }
}

async function writeInChild(databasePath: string, row: TokenStatsAttempt): Promise<{ pid: number | undefined; result: string }> {
  const storagePath = resolve(import.meta.dir, '../packages/core/src/plugin-storage.ts');
  const reportingPath = resolve(import.meta.dir, '../plugins/token-stats/server/storage.ts');
  const source = `
    import { Database } from 'bun:sqlite';
    import { SQLitePluginStorage } from ${JSON.stringify(storagePath)};
    import { withTokenStatsMetering } from ${JSON.stringify(reportingPath)};
    const db = new Database(process.argv[1], { create: false, readwrite: true, strict: true });
    try {
      db.run('PRAGMA busy_timeout = 5000');
      const metering = withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats')).metering;
      if (!metering) throw new Error('token-stats metering capability unavailable');
      try {
        await metering.recordAttempt(JSON.parse(process.argv[2]));
        console.log('ATTEMPT_WRITTEN');
      } catch (error) {
        if (/busy|locked/i.test(error instanceof Error ? error.message : String(error))) console.log('ATTEMPT_DROPPED_BUSY');
        else throw error;
      }
    } finally { db.close(); }
  `;
  const process = startProcess(source, [databasePath, JSON.stringify(row)]);
  await process.exit;
  return { pid: process.pid, result: process.stdout };
}

function getBusyTimeout(db: Database): number | undefined {
  return db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout;
}

describe('token-stats independent-process storage integration', () => {
  test('independent OS writers persist attempt rows, time windows, and first-write-wins duplicate IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-token-stats-real-process-'));
    const databasePath = join(root, 'access.db');
    try {
      await initializeDatabase(databasePath);
      const now = Date.now();
      const first = makeAttempt({ attempt_id: 'process-attempt-a', request_id: 'shared-logical-request', finished_at_ms: now - 1_000, input_tokens: 7 });
      const second = makeAttempt({ attempt_id: 'process-attempt-b', request_id: 'shared-logical-request', finished_at_ms: now - 500, input_tokens: 11, upstream_id: 'upstream-b' });
      const [writerA, writerB] = await Promise.all([
        writeInChild(databasePath, first),
        writeInChild(databasePath, second),
      ]);
      expect(writerA.pid).toBeDefined();
      expect(writerB.pid).toBeDefined();
      expect(writerA.pid).not.toBe(writerB.pid);
      expect(writerA.result).toMatch(/ATTEMPT_WRITTEN|ATTEMPT_DROPPED_BUSY/);
      expect(writerB.result).toMatch(/ATTEMPT_WRITTEN|ATTEMPT_DROPPED_BUSY/);

      const duplicate = makeAttempt({ attempt_id: 'first-write-wins', request_id: 'duplicate-first', finished_at_ms: now, input_tokens: 13 });
      const duplicateConflict = makeAttempt({ ...duplicate, request_id: 'duplicate-second', finished_at_ms: now + 1, input_tokens: 99 });
      await writeInChild(databasePath, duplicate);
      await writeInChild(databasePath, duplicateConflict);

      const old = makeAttempt({ attempt_id: 'outside-one-hour', request_id: 'old-logical-request', finished_at_ms: now - 2 * 60 * 60_000, input_tokens: 101 });
      await writeInChild(databasePath, old);

      const db = new Database(databasePath, { create: false, readwrite: true, strict: true });
      try {
        db.run('PRAGMA busy_timeout = 5000');
        expect(getBusyTimeout(db)).toBe(5000);
        const concurrentRows = db.query<{ attempt_id: string; input_tokens: number }, [string, string]>(
          'SELECT attempt_id, input_tokens FROM token_stats_attempts WHERE attempt_id IN (?, ?) ORDER BY attempt_id',
        ).all(first.attempt_id, second.attempt_id);
        expect(concurrentRows.length).toBeGreaterThanOrEqual(1);
        expect(concurrentRows.length).toBeLessThanOrEqual(2);
        expect(db.query<{ request_id: string; input_tokens: number }, [string]>(
          'SELECT request_id, input_tokens FROM token_stats_attempts WHERE attempt_id = ?',
        ).get(duplicate.attempt_id)).toEqual({ request_id: 'duplicate-first', input_tokens: 13 });

        const storage = withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats'));
        const snapshot = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 2, range: '1h', groupBy: 'model' });
        expect(snapshot.all.upstreamAttempts).toBe(concurrentRows.length + 1);
        expect(snapshot.all.logicalRequests).toBe((concurrentRows.length > 0 ? 1 : 0) + 1);
        expect(snapshot.all.inputTokens).toBe(concurrentRows.reduce((sum, row) => sum + row.input_tokens, 13));
      } finally { db.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, TIMEOUT_MS * 2);

  test('a separate process write lock fails within the short timeout and leaves the loopback event loop responsive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-token-stats-lock-'));
    const databasePath = join(root, 'access.db');
    let db: Database | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let lockHolder: RunningProcess | undefined;
    try {
      await initializeDatabase(databasePath);
      db = new Database(databasePath, { create: false, readwrite: true, strict: true });
      db.run('PRAGMA busy_timeout = 5000');
      const storage = withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats'));
      expect(getBusyTimeout(db)).toBe(5000);
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('loopback-ok') });

      const source = `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.argv[1], { create: false, readwrite: true, strict: true });
        db.run('PRAGMA busy_timeout = 5000');
        db.run('BEGIN IMMEDIATE');
        console.log('WRITE_LOCK_HELD');
        await Bun.sleep(${LOCK_HOLD_MS});
        db.run('ROLLBACK');
        db.close();
      `;
      lockHolder = startProcess(source, [databasePath]);
      await lockHolder.waitForText('WRITE_LOCK_HELD');

      const healthStarted = performance.now();
      const healthPromise = fetch(`http://127.0.0.1:${server.port}/health`);
      const writeStarted = performance.now();
      let writeError: unknown;
      try { await storage.metering!.recordAttempt(makeAttempt({ attempt_id: 'locked-attempt', finished_at_ms: Date.now() })); }
      catch (error) { writeError = error; }
      const writeElapsed = performance.now() - writeStarted;
      const response = await healthPromise;
      const healthElapsed = performance.now() - healthStarted;
      const restoredTimeout = getBusyTimeout(db);

      expect(writeError).toBeDefined();
      expect(writeElapsed).toBeLessThan(250);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('loopback-ok');
      expect(healthElapsed).toBeLessThan(500);
      expect(lockHolder.child.exitCode).toBeNull();
      expect(restoredTimeout).toBe(5000);
      console.log(`TOKEN_STATS_LOCK_PROBE write_elapsed_ms=${writeElapsed.toFixed(2)} health_elapsed_ms=${healthElapsed.toFixed(2)} busy_timeout_restored_ms=${restoredTimeout}`);
      await lockHolder.exit;
      expect(lockHolder.stdout).toContain('WRITE_LOCK_HELD');

      const stored = await storage.metering!.queryWindowSnapshot({ asOfMs: Date.now() + 1, range: '1h', groupBy: 'model' });
      expect(stored.all.upstreamAttempts).toBe(0);
    } finally {
      if (lockHolder?.child.exitCode === null) {
        lockHolder.child.kill('SIGKILL');
        await lockHolder.exit.catch(() => {});
      }
      server?.stop(true);
      db?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);
});
