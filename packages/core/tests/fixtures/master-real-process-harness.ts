import { execFile, type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureProcessIdentity, captureProcessSnapshot, cleanupProcesses, processIdentityMatches, ProcessRegistry, processAlive, processLiveness, PROCESS_PROBE_TIMEOUT_MS, waitForDead as waitForRegisteredDead, type ExactProcessRegistration, type ProcessIdentitySnapshot, type ProcessLiveness } from './process-cleanup';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import { claimTestPortBlock, ensureTestPortBlockClosed, makeTestPortBlock, probeTestTcpPort, quarantineAndDetach, releaseTestPortBlock, testPortBlockOverlapsClaimed, type TestPortBlock, type TestTcpPortState } from '../../../../tests/support/test-port-block-broker';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed, parseWorkerDescriptor, SupervisionProtocolError, type WorkerDescriptor } from '../../src/supervision';
import { isLowercaseUuid } from '../../src/config-storage/validation';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/main.ts');
const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/main.js');
const WAIT_STEP_MS = 25;
const CLEANUP_COVERAGE_TIMEOUT_MS = 1_000;
const spawnedProcessMonitors = new Map<ProcessRegistry, () => void>();
const masterFixtures = new Map<number, MasterFixture>();
const masterMarkers = new Map<number, string>();
const masterRootMarkers = new Map<number, string>();
const masterRootProofs = new Map<ProcessRegistry, ProcessIdentitySnapshot>();
const masterRootProofHistory = new Map<ProcessRegistry, RootProofWriteRecord[]>();
const masterMonitorStates = new Map<ProcessRegistry, RootMonitorState>();
const masterPids = new Map<ProcessRegistry, number>();
const masterPorts = new Map<ProcessRegistry, readonly number[]>();
const masterCleanupFixtures = new Map<ProcessRegistry, MasterFixture>();
const masterDescriptorProofs = new Map<ProcessRegistry, readonly SignedDescriptor[]>();
const masterAdoptsReparentedWorkers = new WeakMap<ProcessRegistry, boolean>();
const descriptorDiagnostics = new Map<MasterFixture, DescriptorDiagnosticEvidence>();
const runningMasters = new Map<ProcessRegistry, RunningMaster>();
const execFileAsync = promisify(execFile);
export const ROOT_PROOF_LATE_WRITE_ERROR = 'late root proof write rejected after monitor stop';

export const TEST_RESOURCE_BROKER_CLEANUP_ERROR = 'test resource broker cleanup failed';
export type PortBlock = TestPortBlock;

export type MasterCleanupScope = {
  readonly scopeId: string;
  readonly registries: Set<ProcessRegistry>;
  readonly portBlocks: Set<PortBlock>;
};

export type RootProofSource = 'spawn' | 'monitor_snapshot' | 'descriptor_registration' | 'ownership_sync';
export type RootMonitorState = 'running' | 'stopped' | 'unknown';
export type RootProofWriteRecord = {
  readonly scope_id: string;
  readonly master_id: string;
  readonly proof_source: RootProofSource;
  readonly proof_write_sequence: number;
  readonly proof_fingerprint: string;
  readonly monitor_state: RootMonitorState;
};

export type DescriptorReadOutcome = 'ok' | 'empty' | 'missing' | 'parse_error' | 'read_error';
type DescriptorSetEvidence = { readonly outcome: DescriptorReadOutcome; readonly count: number; readonly fingerprint: string };
type DescriptorDiagnosticEvidence = {
  readonly current: DescriptorSetEvidence;
  readonly saved: DescriptorSetEvidence;
  readonly registration_source: string;
};

let nextScopeId = 1;

export function createMasterCleanupScope(): MasterCleanupScope {
  return { scopeId: `scope-${nextScopeId++}`, registries: new Set<ProcessRegistry>(), portBlocks: new Set<PortBlock>() };
}

function proofFingerprint(proof: ProcessIdentitySnapshot): string {
  return createHash('sha256').update(JSON.stringify(proof)).digest('hex');
}

export function rootIdentityMismatchFields(
  expected: ProcessIdentitySnapshot,
  actual: ProcessIdentitySnapshot,
  platform = process.platform,
): readonly string[] {
  const fields: string[] = [];
  if (expected.startToken !== actual.startToken) fields.push('start_token');
  const expectedExecutable = platform === 'win32' ? expected.executable.toLowerCase() : expected.executable;
  const actualExecutable = platform === 'win32' ? actual.executable.toLowerCase() : actual.executable;
  if (expectedExecutable !== actualExecutable) fields.push('executable');
  if (expected.commandLine !== actual.commandLine) fields.push('command_line');
  if (platform !== 'win32' && expected.roleMarker !== actual.roleMarker) fields.push('role_marker');
  if (platform !== 'win32' && expected.testMarker !== actual.testMarker) fields.push('test_marker');
  return fields;
}

function rootMarkerMismatchFields(actual: ProcessIdentitySnapshot, rootMarker: string, testMarker: string | undefined, platform: NodeJS.Platform): readonly string[] {
  const fields: string[] = [];
  if (countExactMarker(actual.commandLine, rootMarker) !== 1) fields.push('command_line');
  if (platform === 'linux' && testMarker !== undefined && actual.testMarker !== testMarker) fields.push('test_marker');
  return fields;
}

export function writeRootProof(
  registry: ProcessRegistry,
  proof: ProcessIdentitySnapshot,
  source: RootProofSource,
  scope: MasterCleanupScope | undefined,
  masterId: string,
  monitorState: RootMonitorState,
  allowStopped = false,
): void {
  if (monitorState === 'stopped' && !allowStopped) throw new Error(ROOT_PROOF_LATE_WRITE_ERROR);
  const history = masterRootProofHistory.get(registry) ?? [];
  const record: RootProofWriteRecord = {
    scope_id: scope?.scopeId ?? 'unscoped', master_id: masterId, proof_source: source,
    proof_write_sequence: history.length + 1, proof_fingerprint: proofFingerprint(proof), monitor_state: monitorState,
  };
  masterRootProofs.set(registry, proof);
  history.push(record);
  masterRootProofHistory.set(registry, history);
}

export function rootProofWriteEvidence(registry: ProcessRegistry): readonly RootProofWriteRecord[] {
  return [...(masterRootProofHistory.get(registry) ?? [])];
}

function descriptorFingerprint(descriptors: readonly SignedDescriptor[]): string {
  return createHash('sha256').update(JSON.stringify(descriptors.map(({ descriptor }) => ({
    pid: descriptor.pid, master_generation: descriptor.master_generation, worker_instance_id: descriptor.worker_instance_id,
    boot_nonce: descriptor.boot_nonce, worker_slot: descriptor.worker_slot, private_port: descriptor.private_port,
  })).sort((left, right) => left.pid - right.pid))).digest('hex');
}

function descriptorSetEvidence(outcome: DescriptorReadOutcome, descriptors: readonly SignedDescriptor[] = []): DescriptorSetEvidence {
  return { outcome, count: descriptors.length, fingerprint: descriptorFingerprint(descriptors) };
}

export function classifyDescriptorReadError(error: unknown): Extract<DescriptorReadOutcome, 'parse_error' | 'read_error'> {
  if (error instanceof SyntaxError || error instanceof SupervisionProtocolError
    || (error instanceof Error && error.message.startsWith('worker descriptor'))) return 'parse_error';
  return 'read_error';
}

function recordDescriptorDiagnostic(
  fixture: MasterFixture,
  current: DescriptorSetEvidence,
  saved: readonly SignedDescriptor[],
  registrationSource: string,
): void {
  descriptorDiagnostics.set(fixture, {
    current, saved: descriptorSetEvidence(saved.length === 0 ? 'empty' : 'ok', saved), registration_source: registrationSource,
  });
}
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
  readonly confirmRootAbsence: () => void;
  readonly settleRootExit: (confirmedBy: 'event' | 'close' | 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null) => void;
  readonly synchronizeOwnership: () => Promise<void>;
  readonly output: () => string;
  readonly testMarker: string;
  readonly rootMarker: string;
  readonly ingressPorts: readonly number[];
  readonly workerCount: number;
  readonly cleanupProbes?: CleanupProbeSet;
  readonly cleanupScope?: MasterCleanupScope;
};

export type RootExitEvidence = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type RootExitState = {
  exited: boolean; code: number | null; signal: NodeJS.Signals | null;
  confirmedBy: 'event' | 'close' | 'os_absence' | 'os_terminal' | 'os_replaced' | null;
  eventObserved?: boolean; eventCode?: number | null; eventSignal?: NodeJS.Signals | null; closeObserved?: boolean;
};

export type CleanupMasterOptions = {
  readonly fixture?: MasterFixture;
  readonly ports?: readonly number[];
  readonly expectGraceful?: boolean;
  readonly probePort?: (port: number) => Promise<TcpPortState>;
};

export type CleanupSpawnedProcessesOptions = {
  /** Keep this scope's leased blocks quarantined after a startup address collision. */
  readonly quarantinePorts?: boolean;
};

type TcpPortState = TestTcpPortState;
export type CleanupProbeSet = {
  readonly snapshot: () => Promise<readonly ProcessIdentitySnapshot[]>;
  readonly identity: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
  readonly alive: (pid: number) => boolean;
  readonly signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly port: (port: number) => Promise<TcpPortState>;
  readonly liveness?: (pid: number) => ProcessLiveness;
  readonly platform?: NodeJS.Platform;
};

