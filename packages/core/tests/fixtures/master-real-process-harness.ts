import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/main.ts');
const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/main.js');
const WAIT_STEP_MS = 25;
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
  readonly output: () => string;
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
    if (errorCode(error) === 'ENOENT') return false;
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
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('reserved server did not expose a port');
  return port;
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
): RunningMaster {
  const child = spawn(entry.executable, [...entry.args], {
    cwd,
    env: {
      ...process.env,
      BUNGEE_CONFIG_DB_PATH: fixture.dbPath,
      BUNGEE_ACCESS_DB_PATH: accessDbPath,
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_STARTUP_APPLY_TIMEOUT_MS: '10000',
      BUNGEE_DRAIN_TIMEOUT_MS: '1000',
      BUNGEE_HEARTBEAT_INTERVAL_MS: '100',
      BUNGEE_HEARTBEAT_TIMEOUT_MS: '750',
      BUNGEE_SHUTDOWN_TIMEOUT_MS: '500',
      CONFIG_PATH: fixture.configPath,
      DOTENV_CONFIG_QUIET: 'true',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      PLUGINS_DIR: fixture.pluginsPath,
      PORT: String(port),
      WORKER_COUNT: String(workerCount),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  return { child, output: () => Buffer.concat(chunks).toString('utf8') };
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

export async function waitForWorkerPids(masterPid: number, count: number): Promise<readonly number[]> {
  let workers: readonly number[] = [];
  await waitUntil(async () => {
    workers = await childPids(masterPid);
    return workers.length === count;
  }, `master ${masterPid} did not expose ${count} worker PIDs`);
  return workers;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

export async function waitForDead(pids: readonly number[]): Promise<void> {
  await waitUntil(() => pids.every((pid) => !processAlive(pid)), `processes remained alive: ${pids.join(',')}`, 5_000);
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
  if (master.child.exitCode === null && master.child.signalCode === null) master.child.kill('SIGKILL');
  await waitForExit(master.child);
  for (const pid of workers) {
    if (processAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  if (workers.length > 0) await waitForDead(workers);
}

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
