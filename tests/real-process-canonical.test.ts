import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER,
  DAEMON_SHUTDOWN_PATH,
} from '@jeffusion/bungee-types';
import { readDaemonMetadataFile, type DaemonFileOptions } from '../packages/types/src/daemon-file';
import type { DaemonMetadataState } from '../packages/types/src/daemon-control';
import { DaemonManager } from '../packages/cli/src/daemon/manager';
import { probeDaemonProcess } from '../packages/cli/src/daemon/process-identity';
import { createMemoryWindowsAcl } from '../packages/cli/src/daemon/test-support';
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

async function createDaemonHarness(root: string, lease: PortLease, fixture: Fixture | undefined, workers = 2, options: Readonly<{
  home?: string;
  dataDirectory?: string;
  logsDirectory?: string;
  pluginsPath?: string;
  managementPort?: number;
  pluginSecretsKey?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
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
  const baseEnvironment = options.baseEnvironment ?? (fixture === undefined ? process.env : coreEnvironment(fixture, lease, workers));
  const windowsAcl = createMemoryWindowsAcl();
  const metadataFileOptions: DaemonFileOptions = { runtimeDirectory: runtime, windowsAcl };
  const childTracking: { current?: StartChildTracking } = {};
  const manager = new DaemonManager((executable, args, spawnOptions) => {
    const child = spawn(executable, [...args], spawnOptions);
    const output: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
    childOutput.set(child, output);
    spawned.push({ child, executable, args: [...args] });
    if (childTracking.current !== undefined) childTracking.current.disposers.push(trackChildLifecycle(child, childTracking.current.boxes));
    return child;
  }, undefined, {
    runtimeDirectory: runtime, dataDirectory, logsDirectory, configDirectory,
    pidFile: join(configDirectory, 'bungee.pid'), logFile: logFiles[0], errorLogFile: logFiles[1],
    windowsAcl,
    directLaunch: { executable: process.execPath, entrypoint: CORE_ENTRY },
    inheritedEnvironment: {
      ...baseEnvironment, HOME: home, USERPROFILE: home,
      BUNGEE_MANAGEMENT_PORT: String(options.managementPort ?? lease.base),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(lease.base + 2),
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_PLUGIN_SECRETS_KEY: options.pluginSecretsKey ?? Buffer.alloc(32, 9).toString('base64'),
      BUNGEE_FILE_LOG_DIR: logsDirectory, PLUGINS_DIR: pluginsPath, LOG_LEVEL: 'error',
    },
  });
  attachStartDiagnostics(manager, { logFiles, metadataPath, metadataFileOptions, childTracking });
  return { manager, spawned, metadataPath, runtime, logFiles };
}

// Test-only start diagnostics: when a daemon start fails, only the bytes appended to the
// harness log files during THAT start call are read (fixed per-file cap, tail kept when
// exceeded) and classified against a fixed whitelist into `daemon_log_phase`; the metadata
// file is re-read through the same harness file options for `daemon_metadata_state`; the
// spawn wrapper tracks this invocation's direct children (`error`/`exit` events) for
// `daemon_child_state`. The original error is discarded and replaced by a fresh Error
// carrying the fixed prefix plus exactly those three enums. Paths, raw log lines, argv,
// PIDs, nonces, secrets, stacks, causes, and custom fields are never surfaced; the success
// path, timeouts, retries, and cleanup are unchanged.
type DaemonLogPhase =
  | 'ingress_identity_capture'
  | 'ingress_ownership_transfer'
  | 'worker_identity_capture'
  | 'worker_adoption'
  | 'process_query'
  | 'instance_lock'
  | 'startup_unknown';

type DaemonMetadataDiagnostic = DaemonMetadataState | 'absent' | 'unreadable';
type DaemonChildDiagnostic = 'not_spawned' | 'live' | 'exited' | 'spawn_failed';
type ChildLifecycleState = Exclude<DaemonChildDiagnostic, 'not_spawned'>;
type ChildLifecycleBox = { state: ChildLifecycleState };

const LOG_PHASE_RULES: readonly (readonly [DaemonLogPhase, RegExp])[] = [
  ['instance_lock', /instance lock/i],
  ['ingress_ownership_transfer', /ingress ownership transfer could not be verified/],
  ['ingress_identity_capture', /ingress process identity could not be captured/],
  ['worker_adoption', /adopted worker/],
  ['worker_identity_capture', /identity marker/],
  ['process_query', /process query failed|main executable could not be identified|identity sampling timed out/],
];

const LOG_APPEND_CAP_BYTES = 64 * 1024;
type FrozenDaemonLogWindow = Readonly<{ file: string; start: number; end: number }>;

function classifyLogPhase(logs: string): DaemonLogPhase {
  for (const [phase, pattern] of LOG_PHASE_RULES) if (pattern.test(logs)) return phase;
  return 'startup_unknown';
}

async function captureLogOffsets(logFiles: readonly string[]): Promise<number[]> {
  return await Promise.all(logFiles.map(async (file) => {
    try { return (await stat(file)).size; } catch { return 0; }
  }));
}

function freezeDaemonLogWindows(logFiles: readonly string[], offsets: readonly number[]): FrozenDaemonLogWindow[] {
  return logFiles.map((file, index) => {
    const start = offsets[index] ?? 0;
    let end = start;
    try {
      const info = statSync(file);
      if (info.isFile()) end = Math.max(start, info.size);
    } catch { /* preserve the frozen start when the file is unavailable */ }
    return { file, start, end };
  });
}

const STARTUP_TIMING_LINE = /^BUNGEE_DIAG component=(?:types|cli|core) phase=(?:acl|poll_startup|base_probe|probe_current_user|bootstrap|composition|ingress_connect|runtime_start|arm_transition|identity_capture) kind=(?:none|read|set) event=(?:begin|end) seq=\d+ at_ms=\d+ elapsed_ms=\d+ ok=(?:true|false) category=(?:begin|success|failure|deadline|identity_unknown|metadata_failure|other)$/;
const STARTUP_TIMING_TRUNCATION_LINE = /^BUNGEE_DIAG component=canonical phase=log_window kind=truncation event=end seq=0 at_ms=\d+ elapsed_ms=0 ok=true category=truncated$/;

function strictStartupTimingLines(text: string, truncated: boolean): string[] {
  const normalized = text.replaceAll('\r\n', '\n');
  const firstNewline = normalized.indexOf('\n');
  const complete = truncated ? (firstNewline < 0 ? '' : normalized.slice(firstNewline + 1)) : normalized;
  return complete.split('\n').filter((line) => STARTUP_TIMING_LINE.test(line));
}

async function emitStartupTimingLines(windows: readonly FrozenDaemonLogWindow[]): Promise<void> {
  for (const window of windows) {
    const totalBytes = Math.max(0, window.end - window.start);
    let text = await readLogAppendWindow(window.file, window.start, window.end);
    if (totalBytes > LOG_APPEND_CAP_BYTES) {
      console.log(`BUNGEE_DIAG component=canonical phase=log_window kind=truncation event=end seq=0 at_ms=${Date.now()} elapsed_ms=0 ok=true category=truncated`);
    }
    for (const line of strictStartupTimingLines(text, totalBytes > LOG_APPEND_CAP_BYTES)) console.log(line);
  }
}

// Reads only the [offset, size) region appended during this start call; when that region
// exceeds the fixed cap its tail is kept. The text feeds whitelist classification only and
// is never surfaced.
async function readLogAppendWindow(file: string, offset: number, endOverride?: number): Promise<string> {
  try {
    const end = endOverride ?? (await stat(file)).size;
    if (end <= offset) return '';
    const start = Math.max(offset, end - LOG_APPEND_CAP_BYTES);
    return await Bun.file(file).slice(start, Math.min(end, start + LOG_APPEND_CAP_BYTES)).text();
  } catch { return ''; }
}

async function readMetadataDiagnosticState(metadataPath: string, fileOptions: DaemonFileOptions): Promise<DaemonMetadataDiagnostic> {
  try { return (await readDaemonMetadataFile(metadataPath, fileOptions)).state; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'; }
}

function childLifecycleDiagnostic(children: readonly ChildLifecycleBox[]): DaemonChildDiagnostic {
  if (children.length === 0) return 'not_spawned';
  if (children.some((child) => child.state === 'spawn_failed')) return 'spawn_failed';
  return children.some((child) => child.state === 'live') ? 'live' : 'exited';
}

// Tracks one direct child for the duration of a start call. Listeners are `once`
// (self-removing) and the box is dropped when the start call ends, so nothing leaks.
// The state is saved before dispose runs; `error` wins over `exit` (spawn_failed has
// priority), and the originating error/exit details are never inspected or surfaced.
// The returned dispose removes BOTH of this helper's listeners (idempotently, without
// touching any other listeners on the child).
function trackChildLifecycle(child: ChildProcess, tracking: ChildLifecycleBox[]): () => void {
  const lifecycle: ChildLifecycleBox = { state: 'live' };
  const onError = () => { lifecycle.state = 'spawn_failed'; dispose(); };
  const onExit = () => { if (lifecycle.state === 'live') lifecycle.state = 'exited'; dispose(); };
  const dispose = (): void => {
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
  };
  child.once('error', onError);
  child.once('exit', onExit);
  tracking.push(lifecycle);
  return dispose;
}

type StartChildTracking = Readonly<{ readonly boxes: ChildLifecycleBox[]; readonly disposers: (() => void)[] }>;
type StartDiagnosticsContext = Readonly<{
  logFiles: readonly string[];
  metadataPath: string;
  metadataFileOptions: DaemonFileOptions;
  childTracking: { current?: StartChildTracking };
}>;

const DAEMON_START_FAILURE_PREFIX = 'daemon start failed';

// P0: the original error object is NEVER rethrown or copied. A brand-new Error with a
// fixed prefix plus the three enum fields is created; no cause is set, and the original
// message, stack, cause, and custom fields are all dropped. Non-Error throws get the
// same fixed treatment.
async function annotateDaemonStartFailure(
  error: unknown, context: StartDiagnosticsContext, logOffsets: readonly number[], children: readonly ChildLifecycleBox[], daemonWindows?: readonly FrozenDaemonLogWindow[],
): Promise<never> {
  void error;
  const frozenWindows = daemonWindows ?? freezeDaemonLogWindows(context.logFiles, logOffsets);
  let logPhase: DaemonLogPhase = 'startup_unknown';
  let metadataState: DaemonMetadataDiagnostic = 'unreadable';
  try {
    const logs = (await Promise.all(frozenWindows.map((window) => readLogAppendWindow(window.file, window.start, window.end)))).join('\n');
    logPhase = classifyLogPhase(logs);
    metadataState = await readMetadataDiagnosticState(context.metadataPath, context.metadataFileOptions);
  } catch { /* keep defaults: diagnostics are best effort */ }
  const childState = childLifecycleDiagnostic(children);
  const diagnostic = new Error(`${DAEMON_START_FAILURE_PREFIX} (daemon_log_phase=${logPhase} daemon_metadata_state=${metadataState} daemon_child_state=${childState})`);
  const enriched = diagnostic as {
    daemon_log_phase?: DaemonLogPhase;
    daemon_metadata_state?: DaemonMetadataDiagnostic;
    daemon_child_state?: DaemonChildDiagnostic;
  };
  enriched.daemon_log_phase = logPhase;
  enriched.daemon_metadata_state = metadataState;
  enriched.daemon_child_state = childState;
  throw diagnostic;
}

function attachStartDiagnostics(manager: DaemonManager, context: StartDiagnosticsContext): void {
  const originalStart = manager.start.bind(manager);
  manager.start = async (options: Parameters<DaemonManager['start']>[0]) => {
    const logOffsets = await captureLogOffsets(context.logFiles);
    const boxes: ChildLifecycleBox[] = [];
    const disposers: (() => void)[] = [];
    context.childTracking.current = { boxes, disposers };
    try {
      const result = await originalStart(options);
      const frozenWindows = freezeDaemonLogWindows(context.logFiles, logOffsets);
      await emitStartupTimingLines(frozenWindows);
      return result;
    }
    catch (error) {
      const frozenWindows = freezeDaemonLogWindows(context.logFiles, logOffsets);
      await emitStartupTimingLines(frozenWindows);
      throw await annotateDaemonStartFailure(error, context, logOffsets, boxes, frozenWindows);
    }
    finally {
      // Belt-and-braces: dispose both listeners on every child of THIS start call, even
      // ones still live; terminal events already disposed themselves. Never touches
      // listeners owned by others.
      for (const dispose of disposers) dispose();
      context.childTracking.current = undefined;
    }
  };
}

// ---- B-only post-start exit classifier (minimal, separate from startup diagnostics) ----
// The daemon child writes winston JSON lines to <cwd>/logs/app-%DATE%.log (cwd is the
// harness dataDirectory) only when NODE_ENV=production, so absent files/directories are
// the norm in tests and every capture is best-effort. Line shape (from logger.ts +
// serializeErrorChain): {"level","message","error":{name,message,code?,stack?,cause?,errors?}}.
// Only fixed enums are ever produced; raw lines, paths, messages, codes, stacks, PIDs,
// argv, nonces, and secrets are never surfaced.
type DaemonRuntimePhase =
  | 'master_repair_fatal'
  | 'master_publication_fatal'
  | 'master_recovery_fatal'
  | 'master_runtime_other'
  | 'process_startup_failure'
  | 'shutdown_failure'
  | 'unclassified_error'
  | 'no_error_record'
  | 'log_unavailable';

type AppLogWindow = Readonly<{ file: string; start: number }>;
type AppLogFreeze = Readonly<{ file: string; start: number; end: number }>;

const APP_LOG_MAX_FILES = 2;
const APP_LOG_TOTAL_CAP_BYTES = 64 * 1024;
// Matches the production serializeErrorChain depth bound; only allowlisted codes are
// collected for matching, never emitted.
const RUNTIME_CHAIN_MAX_DEPTH = 5;

const RUNTIME_PHASE_PRIORITY: readonly DaemonRuntimePhase[] = [
  'master_repair_fatal', 'master_publication_fatal', 'master_recovery_fatal',
  'process_startup_failure', 'shutdown_failure', 'master_runtime_other',
];

function appLogFileName(name: string): boolean { return name.startsWith('app-') && name.endsWith('.log'); }

// Best-effort: before the FIRST B start, snapshot byte offsets of up to 2 app logs
// (sorted by filename). Missing directory/files yield an empty snapshot.
function captureAppLogOffsets(logsDirectory: string): readonly AppLogWindow[] {
  let entries: readonly string[];
  try { entries = readdirSync(logsDirectory); } catch { return []; }
  return entries.filter(appLogFileName).sort().slice(0, APP_LOG_MAX_FILES).map((name) => {
    const file = join(logsDirectory, name);
    try { return { file, start: statSync(file).size }; } catch { return { file, start: 0 }; }
  });
}

// Synchronous/atomic freeze at exit time: stats the recorded files plus any NEWLY
// appeared app logs (start 0), still capped at 2 files by sorted filename. Because this
// runs inside the exit event with no awaits, bytes appended by the replacement child
// cannot mix in.
function freezeAppLogWindows(windows: readonly AppLogWindow[], logsDirectory: string): readonly AppLogFreeze[] {
  const starts = new Map<string, number>(windows.map((window) => [window.file, window.start]));
  try {
    for (const name of readdirSync(logsDirectory)) {
      if (!appLogFileName(name)) continue;
      const file = join(logsDirectory, name);
      if (!starts.has(file)) starts.set(file, 0);
    }
  } catch { /* directory unavailable: keep the recorded windows only */ }
  return [...starts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).slice(0, APP_LOG_MAX_FILES)
    .map(([file, start]) => {
      let end = start;
      try {
        const info = statSync(file);
        if (info.isFile()) end = Math.max(start, info.size);
      } catch { /* unreadable now: empty window */ }
      return { file, start, end };
    });
}

// Registers the exit collector on the daemon child. A child that already exited before
// registration is frozen immediately; the frozen result is cached so later reads never
// observe post-exit (replacement) appends.
function createExitAppLogFreeze(child: ChildProcess, windows: readonly AppLogWindow[], logsDirectory: string): () => readonly AppLogFreeze[] {
  let frozen: readonly AppLogFreeze[] | undefined;
  const freeze = (): void => { if (frozen === undefined) frozen = freezeAppLogWindows(windows, logsDirectory); };
  if (child.exitCode !== null || child.signalCode !== null) freeze();
  else child.once('exit', freeze);
  return () => { freeze(); return frozen ?? []; };
}

// Reads the frozen windows, at most 2 files and 64 KiB total; a window larger than the
// remaining budget contributes its tail. Per-file failures are skipped.
async function readAppLogWindows(freeze: readonly AppLogFreeze[]): Promise<Readonly<{ chunks: readonly string[]; anyRead: boolean }>> {
  const chunks: string[] = [];
  let anyRead = false;
  let budget = APP_LOG_TOTAL_CAP_BYTES;
  for (const window of freeze.slice(0, APP_LOG_MAX_FILES)) {
    if (budget <= 0) break;
    const length = Math.max(0, window.end - window.start);
    if (length === 0) { anyRead = true; continue; }
    const take = Math.min(length, budget);
    const start = window.start + (length - take);
    try { chunks.push(await Bun.file(window.file).slice(start, start + take).text()); budget -= take; anyRead = true; }
    catch { /* skip unreadable file */ }
  }
  return { chunks, anyRead };
}

// Bounded-depth walk of the serialized chain; collects ONLY allowlisted nested codes —
// nested messages are never read or stored.
const RUNTIME_CODE_ALLOWLIST: ReadonlySet<string> = new Set(['repair_failed', 'publication_failed', 'startup_incomplete']);

function walkRuntimeChain(node: unknown, depth: number, codes: Set<string>): void {
  if (depth >= RUNTIME_CHAIN_MAX_DEPTH || typeof node !== 'object' || node === null) return;
  const chain = node as { readonly code?: unknown; readonly cause?: unknown; readonly errors?: unknown };
  if (typeof chain.code === 'string' && RUNTIME_CODE_ALLOWLIST.has(chain.code)) codes.add(chain.code);
  walkRuntimeChain(chain.cause, depth + 1, codes);
  if (Array.isArray(chain.errors)) for (const item of chain.errors) walkRuntimeChain(item, depth + 1, codes);
}

function matchRuntimeErrorLine(line: unknown): DaemonRuntimePhase | undefined {
  if (typeof line !== 'object' || line === null) return undefined;
  const record = line as { readonly level?: unknown; readonly message?: unknown; readonly error?: unknown };
  if (record.level !== 'error') return undefined;
  const message = typeof record.message === 'string' ? record.message : '';
  if (message === 'Process startup failed') return 'process_startup_failure';
  if (message === 'Master shutdown failed') return 'shutdown_failure';
  if (message === 'Master runtime failed') {
    const codes = new Set<string>();
    walkRuntimeChain(record.error, 0, codes);
    if (codes.has('repair_failed')) return 'master_repair_fatal';
    if (codes.has('publication_failed')) return 'master_publication_fatal';
    if (codes.has('startup_incomplete')) return 'master_recovery_fatal';
    return 'master_runtime_other';
  }
  return undefined;
}

async function classifyDaemonRuntimeExit(freeze: readonly AppLogFreeze[]): Promise<DaemonRuntimePhase> {
  if (freeze.length === 0) return 'log_unavailable';
  const { chunks, anyRead } = await readAppLogWindows(freeze);
  if (!anyRead) return 'log_unavailable';
  let sawErrorLine = false;
  const matched = new Set<DaemonRuntimePhase>();
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; /* malformed line: skip */ }
      const candidate = matchRuntimeErrorLine(parsed);
      if (candidate === undefined) {
        if (typeof parsed === 'object' && parsed !== null && (parsed as { level?: unknown }).level === 'error') sawErrorLine = true;
        continue;
      }
      sawErrorLine = true;
      matched.add(candidate);
    }
  }
  for (const phase of RUNTIME_PHASE_PRIORITY) if (matched.has(phase)) return phase;
  return sawErrorLine ? 'unclassified_error' : 'no_error_record';
}