export type FakeRunningMasterOptions = {
  readonly fixture: MasterFixture;
  readonly root: ProcessIdentitySnapshot;
  readonly testMarker: string;
  readonly rootMarker: string;
  readonly ports: readonly number[];
  readonly ingressPorts: readonly number[];
  readonly workerCount: number;
  readonly rootExited?: boolean;
  readonly rootPorts?: readonly number[];
  readonly savedDescriptors?: readonly SignedDescriptor[];
  readonly probes: CleanupProbeSet;
  readonly stopMonitoringAndDrain?: () => Promise<void>;
  readonly cleanupScope?: MasterCleanupScope;
  readonly onKill?: () => void;
  readonly registered?: readonly { readonly identity: ProcessIdentitySnapshot; readonly role: 'worker' | 'ingress'; readonly ports?: readonly number[] }[];
};

export function createFakeRunningMaster(options: FakeRunningMasterOptions): RunningMaster {
  const rootExited = options.rootExited === true;
  const fakeChild: { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: () => void } = {
    pid: options.root.pid, exitCode: rootExited ? 0 : null, signalCode: null,
    kill: () => { fakeChild.exitCode = 0; options.onKill?.(); },
  };
  const child = fakeChild as unknown as ChildProcess;
  const rootExitState: RootExitState = { exited: false, code: null, signal: null, confirmedBy: null };
  let resolveRootExit!: (evidence: RootExitEvidence) => void;
  const rootExit = new Promise<RootExitEvidence>((resolve) => { resolveRootExit = resolve; });
  const processes = new ProcessRegistry({ liveness: options.probes.liveness, alive: options.probes.alive, signal: options.probes.signal, captureIdentity: options.probes.identity, requireTestMarker: false });
  let rootSettled = false;
  const settleRoot = (confirmedBy: 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null): void => {
    if (rootSettled) return;
    rootSettled = true;
    rootExitState.exited = true;
    rootExitState.code = code;
    rootExitState.signal = signal;
    rootExitState.confirmedBy = confirmedBy;
    fakeChild.exitCode = code;
    fakeChild.signalCode = signal;
    processes.confirmHandleClosed(child);
    resolveRootExit({ code, signal });
  };
  processes.registerChild(child, options.root, { ports: options.rootPorts });
  for (const entry of options.registered ?? []) {
    if (entry.role === 'worker') processes.registerPid(entry.identity.pid, entry.identity, { role: 'worker' });
    else processes.registerAdoptedIngress(entry.identity.pid, entry.ports ?? options.ingressPorts, entry.identity);
  }
  let settleRootExit!: (confirmedBy: 'event' | 'close' | 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null) => void;
  let master: RunningMaster;
  master = {
    child, processes, ports: options.ports, fixture: options.fixture,
    stopMonitoring: () => {}, stopMonitoringAndDrain: options.stopMonitoringAndDrain ?? (async () => {}), rootExit,
    rootExitState, output: () => '', testMarker: options.testMarker, rootMarker: options.rootMarker,
    confirmRootAbsence: () => settleRootExit('os_absence', rootExitState.eventCode ?? null, rootExitState.eventSignal ?? null), settleRootExit: (...args) => settleRootExit(...args),
    ingressPorts: options.ingressPorts, workerCount: options.workerCount, cleanupProbes: options.probes, cleanupScope: options.cleanupScope,
    synchronizeOwnership: async () => synchronizeMasterOwnership(master),
  };
  masterPids.set(processes, options.root.pid);
  masterPorts.set(processes, options.ports);
  masterFixtures.set(options.root.pid, options.fixture);
  masterMarkers.set(options.root.pid, options.testMarker);
  masterRootMarkers.set(options.root.pid, options.rootMarker);
  writeRootProof(processes, options.root, 'spawn', options.cleanupScope, String(options.root.pid), 'unknown');
  masterDescriptorProofs.set(processes, options.savedDescriptors ?? []);
  options.cleanupScope?.registries.add(processes);
  const observeRootEvent = (kind: 'event' | 'close', code: number | null, signal: NodeJS.Signals | null): void => {
    if (rootSettled) return;
    if (kind === 'event') rootExitState.eventObserved = true;
    else rootExitState.closeObserved = true;
    rootExitState.eventCode = code;
    rootExitState.eventSignal = signal;
  };
  settleRootExit = (confirmedBy: 'event' | 'close' | 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null): void => {
    if (confirmedBy === 'event' || confirmedBy === 'close') observeRootEvent(confirmedBy, code, signal);
    else settleRoot(confirmedBy, code, signal);
  };
  if (rootExited) {
    rootExitState.eventObserved = true;
    rootExitState.eventCode = 0;
    rootExitState.eventSignal = null;
  }
  runningMasters.set(processes, master);
  return master;
}

