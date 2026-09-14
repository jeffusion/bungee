import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupProcesses, ProcessRegistry, processAlive } from './process-cleanup';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/main.ts');
const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/main.js');
const WAIT_STEP_MS = 25;
const spawnedProcessRegistries = new Set<ProcessRegistry>();
const spawnedProcessMonitors = new Map<ProcessRegistry, () => void>();
export const MASTER_ROOT_KEY = new Uint8Array(32).fill(9);
const FIXTURE_MANIFEST = {
  name: 'fixture-plugin',
  version: '1.0.0',
  schemaVersion: 2,
  artifactKind: 'runtime-plugin',
  main: 'index.js',
  capabilities: ['hooks', 'dynamicRuntimeLoad'],
  uiExtensionMode: 'none',
  engines: { bungee: '^4.2.0' },
  builtin: false,
  contributes: {},
  metadata: { name: 'metadata.name', description: 'plugin.description', icon: 'test' },
  configSchema: [],
  translations: { en: { 'metadata.name': 'Fixture', 'plugin.description': 'Test fixture' } },
} as const;
const FIXTURE_MODULE = `const plugin = class {
  static version = '1.0.0';
  register() {}
};
Object.defineProperty(plugin, 'name', { value: 'fixture-plugin' });
export default plugin;
`;

export type MasterEntry = {
  readonly name: 'source' | 'dist' | 'compiled';
  readonly executable: string;
  readonly args: readonly string[];
};

export type MasterFixture = {
  readonly root: string;
  readonly dbPath: string;
  readonly accessDbPath: string;
  readonly configPath: string;
  readonly pluginsPath: string;
};

export type RunningMaster = {
  readonly child: ChildProcess;
  readonly processes: ProcessRegistry;
  readonly stopMonitoring: () => void;
  readonly output: () => string;
};

export type SpawnMasterOptions = {
  /** The deterministic parent environment used by real-process tests. */
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Legacy v6 targets use one public/control listener. */
  readonly layout?: 'split' | 'legacy-single-port';
  /** Useful for short-lived benchmark processes which do their own cleanup. */
  readonly stopProcessMonitor?: boolean;
};

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EACCES') return false;
    throw error;
  }
}

export async function createMasterFixture(prefix: string): Promise<MasterFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const configPath = join(root, 'invalid-config.json');
  const pluginsPath = join(root, 'plugins');
  const pluginPath = join(pluginsPath, FIXTURE_MANIFEST.name);
  await mkdir(pluginPath, { recursive: true });
  await writeFile(configPath, '{invalid json', 'utf8');
  await writeFile(join(pluginPath, 'manifest.json'), `${JSON.stringify(FIXTURE_MANIFEST)}\n`, 'utf8');
  await writeFile(join(pluginPath, 'index.js'), FIXTURE_MODULE, 'utf8');
  return {
    root,
    dbPath: join(root, 'data', 'config.db'),
    accessDbPath: join(root, 'custom', 'access.db'),
    configPath,
    pluginsPath,
  };
}

export function sourceMasterEntry(): MasterEntry {
  return { name: 'source', executable: process.execPath, args: [SOURCE_ENTRY] };
}

export async function removeFixture(fixture: MasterFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

export async function freePort(): Promise<number> {
  for (;;) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = server.port;
    if (port === undefined) { await server.stop(true); continue; }
    let next: ReturnType<typeof Bun.serve> | null = null;
    let nextNext: ReturnType<typeof Bun.serve> | null = null;
    try {
      next = Bun.serve({ hostname: '127.0.0.1', port: port + 1, fetch: () => new Response('reserved') });
      nextNext = Bun.serve({ hostname: '127.0.0.1', port: port + 2, fetch: () => new Response('reserved') });
      await server.stop(true); await next.stop(true); await nextNext.stop(true);
      return port;
    } catch {
      await server.stop(true); if (next !== null) await next.stop(true); if (nextNext !== null) await nextNext.stop(true);
    }
  }
}