describe.serial('start diagnostics helpers', () => {
  test('freezes daemon timing windows and keeps only complete strict lines', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-diagnostics', { daemonSafe: true });
    try {
      const file = join(root, 'bungee.log');
      await writeFile(file, '', 'utf8');
      const offsets = await captureLogOffsets([file]);
      const valid = 'BUNGEE_DIAG component=core phase=bootstrap kind=none event=end seq=7 at_ms=100 elapsed_ms=3 ok=true category=success\r\n';
      await writeFile(file, `${valid}partial line`, 'utf8');
      const frozen = freezeDaemonLogWindows([file], offsets);
      await appendFile(file, 'BUNGEE_DIAG component=core phase=bootstrap kind=none event=end seq=8 at_ms=101 elapsed_ms=4 ok=true category=success\n', 'utf8');
      const frozenText = await readLogAppendWindow(file, frozen[0]!.start, frozen[0]!.end);
      expect(strictStartupTimingLines(frozenText, false)).toEqual([valid.replaceAll('\r\n', '\n').trimEnd()]);
      expect(strictStartupTimingLines(`${'x'.repeat(LOG_APPEND_CAP_BYTES)}\n${valid}`, true)).toEqual([valid.replaceAll('\r\n', '\n').trimEnd()]);
      expect(STARTUP_TIMING_LINE.test('BUNGEE_DIAG component=core phase=bootstrap kind=none event=end seq=7 at_ms=100 elapsed_ms=3 ok=true category=success')).toBeTrue();
      expect(STARTUP_TIMING_LINE.test(`${valid.trimEnd()} secret`)).toBeFalse();
      expect(STARTUP_TIMING_TRUNCATION_LINE.test('BUNGEE_DIAG component=canonical phase=log_window kind=truncation event=end seq=0 at_ms=102 elapsed_ms=0 ok=true category=truncated')).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maps whitelisted phases, caps append windows to the tail, and maps metadata/child enums', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-diagnostics', { daemonSafe: true });
    try {
      expect(classifyLogPhase('')).toBe('startup_unknown');
      expect(classifyLogPhase('unrelated noise')).toBe('startup_unknown');
      expect(classifyLogPhase('failed to acquire instance lock')).toBe('instance_lock');
      expect(classifyLogPhase('ingress ownership transfer could not be verified')).toBe('ingress_ownership_transfer');
      expect(classifyLogPhase('ingress process identity could not be captured')).toBe('ingress_identity_capture');
      expect(classifyLogPhase('could not adopt adopted worker yet')).toBe('worker_adoption');
      expect(classifyLogPhase('identity marker mismatch')).toBe('worker_identity_capture');
      expect(classifyLogPhase('process query failed once')).toBe('process_query');
      expect(classifyLogPhase('main executable could not be identified')).toBe('process_query');
      expect(classifyLogPhase('identity sampling timed out')).toBe('process_query');
      const logFile = join(root, 'window.log');
      await writeFile(logFile, 'x'.repeat(LOG_APPEND_CAP_BYTES + 512) + 'TAIL_MARKER', 'utf8');
      const capped = await readLogAppendWindow(logFile, 0);
      expect(capped.length).toBe(LOG_APPEND_CAP_BYTES);
      expect(capped.endsWith('TAIL_MARKER')).toBeTrue();
      expect(await readLogAppendWindow(logFile, LOG_APPEND_CAP_BYTES + 512)).toBe('TAIL_MARKER');
      expect(await readLogAppendWindow(logFile, LOG_APPEND_CAP_BYTES)).toBe('x'.repeat(512) + 'TAIL_MARKER');
      expect(await readLogAppendWindow(join(root, 'missing.log'), 0)).toBe('');
      expect(await readLogAppendWindow(logFile, Number.MAX_SAFE_INTEGER)).toBe('');
      const runtimeDirectory = join(root, 'run');
      await mkdir(runtimeDirectory, { recursive: true });
      const fileOptions: DaemonFileOptions = { runtimeDirectory, windowsAcl: createMemoryWindowsAcl() };
      expect(await readMetadataDiagnosticState(join(runtimeDirectory, 'daemon.json'), fileOptions)).toBe('absent');
      await mkdir(join(runtimeDirectory, 'daemon.json'), { recursive: true });
      expect(await readMetadataDiagnosticState(join(runtimeDirectory, 'daemon.json'), fileOptions)).toBe('unreadable');
      expect(childLifecycleDiagnostic([])).toBe('not_spawned');
      expect(childLifecycleDiagnostic([{ state: 'live' }])).toBe('live');
      expect(childLifecycleDiagnostic([{ state: 'exited' }])).toBe('exited');
      expect(childLifecycleDiagnostic([{ state: 'spawn_failed' }])).toBe('spawn_failed');
      expect(childLifecycleDiagnostic([{ state: 'exited' }, { state: 'live' }])).toBe('live');
      expect(childLifecycleDiagnostic([{ state: 'exited' }, { state: 'spawn_failed' }])).toBe('spawn_failed');
      expect(childLifecycleDiagnostic([{ state: 'exited' }, { state: 'exited' }])).toBe('exited');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  test('drops both listeners on terminal events and tracks spawn_failed/exited', async () => {
    const tracking: ChildLifecycleBox[] = [];
    const failed = spawn('bungee-canonical-diagnostics-no-such-executable', [], { stdio: 'ignore' });
    expect(failed.listenerCount('error')).toBe(0);
    expect(failed.listenerCount('exit')).toBe(0);
    trackChildLifecycle(failed, tracking);
    expect(failed.listenerCount('error')).toBe(1);
    expect(failed.listenerCount('exit')).toBe(1);
    await new Promise<void>((resolve) => failed.once('error', () => resolve()));
    expect(failed.listenerCount('error')).toBe(0);
    expect(failed.listenerCount('exit')).toBe(0);
    expect(tracking).toEqual([{ state: 'spawn_failed' }]);
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(exited.listenerCount('error')).toBe(0);
    expect(exited.listenerCount('exit')).toBe(0);
    trackChildLifecycle(exited, tracking);
    expect(exited.listenerCount('error')).toBe(1);
    expect(exited.listenerCount('exit')).toBe(1);
    await childExit(exited);
    expect(exited.listenerCount('error')).toBe(0);
    expect(exited.listenerCount('exit')).toBe(0);
    expect(tracking).toEqual([{ state: 'spawn_failed' }, { state: 'exited' }]);
  }, { timeout: 30_000 });

  test('a live child keeps its state but loses both listeners when the start wrapper finishes', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-diagnostics', { daemonSafe: true });
    let live: ChildProcess | undefined;
    try {
      const runtimeDirectory = join(root, 'run');
      await mkdir(runtimeDirectory, { recursive: true });
      const childTracking: { current?: StartChildTracking } = {};
      const context: StartDiagnosticsContext = {
        logFiles: [join(root, 'absent.log'), join(root, 'absent.error.log')],
        metadataPath: join(runtimeDirectory, 'daemon.json'),
        metadataFileOptions: { runtimeDirectory, windowsAcl: createMemoryWindowsAcl() },
        childTracking,
      };
      const manager = {
        start: async () => {
          const tracking = childTracking.current;
          if (tracking === undefined) throw new Error('tracking was not installed by the wrapper');
          live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
          expect(live.listenerCount('error')).toBe(0);
          expect(live.listenerCount('exit')).toBe(0);
          tracking.disposers.push(trackChildLifecycle(live, tracking.boxes));
          expect(live.listenerCount('error')).toBe(1);
          expect(live.listenerCount('exit')).toBe(1);
          throw new Error('boom');
        },
      } as unknown as DaemonManager;
      attachStartDiagnostics(manager, context);
      await expect(manager.start({})).rejects.toThrow('daemon start failed (daemon_log_phase=startup_unknown daemon_metadata_state=absent daemon_child_state=live)');
      expect(live).toBeDefined();
      expect(live?.exitCode).toBeNull();
      expect(live?.listenerCount('error')).toBe(0);
      expect(live?.listenerCount('exit')).toBe(0);
      expect(childTracking.current).toBeUndefined();
    } finally {
      if (live !== undefined) await stopChild(live);
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  test('replaces the failed start with a fresh fixed diagnostic error carrying only the three enums', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-diagnostics', { daemonSafe: true });
    try {
      const runtimeDirectory = join(root, 'run');
      await mkdir(runtimeDirectory, { recursive: true });
      const context: StartDiagnosticsContext = {
        logFiles: [join(root, 'absent.log'), join(root, 'absent.error.log')],
        metadataPath: join(runtimeDirectory, 'daemon.json'),
        metadataFileOptions: { runtimeDirectory, windowsAcl: createMemoryWindowsAcl() },
        childTracking: {},
      };
      const original = new Error('start failed /secret/canonical/path with SECRET-VALUE-123 and pid 99999');
      (original as { custom_marker?: string }).custom_marker = 'CUSTOM-FIELD-VALUE';
      (original as { cause?: unknown }).cause = new Error('cause /secret/canonical/path');
      const offsets = await captureLogOffsets(context.logFiles);
      let thrown: unknown;
      try { await annotateDaemonStartFailure(original, context, offsets, [{ state: 'exited' }]); }
      catch (error) { thrown = error; }
      let primitive: unknown;
      try { await annotateDaemonStartFailure('raw non-error payload SECRET-VALUE-123', context, offsets, [{ state: 'exited' }]); }
      catch (error) { primitive = error; }
      for (const diagnostic of [thrown, primitive]) {
        expect(diagnostic).toBeInstanceOf(Error);
        expect(diagnostic).not.toBe(original);
        const sanitized = diagnostic as Error & {
          daemon_log_phase?: string; daemon_metadata_state?: string; daemon_child_state?: string; cause?: unknown;
        };
        expect(sanitized.message).toBe('daemon start failed (daemon_log_phase=startup_unknown daemon_metadata_state=absent daemon_child_state=exited)');
        expect(sanitized.message).toMatch(/\(daemon_log_phase=\w+ daemon_metadata_state=\w+ daemon_child_state=\w+\)$/);
        expect(sanitized.message).not.toContain(root);
        expect(sanitized.stack ?? '').not.toContain('SECRET-VALUE-123');
        expect(sanitized.stack ?? '').not.toContain('/secret/canonical/path');
        expect(sanitized.stack ?? '').not.toContain('CUSTOM-FIELD-VALUE');
        expect(Object.keys(sanitized).sort()).toEqual(['daemon_child_state', 'daemon_log_phase', 'daemon_metadata_state']);
        expect(sanitized.daemon_log_phase).toBe('startup_unknown');
        expect(sanitized.daemon_metadata_state).toBe('absent');
        expect(sanitized.daemon_child_state).toBe('exited');
        expect(sanitized.cause).toBeUndefined();
      }
      expect((original as { daemon_log_phase?: string }).daemon_log_phase).toBeUndefined();
      expect(original.message).toBe('start failed /secret/canonical/path with SECRET-VALUE-123 and pid 99999');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  test('classifies daemon runtime exit windows: boundaries, replacement isolation, caps, and every enum', async () => {
    const root = makeCanonicalTempDir('bungee-canonical-diagnostics', { daemonSafe: true });
    try {
      // offset/end boundary + replacement isolation through a real exit event
      const logs = join(root, 'logs');
      await mkdir(logs, { recursive: true });
      const seedFile = join(logs, 'app-2026-01-01.log');
      await writeFile(seedFile, 'seed\n', 'utf8');
      const windows = captureAppLogOffsets(logs);
      expect(windows).toEqual([{ file: seedFile, start: 5 }]);
      const fatalLine = '{"level":"error","message":"Master runtime failed","error":{"name":"MasterRuntimeError","message":"worker repair failed","code":"repair_failed"}}\n';
      await appendFile(seedFile, fatalLine, 'utf8');
      const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      const freezeGetter = createExitAppLogFreeze(exited, windows, logs);
      await childExit(exited);
      await appendFile(seedFile, '{"level":"error","message":"replacement noise"}\n', 'utf8');
      const frozen = freezeGetter();
      expect(frozen).toEqual([{ file: seedFile, start: 5, end: 5 + Buffer.byteLength(fatalLine) }]);
      expect(await classifyDaemonRuntimeExit(frozen)).toBe('master_repair_fatal');

      // a child that already exited before registration freezes immediately, with no
      // listener added at all
      const preExited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await childExit(preExited);
      const preExitBaseline = preExited.listenerCount('exit');
      const preExitEnd = statSync(seedFile).size;
      const preFrozenGetter = createExitAppLogFreeze(preExited, windows, logs);
      expect(preExited.listenerCount('exit')).toBe(preExitBaseline);
      await appendFile(seedFile, '{"level":"error","message":"late noise"}\n', 'utf8');
      const preFrozen = preFrozenGetter();
      expect(preFrozen).toEqual([{ file: seedFile, start: 5, end: preExitEnd }]);
      expect(preFrozenGetter()).toEqual(preFrozen);
      // live child: our once('exit') is +1 over baseline, self-removes on exit, and never
      // touches a foreign exit listener
      const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      const liveBaseline = liveChild.listenerCount('exit');
      const foreignExit = (): void => {};
      liveChild.on('exit', foreignExit);
      const withForeign = liveChild.listenerCount('exit');
      expect(withForeign).toBe(liveBaseline + 1);
      createExitAppLogFreeze(liveChild, windows, logs);
      expect(liveChild.listenerCount('exit')).toBe(withForeign + 1);
      await stopChild(liveChild);
      expect(liveChild.listenerCount('exit')).toBe(withForeign);
      liveChild.removeListener('exit', foreignExit);
      expect(liveChild.listenerCount('exit')).toBe(liveBaseline);

      // 2-file / 64 KiB total cap: first file whole, second file contributes its tail
      const capDir = join(root, 'cap');
      await mkdir(capDir, { recursive: true });
      const capA = join(capDir, 'app-a.log');
      const capB = join(capDir, 'app-b.log');
      await writeFile(capA, 'a'.repeat(40_960), 'utf8');
      await writeFile(capB, 'b'.repeat(40_960), 'utf8');
      const capped = await readAppLogWindows([{ file: capA, start: 0, end: 40_960 }, { file: capB, start: 0, end: 40_960 }]);
      expect(capped.anyRead).toBeTrue();
      expect(capped.chunks[0]?.length).toBe(40_960);
      expect(capped.chunks[1]?.length).toBe(24_576);
      const capC = join(capDir, 'app-0-c.log');
      await writeFile(capC, 'cccccccccc', 'utf8');
      expect(captureAppLogOffsets(capDir).map((window) => window.file)).toEqual([capC, capA]);

      // every enum from real winston line shapes (nested codes, exact messages, malformed lines)
      const enumCases: readonly (readonly [string, DaemonRuntimePhase])[] = [
        ['{"level":"error","message":"Master runtime failed","error":{"name":"MasterRuntimeError","message":"wrap","cause":{"message":"deeper","cause":{"message":"deepest","code":"repair_failed"}}}}\n', 'master_repair_fatal'],
        ['{"level":"error","message":"Master runtime failed","error":{"code":"publication_failed"}}\n', 'master_publication_fatal'],
        ['{"level":"error","message":"Master runtime failed","error":{"code":"startup_incomplete"}}\n', 'master_recovery_fatal'],
        ['{"level":"error","message":"Master runtime failed","error":{"name":"MasterRuntimeError"}}\n', 'master_runtime_other'],
        ['{"level":"error","message":"Process startup failed","error":{"message":"/secret/path SECRET-TOKEN pid 1"}}\n', 'process_startup_failure'],
        ['{"level":"error","message":"Master shutdown failed"}\n', 'shutdown_failure'],
        ['{"level":"error","message":"something unlisted","error":{"code":"mystery"}}\n', 'unclassified_error'],
        ['{"level":"info","message":"healthy"}\nnot json {{{\n', 'no_error_record'],
        ['{"level":"error","message":"Master runtime failed","error":{"code":"publication_failed","cause":{"code":"repair_failed"}}}\n', 'master_repair_fatal'],
      ];
      for (const [index, [lines, expected]] of enumCases.entries()) {
        const file = join(root, `enum-${index}.log`);
        await writeFile(file, lines, 'utf8');
        expect(await classifyDaemonRuntimeExit([{ file, start: 0, end: Buffer.byteLength(lines) }])).toBe(expected);
      }
      // unavailable inputs: empty freeze, unreadable file, zero-length window
      expect(await classifyDaemonRuntimeExit([])).toBe('log_unavailable');
      expect(await classifyDaemonRuntimeExit([{ file: join(root, 'missing.log'), start: 0, end: 100 }])).toBe('log_unavailable');
      const emptyFile = join(root, 'empty.log');
      await writeFile(emptyFile, '', 'utf8');
      expect(await classifyDaemonRuntimeExit([{ file: emptyFile, start: 0, end: 0 }])).toBe('no_error_record');
      // an app log that appeared AFTER capture is frozen from offset 0
      const lateDir = join(root, 'late');
      await mkdir(lateDir, { recursive: true });
      const lateWindows = captureAppLogOffsets(lateDir);
      const lateFile = join(lateDir, 'app-2026-02-02.log');
      const lateLine = '{"level":"error","message":"Process startup failed"}\n';
      await writeFile(lateFile, lateLine, 'utf8');
      const lateFrozen = freezeAppLogWindows(lateWindows, lateDir);
      expect(lateFrozen).toEqual([{ file: lateFile, start: 0, end: Buffer.byteLength(lateLine) }]);
      expect(await classifyDaemonRuntimeExit(lateFrozen)).toBe('process_startup_failure');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });
});

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
    const root = makeCanonicalTempDir('bungee-canonical-core', { daemonSafe: true });
    const lease = await reservePortBlock();
    const fixture = await makeFixture(root, 'core');
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(state?.marker ?? 'A') });
    if (upstream.port === undefined) throw new Error('upstream did not bind');
    const daemon = await createDaemonHarness(fixture.root, lease, fixture, 2, {
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
  let state: { root: string; lease: PortLease; manager: DaemonManager; spawned: SpawnRecord[]; metadataPath: string; runtime: string; logFiles: readonly string[]; errors: string[]; appLogsDirectory: string; appLogWindows: readonly AppLogWindow[]; firstExitFreeze?: () => readonly AppLogFreeze[] } | undefined;
  beforeAll(async () => {
    const root = makeCanonicalTempDir('bungee-canonical-daemon', { daemonSafe: true });
    const lease = await reservePortBlock();
    const home = join(root, 'home'); const data = join(home, 'data'); const logs = join(home, 'logs'); const runtime = join(home, '.bungee', 'run');
    const plugins = join(data, 'plugins'); const plugin = join(plugins, 'canonical-plugin');
    await Promise.all([mkdir(plugin, { recursive: true }), mkdir(logs, { recursive: true }), mkdir(runtime, { recursive: true })]);
    await Promise.all([writeFile(join(plugin, 'manifest.json'), JSON.stringify({ name: 'canonical-plugin', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js', capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.2.0' }, builtin: false, contributes: {}, configSchema: [], metadata: { name: 'canonical-plugin', description: 'canonical', icon: 'test' } })), writeFile(join(plugin, 'index.js'), "export default class CanonicalPlugin { static version = '1.0.0'; register() {} };")]);
    const daemon = await createDaemonHarness(root, lease, undefined, 1, {
      home, dataDirectory: data, logsDirectory: logs, pluginsPath: plugins, managementPort: lease.base + 1,
      pluginSecretsKey: Buffer.alloc(32, 7).toString('base64'),
      baseEnvironment: {
        ...process.env, HOME: home, USERPROFILE: home,
        BUNGEE_MANAGEMENT_PORT: String(lease.base + 1), BUNGEE_INGRESS_SUPERVISION_PORT: String(lease.base + 2),
        BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false', BUNGEE_PLUGIN_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
        BUNGEE_FILE_LOG_DIR: logs, PLUGINS_DIR: plugins, LOG_LEVEL: 'error',
      },
    });
    state = { root, lease, ...daemon, errors: [], appLogsDirectory: join(data, 'logs'), appLogWindows: [] };
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
    state.appLogWindows = captureAppLogOffsets(state.appLogsDirectory);
    await state.manager.start({ workers: '1', port: String(state.lease.base) });
    const metadata = await readDaemonMetadataFile(state.metadataPath, { runtimeDirectory: state.runtime });
    if (metadata.state !== 'armed' || metadata.pid === null || metadata.management_port === null || metadata.instance_id === null) throw new Error('daemon did not arm');
    const firstChild = state.spawned[0]?.child;
    if (firstChild === undefined || firstChild.pid === undefined) throw new Error('daemon child was not captured');
    state.firstExitFreeze = createExitAppLogFreeze(firstChild, state.appLogWindows, state.appLogsDirectory);
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
    const firstExit = await childExit(firstChild);
    // B-only post-start exit classifier: on any abnormal first-child exit, emit ONLY the
    // fixed phase enum — never the exit code, signal, raw logs, or paths.
    if (firstExit.code !== 0 || firstExit.signal !== null) {
      const freeze = state.firstExitFreeze === undefined ? [] : state.firstExitFreeze();
      throw new Error(`unexpected daemon exit (daemon_runtime_phase=${await classifyDaemonRuntimeExit(freeze)})`);
    }
    expect(firstExit).toEqual({ code: 0, signal: null });
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
    const root = makeCanonicalTempDir('bungee-canonical-benchmark', { daemonSafe: true }); const lease = await reservePortBlock();
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ordinary') });
    if (upstream.port === undefined) throw new Error('benchmark upstream did not bind');
    const fixture = await makeFixture(root, 'benchmark');
    const daemon = await createDaemonHarness(fixture.root, lease, fixture, 2, {
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