export function masterLifecycleMapSizes(registry?: ProcessRegistry, masterPid?: number): Record<string, number> {
  const scopedMasterPid = registry === undefined ? undefined : masterPid ?? masterPids.get(registry);
  const scopedFixture = registry === undefined ? undefined : masterCleanupFixtures.get(registry);
  return {
    masterFixtures: registry === undefined ? masterFixtures.size : Number(scopedMasterPid !== undefined && masterFixtures.has(scopedMasterPid)),
    masterMarkers: registry === undefined ? masterMarkers.size : Number(scopedMasterPid !== undefined && masterMarkers.has(scopedMasterPid)),
    masterRootMarkers: registry === undefined ? masterRootMarkers.size : Number(scopedMasterPid !== undefined && masterRootMarkers.has(scopedMasterPid)),
    masterRootProofs: registry === undefined ? masterRootProofs.size : Number(masterRootProofs.has(registry)),
    masterRootProofHistory: registry === undefined ? masterRootProofHistory.size : Number(masterRootProofHistory.has(registry)),
    masterMonitorStates: registry === undefined ? masterMonitorStates.size : Number(masterMonitorStates.has(registry)),
    masterPids: registry === undefined ? masterPids.size : Number(masterPids.has(registry)),
    masterPorts: registry === undefined ? masterPorts.size : Number(masterPorts.has(registry)),
    masterCleanupFixtures: registry === undefined ? masterCleanupFixtures.size : Number(masterCleanupFixtures.has(registry)),
    masterDescriptorProofs: registry === undefined ? masterDescriptorProofs.size : Number(masterDescriptorProofs.has(registry)),
    descriptorDiagnostics: registry === undefined ? descriptorDiagnostics.size : Number(scopedFixture !== undefined && descriptorDiagnostics.has(scopedFixture)),
    runningMasters: registry === undefined ? runningMasters.size : Number(runningMasters.has(registry)),
    spawnedProcessMonitors: registry === undefined ? spawnedProcessMonitors.size : Number(spawnedProcessMonitors.has(registry)),
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
  readonly adoptReparentedWorkers?: boolean;
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

function brokerBlockInUse(block: PortBlock): boolean {
  return testPortBlockOverlapsClaimed(block);
}

function leasePortBlock(scope: MasterCleanupScope, basePort: number): PortBlock {
  const block = makeTestPortBlock(basePort);
  if (!claimTestPortBlock(block)) throw new Error('port block is already reserved');
  scope.portBlocks.add(block);
  return block;
}

export async function freePort(scope: MasterCleanupScope, excludedPorts: readonly number[] = []): Promise<number> {
  for (;;) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = server.port;
    if (port === undefined) { await server.stop(true); continue; }
    const block = makeTestPortBlock(port);
    let next: ReturnType<typeof Bun.serve> | null = null;
    let nextNext: ReturnType<typeof Bun.serve> | null = null;
    const owned = [server];
    const stopped = new Set<ReturnType<typeof Bun.serve>>();
    let leased: PortBlock | undefined;
    const stopOwned = async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const candidate of owned) {
        if (stopped.has(candidate)) continue;
        try { await candidate.stop(true); stopped.add(candidate); }
        catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'port reservation cleanup failed');
    };
    try {
      if (port < 1 || port > 65532 || brokerBlockInUse(block)
        || block.ports.some((candidate) => excludedPorts.includes(candidate))) {
        await stopOwned();
        continue;
      }
      next = Bun.serve({ hostname: '127.0.0.1', port: port + 1, fetch: () => new Response('reserved') });
      owned.push(next);
      nextNext = Bun.serve({ hostname: '127.0.0.1', port: port + 2, fetch: () => new Response('reserved') });
      owned.push(nextNext);
      leased = leasePortBlock(scope, port);
      try {
        await stopOwned();
        await ensureTestPortBlockClosed(leased);
      }
      catch (error) { quarantineAndDetach(scope, leased); throw error; }
      return port;
    } catch (error) {
      try { await stopOwned(); }
      catch (cleanupError) {
        if (leased === undefined) quarantineAndDetach(scope, block);
        throw new AggregateError([error, cleanupError], 'port reservation failed', { cause: error });
      }
      if (!errorCode(error) || errorCode(error) !== 'EADDRINUSE') throw error;
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
  scope: MasterCleanupScope,
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
  const rootExitState: RootExitState = { exited: false, code: null, signal: null, confirmedBy: null };
  let resolveRootExit!: (evidence: RootExitEvidence) => void;
  const rootExit = new Promise<RootExitEvidence>((resolveExit) => { resolveRootExit = resolveExit; });
  let processes: ProcessRegistry | undefined;
  let rootSettled = false;
  let confirmRootFromFreshProbe!: () => Promise<void>;
  const commitRootExit = (confirmedBy: 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null): void => {
    if (rootSettled) return;
    rootSettled = true;
    rootExitState.exited = true;
    rootExitState.code = code;
    rootExitState.signal = signal;
    rootExitState.confirmedBy = confirmedBy;
    if (processes !== undefined) processes.confirmHandleClosed(child);
    resolveRootExit({ code, signal });
  };
  const observeRootEvent = (kind: 'event' | 'close', code: number | null, signal: NodeJS.Signals | null): void => {
    if (rootSettled) return;
    if (kind === 'event') rootExitState.eventObserved = true;
    else rootExitState.closeObserved = true;
    rootExitState.eventCode = code;
    rootExitState.eventSignal = signal;
    void confirmRootFromFreshProbe().catch(() => undefined);
  };
  const settleRootExit = (confirmedBy: 'event' | 'close' | 'os_absence' | 'os_terminal' | 'os_replaced', code: number | null, signal: NodeJS.Signals | null): void => {
    if (confirmedBy === 'event' || confirmedBy === 'close') observeRootEvent(confirmedBy, code, signal);
    else commitRootExit(confirmedBy, code, signal);
  };
  child.once('exit', (code, signal) => {
    observeRootEvent('event', code, signal);
  });
  child.once('close', () => observeRootEvent('close', child.exitCode, child.signalCode));
  if (child.pid !== undefined) {
    masterFixtures.set(child.pid, fixture);
    masterMarkers.set(child.pid, marker);
    masterRootMarkers.set(child.pid, rootMarker);
  }
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  processes = new ProcessRegistry({ signal: options.signal, requireTestMarker: false });
  const captureSnapshot = options.captureProcessSnapshot ?? captureProcessSnapshot;
  const captureIdentity = options.captureProcessIdentity ?? captureProcessIdentity;
  confirmRootFromFreshProbe = async (): Promise<void> => {
    if (rootSettled || child.pid === undefined) return;
    const liveness = processLiveness(child.pid);
    if (liveness === 'unknown') return;
    if (liveness === 'terminal' || liveness === 'absent') {
      commitRootExit(liveness === 'terminal' ? 'os_terminal' : 'os_absence', rootExitState.eventCode ?? null, rootExitState.eventSignal ?? null);
      return;
    }
    let actual: ProcessIdentitySnapshot | null;
    try { actual = await captureIdentity(child.pid); } catch { return; }
    const expected = masterRootProofs.get(processes!);
    if (actual !== null && expected !== undefined && !processIdentityMatches(expected, actual, process.platform)) {
      commitRootExit('os_replaced', rootExitState.eventCode ?? null, rootExitState.eventSignal ?? null);
    }
  };
  const ports = split ? [port, port + 1, port + 2] : [port];
  const ingressPorts = split ? [port + 1, port + 2] : [port];
  processes.registerChild(child, undefined, split ? {} : { ports });
  masterAdoptsReparentedWorkers.set(processes, options.adoptReparentedWorkers === true);
  if (rootExitState.exited && rootExitState.confirmedBy !== 'os_replaced') processes.confirmHandleClosed(child);
  let monitoring = false;
  let stopped = false;
  let runningMaster: RunningMaster | undefined;
  let inFlightCapture: Promise<void> | undefined;
  const pendingCaptures = new Set<Promise<unknown>>();
  const monitorRootMarker = (): string => runningMaster?.rootMarker ?? rootMarker;
  const stableMonitorRootProof = (direct: ProcessIdentitySnapshot | null): ProcessIdentitySnapshot | undefined => {
    const marker = `--bungee-test-root-marker=${monitorRootMarker()}`;
    const directIsRoot = direct !== null && countExactMarker(direct.commandLine, marker) === 1
      && (process.platform !== 'linux' || direct.testMarker === (runningMaster?.testMarker ?? marker));
    const proof = directIsRoot ? direct : masterRootProofs.get(processes);
    if (directIsRoot && proof !== undefined && masterRootProofs.get(processes) === undefined
      && masterMonitorStates.get(processes) !== 'stopped') {
      writeRootProof(processes, proof, 'monitor_snapshot', scope, String(child.pid), masterMonitorStates.get(processes) ?? 'unknown');
    }
    if (proof === undefined) {
      recordDescriptorDiagnostic(fixture, descriptorDiagnostics.get(fixture)?.current ?? descriptorSetEvidence('empty'),
        masterDescriptorProofs.get(processes) ?? [], 'monitor_no_stable_root_proof');
    }
    return proof;
  };
  const trackCapture = <T>(capture: Promise<T>): Promise<T> => {
    pendingCaptures.add(capture);
    void capture.finally(() => pendingCaptures.delete(capture));
    return capture;
  };
  const startCapture = (): void => {
    if (stopped || monitoring) return;
    monitoring = true;
    const capture = (async () => {
      if (rootExitState.exited || child.pid === undefined) {
        clearInterval(monitor);
        return;
      }
      const direct = await captureIdentity(child.pid);
      const stableRootProof = stableMonitorRootProof(direct);
      if (stableRootProof === undefined) {
        return;
      }
      await registerDescendantPids(processes, await captureSnapshot(), child.pid, fixture, ingressPorts,
        monitorRootMarker(), stableRootProof, undefined, process.platform, 'monitor_snapshot');
    })();
    inFlightCapture = capture;
    void capture.catch(() => undefined).finally(() => {
      monitoring = false;
      if (inFlightCapture === capture) inFlightCapture = undefined;
    });
  };
  const monitor = setInterval(startCapture, WAIT_STEP_MS);
  monitor.unref?.();
  masterMonitorStates.set(processes, 'running');
  const stopMonitoring = () => { stopped = true; masterMonitorStates.set(processes, 'stopped'); clearInterval(monitor); };
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
  scope.registries.add(processes);
  masterPorts.set(processes, ports);
  if (child.pid !== undefined) masterPids.set(processes, child.pid);
  const running: RunningMaster = {
    child, processes, fixture, testMarker: marker, rootMarker,
    ports, ingressPorts, workerCount, cleanupScope: scope,
    stopMonitoring, stopMonitoringAndDrain, rootExit, rootExitState,
    confirmRootAbsence: () => { void confirmRootFromFreshProbe().catch(() => undefined); }, settleRootExit,
    synchronizeOwnership: async () => synchronizeMasterOwnership(running),
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
  runningMaster = running;
  runningMasters.set(processes, running);
  if (child.pid !== undefined) {
    trackCapture(captureIdentity(child.pid)
      .then((identity) => {
        if (identity !== null && countExactMarker(identity.commandLine, `--bungee-test-root-marker=${running.rootMarker}`) === 1
          && (process.platform !== 'linux' || identity.testMarker === running.testMarker)) {
          writeRootProof(processes, identity, 'monitor_snapshot', scope, String(child.pid), masterMonitorStates.get(processes) ?? 'unknown');
          processes.setIdentity(child.pid!, identity);
        }
      })
      .catch(() => undefined));
    trackCapture(captureIdentity(child.pid)
      .then(async (direct) => {
        const stableRootProof = stableMonitorRootProof(direct);
        if (stableRootProof === undefined) {
          return;
        }
        const snapshot = await captureSnapshot();
        await registerDescendantPids(processes, snapshot, child.pid!, fixture, ingressPorts,
          running.rootMarker, stableRootProof, undefined, process.platform, 'monitor_snapshot');
      })
      .catch(() => undefined));
  }
  return running;
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('wait aborted');
    if (await predicate()) return;
    await Promise.race([
      Bun.sleep(WAIT_STEP_MS),
      signal === undefined ? new Promise<void>(() => {}) : new Promise<void>((_, reject) => {
        const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('wait aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  }
  throw new Error(message);
}

export type TestPhaseBudget = {
  readonly deadline: number;
  readonly cleanupReserveMs: number;
  readonly signal: AbortSignal;
  remaining(): number;
  bodyRemaining(): number;
  run<T>(phase: string, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>): Promise<T>;
  runCleanup<T>(phase: string, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>): Promise<T>;
};

export type TestPhaseBudgetOptions = {
  readonly schedule?: (callback: () => void, milliseconds: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  readonly cleanupReserveMs?: number;
};

export function createTestPhaseBudget(totalMs = 55_000, now: () => number = Date.now, options: TestPhaseBudgetOptions = {}): TestPhaseBudget {
  const deadline = now() + totalMs;
  const cleanupReserveMs = options.cleanupReserveMs ?? 15_000;
  const controller = new AbortController();
  const schedule = options.schedule ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return {
    deadline,
    cleanupReserveMs,
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - now()),
    bodyRemaining: () => Math.max(0, deadline - cleanupReserveMs - now()),
    async run<T>(phase: string, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>) {
      const remainingMs = deadline - cleanupReserveMs - now();
      if (remainingMs <= 0) {
        controller.abort(new Error(`phase budget exhausted: ${phase}`));
        throw new Error(`phase budget exhausted: ${phase}`);
      }
      let timer: unknown;
      let timedOut = false;
      const operationPromise = operation(controller.signal, remainingMs);
      const timeout = new Promise<never>((_, reject) => {
        timer = schedule(() => {
          timedOut = true;
          controller.abort(new Error(`phase budget exhausted: ${phase}`));
          reject(new Error(`phase budget exhausted: ${phase}`));
        }, remainingMs);
      });
      try { return await Promise.race([operationPromise, timeout]); }
      catch (error) {
        if (timedOut) await operationPromise.catch(() => undefined);
        throw error;
      }
      finally { if (timer !== undefined) cancel(timer); }
    },
    async runCleanup<T>(phase: string, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>) {
      const remainingMs = Math.max(0, deadline - now());
      const cleanupController = new AbortController();
      let timer: unknown;
      let timedOut = false;
      const cleanup = operation(cleanupController.signal, remainingMs);
      if (remainingMs <= 0) {
        timedOut = true;
        cleanupController.abort(new Error(`phase budget exhausted: ${phase}`));
        await cleanup.catch(() => undefined);
        throw new Error(`phase budget exhausted: ${phase}`);
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = schedule(() => {
          timedOut = true;
          cleanupController.abort(new Error(`phase budget exhausted: ${phase}`));
          reject(new Error(`phase budget exhausted: ${phase}`));
        }, remainingMs);
      });
      try { return await Promise.race([cleanup, timeout]); }
      catch (error) {
        if (timedOut) await cleanup.catch(() => undefined);
        throw error;
      }
      finally { if (timer !== undefined) cancel(timer); }
    },
  };
}

export async function waitForHealth(port: number, master: RunningMaster, signal?: AbortSignal): Promise<void> {
  await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error(`master exited before health check: ${master.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { connection: 'close' },
        signal: signal === undefined ? AbortSignal.timeout(250) : AbortSignal.any([signal, AbortSignal.timeout(250)]),
      });
      return response.status === 200 && await response.text() === '{"status":"ok"}';
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }, `master did not serve health: ${master.output()}`, 15_000, signal);
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
  rootMarker = masterRootMarkers.get(masterPid),
  master?: RunningMaster,
): readonly ProcessIdentitySnapshot[] {
  const roots = snapshot.filter(({ pid }) => pid === masterPid);
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  const rootProof = master === undefined ? undefined : masterRootProofs.get(master.processes);
  if (rootProof !== undefined) {
    if (!processIdentityMatches(rootProof, root, process.platform)) return [];
  } else if (rootMarker === undefined || countExactMarker(root.commandLine, `--bungee-test-root-marker=${rootMarker}`) !== 1) {
    return [];
  }
  const descendants = descendantProcessSnapshot(snapshot, masterPid, testMarker, process.platform === 'linux', rootProof, rootMarker);
  return descendants
    .filter((identity) => descriptorPids.has(identity.pid));
}

export function workerObservationDiagnostics(
  master: RunningMaster,
  descriptorPids: ReadonlySet<number>,
  snapshot: readonly ProcessIdentitySnapshot[],
): string {
  const masterPid = master.child.pid ?? -1;
  const observedRoot = snapshot.find(({ pid }) => pid === masterPid);
  const savedRoot = masterRootProofs.get(master.processes);
  const rootMarker = `--bungee-test-root-marker=${master.rootMarker}`;
  const rootMismatch = observedRoot !== undefined && (
    savedRoot !== undefined
      ? !processIdentityMatches(savedRoot, observedRoot, process.platform)
      : countExactMarker(observedRoot.commandLine, rootMarker) !== 1
        || (process.platform === 'linux' && observedRoot.testMarker !== master.testMarker)
  );
  if (rootMismatch) {
    const mismatchFields = savedRoot === undefined
      ? rootMarkerMismatchFields(observedRoot!, rootMarker, master.testMarker, process.platform)
      : rootIdentityMismatchFields(savedRoot, observedRoot!, process.platform);
    return `master pid=${masterPid} alive=${processAlive(masterPid)}; descriptor PIDs=[${[...descriptorPids].join(',')}]; `
      + `root_identity_mismatch_fields=${mismatchFields.join(',')}; snapshot_count=${snapshot.length}; ${descriptorDiagnosticText(master)}`;
  }
  const descendants = new Set(workerIdentitiesFromSnapshot(snapshot, masterPid, descriptorPids, master.testMarker, master.rootMarker, master).map(({ pid }) => pid));
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
    + `expected master marker=${master.rootMarker}; snapshot candidates=${candidateDetails || '[]'}; ${descriptorDiagnosticText(master)}`;
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
  platform = process.platform,
  proofSource: RootProofSource = 'descriptor_registration',
  optionsOrAllowStopped: boolean | { readonly allowStopped?: boolean; readonly persist?: boolean } = false,
): Promise<readonly ExactProcessRegistration[]> {
  const persist = typeof optionsOrAllowStopped === 'boolean' || optionsOrAllowStopped.persist !== false;
  if (!registry.hasLiveHandle(masterPid)) return [];
  if (rootMarker === undefined) return [];
  const root = snapshot.find(({ pid }) => pid === masterPid);
  const savedRootProof = rootProof ?? masterRootProofs.get(registry);
  if (root === undefined) return [];
  const testMarker = runningMasters.get(registry)?.testMarker ?? masterMarkers.get(masterPid);
  const platformRequiresTestMarker = platform === 'linux' && requireTestMarker;
  const descendants = descendantProcessSnapshot(snapshot, masterPid, testMarker, platformRequiresTestMarker, savedRootProof, rootMarker, platform);
  if (countExactMarker(root.commandLine, `--bungee-test-root-marker=${rootMarker}`) !== 1
    || (savedRootProof !== undefined && !processIdentityMatches(savedRootProof, root, platform))) return [];
  if (platformRequiresTestMarker && root.testMarker !== testMarker) return [];
  // Legacy masters have no signed descriptor or process-identity contract. Their
  // root proof is still exact, so register the complete rooted PPID tree as
  // generic children and leave the listener port on the root registration.
  if (ingressPorts.length <= 1) {
    const plan = descendants.map((identity) => ({ identity }));
    if (persist) registry.registerExactProcesses(savedRootProof === undefined ? plan : [{ identity: savedRootProof }, ...plan]);
    return plan;
  }
  const observedDescriptors = await readSignedWorkerDescriptors(fixture);
  const workerMarkers = new Map(observedDescriptors.map(({ descriptor }) =>
    [descriptor.pid, `--bungee-process-identity=${descriptor.worker_instance_id}`] as const));
  const directChildren = descendants.filter((identity) => identity.ppid === masterPid);
  const ownedDescriptors: SignedDescriptor[] = [];
  const ownedDescriptorIdentities = new Map<number, ProcessIdentitySnapshot>();
  const priorDescriptors = masterDescriptorProofs.get(registry) ?? [];
  recordDescriptorDiagnostic(fixture, descriptorDiagnostics.get(fixture)?.current ?? descriptorSetEvidence('empty'), priorDescriptors, proofSource);
  const descriptorsByPid = new Map([...priorDescriptors, ...observedDescriptors].map(({ descriptor }) => [descriptor.pid, descriptor] as const));
  for (const candidate of observedDescriptors) {
    // Signed workers may be reparented to init while their master is being
    // replaced.  The descriptor is the ownership proof; ingress still must be
    // a rooted direct child and is never admitted through this path.
    const identity = (masterAdoptsReparentedWorkers.get(registry) === true ? snapshot : descendants)
      .find(({ pid }) => pid === candidate.descriptor.pid);
    if (identity !== null && identity !== undefined
      && processIdentityMarker(identity.commandLine) === workerMarkers.get(candidate.descriptor.pid)) {
      ownedDescriptors.push(candidate);
      ownedDescriptorIdentities.set(candidate.descriptor.pid, identity);
    }
  }
  const mergedDescriptors = [...priorDescriptors];
  for (const candidate of ownedDescriptors) {
    const index = mergedDescriptors.findIndex(({ descriptor }) => descriptor.pid === candidate.descriptor.pid
      && descriptor.worker_instance_id === candidate.descriptor.worker_instance_id);
    if (index < 0) mergedDescriptors.push(candidate);
    else mergedDescriptors[index] = candidate;
  }
  const ingressCandidates = directChildren.filter((identity) => {
    const descriptor = descriptorsByPid.get(identity.pid);
    return descriptor === undefined && isIngressCandidateForMaster(identity, testMarker, platform, platformRequiresTestMarker);
  });
  const ingress = ingressCandidates.length === 1 ? ingressCandidates[0] : undefined;
  const plan: ExactProcessRegistration[] = [];
  for (const discovered of descendants) {
    const pid = discovered.pid;
    const workerMarker = workerMarkers.get(pid);
    if (workerMarker !== undefined && processIdentityMarker(discovered.commandLine) === workerMarker) {
      plan.push({ identity: discovered, role: 'worker' });
    } else if (discovered === ingress) {
      plan.push({ identity: discovered, role: 'ingress', ports: ingressPorts });
    } else if (processIdentityArgumentCount(discovered.commandLine) === 0) {
      // Exact identity is enough for a rooted plugin child; it must not own ingress ports.
      plan.push({ identity: discovered });
    }
  }
  for (const candidate of ownedDescriptors) {
    const identity = ownedDescriptorIdentities.get(candidate.descriptor.pid);
    if (identity !== undefined && !plan.some(({ identity: planned }) => planned.pid === identity.pid)) {
      plan.push({ identity, role: 'worker' });
    }
  }
  if (persist) {
    const committed = registry.registerExactProcesses(savedRootProof === undefined ? plan : [{ identity: savedRootProof }, ...plan]);
    if (committed) {
      masterDescriptorProofs.set(registry, mergedDescriptors);
      recordDescriptorDiagnostic(fixture, descriptorDiagnostics.get(fixture)?.current ?? descriptorSetEvidence('empty'), mergedDescriptors, proofSource);
    }
  }
  return plan;
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

function probePid(pid: number, alive: (pid: number) => boolean = processAlive): 'alive' | 'dead' | 'unknown' {
  try { return alive(pid) ? 'alive' : 'dead'; }
  catch (error) { return errorCode(error) === 'ESRCH' ? 'dead' : 'unknown'; }
}

function isIngressCandidate(identity: ProcessIdentitySnapshot): boolean {
  return processIdentityMarker(identity.commandLine) !== null
    && (identity.roleMarker === undefined || identity.roleMarker === 'ingress');
}

function isIngressCandidateForMaster(identity: ProcessIdentitySnapshot, testMarker: string | undefined, platform = process.platform, requireTestMarker = platform === 'linux'): boolean {
  if (!isIngressCandidate(identity)) return false;
  return platform === 'linux' && requireTestMarker
    ? testMarker !== undefined && identity.testMarker === testMarker
    : true;
}

async function descriptorWorkerPids(fixture: MasterFixture): Promise<ReadonlySet<number>> {
  return new Set((await descriptorWorkerMarkers(fixture)).keys());
}

type SignedDescriptor = { readonly file: string; readonly descriptor: WorkerDescriptor };

export type DescriptorBackup = { readonly path: string; readonly backup: string };

export async function restoreDescriptorBackups(
  backups: readonly DescriptorBackup[],
  tamperedPaths: readonly string[] = backups.map(({ path }) => path),
): Promise<void> {
  const groups = new Map<string, Set<string>>();
  const backupOwners = new Map<string, string>();
  for (const { path, backup } of backups) {
    const owner = backupOwners.get(backup);
    if (owner !== undefined && owner !== path) throw new Error(`descriptor backup path is shared by ${owner} and ${path}`);
    backupOwners.set(backup, path);
    const paths = groups.get(path) ?? new Set<string>();
    paths.add(backup);
    groups.set(path, paths);
  }
  const restores = new Map<string, string>();
  for (const [path, candidates] of groups) {
    const valid = [] as string[];
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) valid.push(candidate); }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    if (valid.length > 1) throw new Error(`descriptor backup has multiple valid copies for ${path}`);
    if (valid.length === 1) restores.set(path, valid[0]!);
    else throw new Error(`descriptor backup is unavailable for ${path}`);
  }
  for (const path of [...new Set(tamperedPaths)]) {
    await rm(path, { recursive: true, force: true });
  }
  for (const [path, backup] of restores) await rename(backup, path);
}

async function readSignedWorkerDescriptors(fixture: MasterFixture): Promise<readonly SignedDescriptor[]> {
  try {
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
    const outcome: DescriptorReadOutcome = descriptors.length === 0
      ? (await pathExists(directory) ? 'empty' : 'missing') : 'ok';
    descriptorDiagnostics.set(fixture, {
      current: descriptorSetEvidence(outcome, descriptors),
      saved: descriptorDiagnostics.get(fixture)?.saved ?? descriptorSetEvidence('empty'),
      registration_source: descriptorDiagnostics.get(fixture)?.registration_source ?? 'read_only',
    });
    return descriptors;
  } catch (error) {
    descriptorDiagnostics.set(fixture, {
      current: descriptorSetEvidence(classifyDescriptorReadError(error)),
      saved: descriptorDiagnostics.get(fixture)?.saved ?? descriptorSetEvidence('empty'),
      registration_source: descriptorDiagnostics.get(fixture)?.registration_source ?? 'read_error',
    });
    throw error;
  }
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

export async function waitForWorkerPids(master: RunningMaster, count: number, signal?: AbortSignal): Promise<readonly number[]> {
  const identities = await waitForWorkerIdentities(master, count, signal);
  return identities.map(({ pid }) => pid);
}

export async function waitForWorkerIdentities(master: RunningMaster, count: number, signal?: AbortSignal): Promise<readonly ProcessIdentitySnapshot[]> {
  const masterPid = master.child.pid;
  if (masterPid === undefined) throw new Error('master PID is unavailable');
  let identities: readonly ProcessIdentitySnapshot[] = [];
  let lastSnapshot: readonly ProcessIdentitySnapshot[] = [];
  let lastDescriptorPids: ReadonlySet<number> = new Set();
  const message = `master ${masterPid} did not expose ${count} worker PIDs`;
  try {
    await waitUntil(async () => {
      lastSnapshot = await captureProcessSnapshot();
      lastDescriptorPids = await descriptorWorkerPids(master.fixture);
      identities = workerIdentitiesFromSnapshot(lastSnapshot, masterPid, lastDescriptorPids, master.testMarker, master.rootMarker, master);
      return identities.length === count;
    }, message, 15_000, signal);
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw new Error(`${message}; ${workerObservationDiagnostics(master, lastDescriptorPids, lastSnapshot)}`, { cause: error });
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

class CleanupCoverageFailClosedError extends Error {
  readonly name = 'CleanupCoverageFailClosedError';

  constructor(error: Error) {
    super(error.message, { cause: error });
  }
}

type CleanupCoverageDiagnostics = {
  readonly rootState?: string;
  readonly rootDirectIdentity?: string;
  readonly rootSnapshotIdentity?: string;
  readonly splitValid?: boolean;
};

function descriptorDiagnosticText(master: RunningMaster): string {
  const descriptor = descriptorDiagnostics.get(master.fixture);
  const current = descriptor?.current ?? descriptorSetEvidence('missing');
  const saved = descriptor?.saved ?? descriptorSetEvidence('empty', masterDescriptorProofs.get(master.processes) ?? []);
  return `descriptor_read_outcome=${current.outcome} descriptor_current_count=${current.count} descriptor_current_sha256=${current.fingerprint} `
    + `descriptor_saved_count=${saved.count} descriptor_saved_sha256=${saved.fingerprint} `
    + `registration_source=${descriptor?.registration_source ?? 'unknown'}`;
}

function cleanupCoverageError(master: RunningMaster, descriptors: readonly SignedDescriptor[], detail = '', diagnostics: CleanupCoverageDiagnostics = {}): Error {
  const registered = master.processes.registeredProcesses;
  return new Error(`cleanup process coverage incomplete: layout=${master.ingressPorts.length <= 1 ? 'legacy' : 'split'} `
    + `splitValid=${diagnostics.splitValid ?? 'unknown'} rootState=${diagnostics.rootState ?? 'unknown'} `
    + `rootDirectIdentity=${diagnostics.rootDirectIdentity ?? 'unknown'} rootSnapshotIdentity=${diagnostics.rootSnapshotIdentity ?? 'unknown'} `
    + `root=${master.child.pid ?? 'unknown'} descriptors=${descriptors.length} `
    + `${descriptorDiagnosticText(master)} `
    + `registered=${registered.map(({ pid, role }) => `${pid}:${role ?? 'child'}`).join(',')}${detail}`);
}

function ownershipSynchronizationError(
  master: RunningMaster,
  detail: string,
  cause?: unknown,
  diagnostics: CleanupCoverageDiagnostics = {},
): Error {
  const coverage = cleanupCoverageError(master, [], detail, {
    rootState: master.rootExitState.exited ? 'absent' : 'alive',
    rootDirectIdentity: diagnostics.rootDirectIdentity,
    rootSnapshotIdentity: diagnostics.rootSnapshotIdentity,
    splitValid: diagnostics.splitValid,
  });
  return new Error(`bounded ownership synchronization failed: ${coverage.message}`, { cause: cause ?? coverage });
}

async function synchronizeMasterOwnership(master: RunningMaster): Promise<void> {
  const probes = master.cleanupProbes;
  const captureSnapshot = probes?.snapshot ?? captureProcessSnapshot;
  const captureIdentity = probes?.identity ?? captureProcessIdentity;
  const platform = probes?.platform ?? process.platform;
  const pid = master.child.pid;
  if (pid === undefined) throw ownershipSynchronizationError(master, ' root PID unavailable');
  const legacy = master.ingressPorts.length <= 1;
  let diagnostics: CleanupCoverageDiagnostics = {
    rootState: master.rootExitState.exited ? 'absent' : 'alive',
    rootDirectIdentity: 'pending', rootSnapshotIdentity: 'pending', splitValid: legacy ? true : undefined,
  };
  const fail = (detail: string, updates: CleanupCoverageDiagnostics = {}): never => {
    diagnostics = { ...diagnostics, ...updates };
    throw ownershipSynchronizationError(master, detail, undefined, diagnostics);
  };
  try {
    await master.stopMonitoringAndDrain();
    const direct = await captureIdentity(pid);
    const directProof = direct ?? fail(' root direct identity missing', { rootDirectIdentity: 'missing' });
    diagnostics = { ...diagnostics, rootDirectIdentity: 'exact' };
    const rootMarker = `--bungee-test-root-marker=${master.rootMarker}`;
    const savedRoot = masterRootProofs.get(master.processes);
    if (countExactMarker(directProof.commandLine, rootMarker) !== 1
      || (platform === 'linux' && directProof.testMarker !== master.testMarker)
      || (savedRoot !== undefined && !processIdentityMatches(savedRoot, directProof, platform))) {
      const mismatchFields = savedRoot === undefined
        ? rootMarkerMismatchFields(directProof, rootMarker, master.testMarker, platform)
        : rootIdentityMismatchFields(savedRoot, directProof, platform);
      fail(` root direct identity mismatch fields=${mismatchFields.join(',')}`, { rootDirectIdentity: 'mismatch' });
    }
    let snapshot = await captureSnapshot();
    const roots = snapshot.filter((identity) => identity.pid === pid);
    if (roots.length === 0) snapshot = [directProof, ...snapshot];
    else if (roots.length !== 1 || !processIdentityMatches(directProof, roots[0]!, platform)) {
      const mismatchFields = roots.length === 1 ? rootIdentityMismatchFields(directProof, roots[0]!, platform) : ['command_line'];
      fail(` root snapshot identity mismatch fields=${mismatchFields.join(',')}`, { rootSnapshotIdentity: 'mismatch' });
    }
    diagnostics = { ...diagnostics, rootSnapshotIdentity: 'exact' };
    const currentDescriptors = legacy ? [] : await readSignedWorkerDescriptors(master.fixture);
    const savedDescriptors = masterDescriptorProofs.get(master.processes) ?? [];
    const descriptorPids = new Set([...savedDescriptors, ...currentDescriptors].map(({ descriptor }) => descriptor.pid));
    const plan = await registerDescendantPids(master.processes, snapshot, pid, master.fixture, master.ingressPorts,
      master.rootMarker, directProof, platform === 'linux', platform, 'ownership_sync', { persist: false });
    const descendants = descendantProcessSnapshot(snapshot, pid, master.testMarker, platform === 'linux', directProof, master.rootMarker, platform);
    const planByPid = new Map(plan.map((entry) => [entry.identity.pid, entry] as const));
    const exactPlanned = (candidate: ProcessIdentitySnapshot, role?: 'worker' | 'ingress'): boolean => {
      const entry = planByPid.get(candidate.pid);
      return entry !== undefined && (role === undefined || entry.role === role)
        && processIdentityMatches(entry.identity, candidate, platform);
    };
    for (const { descriptor } of currentDescriptors) {
      const observed = descendants.find(({ pid: observedPid }) => observedPid === descriptor.pid);
      const marker = `--bungee-process-identity=${descriptor.worker_instance_id}`;
      if (observed === undefined || processIdentityMarker(observed.commandLine) !== marker
        || !exactPlanned(observed, 'worker')) {
        fail(` worker descriptor PID ${descriptor.pid} is not exact`, { splitValid: false });
      }
    }
    const directChildren = descendants.filter((identity) => identity.ppid === pid);
    const ingressCandidates = legacy ? [] : directChildren.filter((identity) =>
      !descriptorPids.has(identity.pid) && isIngressCandidateForMaster(identity, master.testMarker, platform));
    if (!legacy && ingressCandidates.length !== 1) {
      fail(` split ingress candidates=${ingressCandidates.length}`, { splitValid: false });
    }
    const ingress = ingressCandidates[0];
    if (ingress !== undefined) {
      const entry = planByPid.get(ingress.pid);
      if (entry?.role !== 'ingress' || entry.ports === undefined || entry.ports.length !== master.ingressPorts.length
        || entry.ports.some((port, index) => port !== master.ingressPorts[index]) || !exactPlanned(ingress, 'ingress')) {
        fail(' split ingress registration is not exact', { splitValid: false });
      }
    }
    for (const discovered of descendants) {
      if (discovered.pid === pid) continue;
      const expected = descriptorPids.has(discovered.pid) || discovered === ingress
        || processIdentityArgumentCount(discovered.commandLine) === 0;
      if (!expected || !exactPlanned(discovered)) {
        fail(` descendant PID ${discovered.pid} registration is not exact`, { splitValid: false });
      }
    }
    const mergedDescriptors = [...savedDescriptors];
    for (const current of currentDescriptors) {
      const index = mergedDescriptors.findIndex(({ descriptor }) => descriptor.pid === current.descriptor.pid
        && descriptor.worker_instance_id === current.descriptor.worker_instance_id);
      if (index < 0) mergedDescriptors.push(current);
      else mergedDescriptors[index] = current;
    }
    if (!master.processes.registerExactProcesses([{ identity: directProof }, ...plan])) {
      fail(' atomic ownership commit was rejected');
    }
    writeRootProof(master.processes, directProof, 'ownership_sync', master.cleanupScope, String(pid), 'stopped', true);
    if (!legacy) masterDescriptorProofs.set(master.processes, mergedDescriptors);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('bounded ownership synchronization failed:')) throw error;
    throw ownershipSynchronizationError(master, ' capture checkpoint failed', error, diagnostics);
  }
}

export const probeTcpPort = probeTestTcpPort;

async function captureCleanupCoverage(master: RunningMaster): Promise<void> {
  const probes = master.cleanupProbes;
  const captureSnapshot = probes?.snapshot ?? captureProcessSnapshot;
  const captureIdentity = probes?.identity ?? captureProcessIdentity;
  const isAlive = probes?.alive ?? processAlive;
  const probeProcess = (pid: number): 'alive' | 'dead' | 'unknown' => probePid(pid, isAlive);
  const probePort = probes?.port ?? probeTcpPort;
  const pid = master.child.pid;
  if (pid === undefined) throw new Error('master PID is unavailable for cleanup coverage');
  const legacy = master.ingressPorts.length <= 1;
  const deadline = Date.now() + CLEANUP_COVERAGE_TIMEOUT_MS;
  const platform = master.cleanupProbes?.platform ?? process.platform;
  let rootProof = masterRootProofs.get(master.processes);
  const rootMarker = `--bungee-test-root-marker=${master.rootMarker}`;
  let lastError: unknown;
  for (;;) {
    try {
      const rootState: ProcessLiveness = master.rootExitState.confirmedBy !== null
        ? (master.rootExitState.confirmedBy === 'os_terminal' ? 'terminal' : 'absent')
        : (() => {
          try {
            if (probes?.liveness !== undefined) return probes.liveness(pid);
            if (probes?.alive !== undefined) return probes.alive(pid) ? 'alive' : 'absent';
            return processLiveness(pid);
          } catch { return 'unknown'; }
        })();
      if (rootState === 'unknown') throw new Error(`cleanup coverage root PID ${pid} probe is unknown`);
      if (rootState === 'terminal') master.settleRootExit('os_terminal', null, null);
      if (rootState === 'absent' && !master.rootExitState.exited) {
        const graceDeadline = Math.min(deadline, Date.now() + 100);
        while (!master.rootExitState.exited && Date.now() < graceDeadline) {
          await Promise.race([master.rootExit, new Promise<void>((resolve) => setTimeout(resolve, Math.min(WAIT_STEP_MS, graceDeadline - Date.now()))) ]);
        }
        if (!master.rootExitState.exited) master.confirmRootAbsence();
      }
      const rootProbe = master.rootExitState.exited ? false : rootState === 'alive';
      let directRootIdentity: ProcessIdentitySnapshot | null = null;
      let directRootError: unknown;
      if (!master.rootExitState.exited) {
        try { directRootIdentity = await captureIdentity(pid); }
        catch (error) { directRootError = error; }
        if (rootProbe && directRootError !== undefined) {
          lastError = cleanupCoverageError(master, [], '', { rootState, rootDirectIdentity: 'error', rootSnapshotIdentity: 'pending' });
          if (Date.now() >= deadline) throw new Error('bounded cleanup coverage capture failed', { cause: lastError });
          await Promise.race([master.rootExit, Bun.sleep(WAIT_STEP_MS)]);
          continue;
        }
        if (rootProbe && directRootIdentity === null) {
          lastError = cleanupCoverageError(master, [], '', { rootState, rootDirectIdentity: 'missing', rootSnapshotIdentity: 'pending' });
          if (Date.now() >= deadline) throw new Error('bounded cleanup coverage capture failed', { cause: lastError });
          await Promise.race([master.rootExit, Bun.sleep(WAIT_STEP_MS)]);
          continue;
        }
        const replacedRoot = rootProbe && rootProof !== undefined && directRootIdentity!.pid === pid
          && !processIdentityMatches(rootProof, directRootIdentity!, platform);
        if (replacedRoot) {
          master.settleRootExit('os_replaced', null, null);
        } else if (rootProbe && countExactMarker(directRootIdentity!.commandLine, rootMarker) !== 1) {
          const mismatchFields = rootProof === undefined
            ? rootMarkerMismatchFields(directRootIdentity!, rootMarker, master.testMarker, platform)
            : rootIdentityMismatchFields(rootProof, directRootIdentity!, platform);
          throw new CleanupCoverageFailClosedError(cleanupCoverageError(master, [], ` root identity mismatch fields=${mismatchFields.join(',')}`, {
            rootState, rootDirectIdentity: 'mismatch', rootSnapshotIdentity: 'pending',
          }));
        }
      }
      let snapshot = await captureSnapshot();
      const globalRootObservations = snapshot.filter((identity) => identity.pid === pid);
      if (!master.rootExitState.exited && rootProbe && directRootIdentity !== null) {
        if (globalRootObservations.some((identity) => !processIdentityMatches(directRootIdentity!, identity, platform))) {
          const mismatch = globalRootObservations.find((identity) => !processIdentityMatches(directRootIdentity!, identity, platform));
          const mismatchFields = mismatch === undefined ? ['command_line'] : rootIdentityMismatchFields(directRootIdentity!, mismatch, platform);
          throw new CleanupCoverageFailClosedError(cleanupCoverageError(master, [], ` root identity mismatch fields=${mismatchFields.join(',')}`, {
            rootState, rootDirectIdentity: 'exact', rootSnapshotIdentity: 'mismatch',
          }));
        }
        if (globalRootObservations.length === 0) snapshot = [directRootIdentity, ...snapshot];
      }
      const savedDescriptors = masterDescriptorProofs.get(master.processes) ?? [];
      const currentDescriptors = legacy ? [] : await readSignedWorkerDescriptors(master.fixture);
      const descriptors = legacy ? [] : [...savedDescriptors];
      recordDescriptorDiagnostic(master.fixture, descriptorDiagnostics.get(master.fixture)?.current ?? descriptorSetEvidence(legacy ? 'empty' : 'missing'), savedDescriptors, 'descriptor_registration');
      const descriptorPids = new Set([...savedDescriptors, ...currentDescriptors].map(({ descriptor }) => descriptor.pid));
      if (!legacy && !master.rootExitState.exited) {
        for (const candidate of currentDescriptors) {
          const index = descriptors.findIndex(({ descriptor }) => descriptor.pid === candidate.descriptor.pid
            && descriptor.worker_instance_id === candidate.descriptor.worker_instance_id);
          if (index < 0) descriptors.push(candidate);
          else descriptors[index] = candidate;
        }
      }
      await registerDescendantPids(master.processes, snapshot, pid, master.fixture, master.ingressPorts,
        master.rootMarker, directRootIdentity ?? rootProof, platform === 'linux', platform, 'descriptor_registration', true);
      if (rootProof === undefined && directRootIdentity !== null) {
        writeRootProof(master.processes, directRootIdentity, 'monitor_snapshot', master.cleanupScope,
          String(pid), masterMonitorStates.get(master.processes) ?? 'stopped', true);
      }
      rootProof = masterRootProofs.get(master.processes) ?? rootProof;
      if (!master.rootExitState.exited && (!rootProbe || directRootIdentity === null)) {
        throw new Error('cleanup coverage cannot prove a live master identity');
      }
      let currentRegistered = new Map(master.processes.registeredProcesses.map((entry) => [entry.pid, entry]));
      const root = currentRegistered.get(pid);
      const rootObservations = snapshot.filter((identity) => identity.pid === pid);
      const observedRoot = rootObservations[0];
      const rootIdentityValid = rootProof !== undefined && root?.identity !== undefined
        && processIdentityMatches(rootProof, root.identity, platform)
        && countExactMarker(rootProof.commandLine, rootMarker) === 1;
      const freshRootIdentityValid = rootObservations.length === 1 && observedRoot !== undefined
        && (rootProof !== undefined
          ? processIdentityMatches(rootProof, observedRoot, platform)
          : countExactMarker(observedRoot.commandLine, rootMarker) === 1);
      if (!master.rootExitState.exited && rootState === 'alive' && !freshRootIdentityValid) {
        lastError = new Error(`cleanup coverage root PID ${pid} is in unknown_transition`);
        if (Date.now() >= deadline) throw new Error('bounded cleanup coverage capture failed', { cause: lastError });
        await Promise.race([master.rootExit, Bun.sleep(WAIT_STEP_MS)]);
        continue;
      }
      const rootLiveCovered = rootProbe === true && master.processes.hasLiveHandle(pid)
        && rootObservations.length === 1 && observedRoot !== undefined && rootIdentityValid
        && countExactMarker(observedRoot.commandLine, rootMarker) === 1
        && processIdentityMatches(rootProof!, observedRoot, platform);
      const rootDeadCovered = master.rootExitState.exited;
      const descendants = rootLiveCovered ? descendantProcessSnapshot(
        snapshot, pid, master.testMarker, platform === 'linux', rootProof, master.rootMarker, platform,
      ) : [];
      if (rootLiveCovered && !legacy) {
        for (const descriptor of currentDescriptors.map(({ descriptor }) => descriptor)) {
          const observed = descendants.find(({ pid: observedPid }) => observedPid === descriptor.pid);
          if (observed !== null && observed !== undefined && processIdentityMarker(observed.commandLine) === `--bungee-process-identity=${descriptor.worker_instance_id}`) {
            master.processes.registerPid(observed.pid, observed, { role: 'worker' });
          }
        }
        const ingressCandidates = descendants.filter((identity) => identity.ppid === pid
          && !descriptorPids.has(identity.pid) && isIngressCandidateForMaster(identity, master.testMarker, platform));
        if (ingressCandidates.length === 1) master.processes.registerAdoptedIngress(ingressCandidates[0]!.pid, master.ingressPorts, ingressCandidates[0]!);
        currentRegistered = new Map(master.processes.registeredProcesses.map((entry) => [entry.pid, entry]));
      }
      const descendantPids = new Set(descendants.map(({ pid: childPid }) => childPid));
      let workersCovered = true;
      if (rootDeadCovered && !legacy) {
        for (const { descriptor } of currentDescriptors) {
          const probe = probeProcess(descriptor.pid);
          if (probe === 'unknown') { workersCovered = false; continue; }
          if (probe === 'alive' && !savedDescriptors.some(({ descriptor: saved }) =>
            saved.pid === descriptor.pid && saved.worker_instance_id === descriptor.worker_instance_id)) workersCovered = false;
        }
      }
      for (const { descriptor } of descriptors) {
        const workerPid = descriptor.pid;
        const probe = probeProcess(workerPid);
        if (probe === 'unknown') { workersCovered = false; continue; }
        // An explicit dead probe is sufficient. There is no process to own or signal.
        if (probe === 'dead') continue;
        const entry = currentRegistered.get(workerPid);
        if (rootDeadCovered && entry?.identity !== undefined) {
          let observed: ProcessIdentitySnapshot | null = null;
          try { observed = await captureIdentity(workerPid); } catch { workersCovered = false; continue; }
          if (observed === null) { workersCovered = false; continue; }
          // The old owned instance is gone. ProcessRegistry will release its
          // owner without ever signalling this replacement PID.
          if (!processIdentityMatches(entry.identity, observed, platform)) continue;
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
          try { observed = await captureIdentity(workerPid) ?? undefined; }
          catch { observed = undefined; }
        }
        if (!rootDeadCovered && (!rootLiveCovered || observations.length !== 1 || observed === undefined
          || processIdentityMarker(observed.commandLine) !== marker
          || !processIdentityMatches(entry.identity, observed, platform))) workersCovered = false;
        if (rootDeadCovered && (observed === undefined || processIdentityMarker(observed.commandLine) !== marker)) workersCovered = false;
      }
      if (!legacy) {
        for (const entry of currentRegistered) {
          if (entry[1].role !== 'worker' || !entry[1].identity) continue;
          if (!descriptors.some(({ descriptor }) => descriptor.pid === entry[0])) {
            try { if (isAlive(entry[0])) workersCovered = false; }
            catch { workersCovered = false; }
          }
        }
      }
      const directChildren = rootLiveCovered ? descendants.filter((identity) => identity.ppid === pid) : [];
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
        if (marker === null || !isIngressCandidateForMaster(identity, master.testMarker, platform)) splitSnapshotValid = false;
        return marker !== null && isIngressCandidateForMaster(identity, master.testMarker, platform);
      });
      for (const identity of descendants) {
        if (descriptorPids.has(identity.pid) || processIdentityArgumentCount(identity.commandLine) === 0) continue;
        if (isIngressCandidateForMaster(identity, master.testMarker, platform)
          && !directChildren.some(({ pid: childPid }) => childPid === identity.pid)) splitSnapshotValid = false;
      }
      const registeredIngress = [...currentRegistered.values()].filter(({ role, pid: ingressPid }) =>
        role === 'ingress' && probeProcess(ingressPid) !== 'dead');
      const ingressEntry = registeredIngress[0];
      const ingressPortsMatch = ingressEntry?.ports !== undefined
        && ingressEntry.ports.length === master.ingressPorts.length
        && ingressEntry.ports.every((port, index) => port === master.ingressPorts[index]);
      const knownPortsClosed = async (): Promise<boolean> => (await Promise.all(master.ports.map((port) => probePort(port)))).every((state) => state === 'closed');
      const knownIngressPortsClosed = async (): Promise<boolean> => (await Promise.all(master.ingressPorts.map((port) => probePort(port)))).every((state) => state === 'closed');
      const ingressCovered = legacy
        ? rootDeadCovered ? await knownPortsClosed() : master.ingressPorts.every((port) => master.processes.portOwnedByThis(port)
          && currentRegistered.get(pid)?.identity !== undefined && (currentRegistered.get(pid)!.ports ?? []).includes(port))
        : rootDeadCovered
          ? await (async () => {
            if (registeredIngress.length === 0) return knownPortsClosed();
            if (registeredIngress.length !== 1 || !ingressPortsMatch || ingressEntry!.identity === undefined
              || processIdentityMarker(ingressEntry!.identity.commandLine) === null
              || processIdentityArgumentCount(ingressEntry!.identity.commandLine) !== 1) return false;
            const ingressState = probeProcess(ingressEntry!.pid);
            if (ingressState === 'dead') return true;
            if (ingressState === 'unknown') return false;
            try {
              const actual = await captureIdentity(ingressEntry!.pid);
              return actual !== null && processIdentityMatches(ingressEntry!.identity, actual, platform)
                ? true : knownPortsClosed();
            } catch { return false; }
          })()
          : registeredIngress.length === 0
            ? ingressCandidates.length === 0 && (master.workerCount === 0 || (currentDescriptors.length === 0
              && ![...currentRegistered.values()].some(({ role }) => role === 'worker')))
              && await knownIngressPortsClosed()
            : ingressCandidates.length === 1 && registeredIngress.length === 1
            && registeredIngress[0]!.identity !== undefined
            && processIdentityMatches(registeredIngress[0]!.identity, ingressCandidates[0]!, platform)
            || ingressCandidates.length === 0 && registeredIngress.length === 1
              && registeredIngress[0]!.identity !== undefined
              && probeProcess(registeredIngress[0]!.pid) === 'alive'
              && await captureIdentity(registeredIngress[0]!.pid).then((actual) => actual !== null
                && processIdentityMatches(registeredIngress[0]!.identity!, actual, platform)).catch(() => false);
      const directChildrenCovered = rootLiveCovered
        ? [...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid).every((entry) => {
          if (probeProcess(entry.pid) === 'dead') return true;
          const observed = descendants.find(({ pid: observedPid }) => observedPid === entry.pid);
          return descendantPids.has(entry.pid) && observed !== undefined && entry.identity !== undefined
            && processIdentityMatches(entry.identity, observed, platform);
        })
        : rootDeadCovered && [...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid)
          .every(({ identity }) => identity !== undefined);
      const registeredChildrenCovered = rootLiveCovered
        ? [...currentRegistered.values()].every((entry) => {
          if (entry.pid === pid) return true;
          try {
            if (!isAlive(entry.pid)) return true;
          } catch { return false; }
          if (!descendantPids.has(entry.pid)) return false;
          const observed = descendants.find(({ pid: observedPid }) => observedPid === entry.pid);
          return observed !== undefined && entry.identity !== undefined
            && processIdentityMatches(entry.identity, observed, platform);
        })
        : rootDeadCovered && (await Promise.all([...currentRegistered.values()].filter(({ pid: entryPid }) => entryPid !== pid).map(async (entry) => {
          if (entry.identity === undefined) return false;
          const probe = probeProcess(entry.pid);
          if (probe === 'dead') return true;
          if (probe === 'unknown') return false;
          try {
            const observed = await captureIdentity(entry.pid);
            return observed !== null && processIdentityMatches(entry.identity, observed, platform)
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
        + ` registered=${currentRegistered.size}`, {
          rootState,
          rootDirectIdentity: directRootIdentity === null ? directRootError === undefined ? 'missing' : 'error' : 'exact',
          rootSnapshotIdentity: rootObservations.length === 0 ? 'missing' : rootObservations.length === 1 && observedRoot !== undefined
            && (rootProof === undefined || processIdentityMatches(rootProof, observedRoot, platform)) ? 'exact' : 'mismatch',
          splitValid: splitSnapshotValid,
        });
    } catch (error) {
      lastError = error;
      if (error instanceof CleanupCoverageFailClosedError) throw error;
    }
    if (Date.now() >= deadline) throw new Error('bounded cleanup coverage capture failed', { cause: lastError });
    await Bun.sleep(WAIT_STEP_MS);
  }
}

async function assertFreshRootDeath(master: RunningMaster): Promise<void> {
  const pid = master.child.pid;
  if (pid === undefined) throw new Error('master PID is unavailable for root death proof');
  const liveness = master.cleanupProbes?.liveness?.(pid)
    ?? (master.cleanupProbes?.alive !== undefined ? master.cleanupProbes.alive(pid) ? 'alive' : 'absent' : processLiveness(pid));
  if (liveness === 'unknown') throw new Error(`root PID ${pid} death proof is unknown`);
  if (liveness === 'alive') {
    const actual = await (master.cleanupProbes?.identity ?? captureProcessIdentity)(pid);
    const expected = masterRootProofs.get(master.processes)
      ?? master.processes.registeredProcesses.find(({ pid: registeredPid }) => registeredPid === pid)?.identity;
    if (actual !== null && expected !== undefined && !processIdentityMatches(expected, actual, master.cleanupProbes?.platform ?? process.platform)) {
      master.settleRootExit('os_replaced', master.rootExitState.eventCode ?? null, master.rootExitState.eventSignal ?? null);
      return;
    }
    throw new Error(`root PID ${pid} remains alive after cleanup`);
  }
  if (!master.rootExitState.exited) {
    master.settleRootExit(liveness === 'terminal' ? 'os_terminal' : 'os_absence',
      master.rootExitState.eventCode ?? null, master.rootExitState.eventSignal ?? null);
  }
  await master.rootExit;
}

export async function cleanupMaster(
  master: RunningMaster,
  /** Historical PID evidence only; ownership must have been captured while the master was alive. */
  workers: readonly number[] = [],
  options: CleanupMasterOptions = {},
): Promise<void> {
  const errors: unknown[] = [];
  const probePort = options.probePort ?? master.cleanupProbes?.port ?? probeTcpPort;
  if (options.fixture !== undefined) masterCleanupFixtures.set(master.processes, options.fixture);
  try {
    await master.stopMonitoringAndDrain();
    // Coverage is the authorization to signal. Never fall through on failure.
    await captureCleanupCoverage(master);
  } catch (error) { throw error; }
  const expectGraceful = options.expectGraceful === true;
  try {
    await cleanupProcesses(master.processes, {
      expectGraceful,
      ...(expectGraceful ? {
        shutdown: () => {
          if (!master.rootExitState.exited) master.child.kill('SIGTERM');
        },
        observeGraceful: async () => {
          const settled = await Promise.allSettled((options.ports ?? master.ports)
            .filter((port) => !master.processes.portOwnedByAnother(port))
            .map((port) => expectPortClosedWithProbe(port, probePort)));
          const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length > 0) throw new AggregateError(failures, 'graceful port cleanup failed');
        },
      } : {}),
    });
  } catch (error) { errors.push(error); }
  if (errors.length === 0) {
    try { await assertFreshRootDeath(master); } catch (error) { errors.push(error); }
  }
  if (expectGraceful && (master.rootExitState.confirmedBy === 'os_absence' || master.rootExitState.code !== 0 || master.rootExitState.signal !== null)) {
    errors.push(new Error(`graceful master exit contract failed: confirmedBy=${master.rootExitState.confirmedBy ?? 'unknown'} code=${master.rootExitState.code ?? 'null'} signal=${master.rootExitState.signal ?? 'null'}`));
  }
  const ports = [...new Set(options.ports ?? master.ports)];
  const portResults = await Promise.allSettled(ports
    .filter((port) => !master.processes.portOwnedByAnother(port))
    .map((port) => expectPortClosedWithProbe(port, probePort)));
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
    descriptorDiagnostics.delete(master.fixture);
    masterRootProofs.delete(master.processes);
    masterRootProofHistory.delete(master.processes);
    masterMonitorStates.delete(master.processes);
    spawnedProcessMonitors.delete(master.processes);
    master.cleanupScope?.registries.delete(master.processes);
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

export async function cleanupSpawnedProcesses(scope: MasterCleanupScope, options: CleanupSpawnedProcessesOptions = {}): Promise<void> {
  const registries = [...scope.registries];
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
      if (fixture !== undefined) descriptorDiagnostics.delete(fixture);
      masterRootProofs.delete(registry);
      masterRootProofHistory.delete(registry);
      masterMonitorStates.delete(registry);
      spawnedProcessMonitors.delete(registry);
      scope.registries.delete(registry);
      runningMasters.delete(registry);
    } else {
      errors.push(result.reason);
    }
  }
  const blocks = [...scope.portBlocks];
  if (options.quarantinePorts) for (const block of blocks) quarantineAndDetach(scope, block);
  if (!options.quarantinePorts) {
    const portResults = await Promise.allSettled(blocks.flatMap(({ ports }) => ports.map((port) => expectPortClosed(port))));
    for (const result of portResults) if (result.status === 'rejected') errors.push(result.reason);
  }

  if (errors.length > 0) {
    if (!options.quarantinePorts) for (const block of blocks) quarantineAndDetach(scope, block);
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, 'spawned process cleanup failed');
    throw new Error(TEST_RESOURCE_BROKER_CLEANUP_ERROR, { cause });
  }
  if (options.quarantinePorts) return;
  for (const block of blocks) {
    releaseTestPortBlock(block);
    scope.portBlocks.delete(block);
  }
}

export { captureProcessIdentity, captureProcessSnapshot, ProcessRegistry, cleanupProcesses, processAlive } from './process-cleanup';

async function expectPortClosedWithProbe(port: number, probe: (port: number) => Promise<TcpPortState>): Promise<void> {
  await waitUntil(async () => {
    return (await probe(port)) === 'closed';
  }, `port ${port} remained open`, 5_000);
}

export async function expectPortClosed(port: number): Promise<void> {
  await expectPortClosedWithProbe(port, probeTcpPort);
}
