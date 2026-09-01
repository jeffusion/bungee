import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { resolveConfigWorkerCoreBaseDir } from '../../src/config-worker/process-entry';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { BUILTINS } from '../unit/plugin-manifest-catalog-fixtures';
import {
  privateWorkerHeaders,
  TEST_WORKER_TRANSPORT_SECRET,
} from '../fixtures/config-worker-private-transport';

const workerEntry = resolve(import.meta.dir, '../../src/main.ts');
const parentEntry = resolve(import.meta.dir, '../fixtures/config-worker-parent.ts');
const identity = {
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};
let catalog: PluginManifestCatalog;
const temporaryDirectories: string[] = [];

beforeAll(async () => { catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] }); });

afterAll(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function normalize(value: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(value, catalog.toCompileOptions());
  if (!result.ok) throw new Error('real-process fixture must compile');
  return result.value;
}

function spawnWorker(directory: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [workerEntry], {
    cwd: directory,
    env: {
      BUNGEE_ACCESS_DB_PATH: join(directory, 'logs', 'access.db'),
      ...process.env,
      PLUGINS_DIR: BUILTINS,
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_ROLE: 'worker',
      BUNGEE_MASTER_GENERATION: identity.master_generation,
      BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id,
      BUNGEE_WORKER_SLOT: '0',
      BUNGEE_MASTER_PID: String(process.pid),
      BUNGEE_HEARTBEAT_TIMEOUT_MS: '10000',
      BUNGEE_SHUTDOWN_TIMEOUT_MS: '1000',
      BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function message(child: ChildProcess, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for worker IPC')), 20_000);
    const onMessage = (value: unknown) => {
      if (value !== null && typeof value === 'object' && predicate(value as Record<string, unknown>)) {
        finish(undefined, value as Record<string, unknown>);
      }
    };
    const onExit = () => finish(new Error('worker exited before expected IPC'));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else if (value) resolveMessage(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function send(child: ChildProcess, value: object): Promise<void> {
  return new Promise((resolveSend, reject) => {
    child.send(value, (error) => error ? reject(error) : resolveSend());
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
}

async function cleanupChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await exited(child);
}

async function expectFetchRejected(url: string): Promise<void> {
  await fetch(url, { headers: privateWorkerHeaders(url) }).then(
    () => { throw new Error('expected connection to be refused'); },
    () => undefined,
  );
}

function startCommand(aggregate: ConfigurationAggregateV2, pluginCatalogHash = catalog.hash) {
  return {
    command: 'start-current-config-worker', ...identity, revision: 1,
    content_hash: hashConfigurationContent(aggregate), plugin_catalog_hash: pluginCatalogHash,
    aggregate,
    activated_plugin_names: Object.freeze(aggregate.plugin_activations.map(({ plugin_name }) => plugin_name)),
    publication: null,
  };
}

describe('real config worker process', () => {
  test('resolves source and bundled core base directories exactly', () => {
    expect([resolveConfigWorkerCoreBaseDir('/opt/bungee/src/config-worker'), resolveConfigWorkerCoreBaseDir('/opt/bungee/dist')]).toEqual(['/opt/bungee/src', '/opt/bungee/dist']);
  });

  test('invalid environment exits without initializing files or server resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-invalid-env-'));
    temporaryDirectories.push(directory);
    const child = spawnWorker(directory, { BUNGEE_MASTER_PID: '' });
    expect(await exited(child)).not.toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });

  test('catalog mismatch, unknown activation, and invalid options fail before DB or server initialization', async () => {
    const empty = normalize({ logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] });
    const knownPlugin = catalog.names()[0];
    if (knownPlugin === undefined) throw new Error('catalog must not be empty');
    const cases: Array<{ name: string; command: ReturnType<typeof startCommand> }> = [
      { name: 'catalog', command: startCommand(empty, `sha256:${'0'.repeat(64)}`) },
      { name: 'activation', command: startCommand({
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [{ plugin_name: 'not-in-catalog' }],
      }) },
      { name: 'options', command: startCommand({
        logical_configuration: { services: [], routes: [], plugins: [{
          id: '40000000-0000-4000-8000-000000000001', position: 1,
          name: knownPlugin, enabled: true, options: { impossible_option: true },
        }] },
        plugin_activations: [{ plugin_name: knownPlugin }],
      }) },
    ];
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), `bungee-worker-invalid-${testCase.name}-`));
      temporaryDirectories.push(directory);
      const child = spawnWorker(directory);
      try {
        const failure = message(child, (value) => value.status === 'config-apply-failed');
        await send(child, { command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: 1 });
        await send(child, testCase.command);
        expect((await failure).error).toBe('runtime configuration compilation failed');
        expect(await readdir(directory)).toEqual([]);
      } finally {
        child.disconnect();
        await exited(child);
      }
    }
  });

  test('serves on a real loopback port, drains in-flight work, then exits on disconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-real-'));
    temporaryDirectories.push(directory);
    let releaseUpstream: (() => void) | undefined;
    let markUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolveStarted) => { markUpstreamStarted = resolveStarted; });
    const upstreamGate = new Promise<void>((resolveRequest) => { releaseUpstream = resolveRequest; });
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
      markUpstreamStarted?.();
      await upstreamGate;
      return new Response('completed');
    } });
    const aggregate = normalize({
      logical_configuration: {
        services: [{ id: '10000000-0000-4000-8000-000000000001', position: 1, name: 'slow',
          endpoints: [{ id: '30000000-0000-4000-8000-000000000001', position: 1,
            target: `http://127.0.0.1:${upstream.port}` }] }],
        routes: [{ id: '20000000-0000-4000-8000-000000000001', position: 1, path: '/slow',
          service_id: '10000000-0000-4000-8000-000000000001' }], plugins: [],
      }, plugin_activations: [],
    });
    const child = spawnWorker(directory);
    try {
      const readyResult = message(child, (value) => value.status === 'config-ready');
      await send(child, { command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: 1 });
      await send(child, { command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: 2 });
      await send(child, startCommand(aggregate));
      const ready = await readyResult;
      const port = ready.private_port;
      expect(typeof port).toBe('number');
      if (typeof port !== 'number') throw new Error('ready port is missing');
      console.info(`CONFIG_WORKER_READY pid=${child.pid} port=${port}`);
      expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.status)).toBe(403);
      expect(await fetch(`http://127.0.0.1:${port}/health`, { headers: privateWorkerHeaders('https://public.example/health', { connection: 'close' }) }).then((res) => res.status)).toBe(200);

      const inFlight = fetch(`http://127.0.0.1:${port}/slow`, { headers: privateWorkerHeaders('https://public.example/slow', { connection: 'close' }) });
      await upstreamStarted;
      const drainedResult = message(child, (value) => value.status === 'worker-drained');
      await send(child, { command: 'drain-worker', ...identity, revision: 1,
        content_hash: hashConfigurationContent(aggregate), plugin_catalog_hash: catalog.hash, publication: null });
      await Bun.sleep(100);
      await fetch(`http://127.0.0.1:${port}/health`, { headers: privateWorkerHeaders('https://public.example/health', { connection: 'close' }) }).then(
        () => { throw new Error('new connection unexpectedly succeeded while draining'); },
        () => undefined,
      );
      releaseUpstream?.();
      expect(await inFlight.then((response) => response.text())).toBe('completed');
      expect((await drainedResult).status).toBe('worker-drained');

      const exitResult = exited(child);
      child.disconnect();
      expect(await exitResult).toBe(1);
      await expectFetchRejected(`http://127.0.0.1:${port}/health`);
    } finally {
      upstream.stop(true);
      await cleanupChild(child);
    }
  }, 30_000);

  test('exits and closes its port when the IPC parent dies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-parent-death-'));
    temporaryDirectories.push(directory);
    const aggregate = normalize({ logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] });
    const parent = spawn(process.execPath, [parentEntry], {
      cwd: directory,
      env: { ...process.env, PLUGINS_DIR: BUILTINS, BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
        TEST_WORKER_ENTRY: workerEntry, TEST_WORKER_AGGREGATE: JSON.stringify(aggregate),
        TEST_WORKER_CATALOG_HASH: catalog.hash, TEST_WORKER_CONTENT_HASH: hashConfigurationContent(aggregate) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let orphanWorkerPid: number | undefined;
    try {
      const report = await message(parent, (value) => typeof value.workerPid === 'number' && typeof value.port === 'number');
      const workerPid = report.workerPid;
      const port = report.port;
      if (typeof workerPid !== 'number' || typeof port !== 'number') throw new Error('parent report is incomplete');
      orphanWorkerPid = workerPid;
      expect(await fetch(`http://127.0.0.1:${port}/health`, { headers: privateWorkerHeaders('https://public.example/health') }).then((response) => response.status)).toBe(200);
      const parentKilledAt = Date.now();
      parent.kill('SIGKILL');
      await exited(parent);
      const deadline = parentKilledAt + 1_000;
      while (Date.now() < deadline) {
        try { process.kill(workerPid, 0); } catch { break; }
        await Bun.sleep(50);
      }
      expect(() => process.kill(workerPid, 0)).toThrow();
      console.info(`CONFIG_WORKER_PARENT_DEATH pid=${workerPid} port=${port} containment_ms=${Date.now() - parentKilledAt}`);
      await expectFetchRejected(`http://127.0.0.1:${port}/health`);
    } finally {
      await cleanupChild(parent);
      if (orphanWorkerPid !== undefined) {
        try { process.kill(orphanWorkerPid, 'SIGKILL'); } catch {}
      }
    }
  }, 30_000);
});
