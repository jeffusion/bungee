import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER,
  DAEMON_SHUTDOWN_PATH,
} from '@jeffusion/bungee-types';
import { readDaemonMetadataFile } from '../packages/types/src/daemon-file';
import { DaemonManager } from '../packages/cli/src/daemon/manager';
import { probeDaemonProcess } from '../packages/cli/src/daemon/process-identity';
import { deriveSupervisionProcessKey } from '../packages/core/src/supervision';
import { IngressControllerClient } from '../packages/core/src/ingress/supervision-http';
import { makeCanonicalTempDir } from './support/canonical-temp';
import {
  claimTestPortBlock, ensureTestPortBlockClosed, makeTestPortBlock, releaseTestPortBlock,
  quarantineTestPortBlock, type TestPortBlock,
} from './support/test-port-block-broker';

const CORE_ENTRY = resolve(import.meta.dir, '../packages/core/dist/main.js');
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const childOutput = new WeakMap<ChildProcess, string[]>();

type Fixture = Readonly<{ root: string; dbPath: string; accessDbPath: string; configPath: string; pluginsPath: string }>;
type PortLease = Readonly<{ base: number; block: TestPortBlock }>;
type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type SpawnRecord = Readonly<{ child: ChildProcess; executable: string; args: readonly string[] }>;
type DaemonHarness = Readonly<{
  manager: DaemonManager;
  spawned: SpawnRecord[];
  metadataPath: string;
  runtime: string;
  logFiles: readonly string[];
}>;

async function reservePortBlock(): Promise<PortLease> {
  for (;;) {
    const first = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const base = first.port;
    let second: ReturnType<typeof Bun.serve> | undefined;
    let third: ReturnType<typeof Bun.serve> | undefined;
    if (base === undefined || base < 1 || base > 65_532) {
      await first.stop(true);
      continue;
    }
    const block = makeTestPortBlock(base);
    try {
      second = Bun.serve({ hostname: '127.0.0.1', port: base + 1, fetch: () => new Response('reserved') });
      third = Bun.serve({ hostname: '127.0.0.1', port: base + 2, fetch: () => new Response('reserved') });
      if (!claimTestPortBlock(block)) throw new Error('port block is already reserved');
      await Promise.all([first.stop(true), second.stop(true), third.stop(true)]);
      await ensureTestPortBlockClosed(block);
      return { base, block };
    } catch (error) {
      await Promise.allSettled([first.stop(true), second?.stop(true), third?.stop(true)].filter((value): value is Promise<void> => value !== undefined));
      quarantineTestPortBlock(block);
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
    }
  }
}

async function makeFixture(root: string, name: string): Promise<Fixture> {
  const fixtureRoot = join(root, name);
  const pluginsPath = join(fixtureRoot, 'data', 'plugins');
  const pluginPath = join(pluginsPath, 'canonical-plugin');
  const configPath = join(fixtureRoot, 'invalid-config.json');
  const dbPath = join(fixtureRoot, 'data', 'bungee.db');
  const accessDbPath = join(fixtureRoot, 'custom', 'access.db');
  await mkdir(pluginPath, { recursive: true });
  await mkdir(join(fixtureRoot, 'data'), { recursive: true });
  await mkdir(join(fixtureRoot, 'custom'), { recursive: true });
  await writeFile(configPath, '{invalid json', 'utf8');
  await writeFile(join(pluginPath, 'manifest.json'), JSON.stringify({
    name: 'canonical-plugin', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.2.0' },
    builtin: false, contributes: {}, configSchema: [], metadata: { name: 'canonical-plugin', description: 'canonical', icon: 'test' },
  }));
  await writeFile(join(pluginPath, 'index.js'), "export default class CanonicalPlugin { static version = '1.0.0'; register() {} };");
  return { root: fixtureRoot, dbPath, accessDbPath, configPath, pluginsPath };
}

function childExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => resolveExit({ code, signal });
    child.once('exit', finish);
    child.once('close', () => finish(child.exitCode, child.signalCode));
  });
}

async function stopChild(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  return childExit(child);
}

