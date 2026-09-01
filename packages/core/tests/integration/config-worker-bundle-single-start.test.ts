import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { BUILTINS } from '../unit/plugin-manifest-catalog-fixtures';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

const identity = {
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;

function isMessage(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function send(child: ChildProcess, value: object): Promise<void> {
  return new Promise((resolveSend, reject) => {
    child.send(value, (error) => error ? reject(error) : resolveSend());
  });
}

async function cleanupChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  if (child.connected) child.disconnect();
  const completed = await Promise.race([exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
  if (!completed) {
    child.kill('SIGKILL');
    await exited;
  }
}

test('fresh main bundle starts exactly one config worker lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-bundle-'));
  let child: ChildProcess | undefined;
  try {
    const build = Bun.spawnSync({
      cmd: [
        process.execPath, 'build', 'src/main.ts', 'src/master.ts', 'src/worker.ts',
        '--outdir', directory, '--target', 'bun',
      ],
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));
    const bundle = resolve(directory, 'main.js');

    const catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] });
    const compiled = parseNormalizeCompileAggregate(
      { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
      catalog.toCompileOptions(),
    );
    if (!compiled.ok) throw new Error('bundle fixture must compile');
    const aggregate = compiled.value;
    child = spawn(process.execPath, [bundle], {
      cwd: directory,
      env: {
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
        BUNGEE_ACCESS_DB_PATH: join(directory, 'logs', 'access.db'),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const readyMessages: Record<string, unknown>[] = [];
    let resolveFirstReady: (() => void) | undefined;
    const firstReady = new Promise<void>((resolveReady) => { resolveFirstReady = resolveReady; });
    child.on('message', (value: unknown) => {
      if (isMessage(value) && value.status === 'config-ready') {
        readyMessages.push(value);
        resolveFirstReady?.();
      }
    });
    await send(child, { command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: 1 });
    await send(child, {
      command: 'start-current-config-worker', ...identity, revision: 1,
      content_hash: hashConfigurationContent(aggregate), plugin_catalog_hash: catalog.hash,
      aggregate,
      activated_plugin_names: Object.freeze(aggregate.plugin_activations.map(({ plugin_name }) => plugin_name)),
      publication: null,
    });
    await Promise.race([
      firstReady,
      Bun.sleep(20_000).then(() => { throw new Error('timed out waiting for bundled worker'); }),
    ]);
    await Bun.sleep(500);

    expect(readyMessages).toHaveLength(1);
    expect(new Set(readyMessages.map((message) => message.private_port)).size).toBe(1);
    expect(new Set(readyMessages.map((message) => message.pid))).toEqual(new Set([child.pid]));
    console.info(`CONFIG_WORKER_BUNDLE_SINGLE pid=${child.pid} port=${String(readyMessages[0]?.private_port)}`);
  } finally {
    if (child !== undefined) await cleanupChild(child);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
