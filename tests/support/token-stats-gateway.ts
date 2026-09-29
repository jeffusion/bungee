import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  claimTestPortBlock,
  ensureTestPortBlockClosed,
  makeTestPortBlock,
  quarantineTestPortBlock,
  releaseTestPortBlock,
  type TestPortBlock,
} from './test-port-block-broker';

const CORE_ENTRY = resolve(import.meta.dir, '../../packages/core/dist/main.js');
const TOKEN_STATS_DIST = resolve(import.meta.dir, '../../packages/core/dist/plugins/token-stats');
const SETUP_TIMEOUT_MS = 30_000;

export type GatewayFixture = Readonly<{
  root: string;
  configDbPath: string;
  accessDbPath: string;
  pluginsPath: string;
  pluginSecretsKey: string;
  token: string;
}>;

export type PortLease = Readonly<{ base: number; block: TestPortBlock }>;
export type OwnedWorker = Readonly<{ pid: number; workerInstanceId: string }>;
export type OwnedMaster = {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly token: string;
  readonly workers: Map<string, OwnedWorker>;
  workerInventoryComplete: boolean;
};
export type StopOwnedMasterOptions = Readonly<{ graceTimeoutMs?: number; forceTimeoutMs?: number }>;

export class OwnedMasterShutdownError extends Error {
  constructor(message: string, readonly workersVerifiedExited: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OwnedMasterShutdownError';
  }
}

async function listenPort(port?: number): Promise<ReturnType<typeof Bun.serve>> {
  return Bun.serve({ hostname: '127.0.0.1', port: port ?? 0, fetch: () => new Response('reserved') });
}

export async function reservePortBlock(): Promise<PortLease> {
  for (;;) {
    const first = await listenPort();
    const base = first.port;
    let second: ReturnType<typeof Bun.serve> | undefined;
    let third: ReturnType<typeof Bun.serve> | undefined;
    let fourth: ReturnType<typeof Bun.serve> | undefined;
    if (base === undefined || base < 1 || base > 65_531) {
      await first.stop(true);
      continue;
    }
    const block = makeTestPortBlock(base);
    try {
      second = await listenPort(base + 1);
      third = await listenPort(base + 2);
      fourth = await listenPort(base + 3);
      if (!claimTestPortBlock(block)) throw new Error('test port block already claimed');
      await Promise.all([first.stop(true), second.stop(true), third.stop(true), fourth.stop(true)]);
      await ensureTestPortBlockClosed(block);
      return { base, block };
    } catch (error) {
      await Promise.allSettled([first.stop(true), second?.stop(true), third?.stop(true), fourth?.stop(true)]
        .filter((pending): pending is Promise<void> => pending !== undefined));
      quarantineTestPortBlock(block);
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw error;
    }
  }
}

export async function releasePortBlock(lease: PortLease): Promise<void> {
  try {
    await ensureTestPortBlockClosed(lease.block);
  } catch (error) {
    quarantineTestPortBlock(lease.block);
    throw error;
  }
  if (!releaseTestPortBlock(lease.block)) throw new Error('test port lease was not active');
}

