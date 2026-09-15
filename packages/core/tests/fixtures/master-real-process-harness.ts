import { execFile, type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureProcessIdentity, captureProcessSnapshot, cleanupProcesses, processIdentityMatches, ProcessRegistry, processAlive, PROCESS_PROBE_TIMEOUT_MS, waitForDead as waitForRegisteredDead, type ProcessIdentitySnapshot } from './process-cleanup';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/main.ts');
const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/main.js');
const WAIT_STEP_MS = 25;
const spawnedProcessRegistries = new Set<ProcessRegistry>();
const spawnedProcessMonitors = new Map<ProcessRegistry, () => void>();
const masterFixtures = new Map<number, MasterFixture>();
const masterMarkers = new Map<number, string>();
const masterRootMarkers = new Map<number, string>();
const masterRootProofs = new Map<number, ProcessIdentitySnapshot>();
const masterPids = new Map<ProcessRegistry, number>();
const masterPorts = new Map<ProcessRegistry, readonly number[]>();
const masterCleanupFixtures = new Map<ProcessRegistry, MasterFixture>();
const execFileAsync = promisify(execFile);
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
  readonly ports: readonly number[];
  readonly fixture: MasterFixture;
  readonly stopMonitoring: () => void;
  readonly output: () => string;
  readonly testMarker: string;
  readonly rootMarker: string;
  readonly ingressPorts: readonly number[];
};

export type CleanupMasterOptions = {
  readonly fixture?: MasterFixture;
  readonly ports?: readonly number[];
  readonly expectGraceful?: boolean;
};

export type SpawnMasterOptions = {
  /** The deterministic parent environment used by real-process tests. */
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Legacy v6 targets use one public/control listener. */
  readonly layout?: 'split' | 'legacy-single-port';
  /** Useful for short-lived benchmark processes which do their own cleanup. */
  readonly stopProcessMonitor?: boolean;
  readonly daemonBootNonce?: string;
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
  const root = makeCanonicalTempDir(prefix.replace(/-$/, ''));
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
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  const marker = randomUUID();
  const rootMarker = `BUNGEE_TEST_ROOT_IDENTITY_${randomUUID()}`;
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
    BUNGEE_TEST_PROCESS_MARKER: marker,
  };
  if (options.layout === 'legacy-single-port') {
    delete childEnv.BUNGEE_MANAGEMENT_HOST;
    delete childEnv.BUNGEE_MANAGEMENT_PORT;
    delete childEnv.BUNGEE_INGRESS_SUPERVISION_PORT;
  }
  const child = spawn(entry.executable, [...entry.args, `--bungee-test-root-marker=${rootMarker}`,
    ...(options.daemonBootNonce === undefined ? [] : [`--bungee-daemon-boot=${options.daemonBootNonce}`])], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid !== undefined) {
    masterFixtures.set(child.pid, fixture);
    masterMarkers.set(child.pid, marker);
    masterRootMarkers.set(child.pid, rootMarker);
  }
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  const processes = new ProcessRegistry();
  const ports = split ? [port, port + 1, port + 2] : [port];
  const ingressPorts = split ? [port + 1, port + 2] : [port];
  processes.registerChild(child);
  let monitoring = false;
  const monitor = setInterval(() => {
    if (monitoring) return;
    monitoring = true;
    void (async () => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        clearInterval(monitor);
        return;
      }
      await registerDescendantPids(processes, await captureProcessSnapshot(), child.pid, fixture, ingressPorts);
    })().catch(() => undefined).finally(() => { monitoring = false; });
  }, WAIT_STEP_MS);
  monitor.unref?.();
  const stopMonitoring = () => clearInterval(monitor);
  child.once('exit', stopMonitoring);
  if (options.stopProcessMonitor !== true) spawnedProcessMonitors.set(processes, stopMonitoring);
  if (options.stopProcessMonitor === true) stopMonitoring();
  spawnedProcessRegistries.add(processes);
  masterPorts.set(processes, ports);
  if (child.pid !== undefined) masterPids.set(processes, child.pid);
  if (child.pid !== undefined) {
    void captureProcessSnapshot()
      .then((snapshot) => registerDescendantPids(processes, snapshot, child.pid!, fixture, ingressPorts))
      .catch(() => undefined);
  }
  return {
    child, processes, fixture, testMarker: marker, rootMarker,
    ports, ingressPorts,
    stopMonitoring, output: () => Buffer.concat(chunks).toString('utf8'),
  };
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