async function waitUntil(predicate: () => Promise<boolean>, message: string): Promise<void> {
  for (;;) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  await waitUntil(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`core exited before health: ${child.exitCode ?? child.signalCode}\n${childOutput.get(child)?.join('') ?? ''}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      return response.status === 200 && await response.text() === '{"status":"ok"}';
    } catch { return false; }
  }, 'management health did not become ready');
}

async function waitPortClosed(port: number): Promise<void> {
  await waitUntil(async () => {
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) }); return false; }
    catch { return true; }
  }, `port ${port} remained open`);
}

async function closePorts(lease: PortLease): Promise<void> {
  for (const port of lease.block.ports) await waitPortClosed(port);
  await ensureTestPortBlockClosed(lease.block);
}

function coreEnvironment(fixture: Fixture, lease: PortLease, workers = 2): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUNGEE_CONFIG_DB_PATH: fixture.dbPath,
    BUNGEE_ACCESS_DB_PATH: fixture.accessDbPath,
    BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
    BUNGEE_PLUGIN_SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
    CONFIG_PATH: fixture.configPath,
    DOTENV_CONFIG_QUIET: 'true',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    PLUGINS_DIR: fixture.pluginsPath,
    PORT: String(lease.base + 1),
    WORKER_COUNT: String(workers),
    BUNGEE_MANAGEMENT_HOST: '127.0.0.1',
    BUNGEE_MANAGEMENT_PORT: String(lease.base),
    BUNGEE_INGRESS_SUPERVISION_PORT: String(lease.base + 2),
  };
}

function spawnCore(fixture: Fixture, lease: PortLease, workers = 2, overrides: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [CORE_ENTRY], {
    cwd: fixture.root,
    env: { ...coreEnvironment(fixture, lease, workers), ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  childOutput.set(child, output);
  return child;
}

async function createDaemonHarness(root: string, lease: PortLease, options: Readonly<{
  home?: string;
  dataDirectory?: string;
  logsDirectory?: string;
  pluginsPath?: string;
  managementPort?: number;
  pluginSecretsKey?: string;
}> = {}): Promise<DaemonHarness> {
  const home = options.home ?? join(root, 'home');
  const dataDirectory = options.dataDirectory ?? join(home, 'data');
  const logsDirectory = options.logsDirectory ?? join(home, 'logs');
  const configDirectory = join(home, '.bungee');
  const runtime = join(configDirectory, 'run');
  const pluginsPath = options.pluginsPath ?? join(dataDirectory, 'plugins');
  await Promise.all([mkdir(dataDirectory, { recursive: true }), mkdir(logsDirectory, { recursive: true }), mkdir(runtime, { recursive: true }), mkdir(pluginsPath, { recursive: true })]);
  const metadataPath = join(runtime, 'daemon.json');
  const spawned: SpawnRecord[] = [];
  const logFiles = [join(configDirectory, 'bungee.log'), join(configDirectory, 'bungee.error.log')];
  const manager = new DaemonManager((executable, args, spawnOptions) => {
    const child = spawn(executable, [...args], spawnOptions);
    spawned.push({ child, executable, args: [...args] });
    return child;
  }, undefined, {
    runtimeDirectory: runtime, dataDirectory, logsDirectory, configDirectory,
    pidFile: join(configDirectory, 'bungee.pid'), logFile: logFiles[0], errorLogFile: logFiles[1],
    directLaunch: { executable: process.execPath, entrypoint: CORE_ENTRY },
    inheritedEnvironment: {
      ...process.env, HOME: home, USERPROFILE: home,
      BUNGEE_MANAGEMENT_PORT: String(options.managementPort ?? lease.base),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(lease.base + 2),
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_PLUGIN_SECRETS_KEY: options.pluginSecretsKey ?? Buffer.alloc(32, 9).toString('base64'),
      BUNGEE_FILE_LOG_DIR: logsDirectory, PLUGINS_DIR: pluginsPath, LOG_LEVEL: 'error',
    },
  });
  return { manager, spawned, metadataPath, runtime, logFiles };
}

function aggregate(upstreamPort: number, path = '/proxy'): ConfigurationAggregateV2 {
  return {
    plugin_activations: [],
    logical_configuration: {
      auth: { enabled: true, tokens: [TOKEN] }, plugins: [],
      services: [{
        id: '10000000-0000-4000-8000-000000000001', position: 1, name: 'canonical-service', plugins: [],
        endpoints: [{ id: '20000000-0000-4000-8000-000000000001', position: 1, target: `http://127.0.0.1:${upstreamPort}`, weight: 100, priority: 1, is_disabled: false, plugins: [] }],
      }],
      routes: [{ id: '30000000-0000-4000-8000-000000000001', position: 1, path, service_id: '10000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [] }],
    },
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

async function publish(port: number, upstreamPort: number, mutationId: string, revision: number, path = '/proxy'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT', headers: authHeaders(),
    body: JSON.stringify({ expected_revision: revision, aggregate: aggregate(upstreamPort, path), mutation_id: mutationId }),
  });
}