export async function createGatewayFixture(parent: string): Promise<GatewayFixture> {
  const root = await mkdtemp(join(parent, 'token-stats-gateway-'));
  try {
    const pluginsPath = join(root, 'plugins');
    await mkdir(pluginsPath, { recursive: true });
    await cp(TOKEN_STATS_DIST, join(pluginsPath, 'token-stats'), { recursive: true, errorOnExist: true });
    await writeFile(join(root, 'config.json'), '{invalid json', 'utf8');
    return {
      root,
      configDbPath: join(root, 'config.db'),
      accessDbPath: join(root, 'access.db'),
      pluginsPath,
      pluginSecretsKey: randomBytes(32).toString('base64'),
      token: randomBytes(32).toString('base64url'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function spawnMaster(fixture: GatewayFixture, lease: PortLease): OwnedMaster {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) safeEnv[name] = process.env[name];
  }
  const child = spawn(process.execPath, [CORE_ENTRY], {
    cwd: fixture.root,
    env: {
      ...safeEnv,
      HOME: fixture.root,
      USERPROFILE: fixture.root,
      BUNGEE_CONFIG_DB_PATH: fixture.configDbPath,
      BUNGEE_ACCESS_DB_PATH: fixture.accessDbPath,
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_PLUGIN_SECRETS_KEY: fixture.pluginSecretsKey,
      BUNGEE_MANAGEMENT_HOST: '127.0.0.1',
      BUNGEE_MANAGEMENT_PORT: String(lease.base),
      BUNGEE_MASTER_CONTROL_PORT: String(lease.block.ports[3]),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(lease.block.ports[2]),
      BUNGEE_FILE_LOG_DIR: join(fixture.root, 'logs'),
      CONFIG_PATH: join(fixture.root, 'config.json'),
      HOST: '127.0.0.1',
      PORT: String(lease.block.ports[1]),
      WORKER_COUNT: '2',
      PLUGINS_DIR: fixture.pluginsPath,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  return { child, output, token: fixture.token, workers: new Map(), workerInventoryComplete: false };
}

export async function waitForHealth(master: OwnedMaster, port: number): Promise<void> {
  await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error(`master exited before health (${master.child.exitCode ?? master.child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      return response.status === 200 && await response.text() === '{"status":"ok"}';
    } catch { return false; }
  }, 'management health did not become ready', SETUP_TIMEOUT_MS);
  await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error(`master exited before its worker inventory was captured (${master.child.exitCode ?? master.child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, {
        headers: { authorization: `Bearer ${master.token}` },
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return false;
      const body = await response.json() as { workers?: Array<{ pid?: number; worker_instance_id?: string }> };
      if (body.workers?.length !== 2 || body.workers.some((worker) => !Number.isSafeInteger(worker.pid)
        || typeof worker.worker_instance_id !== 'string')) return false;
      recordOwnedWorkers(master, body.workers.map((worker) => ({
        pid: worker.pid!, worker_instance_id: worker.worker_instance_id!,
      })));
      master.workerInventoryComplete = true;
      return true;
    } catch { return false; }
  }, 'master did not expose two workers with process identities', SETUP_TIMEOUT_MS);
}

export function recordOwnedWorkers(
  master: OwnedMaster,
  workers: readonly { readonly pid: number; readonly worker_instance_id: string }[],
): void {
  for (const worker of workers) {
    if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0 || !/^[0-9a-f-]{36}$/.test(worker.worker_instance_id)) {
      throw new Error('runtime returned an invalid worker PID or instance ID');
    }
    master.workers.set(worker.worker_instance_id, { pid: worker.pid, workerInstanceId: worker.worker_instance_id });
  }
  if (master.workers.size < 2) throw new Error('owned worker inventory is incomplete');
  master.workerInventoryComplete = true;
}

export async function waitUntil(
  predicate: () => Promise<boolean>, message: string, timeoutMs = SETUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; }
    catch (error) { lastError = error; }
    await Bun.sleep(50);
  }
  throw new Error(`${message}${lastError === undefined ? '' : `: ${String(lastError)}`}`);
}

export async function stopOwnedMaster(master: OwnedMaster, options: StopOwnedMasterOptions = {}): Promise<void> {
  const child = master.child;
  const graceTimeoutMs = options.graceTimeoutMs ?? 15_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  let forcedAfterTimeout = false;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try {
    await waitUntil(async () => child.exitCode !== null || child.signalCode !== null,
      'master did not exit after SIGTERM', graceTimeoutMs);
  } catch {
    forcedAfterTimeout = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try {
      await waitUntil(async () => child.exitCode !== null || child.signalCode !== null,
        'owned master did not exit after SIGKILL', forceTimeoutMs);
    } catch (error) {
      throw new OwnedMasterShutdownError('owned master remained alive after bounded SIGKILL; temporary evidence must be retained', false, { cause: error });
    }
  }

  let workersVerifiedExited = false;
  try {
    await waitForOwnedWorkersExited(master, graceTimeoutMs);
    workersVerifiedExited = true;
  } catch (error) {
    throw new OwnedMasterShutdownError(
      `owned workers could not be confirmed exited or identity-mismatched; temporary evidence must be retained: ${errorMessage(error)}`,
      false,
      { cause: error },
    );
  }

  if (forcedAfterTimeout) {
    throw new OwnedMasterShutdownError(
      `master exceeded graceful shutdown deadline and required SIGKILL (exitCode=${child.exitCode}, signalCode=${child.signalCode}); workersVerifiedExited=${workersVerifiedExited}`,
      workersVerifiedExited,
    );
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new OwnedMasterShutdownError(
      `master graceful shutdown failed (exitCode=${child.exitCode}, signalCode=${child.signalCode}); workersVerifiedExited=${workersVerifiedExited}`,
      workersVerifiedExited,
    );
  }
}

type WorkerProcessIdentity = 'gone' | 'different' | 'same' | 'unknown';

async function inspectWorkerIdentity(worker: OwnedWorker): Promise<WorkerProcessIdentity> {
  try {
    const bytes = await readFile(`/proc/${worker.pid}/environ`);
    const variables = bytes.toString('utf8').split('\0');
    const currentId = variables.find((item) => item.startsWith('BUNGEE_WORKER_INSTANCE_ID='))?.slice('BUNGEE_WORKER_INSTANCE_ID='.length);
    return currentId === worker.workerInstanceId ? 'same' : 'different';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}

async function waitForOwnedWorkersExited(master: OwnedMaster, timeoutMs: number): Promise<void> {
  if (!master.workerInventoryComplete || master.workers.size < 2) {
    throw new Error('worker inventory was never authoritatively captured');
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all([...master.workers.values()].map(async (worker) => ({
      worker,
      state: await inspectWorkerIdentity(worker),
    })));
    const unknown = states.filter(({ state }) => state === 'unknown');
    if (unknown.length) throw new Error(`cannot inspect owned worker PID(s): ${unknown.map(({ worker }) => worker.pid).join(',')}`);
    if (states.every(({ state }) => state === 'gone' || state === 'different')) return;
    if (Date.now() >= deadline) {
      const remaining = states.filter(({ state }) => state === 'same').map(({ worker }) => `${worker.pid}/${worker.workerInstanceId}`);
      throw new Error(`owned worker process identity still matches after shutdown: ${remaining.join(',')}`);
    }
    await Bun.sleep(50);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanupGatewayFixture(fixture: GatewayFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

export function scrub(value: string, fixture: GatewayFixture): string {
  return value.split(fixture.token).join('[REDACTED_TOKEN]')
    .split(fixture.pluginSecretsKey).join('[REDACTED_PLUGIN_KEY]');
}

export async function requestJson(url: string, init: RequestInit, fixture: GatewayFixture): Promise<{
  response: Response; body: unknown; text: string;
}> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(5_000) });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok && new URL(url).pathname === '/api/config') {
    throw new Error(`config API ${response.status}: ${scrub(text, fixture)}`);
  }
  return { response, body, text };
}
