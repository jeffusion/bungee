import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { connect, type Socket } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationManager } from '../../src/migrations/migration-manager';
import { createMasterStats, type MasterStatsApi } from '../../src/master-runtime/master-stats';
import { LogQueryService } from '../../src/api/logs';
import { BodyStorageManager } from '../../src/logger/body-storage';
import { HeaderStorageManager } from '../../src/logger/header-storage';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

async function waitForAsync(predicate: () => Promise<boolean>, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await predicate()).toBe(true);
}

async function rawStatus(port: number, target: string): Promise<number> {
  return await new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(599); }, 1_000);
    const finish = (status: number) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    socket.on('error', () => finish(599));
    socket.on('close', () => { if (response.length === 0) finish(599); });
    socket.on('data', chunk => {
      response += chunk.toString();
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(response);
      if (match !== null) finish(Number(match[1]));
    });
    socket.on('connect', () => {
      try {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test\r\nConnection: close\r\n\r\n`);
      } catch { finish(599); }
    });
  });
}

class ProbeChild {
  readonly process: Bun.Subprocess;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly input: Bun.FileSink;
  private buffer = '';
  readonly events: string[] = [];

  constructor(databasePath: string, mode: 'lock' | 'writer', barrierPath?: string) {
    this.process = Bun.spawn([
      'bun',
      new URL('../fixtures/observability-sqlite-lock-child.ts', import.meta.url).pathname,
      databasePath,
      mode,
      ...(barrierPath === undefined ? [] : [barrierPath]),
    ], { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
    const output = this.process.stdout;
    const input = this.process.stdin;
    if (output === undefined || input === undefined || typeof output === 'number' || typeof input === 'number') {
      throw new Error('probe child pipes were not created');
    }
    this.reader = output.getReader();
    this.input = input;
  }

  async next(expected: string, timeout = 5_000): Promise<{ event: string }> {
    const deadline = Date.now() + timeout;
    while (true) {
      const end = this.buffer.indexOf('\n');
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const message = JSON.parse(line) as { event: string };
        this.events.push(message.event);
        if (message.event === expected) return message;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.kill();
        await this.process.exited;
        const errorOutput = this.process.stderr !== undefined && typeof this.process.stderr !== 'number'
          ? await new Response(this.process.stderr).text() : '';
        throw new Error(`timed out waiting for child event ${expected}: ${errorOutput}`);
      }
      const read = await Promise.race([
        this.reader.read(),
        Bun.sleep(remaining).then(() => null),
      ]);
      if (read === null) {
        this.kill();
        await this.process.exited;
        const errorOutput = this.process.stderr !== undefined && typeof this.process.stderr !== 'number'
          ? await new Response(this.process.stderr).text() : '';
        throw new Error(`timed out waiting for child event ${expected}: ${errorOutput}`);
      }
      if (read.done) {
        const errorOutput = this.process.stderr !== undefined && typeof this.process.stderr !== 'number'
          ? await new Response(this.process.stderr).text() : '';
        throw new Error(`child exited before ${expected}: ${errorOutput}`);
      }
      this.buffer += new TextDecoder().decode(read.value);
    }
  }

  send(message: string): void { this.input.write(`${message}\n`); this.input.flush(); }
  has(event: string): boolean { return this.events.includes(event); }
  release(): void { this.send('release'); }
  kill(): void { try { this.process.kill(); } catch { /* already exited */ } }
  async stop(): Promise<void> {
    this.kill();
    await this.process.exited;
  }
}

async function createObservability(root: string, cleanup = false): Promise<{
  master: MasterStatsApi;
  databasePath: string;
  body: BodyStorageManager;
  headers: HeaderStorageManager;
}> {
  const databasePath = join(root, 'access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);
  const body = new BodyStorageManager({}, join(root, 'bodies'));
  const headers = new HeaderStorageManager({}, join(root, 'headers'));
  const master = createMasterStats({
    accessDbPath: databasePath,
    bodyStorage: body,
    headerStorage: headers,
    cleanupConfig: { enabled: cleanup },
  });
  return { master, databasePath, body, headers };
}

test('real SSE socket destruction and owner shutdown drain polling and close the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-sse-'));
  roots.push(root);
  const { master, databasePath } = await createObservability(root);
  const server = Bun.serve({ port: 0, fetch: request => master.handle(request) });
  const port = server.port;
  if (port === undefined) throw new Error('Bun listener did not expose a port');
  const originalQuerySince = LogQueryService.prototype.querySince;
  let querySinceCalls = 0;
  LogQueryService.prototype.querySince = async function (...args) {
    querySinceCalls++;
    return originalQuerySince.apply(this, args);
  };
  try {
    const responseStarted = new Promise<Socket>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.once('error', reject);
      socket.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('HTTP/1.1 200')) resolve(socket);
      });
      socket.on('connect', () => socket.write(
        'GET /api/logs/stream?interval=100 HTTP/1.1\r\n'
        + 'Host: localhost\r\nAuthorization: Bearer test\r\nConnection: keep-alive\r\n\r\n',
      ));
    });
    const socket = await responseStarted;
    socket.destroy();
    await waitFor(() => master.activeRequests?.() === 0);
    const callsAfterDestroy = querySinceCalls;
    await Bun.sleep(250);
    expect(querySinceCalls).toBe(callsAfterDestroy);

    const ownerRequest = await master.handle(new Request('http://localhost/api/logs/stream?interval=100'));
    expect(ownerRequest.status).toBe(200);
    const close = Promise.race([
      master.close().then(() => 'closed'),
      Bun.sleep(2_000).then(() => 'timeout'),
    ]);
    expect(await close).toBe('closed');
    expect(master.activeRequests?.()).toBe(0);
    expect((await master.handle(new Request('http://localhost/api/logs'))).status).toBe(404);
    const reopened = new Database(databasePath);
    reopened.close();
    await ownerRequest.body?.cancel();
  } finally {
    LogQueryService.prototype.querySince = originalQuerySince;
    await server.stop(true);
    await master.close();
  }
});

test('SSE interval validation rejects garbage, zero, maximum overflow and duplicates before polling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-interval-'));
  roots.push(root);
  const { master } = await createObservability(root);
  const originalQuerySince = LogQueryService.prototype.querySince;
  let querySinceCalls = 0;
  LogQueryService.prototype.querySince = async function (...args) {
    querySinceCalls++;
    return originalQuerySince.apply(this, args);
  };
  try {
    for (const query of ['interval=garbage', 'interval=0', 'interval=999999', 'interval=100&interval=200']) {
      const response = await master.handle(new Request(`http://localhost/api/logs/stream?${query}`));
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect(querySinceCalls).toBe(0);
  } finally {
    LogQueryService.prototype.querySince = originalQuerySince;
    await master.close();
  }
});