async function awaitConverged(port: number, mutationId: string): Promise<void> {
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json() as { operation?: { state?: string } };
    if (body.operation?.state === 'failed' || body.operation?.state === 'degraded') throw new Error(`operation ${mutationId} did not converge`);
    if (response.status !== 200) return false;
    return body.operation?.state === 'converged';
  }, `operation ${mutationId} did not converge`);
}

async function awaitBPublication(port: number, mutationId: string): Promise<void> {
  let operation: { state?: string; error_code?: string } = {};
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json() as { operation?: { state?: string; error_code?: string } };
    operation = body.operation ?? {};
    if (operation.state === 'converged') return true;
    if (operation.state === 'failed') throw new Error(`operation ${mutationId} failed`);
    if (operation.state === 'degraded') {
      if (operation.error_code === 'old_worker_drain_failed') return true;
      if (operation.error_code !== 'control_readiness_failed') throw new Error(`operation ${mutationId} degraded: ${operation.error_code ?? 'unknown'}`);
      return true;
    }
    if (response.status !== 200 && response.status !== 202) return false;
    return false;
  }, `operation ${mutationId} did not finish`);
  if (operation.state === 'converged' || operation.error_code === 'old_worker_drain_failed') return;

  let recovery: { trigger?: string; target_revision?: number; state?: string; attempt_count?: number } = {};
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json() as {
      publication?: { recovery?: { trigger?: string; target_revision?: number; state?: string; attempt_count?: number } | null };
    };
    recovery = body.publication?.recovery ?? {};
    if (recovery.trigger !== 'automatic' || recovery.target_revision !== 3) {
      throw new Error(`automatic recovery identity is invalid: ${JSON.stringify(recovery)}`);
    }
    if (recovery.state === 'stopped') throw new Error(`automatic recovery stopped: ${JSON.stringify(recovery)}`);
    return recovery.state === 'succeeded' && (recovery.attempt_count ?? 0) > 0;
  }, `automatic recovery for operation ${mutationId} did not succeed`);
  expect(recovery.trigger).toBe('automatic');
  expect(recovery.target_revision).toBe(3);
  expect(recovery.state).toBe('succeeded');
  expect(recovery.attempt_count).toBeGreaterThan(0);
}

function durableRevision(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true, strict: true });
  try { return database.query<{ active_revision: number }, []>('SELECT active_revision FROM configuration_state WHERE id=1').get()?.active_revision ?? -1; }
  finally { database.close(true); }
}

function durableController(dbPath: string): { readonly instanceId: string; readonly epoch: number; readonly controllerId: string } | null {
  const database = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = database.query<{ instance_id: string; controller_epoch: number; current_controller_id: string | null }, []>(
      'SELECT instance_id, controller_epoch, current_controller_id FROM supervision_state WHERE id=1',
    ).get();
    return row?.current_controller_id === null || row === null
      ? null : { instanceId: row.instance_id, epoch: row.controller_epoch, controllerId: row.current_controller_id };
  }
  finally { database.close(true); }
}

async function ingressClient(lease: PortLease, dbPath: string): Promise<{ readonly client: IngressControllerClient; readonly authority: { controller_epoch: number; controller_id: string } }> {
  const state = durableController(dbPath);
  if (state === null) throw new Error('controller state is unavailable');
  const identity = await (await fetch(`http://127.0.0.1:${lease.base + 2}/__supervision/identity`)).json() as {
    process_instance_id: string; boot_nonce: string;
  };
  const rootKey = new Uint8Array(Buffer.from(Buffer.alloc(32, 9).toString('base64'), 'base64'));
  const credential = deriveSupervisionProcessKey(rootKey, state.instanceId, 'ingress', identity.process_instance_id, identity.boot_nonce);
  return {
    client: new IngressControllerClient({ baseUrl: `http://127.0.0.1:${lease.base + 2}`, credential }),
    authority: { controller_epoch: state.epoch, controller_id: state.controllerId },
  };
}

