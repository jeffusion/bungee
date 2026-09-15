import { execFile, type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { join, resolve } from 'node:path';
import { captureProcessIdentity, captureProcessSnapshot, cleanupProcesses, processIdentityMatches, ProcessRegistry, processAlive, PROCESS_PROBE_TIMEOUT_MS, waitForDead as waitForRegisteredDead, type ProcessIdentitySnapshot } from './process-cleanup';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed, parseWorkerDescriptor, type WorkerDescriptor } from '../../src/supervision';
import { isLowercaseUuid } from '../../src/config-storage/validation';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/main.ts');
const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/main.js');
const WAIT_STEP_MS = 25;
const CLEANUP_COVERAGE_TIMEOUT_MS = 1_000;
const spawnedProcessRegistries = new Set<ProcessRegistry>();
const spawnedProcessMonitors = new Map<ProcessRegistry, () => void>();
const masterFixtures = new Map<number, MasterFixture>();
const masterMarkers = new Map<number, string>();
const masterRootMarkers = new Map<number, string>();
const masterRootProofs = new Map<ProcessRegistry, ProcessIdentitySnapshot>();
const masterPids = new Map<ProcessRegistry, number>();
const masterPorts = new Map<ProcessRegistry, readonly number[]>();
const masterCleanupFixtures = new Map<ProcessRegistry, MasterFixture>();
const masterDescriptorProofs = new Map<ProcessRegistry, readonly SignedDescriptor[]>();
const runningMasters = new Map<ProcessRegistry, RunningMaster>();
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
  readonly stopMonitoringAndDrain: () => Promise<void>;
  readonly rootExit: Promise<RootExitEvidence>;
  readonly rootExitState: RootExitState;
  readonly output: () => string;
  readonly testMarker: string;
  readonly rootMarker: string;
  readonly ingressPorts: readonly number[];
  readonly workerCount: number;
};

export type RootExitEvidence = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type RootExitState = { exited: boolean; code: number | null; signal: NodeJS.Signals | null };

export type CleanupMasterOptions = {
  readonly fixture?: MasterFixture;
  readonly ports?: readonly number[];
  readonly expectGraceful?: boolean;
};

export function masterLifecycleMapSizes(registry?: ProcessRegistry, masterPid?: number): Record<string, number> {
  const scopedMasterPid = registry === undefined ? undefined : masterPid ?? masterPids.get(registry);
  return {
    masterFixtures: registry === undefined ? masterFixtures.size : Number(scopedMasterPid !== undefined && masterFixtures.has(scopedMasterPid)),
    masterMarkers: registry === undefined ? masterMarkers.size : Number(scopedMasterPid !== undefined && masterMarkers.has(scopedMasterPid)),
    masterRootMarkers: registry === undefined ? masterRootMarkers.size : Number(scopedMasterPid !== undefined && masterRootMarkers.has(scopedMasterPid)),
    masterRootProofs: registry === undefined ? masterRootProofs.size : Number(masterRootProofs.has(registry)),
    masterPids: registry === undefined ? masterPids.size : Number(masterPids.has(registry)),
    masterPorts: registry === undefined ? masterPorts.size : Number(masterPorts.has(registry)),
    masterCleanupFixtures: registry === undefined ? masterCleanupFixtures.size : Number(masterCleanupFixtures.has(registry)),
    masterDescriptorProofs: registry === undefined ? masterDescriptorProofs.size : Number(masterDescriptorProofs.has(registry)),
    runningMasters: registry === undefined ? runningMasters.size : Number(runningMasters.has(registry)),
    spawnedProcessMonitors: registry === undefined ? spawnedProcessMonitors.size : Number(spawnedProcessMonitors.has(registry)),
    spawnedProcessRegistries: registry === undefined ? spawnedProcessRegistries.size : Number(spawnedProcessRegistries.has(registry)),
  };
}