export async function buildMasterEntries(outputRoot: string): Promise<readonly MasterEntry[]> {
  const build = Bun.spawnSync({
    cmd: [process.execPath, 'run', 'build'],
    cwd: PACKAGE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));

  const executable = join(outputRoot, 'bungee-real-process');
  const compile = Bun.spawnSync({
    cmd: [process.execPath, 'build', '--compile', SOURCE_ENTRY, '--outfile', executable],
    cwd: PACKAGE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (compile.exitCode !== 0) throw new Error(new TextDecoder().decode(compile.stderr));
  return [
    { name: 'source', executable: process.execPath, args: [SOURCE_ENTRY] },
    { name: 'dist', executable: process.execPath, args: [DIST_ENTRY] },
    { name: 'compiled', executable, args: [] },
  ];
}

export function spawnMaster(
  entry: MasterEntry,
  fixture: MasterFixture,
  port: number,
  workerCount = 2,
  cwd = fixture.root,
  accessDbPath = fixture.accessDbPath,
  envOverrides: Readonly<NodeJS.ProcessEnv> = {},
  options: SpawnMasterOptions = {},
): RunningMaster {
  const split = options.layout !== 'legacy-single-port';
  const baseEnv = options.baseEnv ?? process.env;
  const fixedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    BUNGEE_CONFIG_DB_PATH: fixture.dbPath,
    BUNGEE_ACCESS_DB_PATH: accessDbPath,
    BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
    BUNGEE_PLUGIN_SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
    BUNGEE_STARTUP_APPLY_TIMEOUT_MS: '10000',
    BUNGEE_DRAIN_TIMEOUT_MS: '1000',
    BUNGEE_SHUTDOWN_TIMEOUT_MS: '500',
    BUNGEE_WORKER_ATTACH_GRACE_MS: '30000',
    CONFIG_PATH: fixture.configPath,
    DOTENV_CONFIG_QUIET: 'true',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    PLUGINS_DIR: fixture.pluginsPath,
    PORT: String(split ? port + 1 : port),
    WORKER_COUNT: String(workerCount),
  };
  if (split) {
    fixedEnv.BUNGEE_MANAGEMENT_HOST = '127.0.0.1';
    fixedEnv.BUNGEE_MANAGEMENT_PORT = String(port);
    fixedEnv.BUNGEE_INGRESS_SUPERVISION_PORT = String(port + 2);
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...fixedEnv,
    ...envOverrides,
  };
  if (options.layout === 'legacy-single-port') {
    delete childEnv.BUNGEE_MANAGEMENT_HOST;
    delete childEnv.BUNGEE_MANAGEMENT_PORT;
    delete childEnv.BUNGEE_INGRESS_SUPERVISION_PORT;
  }
  const child = spawn(entry.executable, [...entry.args], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  const processes = new ProcessRegistry();
  processes.registerChild(child);
  const monitor = setInterval(async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      clearInterval(monitor);
      return;
    }
    processes.registerPids(await childPids(child.pid));
  }, WAIT_STEP_MS);
  monitor.unref?.();
  const stopMonitoring = () => clearInterval(monitor);
  child.once('exit', stopMonitoring);
  if (options.stopProcessMonitor !== true) spawnedProcessMonitors.set(processes, stopMonitoring);
  if (options.stopProcessMonitor === true) stopMonitoring();
  spawnedProcessRegistries.add(processes);
  return { child, processes, stopMonitoring, output: () => Buffer.concat(chunks).toString('utf8') };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(WAIT_STEP_MS);
  }
  throw new Error(message);
}

export async function waitForHealth(port: number, master: RunningMaster): Promise<void> {
  await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error(`master exited before health check: ${master.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(250),
      });
      return response.status === 200 && await response.text() === '{"status":"ok"}';
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }, `master did not serve health: ${master.output()}`);
}

export async function childPids(pid: number): Promise<readonly number[]> {
  try {
    const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return text.trim() === '' ? [] : text.trim().split(/\s+/).map(Number);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

export async function isWorkerProcess(pid: number): Promise<boolean> {
  try {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environment.split('\0').includes('BUNGEE_ROLE=worker');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EACCES') return false;
    throw error;
  }
}

export async function isIngressProcess(pid: number): Promise<boolean> {
  try {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environment.split('\0').includes('BUNGEE_ROLE=ingress');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EACCES') return false;
    throw error;
  }
}

export function workerDescriptorsDirectory(fixture: MasterFixture): string {
  return join(fixture.root, 'data', 'runtime', 'workers');
}

export async function readWorkerDescriptors(fixture: MasterFixture): Promise<readonly Record<string, unknown>[]> {
  const directory = workerDescriptorsDirectory(fixture);
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>));
}

export async function waitForWorkerDescriptors(
  fixture: MasterFixture,
  count: number,
  timeoutMs = 15_000,
): Promise<readonly Record<string, unknown>[]> {
  let descriptors: readonly Record<string, unknown>[] = [];
  await waitUntil(async () => {
    descriptors = await readWorkerDescriptors(fixture);
    return descriptors.length === count;
  }, `fixture did not expose ${count} worker descriptors`, timeoutMs);
  return descriptors;
}

export async function waitForWorkerPids(masterPid: number, count: number): Promise<readonly number[]> {
  let workers: readonly number[] = [];
  await waitUntil(async () => {
    workers = (await Promise.all((await childPids(masterPid)).map(async (pid) =>
      await isWorkerProcess(pid) ? pid : null))).filter((pid): pid is number => pid !== null);
    return workers.length === count;
  }, `master ${masterPid} did not expose ${count} worker PIDs`);
  return workers;
}

export async function waitForDead(pids: readonly number[], timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => pids.every((pid) => !processAlive(pid)), `processes remained alive: ${pids.join(',')}`, timeoutMs);
}

export function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timed out waiting for PID ${child.pid ?? 'unknown'} to exit`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    child.once('exit', onExit);
  });
}

export async function cleanupMaster(master: RunningMaster, workers: readonly number[] = []): Promise<void> {
  master.processes.registerPids(workers);
  const captured = new Set<number>();
  const captureDescendants = async (pid: number): Promise<void> => {
    if (captured.has(pid) || !processAlive(pid)) return;
    captured.add(pid);
    const children = await childPids(pid);
    master.processes.registerPids(children);
    await Promise.all(children.map(captureDescendants));
  };
  if (master.child.pid !== undefined) await captureDescendants(master.child.pid);
  master.stopMonitoring();
  await cleanupProcesses(master.processes);
  spawnedProcessMonitors.delete(master.processes);
  spawnedProcessRegistries.delete(master.processes);
}

export async function cleanupSpawnedProcesses(): Promise<void> {
  const registries = [...spawnedProcessRegistries];
  for (const registry of registries) spawnedProcessMonitors.get(registry)?.();
  const settled = await Promise.allSettled(registries.map((registry) => cleanupProcesses(registry)));
  const errors: unknown[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      spawnedProcessMonitors.delete(registries[index]!);
      spawnedProcessRegistries.delete(registries[index]!);
    } else {
      errors.push(result.reason);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'spawned process cleanup failed');
}

export { ProcessRegistry, cleanupProcesses, processAlive } from './process-cleanup';

export async function expectPortClosed(port: number): Promise<void> {
  await waitUntil(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
      return false;
    } catch (error) {
      if (error instanceof Error) return true;
      throw error;
    }
  }, `port ${port} remained open`, 5_000);
}