async function cleanupDirect(children: readonly ChildProcess[], upstream: ReturnType<typeof Bun.serve> | undefined, root: string, lease: PortLease): Promise<void> {
  const errors: unknown[] = [];
  for (const child of children) {
    try { await stopChild(child); } catch (error) { errors.push(error); }
  }
  try { if (upstream !== undefined) await upstream.stop(true); } catch (error) { errors.push(error); }
  try { await closePorts(lease); } catch (error) { errors.push(error); }
  try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (error) { errors.push(error); }
  try { releaseTestPortBlock(lease.block); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, 'canonical test cleanup failed');
}

describe.serial('A core lifecycle', () => {
  let state: { root: string; lease: PortLease; fixture: Fixture; upstream: ReturnType<typeof Bun.serve>; daemon: DaemonHarness; first?: ChildProcess; second?: ChildProcess; competitor?: ChildProcess; firstController?: { readonly instanceId: string; readonly epoch: number; readonly controllerId: string }; marker: string } | undefined;
  afterAll(async () => {
    if (state === undefined) return;
    const failedState = state;
    state = undefined;
    const errors: unknown[] = [];
    try { await failedState.daemon.manager.stop(); } catch (error) { errors.push(error); }
    try { await cleanupDirect([failedState.competitor].filter((child): child is ChildProcess => child !== undefined), failedState.upstream, failedState.root, failedState.lease); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, 'canonical core cleanup failed');
  }, { timeout: 90_000 });
  test('starts the canonical master, separates ports, and publishes A', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-core');
    const lease = await reservePortBlock();
    const fixture = await makeFixture(root, 'core');
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(state?.marker ?? 'A') });
    if (upstream.port === undefined) throw new Error('upstream did not bind');
    const daemon = await createDaemonHarness(fixture.root, lease, {
      home: fixture.root, dataDirectory: join(fixture.root, 'data'), logsDirectory: join(fixture.root, 'custom'), pluginsPath: fixture.pluginsPath,
    });
    state = { root, lease, fixture, upstream, daemon, marker: 'A' };
    await daemon.manager.start({ workers: '2', port: String(lease.base + 1) });
    const first = daemon.spawned[0]?.child;
    if (first === undefined) throw new Error('core daemon child was not captured');
    state.first = first;
    await waitForHealth(lease.base, first);
    expect((await fetch(`http://127.0.0.1:${lease.base}/v1/data`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${lease.base + 1}/health`)).status).toBe(404);
    const unauthorized = await fetch(`http://127.0.0.1:${lease.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(upstream.port), mutation_id: randomUUID() }) });
    expect([401, 403]).toContain(unauthorized.status);
    const initialMutation = randomUUID();
    expect((await publish(lease.base, upstream.port, initialMutation, 1)).status).toBe(202);
    await awaitConverged(lease.base, initialMutation);
    expect(durableRevision(fixture.dbPath)).toBe(2);
    state.firstController = durableController(fixture.dbPath) ?? undefined;
    expect(state.firstController).not.toBeUndefined();
    expect(await (await fetch(`http://127.0.0.1:${lease.base + 1}/proxy`)).text()).toBe('A');
  }, { timeout: 90_000 });
  test('keeps A alive after SIGKILL, rejects the concurrent owner, and rejects stale mutation', async () => {
    if (state === undefined || state.firstController === undefined) throw new Error('core setup did not complete');
    const first = state.first;
    if (first === undefined) throw new Error('first daemon child was not captured');
    first.kill('SIGKILL');
    const firstExit = await childExit(first);
    expect(firstExit.code !== null || firstExit.signal !== null).toBeTrue();
    await state.daemon.manager.start({ workers: '2', port: String(state.lease.base + 1) });
    state.second = state.daemon.spawned[1]?.child;
    if (state.second === undefined) throw new Error('takeover daemon child was not captured');
    await waitForHealth(state.lease.base, state.second);
    await waitUntil(async () => durableController(state!.fixture.dbPath)?.controllerId !== state!.firstController?.controllerId, 'second master did not durably claim controller ownership');
    expect(await (await fetch(`http://127.0.0.1:${state.lease.base + 1}/proxy`)).text()).toBe('A');
    state.competitor = spawnCore(state.fixture, state.lease);
    expect((await childExit(state.competitor)).code).not.toBe(0);
    expect((await publish(state.lease.base, state.upstream.port!, randomUUID(), 1)).status).toBe(409);
    expect(durableRevision(state.fixture.dbPath)).toBe(2);
    const staleIngress = await ingressClient(state.lease, state.fixture.dbPath);
    await expect(staleIngress.client.status({ controller_epoch: state.firstController.epoch, controller_id: state.firstController.controllerId }, 50)).rejects.toMatchObject({ code: 'stale_controller' });
  }, { timeout: 90_000 });
  test('publishes B and closes management, public, and supervision ports', async () => {
    if (state === undefined || state.firstController === undefined || state.second === undefined) throw new Error('core setup did not complete');
    state.marker = 'B';
    const switched = randomUUID();
    expect((await publish(state.lease.base, state.upstream.port!, switched, 2)).status).toBe(202);
    await awaitBPublication(state.lease.base, switched);
    expect(durableRevision(state.fixture.dbPath)).toBe(3);
    expect(await (await fetch(`http://127.0.0.1:${state.lease.base + 1}/proxy`)).text()).toBe('B');
    await state.daemon.manager.stop();
    const secondExit = await childExit(state.second);
    expect(secondExit).toEqual({ code: 0, signal: null });
    await cleanupDirect([state.competitor].filter((child): child is ChildProcess => child !== undefined), state.upstream, state.root, state.lease);
    state = undefined;
  }, { timeout: 90_000 });
});