export type SpawnMasterOptions = {
  /** The deterministic parent environment used by real-process tests. */
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Legacy v6 targets use one public/control listener. */
  readonly layout?: 'split' | 'legacy-single-port';
  /** Useful for short-lived benchmark processes which do their own cleanup. */
  readonly stopProcessMonitor?: boolean;
  readonly daemonBootNonce?: string;
  readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly captureProcessSnapshot?: () => Promise<readonly ProcessIdentitySnapshot[]>;
  readonly captureProcessIdentity?: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
};

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function rootProofForPid(masterPid: number): ProcessIdentitySnapshot | undefined {
  const registry = [...masterPids.entries()].find(([, pid]) => pid === masterPid)?.[0];
  return registry === undefined ? undefined : masterRootProofs.get(registry);
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
  // Bind this to this ChildProcess instance before starting any asynchronous probe.
  const rootExitState: RootExitState = { exited: false, code: null, signal: null };
  let resolveRootExit!: (evidence: RootExitEvidence) => void;
  const rootExit = new Promise<RootExitEvidence>((resolveExit) => { resolveRootExit = resolveExit; });
  child.once('exit', (code, signal) => {
    rootExitState.exited = true;
    rootExitState.code = code;
    rootExitState.signal = signal;
    resolveRootExit({ code, signal });
  });
  if (child.pid !== undefined) {
    masterFixtures.set(child.pid, fixture);
    masterMarkers.set(child.pid, marker);
    masterRootMarkers.set(child.pid, rootMarker);
  }
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  const processes = new ProcessRegistry({ signal: options.signal, requireTestMarker: false });
  const captureSnapshot = options.captureProcessSnapshot ?? captureProcessSnapshot;
  const captureIdentity = options.captureProcessIdentity ?? captureProcessIdentity;
  const ports = split ? [port, port + 1, port + 2] : [port];
  const ingressPorts = split ? [port + 1, port + 2] : [port];
  processes.registerChild(child, undefined, split ? {} : { ports });
  let monitoring = false;
  let stopped = false;
  let inFlightCapture: Promise<void> | undefined;
  const pendingCaptures = new Set<Promise<unknown>>();
  const trackCapture = <T>(capture: Promise<T>): Promise<T> => {
    pendingCaptures.add(capture);
    void capture.finally(() => pendingCaptures.delete(capture));
    return capture;
  };
  const startCapture = (): void => {
    if (stopped || monitoring) return;
    monitoring = true;
    const capture = (async () => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        clearInterval(monitor);
        return;
      }
      await registerDescendantPids(processes, await captureSnapshot(), child.pid, fixture, ingressPorts);
    })();
    inFlightCapture = capture;
    void capture.catch(() => undefined).finally(() => {
      monitoring = false;
      if (inFlightCapture === capture) inFlightCapture = undefined;
    });
  };
  const monitor = setInterval(startCapture, WAIT_STEP_MS);
  monitor.unref?.();
  const stopMonitoring = () => { stopped = true; clearInterval(monitor); };
  const stopMonitoringAndDrain = async (): Promise<void> => {
    stopMonitoring();
    for (;;) {
      const inFlight = inFlightCapture;
      const pending = [...pendingCaptures];
      if (inFlight === undefined && pending.length === 0) return;
      await Promise.allSettled([...(inFlight === undefined ? [] : [inFlight]), ...pending]);
    }
  };
  if (options.stopProcessMonitor !== true) spawnedProcessMonitors.set(processes, stopMonitoring);
  if (options.stopProcessMonitor === true) stopMonitoring();
  spawnedProcessRegistries.add(processes);
  masterPorts.set(processes, ports);
  if (child.pid !== undefined) masterPids.set(processes, child.pid);
  const running: RunningMaster = {
    child, processes, fixture, testMarker: marker, rootMarker,
    ports, ingressPorts, workerCount,
    stopMonitoring, stopMonitoringAndDrain, rootExit, rootExitState,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
  runningMasters.set(processes, running);
  if (child.pid !== undefined) {
    trackCapture(captureIdentity(child.pid)
      .then((identity) => {
        if (identity !== null && countExactMarker(identity.commandLine, `--bungee-test-root-marker=${rootMarker}`) === 1) {
          masterRootProofs.set(processes, identity);
          processes.setIdentity(child.pid!, identity);
        }
      })
      .catch(() => undefined));
    trackCapture(captureSnapshot()
      .then((snapshot) => registerDescendantPids(processes, snapshot, child.pid!, fixture, ingressPorts))
      .catch(() => undefined));
  }
  return running;
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
  requireTestMarker = false,
  rootProof?: ProcessIdentitySnapshot,
  rootMarker?: string,
  platform = process.platform,
): readonly ProcessIdentitySnapshot[] {
  const roots = snapshot.filter(({ pid }) => pid === rootPid);
  if (rootMarker !== undefined && (roots.length !== 1
    || countExactMarker(roots[0]!.commandLine, `--bungee-test-root-marker=${rootMarker}`) !== 1
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
  return commandLine.split(/\s+/u).filter((argument) => argument === marker).length;
}

export function workerIdentitiesFromSnapshot(
  snapshot: readonly ProcessIdentitySnapshot[],
  masterPid: number,
  descriptorPids: ReadonlySet<number>,
  testMarker = masterMarkers.get(masterPid),
): readonly ProcessIdentitySnapshot[] {
  const rootMarker = masterRootMarkers.get(masterPid);
  const root = snapshot.find(({ pid }) => pid === masterPid);
  const rootProof = rootProofForPid(masterPid);
  const descendants = descendantProcessSnapshot(snapshot, masterPid, testMarker, process.platform === 'linux', rootProof, rootMarker);
  if (rootMarker !== undefined && root !== undefined && rootProof === undefined && countExactMarker(root.commandLine, `--bungee-test-root-marker=${rootMarker}`) === 1) {
    const registry = [...masterPids.entries()].find(([, pid]) => pid === masterPid)?.[0];
    if (registry !== undefined) masterRootProofs.set(registry, root);
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
  if (process.platform === 'darwin') return (await captureProcessSnapshot()).filter((identity) => identity.ppid === pid).map(({ pid: childPid }) => childPid);
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
  rootProof?: ProcessIdentitySnapshot,
  requireTestMarker = process.platform === 'linux',
): Promise<void> {
  if (!registry.hasLiveHandle(masterPid)) return;
  if (rootMarker === undefined) return;
  const root = snapshot.find(({ pid }) => pid === masterPid);
  const savedRootProof = rootProof ?? masterRootProofs.get(registry);
  if (root === undefined) return;
  const platform = process.platform;
  const testMarker = runningMasters.get(registry)?.testMarker ?? masterMarkers.get(masterPid);
  const descendants = descendantProcessSnapshot(snapshot, masterPid, testMarker, requireTestMarker, savedRootProof, rootMarker, platform);
  if (rootMarker !== undefined && (countExactMarker(root.commandLine, `--bungee-test-root-marker=${rootMarker}`) !== 1
    || (savedRootProof !== undefined && !processIdentityMatches(savedRootProof, root, platform)))) return;
  if (requireTestMarker && root.testMarker !== testMarker) return;
  if (rootMarker !== undefined && savedRootProof === undefined) masterRootProofs.set(registry, root);
  const savedRoot = masterRootProofs.get(registry);
  if (savedRoot !== undefined) registry.setIdentity(masterPid, savedRoot);
  // Legacy masters have no signed descriptor or process-identity contract. Their
  // root proof is still exact, so register the complete rooted PPID tree as
  // generic children and leave the listener port on the root registration.
  if (ingressPorts.length <= 1) {
    for (const discovered of descendants) registry.registerPid(discovered.pid, discovered, {});
    return;
  }
  const observedDescriptors = await readSignedWorkerDescriptors(fixture);
  const workerMarkers = new Map(observedDescriptors.map(({ descriptor }) =>
    [descriptor.pid, `--bungee-process-identity=${descriptor.worker_instance_id}`] as const));
  const directChildren = descendants.filter((identity) => identity.ppid === masterPid);
  const ownedDescriptors: SignedDescriptor[] = [];
  const ownedDescriptorIdentities = new Map<number, ProcessIdentitySnapshot>();
  for (const candidate of observedDescriptors) {
    const identity = descendants.find(({ pid }) => pid === candidate.descriptor.pid);
    if (identity !== null && identity !== undefined
      && processIdentityMarker(identity.commandLine) === workerMarkers.get(candidate.descriptor.pid)) {
      ownedDescriptors.push(candidate);
      ownedDescriptorIdentities.set(candidate.descriptor.pid, identity);
    }
  }
  const priorDescriptors = masterDescriptorProofs.get(registry) ?? [];
  const descriptorsByPid = new Map(observedDescriptors.map(({ descriptor }) => [descriptor.pid, descriptor] as const));
  const mergedDescriptors = [...priorDescriptors];
  for (const candidate of ownedDescriptors) {
    const index = mergedDescriptors.findIndex(({ descriptor }) => descriptor.pid === candidate.descriptor.pid
      && descriptor.worker_instance_id === candidate.descriptor.worker_instance_id);
    if (index < 0) mergedDescriptors.push(candidate);
    else mergedDescriptors[index] = candidate;
  }
  masterDescriptorProofs.set(registry, mergedDescriptors);
  const ingressCandidates = directChildren.filter((identity) => {
    const descriptor = descriptorsByPid.get(identity.pid);
    return descriptor === undefined && isIngressCandidateForMaster(identity, testMarker);
  });
  const ingress = ingressCandidates.length === 1 ? ingressCandidates[0] : undefined;
  for (const discovered of descendants) {
    const pid = discovered.pid;
    const workerMarker = workerMarkers.get(pid);
    if (workerMarker !== undefined && processIdentityMarker(discovered.commandLine) === workerMarker) {
      registry.registerPid(pid, discovered, { role: 'worker' });
    } else if (discovered === ingress) {
      registry.registerAdoptedIngress(pid, ingressPorts, discovered);
    } else if (processIdentityArgumentCount(discovered.commandLine) === 0) {
      // Exact identity is enough for a rooted plugin child; it must not own ingress ports.
      registry.registerPid(pid, discovered, {});
    }
  }
  for (const candidate of ownedDescriptors) {
    const identity = ownedDescriptorIdentities.get(candidate.descriptor.pid);
    if (identity !== undefined) registry.registerPid(candidate.descriptor.pid, identity, { role: 'worker' });
  }
}

function processIdentityArgumentCount(commandLine: string): number {
  return commandLine.split(/\s+/u).filter((argument) => argument.startsWith('--bungee-process-identity=')).length;
}

function processIdentityMarker(commandLine: string): string | null {
  const markers = commandLine.split(/\s+/u).filter((argument) => argument.startsWith('--bungee-process-identity='));
  if (markers.length !== 1) return null;
  const identity = markers[0]!.slice('--bungee-process-identity='.length);
  return isLowercaseUuid(identity) ? markers[0]! : null;
}

function probePid(pid: number): 'alive' | 'dead' | 'unknown' {
  try { return processAlive(pid) ? 'alive' : 'dead'; }
  catch (error) { return errorCode(error) === 'ESRCH' ? 'dead' : 'unknown'; }
}

function isIngressCandidate(identity: ProcessIdentitySnapshot): boolean {
  return processIdentityMarker(identity.commandLine) !== null
    && (identity.roleMarker === undefined || identity.roleMarker === 'ingress');
}

function isIngressCandidateForMaster(identity: ProcessIdentitySnapshot, testMarker: string | undefined): boolean {
  return isIngressCandidate(identity) && (testMarker === undefined || identity.testMarker === testMarker);
}

async function descriptorWorkerPids(fixture: MasterFixture): Promise<ReadonlySet<number>> {
  return new Set((await descriptorWorkerMarkers(fixture)).keys());
}

type SignedDescriptor = { readonly file: string; readonly descriptor: WorkerDescriptor };

async function readSignedWorkerDescriptors(fixture: MasterFixture): Promise<readonly SignedDescriptor[]> {
  const rawDescriptors = await readWorkerDescriptors(fixture);
  const directory = workerDescriptorsDirectory(fixture);
  const descriptors = rawDescriptors.map((raw, index) => {
    const generation = raw.master_generation;
    const instance = raw.worker_instance_id;
    const bootNonce = raw.boot_nonce;
    const slot = raw.worker_slot;
    if (typeof generation !== 'string' || typeof instance !== 'string' || typeof bootNonce !== 'string'
      || !isLowercaseUuid(generation) || !isLowercaseUuid(instance) || !isLowercaseUuid(bootNonce)
      || !Number.isSafeInteger(slot) || (slot as number) < 0) throw new Error(`worker descriptor ${index} identity is invalid`);
    const credential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, slot as number), bootNonce,
    );
    return { file: directory, descriptor: parseWorkerDescriptor(raw, credential) };
  });
  const pids = new Set<number>();
  const instances = new Set<string>();
  for (const { descriptor } of descriptors) {
    if (pids.has(descriptor.pid) || instances.has(descriptor.worker_instance_id)) {
      throw new Error('worker descriptor identities are duplicated');
    }
    pids.add(descriptor.pid);
    instances.add(descriptor.worker_instance_id);
  }
  return descriptors;
}

async function descriptorWorkerMarkers(fixture: MasterFixture): Promise<ReadonlyMap<number, string>> {
  const descriptors = await readSignedWorkerDescriptors(fixture);
  return new Map(descriptors.map(({ descriptor }) => [descriptor.pid, `--bungee-process-identity=${descriptor.worker_instance_id}`] as const));
}

export async function isWorkerProcess(pid: number, fixture?: MasterFixture): Promise<boolean> {
  if (fixture !== undefined && [...runningMasters.values()].some((master) => master.fixture === fixture && master.ingressPorts.length <= 1)) {
    return false;
  }
  if (fixture !== undefined) return (await descriptorWorkerPids(fixture)).has(pid);
  for (const knownFixture of new Set(masterFixtures.values())) {
    if ((await descriptorWorkerPids(knownFixture)).has(pid)) return true;
  }
  if (process.platform === 'win32' || process.platform === 'darwin') return false;
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
  const snapshot = await captureProcessSnapshot();
  for (const [masterPid, knownFixture] of candidates) {
    if (!snapshot.some((identity) => identity.pid === pid && identity.ppid === masterPid)) continue;
    if ([...runningMasters.values()].some((master) => master.fixture === knownFixture && master.ingressPorts.length <= 1)) continue;
    if (await isWorkerProcess(pid, knownFixture)) return false;
    const descriptorPids = await descriptorWorkerPids(knownFixture);
    const ingressCandidates = snapshot.filter((identity) => identity.ppid === masterPid
      && !descriptorPids.has(identity.pid)
      && isIngressCandidateForMaster(identity, masterMarkers.get(masterPid)));
    const identity = snapshot.find((candidate) => candidate.pid === pid);
    if (ingressCandidates.length === 1 && identity !== undefined && ingressCandidates[0]!.pid === pid) return true;
  }
  return false;
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

function cleanupCoverageError(master: RunningMaster, descriptors: readonly SignedDescriptor[], detail = ''): Error {
  const registered = master.processes.registeredProcesses;
  return new Error(`cleanup process coverage incomplete: root=${master.child.pid ?? 'unknown'} `
    + `descriptors=${descriptors.length} registered=${registered.map(({ pid, role }) => `${pid}:${role ?? 'child'}`).join(',')}${detail}`);
}

type TcpPortState = 'open' | 'closed' | 'unknown';

export function probeTcpPort(port: number, timeoutMs = 100): Promise<TcpPortState> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state: TcpPortState): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error: unknown) => finish(errorCode(error) === 'ECONNREFUSED' ? 'closed' : 'unknown'));
    socket.setTimeout(timeoutMs, () => finish('unknown'));
    timer = setTimeout(() => finish('unknown'), timeoutMs);
  });
}