test('real body/header IDs accept the dashboard shape, preserve empty body, and reject hostile paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-storage-'));
  roots.push(root);
  const { master, body, headers } = await createObservability(root);
  const server = Bun.serve({ port: 0, fetch: request => master.handle(request) });
  if (server.port === undefined) throw new Error('Bun listener did not expose a port');
  try {
    const bodyId = await body.save('request-id', { ok: true }, 'request');
    const emptyId = await body.save('empty-id', '', 'request');
    const headerId = await headers.save('request-id', { 'x-test': 'ok' }, 'request');
    expect(bodyId).not.toBeNull();
    expect(emptyId).not.toBeNull();
    expect(headerId).not.toBeNull();
    expect(await rawStatus(server.port, `/api/logs/body/${bodyId}`)).toBe(200);
    expect(await rawStatus(server.port, `/api/logs/body/${emptyId}`)).toBe(200);
    expect(await rawStatus(server.port, `/api/logs/headers/${headerId}`)).toBe(200);

    const date = new Date().toISOString().slice(0, 10);
    for (const hostile of [
      `${date}/request-../outside`, `${date}/request-id%252fother`, `${date}/request-id%2Fother`,
      `${date}/request-id%5Cother`, `${date}/request-id%00other`, `${date}/request-id/extra`,
    ]) {
      expect(await body.load(hostile)).toBeNull();
      expect(await headers.load(hostile)).toBeNull();
      expect(await rawStatus(server.port, `/api/logs/body/${hostile}`)).not.toBe(200);
      expect(await rawStatus(server.port, `/api/logs/headers/${hostile}`)).not.toBe(200);
    }

    const outside = join(root, 'outside.json');
    await writeFile(outside, '{"outside":true}');
    const dateDirectory = join(root, 'bodies', date);
    await rm(dateDirectory, { recursive: true, force: true });
    await symlink(join(root, 'outside-dir'), dateDirectory);
    await expect(body.load(`${date}/request-request-id`)).resolves.toBeNull();
    expect(await rawStatus(server.port, `/api/logs/body/${date}/request-request-id`)).not.toBe(200);
    await rm(dateDirectory, { force: true });
    await writeFile(dateDirectory, outside);
    await expect(body.load(`${date}/request-request-id`)).resolves.toBeNull();
  } finally {
    await master.close();
    await server.stop(true);
  }
});