describe.serial('B daemon', () => {
  let state: { root: string; lease: PortLease; manager: DaemonManager; spawned: SpawnRecord[]; metadataPath: string; runtime: string; logFiles: readonly string[]; errors: string[] } | undefined;
  beforeAll(async () => {
    const root = makeCanonicalTempDir('bungee-canonical-daemon', { daemonSafe: true });
    const lease = await reservePortBlock();
    const home = join(root, 'home'); const data = join(home, 'data'); const logs = join(home, 'logs'); const runtime = join(home, '.bungee', 'run');
    const plugins = join(data, 'plugins'); const plugin = join(plugins, 'canonical-plugin');
    await Promise.all([mkdir(plugin, { recursive: true }), mkdir(logs, { recursive: true }), mkdir(runtime, { recursive: true })]);
    await Promise.all([writeFile(join(plugin, 'manifest.json'), JSON.stringify({ name: 'canonical-plugin', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js', capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.2.0' }, builtin: false, contributes: {}, configSchema: [], metadata: { name: 'canonical-plugin', description: 'canonical', icon: 'test' } })), writeFile(join(plugin, 'index.js'), "export default class CanonicalPlugin { static version = '1.0.0'; register() {} };")]);
    const daemon = await createDaemonHarness(root, lease, { home, dataDirectory: data, logsDirectory: logs, pluginsPath: plugins, managementPort: lease.base + 1, pluginSecretsKey: Buffer.alloc(32, 7).toString('base64') });
    state = { root, lease, ...daemon, errors: [] };
  }, { timeout: 90_000 });
  afterAll(async () => {
    if (state === undefined) return;
    const failedState = state;
    state = undefined;
    const errors: unknown[] = [];
    try { await failedState.manager.stop(); } catch (error) { failedState.errors.push(String(error)); errors.push(error); }
    try { await cleanupDirect([], undefined, failedState.root, failedState.lease); } catch (error) { failedState.errors.push(String(error)); errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, 'canonical daemon cleanup failed');
  }, { timeout: 90_000 });
  test('starts and rejects missing or wrong shutdown credentials', async () => {
    if (state === undefined) throw new Error('daemon setup did not complete');
    await state.manager.start({ workers: '1', port: String(state.lease.base) });
    const metadata = await readDaemonMetadataFile(state.metadataPath, { runtimeDirectory: state.runtime });
    if (metadata.state !== 'armed' || metadata.pid === null || metadata.management_port === null || metadata.instance_id === null) throw new Error('daemon did not arm');
    const firstChild = state.spawned[0]?.child;
    if (firstChild === undefined || firstChild.pid === undefined) throw new Error('daemon child was not captured');
    expect(metadata.pid).toBe(firstChild.pid);
    expect(metadata.shutdown_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await probeDaemonProcess(metadata.pid, { executable: metadata.executable, entrypoint: metadata.entrypoint }, metadata.boot_nonce)).toBe('exact');
    expect((await state.manager.getStatus()).running).toBeTrue();
    const endpoint = `http://${metadata.management_host}:${metadata.management_port}${DAEMON_SHUTDOWN_PATH}`;
    const common = { [DAEMON_BOOT_HEADER]: metadata.boot_nonce, [DAEMON_INSTANCE_HEADER]: metadata.instance_id, [DAEMON_PID_HEADER]: String(metadata.pid) };
    expect((await fetch(endpoint, { method: 'POST', headers: common })).status).not.toBe(202);
    expect((await fetch(endpoint, { method: 'POST', headers: { ...common, [DAEMON_AUTHORIZATION_HEADER]: 'Bearer wrong-secret' } })).status).not.toBe(202);
  }, { timeout: 90_000 });
  test('changes boot identity on restart and stops durably', async () => {
    if (state === undefined) throw new Error('daemon setup did not complete');
    const first = await readDaemonMetadataFile(state.metadataPath, { runtimeDirectory: state.runtime });
    const firstChild = state.spawned[0]?.child;
    if (firstChild === undefined) throw new Error('daemon child was not captured');
    await state.manager.restart({ workers: '1', port: String(state.lease.base) });
    expect(await childExit(firstChild)).toEqual({ code: 0, signal: null });
    const second = await readDaemonMetadataFile(state.metadataPath, { runtimeDirectory: state.runtime });
    if (second.state !== 'armed' || second.pid === null) throw new Error('restarted daemon did not arm');
    expect(second.boot_nonce).not.toBe(first.boot_nonce);
    expect(await probeDaemonProcess(second.pid, { executable: second.executable, entrypoint: second.entrypoint }, second.boot_nonce)).toBe('exact');
    if (first.pid === null) throw new Error('first daemon PID disappeared');
    expect(await probeDaemonProcess(first.pid, { executable: first.executable, entrypoint: first.entrypoint }, first.boot_nonce)).not.toBe('exact');
    const secondChild = state.spawned[1]?.child;
    if (secondChild === undefined || secondChild.pid === undefined) throw new Error('restarted daemon child was not captured');
    expect(second.pid).toBe(secondChild.pid);
    await state.manager.stop();
    expect(await childExit(secondChild)).toEqual({ code: 0, signal: null });
    expect(await Bun.file(state.metadataPath).exists()).toBeFalse();
    expect((await state.manager.getStatus()).running).toBeFalse();
    await closePorts(state.lease);
    const argv = state.spawned.flatMap(({ executable, args }) => [executable, ...args]).join('\n');
    const logs = (await Promise.all(state.logFiles.map(async (file) => await readFile(file, 'utf8').catch(() => '')))).join('\n');
    const evidence = `${argv}\n${logs}\n${state.errors.join('\n')}`;
    expect(evidence).not.toContain(first.shutdown_secret);
    expect(evidence).not.toContain(second.shutdown_secret);
    state = undefined;
  }, { timeout: 90_000 });
});