async function captureCleanupCoverage(master: RunningMaster): Promise<void> {
  const pid = master.child.pid;
  if (pid === undefined) throw new Error('master PID is unavailable for cleanup coverage');
  const legacy = master.ingressPorts.length <= 1;
  const deadline = Date.now() + CLEANUP_COVERAGE_TIMEOUT_MS;
  let lastError: unknown;
  for (;;) {
    try {
      const snapshot = await captureProcessSnapshot();
      await registerDescendantPids(master.processes, snapshot, pid, master.fixture, master.ingressPorts);
      const rootProbe = (() => {
        if (master.rootExitState.exited) return false;
        try { return processAlive(pid); } catch { return undefined; }
      })();
      if (!master.rootExitState.exited && (rootProbe !== true || rootProofForPid(pid) === undefined)) {
        throw new Error('cleanup coverage cannot prove a live master identity');
      }
      const currentDescriptors = legacy ? [] : await readSignedWorkerDescriptors(master.fixture);
      const rootProof = masterRootProofs.get(master.processes);
      const savedDescriptors = masterDescriptorProofs.get(master.processes) ?? [];
      const descriptors = legacy ? [] : [...savedDescriptors];
      if (!legacy && !master.rootExitState.exited) {
        for (const candidate of currentDescriptors) {
          const index = descriptors.findIndex(({ descriptor }) => descriptor.pid === candidate.descriptor.pid
            && descriptor.worker_instance_id === candidate.descriptor.worker_instance_id);
          if (index < 0) descriptors.push(candidate);
          else descriptors[index] = candidate;
        }
      }
      let currentRegistered = new Map(master.processes.registeredProcesses.map((entry) => [entry.pid, entry]));
      const root = currentRegistered.get(pid);
      const rootObservations = snapshot.filter((identity) => identity.pid === pid);
      const observedRoot = rootObservations[0];
      const rootMarker = `--bungee-test-root-marker=${master.rootMarker}`;
      const rootIdentityValid = rootProof !== undefined && root?.identity !== undefined
        && processIdentityMatches(rootProof, root.identity, process.platform)
        && countExactMarker(rootProof.commandLine, rootMarker) === 1;
      const rootLiveCovered = rootProbe === true && master.processes.hasLiveHandle(pid)
        && rootObservations.length === 1 && observedRoot !== undefined && rootIdentityValid
        && countExactMarker(observedRoot.commandLine, rootMarker) === 1
        && processIdentityMatches(rootProof!, observedRoot, process.platform);
      const rootDeadCovered = master.rootExitState.exited;
      const descendants = rootLiveCovered ? descendantProcessSnapshot(
        snapshot, pid, master.testMarker, process.platform === 'linux', rootProof, master.rootMarker, process.platform,
      ) : [];
      if (rootLiveCovered && !legacy) {
        const descriptorPids = new Set(currentDescriptors.map(({ descriptor }) => descriptor.pid));
        for (const descriptor of currentDescriptors.map(({ descriptor }) => descriptor)) {
          const observed = descendants.find(({ pid: observedPid }) => observedPid === descriptor.pid);
          if (observed !== null && observed !== undefined && processIdentityMarker(observed.commandLine) === `--bungee-process-identity=${descriptor.worker_instance_id}`) {
            master.processes.registerPid(observed.pid, observed, { role: 'worker' });
          }
        }
        const ingressCandidates = descendants.filter((identity) => identity.ppid === pid
          && !descriptorPids.has(identity.pid) && isIngressCandidateForMaster(identity, master.testMarker));
        if (ingressCandidates.length === 1) master.processes.registerAdoptedIngress(ingressCandidates[0]!.pid, master.ingressPorts, ingressCandidates[0]!);
        currentRegistered = new Map(master.processes.registeredProcesses.map((entry) => [entry.pid, entry]));
      }
      const descendantPids = new Set(descendants.map(({ pid: childPid }) => childPid));
      let workersCovered = true;
      if (rootDeadCovered && !legacy) {
        for (const { descriptor } of currentDescriptors) {
          const probe = probePid(descriptor.pid);
          if (probe === 'unknown') { workersCovered = false; continue; }
          if (probe === 'alive' && !savedDescriptors.some(({ descriptor: saved }) =>
            saved.pid === descriptor.pid && saved.worker_instance_id === descriptor.worker_instance_id)) workersCovered = false;
        }
      }
      for (const { descriptor } of descriptors) {
        const workerPid = descriptor.pid;
        const probe = probePid(workerPid);
        if (probe === 'unknown') { workersCovered = false; continue; }
        // An explicit dead probe is sufficient. There is no process to own or signal.
        if (probe === 'dead') continue;
        const entry = currentRegistered.get(workerPid);
        if (rootDeadCovered && entry?.identity !== undefined) {
          let observed: ProcessIdentitySnapshot | null = null;
          try { observed = await captureProcessIdentity(workerPid); } catch { workersCovered = false; continue; }
          if (observed === null) { workersCovered = false; continue; }
          // The old owned instance is gone. ProcessRegistry will release its
          // owner without ever signalling this replacement PID.
          if (!processIdentityMatches(entry.identity, observed, process.platform)) continue;
        }
        const currentDescriptor = currentDescriptors.find(({ descriptor: candidate }) =>
          candidate.pid === descriptor.pid && candidate.worker_instance_id === descriptor.worker_instance_id);
        if (currentDescriptor === undefined) {
          const sameGenerationIsPresent = currentDescriptors.some(({ descriptor: candidate }) =>
            candidate.master_generation === descriptor.master_generation);
          if (sameGenerationIsPresent) { workersCovered = false; continue; }
        }
        if (entry === undefined && rootLiveCovered && currentDescriptor !== undefined) {
          const observedCurrent = descendants.find(({ pid: observedPid }) => observedPid === workerPid);
          if (observedCurrent === null || observedCurrent === undefined
            || processIdentityMarker(observedCurrent.commandLine) !== `--bungee-process-identity=${descriptor.worker_instance_id}`) {
            workersCovered = false;
          }
          continue;
        }
        if (entry === undefined || entry.identity === undefined || entry.role !== 'worker') { workersCovered = false; continue; }
        const marker = `--bungee-process-identity=${descriptor.worker_instance_id}`;
        const exactSavedIdentity = processIdentityMarker(entry.identity.commandLine) === marker
          && entry.identity.pid === workerPid;
        if (!exactSavedIdentity) { workersCovered = false; continue; }
        const observations = (rootLiveCovered ? descendants : snapshot).filter((identity) => identity.pid === workerPid);
        let observed = observations.length === 1 ? observations[0] : undefined;
        if (rootDeadCovered && observations.length === 0) {
          try { observed = await captureProcessIdentity(workerPid) ?? undefined; }
          catch { observed = undefined; }
        }
        if (!rootDeadCovered && (!rootLiveCovered || observations.length !== 1 || observed === undefined
          || processIdentityMarker(observed.commandLine) !== marker
          || !processIdentityMatches(entry.identity, observed, process.platform))) workersCovered = false;
        if (rootDeadCovered && (observed === undefined || processIdentityMarker(observed.commandLine) !== marker)) workersCovered = false;
      }
      if (!legacy) {
        for (const entry of currentRegistered) {
          if (entry[1].role !== 'worker' || !entry[1].identity) continue;
          if (!descriptors.some(({ descriptor }) => descriptor.pid === entry[0])) {
            try { if (processAlive(entry[0])) workersCovered = false; }
            catch { workersCovered = false; }
          }
        }
      }
      const directChildren = rootLiveCovered ? descendants.filter((identity) => identity.ppid === pid) : [];
      const descriptorPids = new Set(descriptors.map(({ descriptor }) => descriptor.pid));
      let splitSnapshotValid = true;
      const ingressCandidates = directChildren.filter((identity) => {
        const descriptor = descriptors.find(({ descriptor: candidate }) => candidate.pid === identity.pid)?.descriptor;
        const markerCount = processIdentityArgumentCount(identity.commandLine);
        const marker = processIdentityMarker(identity.commandLine);
        if (descriptor !== undefined) {
          if (marker !== `--bungee-process-identity=${descriptor.worker_instance_id}`) splitSnapshotValid = false;
          return false;
        }
        if (markerCount === 0) return false;
        if (marker === null || !isIngressCandidateForMaster(identity, master.testMarker)) splitSnapshotValid = false;
        return marker !== null && isIngressCandidateForMaster(identity, master.testMarker);
      });
      for (const identity of descendants) {
        if (descriptorPids.has(identity.pid) || processIdentityArgumentCount(identity.commandLine) === 0) continue;
        if (isIngressCandidateForMaster(identity, master.testMarker)
          && !directChildren.some(({ pid: childPid }) => childPid === identity.pid)) splitSnapshotValid = false;
      }
      const registeredIngress = [...currentRegistered.values()].filter(({ role, pid: ingressPid }) =>
        role === 'ingress' && probePid(ingressPid) !== 'dead');
      const ingressEntry = registeredIngress[0];
      const ingressPortsMatch = ingressEntry?.ports !== undefined
        && ingressEntry.ports.length === master.ingressPorts.length
        && ingressEntry.ports.every((port, index) => port === master.ingressPorts[index]);
      const knownPortsClosed = async (): Promise<boolean> => (await Promise.all(master.ports.map((port) => probeTcpPort(port)))).every((state) => state === 'closed');
      const knownIngressPortsClosed = async (): Promise<boolean> => (await Promise.all(master.ingressPorts.map((port) => probeTcpPort(port)))).every((state) => state === 'closed');
      const ingressCovered = legacy
        ? rootDeadCovered ? await knownPortsClosed() : master.ingressPorts.every((port) => master.processes.portOwnedByThis(port)
          && currentRegistered.get(pid)?.identity !== undefined && (currentRegistered.get(pid)!.ports ?? []).includes(port))
        : rootDeadCovered
          ? await (async () => {
            if (registeredIngress.length === 0) return knownPortsClosed();
            if (registeredIngress.length !== 1 || !ingressPortsMatch || ingressEntry!.identity === undefined
              || processIdentityMarker(ingressEntry!.identity.commandLine) === null
              || processIdentityArgumentCount(ingressEntry!.identity.commandLine) !== 1) return false;
            const ingressState = probePid(ingressEntry!.pid);
            if (ingressState === 'dead') return true;
            if (ingressState === 'unknown') return false;
            try {
              const actual = await captureProcessIdentity(ingressEntry!.pid);
              return actual !== null && processIdentityMatches(ingressEntry!.identity, actual, process.platform)
                ? true : knownPortsClosed();
            } catch { return false; }
          })()
          : registeredIngress.length === 0
            ? (master.workerCount === 0 || (currentDescriptors.length === 0
              && ![...currentRegistered.values()].some(({ role }) => role === 'worker')))
              && await knownIngressPortsClosed()
            : ingressCandidates.length === 1 && registeredIngress.length === 1
            && registeredIngress[0]!.identity !== undefined
            && processIdentityMatches(registeredIngress[0]!.identity, ingressCandidates[0]!, process.platform)
            || ingressCandidates.length === 0 && registeredIngress.length === 1
              && registeredIngress[0]!.identity !== undefined
              && probePid(registeredIngress[0]!.pid) === 'alive'
              && await captureProcessIdentity(registeredIngress[0]!.pid).then((actual) => actual !== null
                && processIdentityMatches(registeredIngress[0]!.identity!, actual, process.platform)).catch(() => false);
      const directChildrenCovered = rootLiveCovered
        ? [...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid).every((entry) => {
          if (probePid(entry.pid) === 'dead') return true;
          const observed = descendants.find(({ pid: observedPid }) => observedPid === entry.pid);
          return descendantPids.has(entry.pid) && observed !== undefined && entry.identity !== undefined
            && processIdentityMatches(entry.identity, observed, process.platform);
        })
        : rootDeadCovered && [...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid)
          .every(({ identity }) => identity !== undefined);
      const registeredChildrenCovered = rootLiveCovered
        ? [...currentRegistered.values()].every((entry) => {
          if (entry.pid === pid) return true;
          try {
            if (!processAlive(entry.pid)) return true;
          } catch { return false; }
          if (!descendantPids.has(entry.pid)) return false;
          const observed = descendants.find(({ pid: observedPid }) => observedPid === entry.pid);
          return observed !== undefined && entry.identity !== undefined
            && processIdentityMatches(entry.identity, observed, process.platform);
        })
        : rootDeadCovered && (await Promise.all([...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid).map(async (entry) => {
          if (entry.identity === undefined) return false;
          const probe = probePid(entry.pid);
          if (probe === 'dead') return true;
          if (probe === 'unknown') return false;
          try {
            const observed = await captureProcessIdentity(entry.pid);
            return observed !== null && processIdentityMatches(entry.identity, observed, process.platform)
              || observed !== null;
          } catch { return false; }
        }))).every(Boolean);
      const deadRootCleanupCovered = rootDeadCovered && [...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid)
        .every(({ identity }) => identity !== undefined);
      if ((rootLiveCovered || deadRootCleanupCovered)
        && workersCovered && ingressCovered && directChildrenCovered && registeredChildrenCovered
        && (legacy || splitSnapshotValid)) return;
      lastError = cleanupCoverageError(master, descriptors,
        ` rootLive=${rootLiveCovered} rootDead=${rootDeadCovered} workers=${workersCovered}`
        + ` ingress=${ingressCovered} direct=${directChildrenCovered} registry=${registeredChildrenCovered} split=${splitSnapshotValid}`
        + ` descendants=${descendants.length} currentDescriptors=${currentDescriptors.length} savedDescriptors=${savedDescriptors.length}`
        + ` registered=${currentRegistered.size}`);
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) throw new Error('bounded cleanup coverage capture failed', { cause: lastError });
    await Bun.sleep(WAIT_STEP_MS);
  }
}

