import {initializePluginStateFixture} from './plugin-state-fixture';
import { ConfigRepository } from '../../packages/core/src/config-storage';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DaemonManager } from '../../packages/cli/src/daemon/manager';
import { captureProcessIdentity, probeProcessIdentity, type CapturedProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { makeCanonicalTempDir } from './canonical-temp';
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
}>;

export type PortLease = Readonly<{ base: number; block: TestPortBlock }>;
export type OwnedWorker = Readonly<{ pid: number; workerInstanceId: string; identity?: CapturedProcessIdentity }>;
export type OwnedMaster = {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly workers: Map<string, OwnedWorker>;
  readonly shutdown?: () => Promise<void>;
  readonly diagnostics?: () => Promise<string>;
  workerInventoryComplete: boolean;
};
export type StopOwnedMasterOptions = Readonly<{ graceTimeoutMs?: number; forceTimeoutMs?: number }>;
export type GatewayMasterStartupState = { attempted: boolean; master?: OwnedMaster; errors: unknown[] };

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

export function quarantinePortBlock(lease: PortLease): void {
  quarantineTestPortBlock(lease.block);
}

export async function createGatewayFixture(): Promise<GatewayFixture> {
  const root = makeCanonicalTempDir('token-stats-gateway', { daemonSafe: true });
  try {
    const pluginsPath = join(root, 'data', 'plugins');
    await Promise.all([
      mkdir(pluginsPath, { recursive: true }),
      mkdir(join(root, 'data'), { recursive: true }),
      mkdir(join(root, 'logs'), { recursive: true }),
      mkdir(join(root, '.bungee', 'run'), { recursive: true }),
    ]);
    await cp(TOKEN_STATS_DIST, join(pluginsPath, 'token-stats'), { recursive: true, errorOnExist: true });
    await cp(resolve(import.meta.dir, '../../packages/core/dist/plugins/token-metering'), join(pluginsPath, 'token-metering'), { recursive: true, errorOnExist: true });
    await cp(resolve(import.meta.dir, '../../packages/core/dist/plugins/models-dev'), join(pluginsPath, 'models-dev'), { recursive: true, errorOnExist: true });
    const probePath = join(pluginsPath, 'catalog-version-probe');
    await mkdir(probePath);
    await cp(join(import.meta.dir, 'catalog-version-probe.ts'), join(probePath, 'main.ts'));
    await writeFile(join(probePath, 'manifest.json'), JSON.stringify({
      name: 'catalog-version-probe', version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
      capabilities: ['hooks', 'dynamicRuntimeLoad'], runtimeScope: 'global', main: 'main.ts',
      uiExtensionMode: 'none', engines: { bungee: '^5.0.0' }, configSchema: [], dependencies: { 'models-dev': '^1.0.0' },
      services: { consumes: [{ plugin: 'models-dev', id: 'models-dev.catalog.v1', version: 1, process: 'worker' }] },
    }));
    await writeFile(join(root, 'config.json'), '{invalid json', 'utf8');
    const repository = ConfigRepository.open(join(root, 'data', 'bungee.db'));
    repository.close();
    await initializePluginStateFixture(join(root, 'data', 'bungee.db'));
    return {
      root,
      configDbPath: join(root, 'data', 'bungee.db'),
      accessDbPath: join(root, 'logs', 'access.db'),
      pluginsPath,
      pluginSecretsKey: randomBytes(32).toString('base64'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function spawnMaster(
  fixture: GatewayFixture,
  lease: PortLease,
  onSpawn?: (master: OwnedMaster) => void,
  logLevel: 'error' | 'debug' = 'error',
): Promise<OwnedMaster> {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'ProgramFiles']) {
    if (process.env[name] !== undefined) safeEnv[name] = process.env[name];
  }
  const runtimeDirectory = join(fixture.root, '.bungee', 'run');
  const dataDirectory = join(fixture.root, 'data');
  const logsDirectory = join(fixture.root, 'logs');
  const configDirectory = join(fixture.root, '.bungee');
  const logFile = join(configDirectory, 'bungee.log');
  const errorLogFile = join(configDirectory, 'bungee.error.log');
  const environment = {
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
      BUNGEE_FILE_LOG_DIR: logsDirectory,
      CONFIG_PATH: join(fixture.root, 'config.json'),
      HOST: '127.0.0.1',
      PORT: String(lease.block.ports[1]),
      WORKER_COUNT: '2',
      PLUGINS_DIR: fixture.pluginsPath,
      LOG_LEVEL: logLevel,
    };
  const owned: { child?: ChildProcess } = {};
  const output: string[] = [];
  let masterHandle: OwnedMaster | undefined;
  const manager = new DaemonManager((executable, args, options) => {
    owned.child = spawn(executable, [...args], options);
    owned.child.once('error', (error) => output.push(`master-spawn-error ${error.name}:${error.message}`));
    owned.child.once('exit', (code, signal) => output.push(`master-exit code=${String(code)} signal=${String(signal)}`));
    masterHandle = {
      child: owned.child,
      output,
      workers: new Map(),
      workerInventoryComplete: false,
      shutdown: () => manager.stop(),
      diagnostics: async () => {
        const appLogs = await readdir(logsDirectory).catch(() => []);
        const paths = [logFile, errorLogFile, ...appLogs.filter((name) => /(?:error|stderr|stdout|\.log)/i.test(name)).map((name) => join(logsDirectory, name))];
        const chunks = await Promise.all(paths.map(async (path) => {
          try {
            const text = await readFile(path, 'utf8');
            return scrub(`${path.slice(fixture.root.length + 1)}:\n${text}`, fixture).slice(-8_192);
          } catch { return ''; }
        }));
        return chunks.filter(Boolean).join('\n').slice(-24_576);
      },
    };
    onSpawn?.(masterHandle);
    return owned.child;
  }, undefined, {
    runtimeDirectory, dataDirectory, logsDirectory, configDirectory,
    pidFile: join(configDirectory, 'bungee.pid'), logFile, errorLogFile,
    directLaunch: { executable: process.execPath, entrypoint: CORE_ENTRY },
    inheritedEnvironment: environment,
  });
  try { await manager.start({ workers: '2' }); }
  catch (error) {
    const diagnostics = await masterHandle?.diagnostics?.() ?? '';
    const summary = scrub(`${errorMessage(error)}; evidenceRoot=${fixture.root}; ${output.join(' ')}; diagnostics=${diagnostics}`, fixture);
    throw new Error(summary.slice(-24_576));
  }
  if (masterHandle === undefined) throw new Error('daemon manager did not spawn the master');
  return masterHandle;
}

export async function startTrackedGatewayMaster(
  state: GatewayMasterStartupState,
  fixture: GatewayFixture,
  lease: PortLease,
  launch: typeof spawnMaster = spawnMaster,
): Promise<OwnedMaster> {
  state.attempted = true;
  state.master = undefined;
  try {
    return await launch(fixture, lease, (owned) => { state.master = owned; });
  } catch (error) {
    state.errors.push(error);
    throw error;
  }
}

export async function waitForHealth(master: OwnedMaster, port: number, fixture: GatewayFixture): Promise<void> {
  try {
    await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error('master exited before health');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json() as {live?: boolean; management?: boolean};
      return response.status === 200 && health.live === true && health.management === true;
    } catch { return false; }
    }, 'management health did not become ready', SETUP_TIMEOUT_MS);
    await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error('master exited before its worker inventory was captured');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return false;
      const body = await response.json() as { workers?: Array<{ pid?: number; worker_instance_id?: string }> };
      if (body.workers?.length !== 2 || body.workers.some((worker) => !Number.isSafeInteger(worker.pid)
        || typeof worker.worker_instance_id !== 'string')) return false;
      await recordOwnedWorkers(master, body.workers.map((worker) => ({
        pid: worker.pid!, worker_instance_id: worker.worker_instance_id!,
      })));
      master.workerInventoryComplete = true;
      return true;
    } catch { return false; }
    }, 'master did not expose two workers with process identities', SETUP_TIMEOUT_MS);
  } catch (error) {
    const diagnostics = await master.diagnostics?.() ?? master.output.join('');
    const summary = scrub(`${errorMessage(error)}; master exit=${master.child.exitCode ?? master.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`, fixture);
    throw new Error(summary.slice(-24_576));
  }
}