describe.serial('C benchmark', () => {
  type BenchmarkRecord = Readonly<{
    label: 'A' | 'B';
    order: readonly ['A', 'B'] | readonly ['B', 'A'];
    attempted: number;
    completed: number;
    errors: number;
    elapsedMs: number;
    rps: number;
    valid: boolean;
  }>;
  let state: { root: string; lease: PortLease; fixture: Fixture; upstream: ReturnType<typeof Bun.serve>; daemon: DaemonHarness; child?: ChildProcess; upstreamPort: number } | undefined;
  const benchmarkRuns: BenchmarkRecord[][] = [];
  beforeAll(async () => {
    const root = makeCanonicalTempDir('bungee-canonical-benchmark'); const lease = await reservePortBlock();
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ordinary') });
    if (upstream.port === undefined) throw new Error('benchmark upstream did not bind');
    const fixture = await makeFixture(root, 'benchmark');
    const daemon = await createDaemonHarness(fixture.root, lease, {
      home: fixture.root, dataDirectory: join(fixture.root, 'data'), logsDirectory: join(fixture.root, 'custom'), pluginsPath: fixture.pluginsPath,
    });
    state = { root, lease, fixture, upstream, daemon, upstreamPort: upstream.port };
    await daemon.manager.start({ workers: '2', port: String(lease.base + 1) });
    const child = daemon.spawned[0]?.child;
    if (child === undefined) throw new Error('benchmark daemon child was not captured');
    if (state === undefined) throw new Error('benchmark setup did not complete');
    state.child = child;
    await waitForHealth(lease.base, child);
    const mutationId = randomUUID();
    expect((await publish(lease.base, upstream.port, mutationId, 1)).status).toBe(202);
    await awaitConverged(lease.base, mutationId);
  }, { timeout: 90_000 });
  afterAll(async () => {
    if (state === undefined) return;
    const failedState = state;
    state = undefined;
    try { await failedState.daemon.manager.stop(); } finally { await cleanupDirect([], failedState.upstream, failedState.root, failedState.lease); }
  }, { timeout: 90_000 });
  const run = async (order: readonly ['A', 'B'] | readonly ['B', 'A']): Promise<BenchmarkRecord[]> => {
    if (state === undefined) throw new Error('benchmark setup did not complete');
    const records: BenchmarkRecord[] = [];
    for (const label of order) {
      const attempted = 5;
      let completed = 0;
      let errors = 0;
      const startedAt = performance.now();
      for (let index = 0; index < attempted; index += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${state.lease.base + 1}/proxy`);
          if (response.status === 200 && await response.text() === 'ordinary') completed += 1;
          else errors += 1;
        } catch { errors += 1; }
      }
      const elapsedMs = performance.now() - startedAt;
      const rps = completed / (elapsedMs / 1_000);
      records.push({ label, order, attempted, completed, errors, elapsedMs, rps, valid: attempted > 0 && completed === attempted && errors === 0 });
    }
    return records;
  };
  const assertRecords = (records: readonly BenchmarkRecord[], order: BenchmarkRecord['order']): void => {
    const parsed = JSON.parse(JSON.stringify({ records })) as { records: BenchmarkRecord[] };
    expect(parsed.records).toHaveLength(order.length);
    for (const [index, record] of parsed.records.entries()) {
      expect(Object.keys(record).sort()).toEqual(['attempted', 'completed', 'elapsedMs', 'errors', 'label', 'order', 'rps', 'valid']);
      expect(record.label).toBe(order[index]);
      expect(record.order).toEqual(order);
      expect(record.attempted).toBeGreaterThan(0);
      expect(record.completed).toBe(record.attempted);
      expect(record.errors).toBe(0);
      expect(Number.isFinite(record.attempted)).toBeTrue();
      expect(Number.isFinite(record.completed)).toBeTrue();
      expect(Number.isFinite(record.errors)).toBeTrue();
      expect(Number.isFinite(record.elapsedMs)).toBeTrue();
      expect(record.elapsedMs).toBeGreaterThan(0);
      expect(Number.isFinite(record.rps)).toBeTrue();
      expect(record.rps).toBeGreaterThan(0);
      expect(record.rps).toBe(record.completed / (record.elapsedMs / 1_000));
      expect(record.valid).toBe(record.attempted > 0 && record.completed === record.attempted && record.errors === 0);
      expect(record.valid).toBeTrue();
    }
  };
  test('AB runs the canonical proxy in A/B order', async () => {
    const records = await run(['A', 'B']);
    assertRecords(records, ['A', 'B']);
    benchmarkRuns.push(records);
  }, { timeout: 90_000 });
  test('BA runs the same canonical proxy in B/A order and cleans up', async () => {
    if (state === undefined) throw new Error('benchmark setup did not complete');
    const records = await run(['B', 'A']);
    assertRecords(records, ['B', 'A']);
    benchmarkRuns.push(records);
    await state.daemon.manager.stop();
    if (state.child === undefined) throw new Error('benchmark daemon child was not captured');
    expect(await childExit(state.child)).toEqual({ code: 0, signal: null });
    await cleanupDirect([], state.upstream, state.root, state.lease);
    state = undefined;
    console.log(JSON.stringify({ benchmark: 'canonical', records: benchmarkRuns.flat() }));
  }, { timeout: 90_000 });
});