export async function cleanupMaster(
  master: RunningMaster,
  /** Historical PID evidence only; ownership must have been captured while the master was alive. */
  workers: readonly number[] = [],
  options: CleanupMasterOptions = {},
): Promise<void> {
  const errors: unknown[] = [];
  if (options.fixture !== undefined) masterCleanupFixtures.set(master.processes, options.fixture);
  try {
    await master.stopMonitoringAndDrain();
    if (!master.rootExitState.exited && (master.child.exitCode !== null || master.child.signalCode !== null)) {
      await master.rootExit;
    }
    // Coverage is the authorization to signal. Never fall through on failure.
    await captureCleanupCoverage(master);
  } catch (error) { throw error; }
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
    await master.rootExit;
  } catch (error) { errors.push(error); }
  if (expectGraceful && (master.rootExitState.code !== 0 || master.rootExitState.signal !== null)) {
    errors.push(new Error(`graceful master exit contract failed: code=${master.rootExitState.code ?? 'null'} signal=${master.rootExitState.signal ?? 'null'}`));
  }
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
      if (masterFixtures.get(master.child.pid) === master.fixture) masterFixtures.delete(master.child.pid);
      if (masterMarkers.get(master.child.pid) === master.testMarker) masterMarkers.delete(master.child.pid);
      if (masterRootMarkers.get(master.child.pid) === master.rootMarker) masterRootMarkers.delete(master.child.pid);
    }
    masterPids.delete(master.processes);
    masterPorts.delete(master.processes);
    masterCleanupFixtures.delete(master.processes);
    masterDescriptorProofs.delete(master.processes);
    masterRootProofs.delete(master.processes);
    spawnedProcessMonitors.delete(master.processes);
    spawnedProcessRegistries.delete(master.processes);
    runningMasters.delete(master.processes);
  }
  if (errors.length > 0) {
    const report = workers.length === 0 ? '' : `; historical worker PIDs=${workers.join(',')}`;
    throw new AggregateError(errors, `master process cleanup failed${report}`);
  }
}