export async function recordOwnedWorkers(
  master: OwnedMaster,
  workers: readonly { readonly pid: number; readonly worker_instance_id: string }[],
): Promise<void> {
  for (const worker of workers) {
    if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0 || !/^[0-9a-f-]{36}$/.test(worker.worker_instance_id)) {
      throw new Error('runtime returned an invalid worker PID or instance ID');
    }
    const identity = await captureProcessIdentity(worker.pid, worker.worker_instance_id);
    master.workers.set(worker.worker_instance_id, { pid: worker.pid, workerInstanceId: worker.worker_instance_id, identity });
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
    catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith('master exited')) throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${message}${lastError === undefined ? '' : `: ${String(lastError)}`}`);
}

export async function stopOwnedMaster(master: OwnedMaster, options: StopOwnedMasterOptions = {}): Promise<void> {
  const child = master.child;
  const graceTimeoutMs = options.graceTimeoutMs ?? 15_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  let forcedAfterTimeout = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (master.shutdown === undefined) throw new OwnedMasterShutdownError('owned master has no authenticated shutdown action; evidence must be retained', false);
    await master.shutdown();
  }
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
      `master graceful shutdown failed (exitCode=${child.exitCode}, signalCode=${child.signalCode}); workersVerifiedExited=${workersVerifiedExited}; diagnostics=${await master.diagnostics?.() ?? master.output.join('')}`,
      workersVerifiedExited,
    );
  }
}

type WorkerProcessIdentity = 'gone' | 'different' | 'same' | 'unknown';

async function inspectWorkerIdentity(worker: OwnedWorker): Promise<WorkerProcessIdentity> {
  if (worker.identity === undefined) return 'unknown';
  const result = await probeProcessIdentity(worker.identity);
  return result === 'dead' ? 'gone' : result === 'mismatch' ? 'different' : result === 'exact' ? 'same' : 'unknown';
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

export async function cleanupGatewayFixture(
  fixture: GatewayFixture,
  proof: Readonly<{ startupAttempted: boolean; master?: OwnedMaster; shutdownVerified: boolean; portsVerifiedClosed: boolean }> = {
    startupAttempted: false, shutdownVerified: true, portsVerifiedClosed: true,
  },
): Promise<boolean> {
  const masterVerified = proof.shutdownVerified && proof.master !== undefined
    && proof.master.child.exitCode === 0 && proof.master.child.signalCode === null
    && proof.master.workerInventoryComplete && proof.master.workers.size >= 2;
  if (proof.startupAttempted && (!masterVerified || !proof.portsVerifiedClosed)) return false;
  await rm(fixture.root, { recursive: true, force: true });
  return true;
}

export function scrub(value: string, fixture: GatewayFixture): string {
  return value.split(fixture.pluginSecretsKey).join('[REDACTED_PLUGIN_KEY]');
}

export function safeGatewayError(error: unknown, fixture: GatewayFixture, maxLength = 8_192): string {
  return scrub(errorMessage(error), fixture).slice(-maxLength);
}

export async function requestJson(url: string, init: RequestInit, fixture: GatewayFixture): Promise<{
  response: Response; body: unknown; text: string;
}> {
  const startedAt = performance.now();
  const signal = init.signal ?? AbortSignal.timeout(5_000);
  let stage = 'response headers';
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { ...init, signal });
    stage = `response body (status=${response.status})`;
    text = await response.text();
  } catch (error) {
    // Exclude query strings, headers and bodies: these may contain credentials.
    throw new Error(`gateway HTTP ${init.method ?? 'GET'} ${new URL(url).pathname} failed during ${stage}; elapsedMs=${Math.round(performance.now() - startedAt)}; aborted=${signal.aborted}; ${safeGatewayError(error, fixture)}`);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok && new URL(url).pathname === '/api/config') {
    throw new Error(`config API ${response.status}: ${scrub(text, fixture)}`);
  }
  return { response, body, text };
}