test('cleanup is configured from the authoritative retention before the first scheduled pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-retention-'));
  roots.push(root);
  const databasePath = join(root, 'access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);
  const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oldDirectory = join(root, 'bodies', oldDate);
  const oldFile = join(oldDirectory, 'request-request-id');
  await mkdir(oldDirectory, { recursive: true });
  await writeFile(oldFile, '{}');

  const first = createMasterStats({
    accessDbPath: databasePath,
    bodyStorage: new BodyStorageManager({}, join(root, 'bodies')),
    headerStorage: new HeaderStorageManager({}, join(root, 'headers')),
  });
  try {
    first.configureLogging?.({ body: { retention_days: 30 } });
    first.startCleanup?.();
    await Bun.sleep(100);
    expect(await Bun.file(oldFile).exists()).toBe(true);
  } finally {
    await first.close();
  }

  const restarted = createMasterStats({
    accessDbPath: databasePath,
    bodyStorage: new BodyStorageManager({}, join(root, 'bodies')),
    headerStorage: new HeaderStorageManager({}, join(root, 'headers')),
  });
  try {
    restarted.configureLogging?.({ body: { retention_days: 1 } });
    restarted.startCleanup?.();
    await waitForAsync(async () => !(await Bun.file(oldFile).exists()), 2_000);
  } finally {
    await restarted.close();
  }
});

test('a real cross-process EXCLUSIVE lock maps cleanup to busy, then writer and DB recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-lock-'));
  roots.push(root);
  const databasePath = join(root, 'access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);
  const realDatabase = new Database(databasePath);
  const sql: string[] = [];
  const tracedDatabase = new Proxy(realDatabase, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'prepare' || property === 'run' || property === 'exec' || property === 'query')
        && typeof value === 'function') {
        return (...args: unknown[]) => {
          const statement = String(args[0] ?? '');
          sql.push(statement);
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Database;
  const body = new BodyStorageManager({}, join(root, 'bodies'));
  const headers = new HeaderStorageManager({}, join(root, 'headers'));
  const master = createMasterStats({ database: tracedDatabase, bodyStorage: body, headerStorage: headers, cleanupConfig: { enabled: false } });
  realDatabase.run('PRAGMA busy_timeout = 50');
  const server = Bun.serve({ port: 0, fetch: request => master.handle(request) });
  if (server.port === undefined) throw new Error('Bun listener did not expose a port');
  const barrierPath = join(root, 'writer-attempt.barrier');
  const writerChild = new ProbeChild(databasePath, 'writer', barrierPath);
  let lockChild: ProbeChild | null = null;
  const causalEvents: string[] = [];
  try {
    expect(realDatabase.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 50 });
    await writerChild.next('WRITER_READY');
    lockChild = new ProbeChild(databasePath, 'lock');
    await lockChild.next('LOCK_READY');
    causalEvents.push('LOCK_READY');
    await writeFile(barrierPath, 'attempt');
    await writerChild.next('WRITE_BUSY');
    causalEvents.push('WRITE_BUSY');
    expect(writerChild.has('WRITE_DONE')).toBe(false);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/logs/cleanup`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'database_busy' });
    causalEvents.push('CLEANUP_BUSY');
    expect(writerChild.has('WRITE_DONE')).toBe(false);

    lockChild.release();
    await lockChild.next('LOCK_RELEASED');
    causalEvents.push('LOCK_RELEASED');
    writerChild.send('retry');
    await writerChild.next('WRITE_DONE');
    causalEvents.push('WRITE_DONE');
    const success = await fetch(`http://127.0.0.1:${server.port}/api/logs/cleanup`, { method: 'POST' });
    expect(success.status).toBe(200);
    expect((await success.json()).deletedSqliteRecords).toBeGreaterThanOrEqual(0);
    causalEvents.push('CLEANUP_SUCCESS');
    expect(causalEvents).toEqual(['LOCK_READY', 'WRITE_BUSY', 'CLEANUP_BUSY', 'LOCK_RELEASED', 'WRITE_DONE', 'CLEANUP_SUCCESS']);
    expect(sql.some(statement => /VACUUM/i.test(statement))).toBe(false);
    await master.close();
    const reopened = new Database(databasePath);
    expect(reopened.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(reopened.query("SELECT COUNT(*) AS count FROM access_logs WHERE path = '/child'").get()).toEqual({ count: 1 });
    reopened.close();
  } finally {
    try { lockChild?.release(); } catch { /* child may already be gone */ }
    await lockChild?.stop();
    await writerChild.stop();
    await server.stop(true);
    await master.close();
  }
});

test('random non-SQLite bytes fail closed during access database initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-observability-notadb-'));
  roots.push(root);
  const databasePath = join(root, 'not-a-database.db');
  await writeFile(databasePath, crypto.getRandomValues(new Uint8Array(512)));
  const probe = new Database(databasePath);
  let actualError: unknown;
  try { probe.prepare('SELECT 1').get(); }
  catch (error) { actualError = error; }
  finally { probe.close(); }
  expect((actualError as { code?: string }).code).toBe('SQLITE_NOTADB');

  expect(() => createMasterStats(databasePath)).toThrow(/not a database/i);
});