const NO_PRIMARY_ERROR = Symbol('no-primary-error');

/** Run assertions and cleanup without allowing teardown to hide the assertion failure. */
export async function runWithCleanup<T>(
  body: () => Promise<T> | T,
  cleanup: (() => Promise<void> | void) | readonly (() => Promise<void> | void)[],
): Promise<T> {
  let value!: T;
  let primary: unknown = NO_PRIMARY_ERROR;
  try { value = await body(); } catch (error) { primary = error; }
  const cleanups = Array.isArray(cleanup) ? cleanup : [cleanup];
  const settled = await Promise.allSettled(cleanups.map(async (operation) => await operation()));
  const cleanupErrors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (primary !== NO_PRIMARY_ERROR) {
    if (cleanupErrors.length > 0) throw new AggregateError([primary, ...cleanupErrors], 'test body and cleanup failed');
    throw primary;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'test cleanup failed');
  return value;
}

export const runWithCleanups = runWithCleanup;

export async function cleanupSpawnedProcesses(): Promise<void> {
  const registries = [...spawnedProcessRegistries];
  for (const registry of registries) spawnedProcessMonitors.get(registry)?.();
  const settled = await Promise.allSettled(registries.map((registry) => {
    const master = runningMasters.get(registry);
    return master === undefined ? cleanupProcesses(registry, { expectGraceful: false })
      : cleanupMaster(master, [], { fixture: master.fixture, expectGraceful: false });
  }));
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
        const master = runningMasters.get(registry);
        if (master !== undefined) {
          if (masterFixtures.get(masterPid) === master.fixture) masterFixtures.delete(masterPid);
          if (masterMarkers.get(masterPid) === master.testMarker) masterMarkers.delete(masterPid);
          if (masterRootMarkers.get(masterPid) === master.rootMarker) masterRootMarkers.delete(masterPid);
        }
      }
      masterPids.delete(registry);
      masterPorts.delete(registry);
      masterCleanupFixtures.delete(registry);
      masterDescriptorProofs.delete(registry);
      masterRootProofs.delete(registry);
      spawnedProcessMonitors.delete(registry);
      spawnedProcessRegistries.delete(registry);
      runningMasters.delete(registry);
    } else {
      errors.push(result.reason);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'spawned process cleanup failed');
}

export { captureProcessIdentity, captureProcessSnapshot, ProcessRegistry, cleanupProcesses, processAlive } from './process-cleanup';

export async function expectPortClosed(port: number): Promise<void> {
  await waitUntil(async () => {
    return (await probeTcpPort(port)) === 'closed';
  }, `port ${port} remained open`, 5_000);
}