export function windowsChildPidsCommand(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('parent PID must be a positive integer');
  return `$ErrorActionPreference = 'Stop'; @(Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
}

export function parseWindowsChildPidsOutput(output: string): readonly number[] {
  const text = output.trim();
  if (text === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { parsed = text.split(/\r?\n/).filter(Boolean); }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return [...new Set(values.flatMap((value) => {
    const candidate = typeof value === 'object' && value !== null && 'ProcessId' in value
      ? (value as { ProcessId?: unknown }).ProcessId : value;
    const childPid = typeof candidate === 'number' ? candidate : Number(candidate);
    return Number.isSafeInteger(childPid) && childPid > 0 ? [childPid] : [];
  }))];
}

export function descendantProcessSnapshot(
  snapshot: readonly ProcessIdentitySnapshot[],
  rootPid: number,
  testMarker?: string,
  requireTestMarker = process.platform !== 'win32',
  rootProof?: ProcessIdentitySnapshot,
  rootMarker?: string,
  platform = process.platform,
): readonly ProcessIdentitySnapshot[] {
  const roots = snapshot.filter(({ pid }) => pid === rootPid);
  if (rootMarker !== undefined && (roots.length !== 1
    || countExactMarker(roots[0]!.commandLine, rootMarker) !== 1
    || (rootProof !== undefined && !processIdentityMatches(rootProof, roots[0]!, platform)))) return [];
  const tree = new Set<number>([rootPid]);
  for (;;) {
    const added = snapshot.filter((identity) => tree.has(identity.ppid)
      && (!requireTestMarker || identity.testMarker === testMarker) && !tree.has(identity.pid));
    if (added.length === 0) break;
    for (const identity of added) tree.add(identity.pid);
  }
  return snapshot.filter((identity) => identity.pid !== rootPid && tree.has(identity.pid));
}

function countExactMarker(commandLine: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= commandLine.length) {
    const found = commandLine.indexOf(marker, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + marker.length;
  }
  return count;
}

export function workerIdentitiesFromSnapshot(
  snapshot: readonly ProcessIdentitySnapshot[],
  masterPid: number,
  descriptorPids: ReadonlySet<number>,
  testMarker = masterMarkers.get(masterPid),
): readonly ProcessIdentitySnapshot[] {
  const rootMarker = masterRootMarkers.get(masterPid);
  const root = snapshot.find(({ pid }) => pid === masterPid);
  const rootProof = masterRootProofs.get(masterPid);
  const descendants = descendantProcessSnapshot(snapshot, masterPid, testMarker, process.platform !== 'win32', rootProof, rootMarker);
  if (rootMarker !== undefined && root !== undefined && rootProof === undefined && countExactMarker(root.commandLine, rootMarker) === 1) {
    masterRootProofs.set(masterPid, root);
  }
  return descendants
    .filter((identity) => descriptorPids.has(identity.pid));
}

function workerObservationDiagnostics(
  masterPid: number,
  marker: string | undefined,
  descriptorPids: ReadonlySet<number>,
  snapshot: readonly ProcessIdentitySnapshot[],
): string {
  const descendants = new Set(workerIdentitiesFromSnapshot(snapshot, masterPid, descriptorPids, marker).map(({ pid }) => pid));
  const candidateDetails = snapshot.map(({ pid, ppid, startToken, testMarker, roleMarker }) => {
    const reasons: string[] = [];
    if (pid === masterPid) reasons.push('master');
    else if (!descendants.has(pid)) {
      if (descriptorPids.has(pid)) reasons.push('not-in-expected-ppid-tree-or-marker');
      else reasons.push('not-in-signed-descriptor-pids');
    }
    return `${JSON.stringify({ pid, ppid, startToken, testMarker, roleMarker })}:${reasons.length === 0 ? 'candidate' : reasons.join(',')}`;
  }).join('; ');
  return `master pid=${masterPid} alive=${processAlive(masterPid)}; descriptor PIDs=[${[...descriptorPids].join(',')}]; `
    + `expected master marker=${marker ?? 'undefined'}; snapshot candidates=${candidateDetails || '[]'}`;
}

async function windowsChildPids(pid: number): Promise<readonly number[]> {
  const result = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsChildPidsCommand(pid),
  ], { timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 });
  return parseWindowsChildPidsOutput(result.stdout);
}

export async function childPids(pid: number): Promise<readonly number[]> {
  if (process.platform === 'win32') return windowsChildPids(pid);
  try {
    const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return text.trim() === '' ? [] : text.trim().split(/\s+/).map(Number);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

export async function registerDescendantPids(
  registry: ProcessRegistry,
  snapshot: readonly ProcessIdentitySnapshot[],
  masterPid: number,
  fixture: MasterFixture,
  ingressPorts: readonly number[],
  rootMarker = masterRootMarkers.get(masterPid),
  rootProof = masterRootProofs.get(masterPid),
  requireTestMarker = process.platform !== 'win32',
): Promise<void> {
  if (!registry.hasLiveHandle(masterPid)) return;
  if (rootMarker === undefined) return;
  const root = snapshot.find(({ pid }) => pid === masterPid);
  if (root === undefined) return;
  const platform = requireTestMarker ? process.platform : 'win32';
  const descendants = descendantProcessSnapshot(snapshot, masterPid, masterMarkers.get(masterPid), requireTestMarker, rootProof, rootMarker, platform);
  if (rootMarker !== undefined && (countExactMarker(root.commandLine, rootMarker) !== 1
    || (rootProof !== undefined && !processIdentityMatches(rootProof, root, platform)))) return;
  if (requireTestMarker && root.testMarker !== masterMarkers.get(masterPid)) return;
  if (rootMarker !== undefined && rootProof === undefined) masterRootProofs.set(masterPid, root);
  const workerPids = await descriptorWorkerPids(fixture);
  for (const discovered of descendants) {
    const pid = discovered.pid;
    const role = discovered.roleMarker === 'ingress' || workerPids.has(pid)
      ? (discovered.roleMarker === 'ingress' ? 'ingress' : 'worker')
      : (process.platform === 'win32' && workerPids.size > 0 ? 'ingress' : undefined);
    if (role === undefined) continue;
    if (role === 'ingress') {
      registry.registerAdoptedIngress(pid, ingressPorts, discovered);
    } else {
      registry.registerPid(pid, discovered, { role: 'worker' });
    }
  }
}

async function descriptorWorkerPids(fixture: MasterFixture): Promise<ReadonlySet<number>> {
  const descriptors = await readWorkerDescriptors(fixture);
  return new Set(descriptors.flatMap((descriptor) => descriptor.role === 'worker' && Number.isSafeInteger(descriptor.pid)
    ? [Number(descriptor.pid)] : []));
}

export async function isWorkerProcess(pid: number, fixture?: MasterFixture): Promise<boolean> {
  if (fixture !== undefined) return (await descriptorWorkerPids(fixture)).has(pid);
  for (const knownFixture of new Set(masterFixtures.values())) {
    if ((await descriptorWorkerPids(knownFixture)).has(pid)) return true;
  }
  if (process.platform === 'win32') return false;
  try {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environment.split('\0').includes('BUNGEE_ROLE=worker');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EACCES') return false;
    throw error;
  }
}

export async function isIngressProcess(pid: number, fixture?: MasterFixture): Promise<boolean> {
  const candidates = fixture === undefined
    ? [...masterFixtures.entries()]
    : [...masterFixtures.entries()].filter(([, knownFixture]) => knownFixture === fixture);
  for (const [masterPid, knownFixture] of candidates) {
    if (!(await childPids(masterPid)).includes(pid)) continue;
    if (await isWorkerProcess(pid, knownFixture)) return false;
    if (process.platform === 'win32') return true;
  }
  if (process.platform === 'win32') return false;
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
  const descriptors = await Promise.all(names.map(async (name) => {
    try { return JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>; }
    catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
  }));
  return descriptors.filter((descriptor): descriptor is Record<string, unknown> => descriptor !== null);
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
  const identities = await waitForWorkerIdentities(masterPid, count);
  return identities.map(({ pid }) => pid);
}

export async function waitForWorkerIdentities(masterPid: number, count: number): Promise<readonly ProcessIdentitySnapshot[]> {
  let identities: readonly ProcessIdentitySnapshot[] = [];
  let lastSnapshot: readonly ProcessIdentitySnapshot[] = [];
  let lastDescriptorPids: ReadonlySet<number> = new Set();
  const fixture = masterFixtures.get(masterPid);
  const message = `master ${masterPid} did not expose ${count} worker PIDs`;
  try {
    await waitUntil(async () => {
      lastSnapshot = await captureProcessSnapshot();
      lastDescriptorPids = fixture === undefined ? new Set() : await descriptorWorkerPids(fixture);
      identities = workerIdentitiesFromSnapshot(lastSnapshot, masterPid, lastDescriptorPids);
      return identities.length === count;
    }, message);
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw new Error(`${message}; ${workerObservationDiagnostics(masterPid, masterMarkers.get(masterPid), lastDescriptorPids, lastSnapshot)}`, { cause: error });
    }
    throw error;
  }
  return identities;
}

export async function waitForDead(
  pids: readonly number[],
  timeoutMs = 5_000,
  alive: (pid: number) => boolean = processAlive,
): Promise<void> {
  await waitForRegisteredDead(pids, timeoutMs, alive);
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

export async function cleanupMaster(
  master: RunningMaster,
  /** Historical PID evidence only; ownership must have been captured while the master was alive. */
  workers: readonly number[] = [],
  options: CleanupMasterOptions = {},
): Promise<void> {
  const errors: unknown[] = [];
  if (options.fixture !== undefined) masterCleanupFixtures.set(master.processes, options.fixture);
  const captureDescendants = async (pid: number): Promise<void> => {
    await registerDescendantPids(master.processes, await captureProcessSnapshot(), pid, master.fixture, master.ingressPorts);
  };
  try {
    if (master.child.pid !== undefined) await captureDescendants(master.child.pid);
  } catch (error) { errors.push(error); }
  try {
    master.stopMonitoring();
    if (master.child.pid !== undefined) await captureDescendants(master.child.pid);
  } catch (error) { errors.push(error); }
  const expectGraceful = options.expectGraceful === true;
  try {
    await cleanupProcesses(master.processes, {
      expectGraceful,
      ...(expectGraceful ? {
        shutdown: () => {
          if (master.child.exitCode === null && master.child.signalCode === null) master.child.kill('SIGTERM');
        },
        observeGraceful: async () => {
          const settled = await Promise.allSettled((options.ports ?? master.ports)
            .filter((port) => !master.processes.portOwnedByAnother(port))
            .map((port) => expectPortClosed(port)));
          const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length > 0) throw new AggregateError(failures, 'graceful port cleanup failed');
        },
      } : {}),
    });
  } catch (error) { errors.push(error); }
  const ports = [...new Set(options.ports ?? master.ports)];
  const portResults = await Promise.allSettled(ports
    .filter((port) => !master.processes.portOwnedByAnother(port))
    .map((port) => expectPortClosed(port)));
  for (const result of portResults) if (result.status === 'rejected') errors.push(result.reason);
  if (errors.length === 0 && options.fixture !== undefined) {
    try { await removeFixture(options.fixture); } catch (error) { errors.push(error); }
  }
  if (errors.length === 0) {
    if (master.child.pid !== undefined) {
      masterFixtures.delete(master.child.pid); masterMarkers.delete(master.child.pid);
      masterRootMarkers.delete(master.child.pid); masterRootProofs.delete(master.child.pid);
    }
    masterPids.delete(master.processes);
    masterPorts.delete(master.processes);
    masterCleanupFixtures.delete(master.processes);
    spawnedProcessMonitors.delete(master.processes);
    spawnedProcessRegistries.delete(master.processes);
  }
  if (errors.length > 0) {
    const report = workers.length === 0 ? '' : `; historical worker PIDs=${workers.join(',')}`;
    throw new AggregateError(errors, `master process cleanup failed${report}`);
  }
}

export async function cleanupSpawnedProcesses(): Promise<void> {
  const registries = [...spawnedProcessRegistries];
  for (const registry of registries) spawnedProcessMonitors.get(registry)?.();
  const settled = await Promise.allSettled(registries.map((registry) => cleanupProcesses(registry, { expectGraceful: false })));
  const errors: unknown[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      const registry = registries[index]!;
      const resourceErrors: unknown[] = [];
      const portResults = await Promise.allSettled((masterPorts.get(registry) ?? [])
        .filter((port) => !registry.portOwnedByAnother(port)).map((port) => expectPortClosed(port)));
      for (const portResult of portResults) if (portResult.status === 'rejected') resourceErrors.push(portResult.reason);
      const fixture = masterCleanupFixtures.get(registry);
      if (resourceErrors.length === 0 && fixture !== undefined) {
        try { await removeFixture(fixture); } catch (error) { resourceErrors.push(error); }
      }
      if (resourceErrors.length > 0) {
        errors.push(new AggregateError(resourceErrors, 'spawned process resources cleanup failed'));
        continue;
      }
      const masterPid = masterPids.get(registry);
      if (masterPid !== undefined) {
        masterFixtures.delete(masterPid); masterMarkers.delete(masterPid);
        masterRootMarkers.delete(masterPid); masterRootProofs.delete(masterPid);
      }
      masterPids.delete(registry);
      masterPorts.delete(registry);
      masterCleanupFixtures.delete(registry);
      spawnedProcessMonitors.delete(registry);
      spawnedProcessRegistries.delete(registry);
    } else {
      errors.push(result.reason);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'spawned process cleanup failed');
}

export { captureProcessIdentity, captureProcessSnapshot, ProcessRegistry, cleanupProcesses, processAlive } from './process-cleanup';

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
