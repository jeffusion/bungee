import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import {
  DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER, DAEMON_SHUTDOWN_PATH,
  encodeDaemonShutdownSecret, type DaemonMetadataV1,
} from '@jeffusion/bungee-types';
import {
  DaemonFileError,
  createLaunchingDaemonMetadataFile,
  deleteDaemonMetadataAfterOwnerExit,
  deleteDaemonMetadataForLauncher,
  formatDaemonFileAclError,
  readDaemonMetadataFile,
  type DaemonFileOptions,
  type WindowsAclAdapter,
} from '@jeffusion/bungee-types/daemon-file';
import { ConfigPaths } from '../config/paths';
import { BinaryManager } from '../binary/manager';
import { createDaemonRuntime } from './runtime';
import { deleteLegacyPidFile, readLegacyPidFile, writeLegacyPidMirror } from './pid-mirror';
import {
  findExactDaemonProcessDetailed,
  probeDaemonProcess,
  type MarkerProbe,
  type MarkerProbeReason,
  type MarkerProbeResult,
  probeProcessAlive,
  type ProcessAliveProbe,
  type ProcessIdentity,
  type ProcessProbe,
  probeDaemonProcessUser,
  type ProcessUserProbe,
} from './process-identity';
import { forceStopDaemon } from './force-stop';

export type LaunchDescriptor = Readonly<{ executable: string; entrypoint: string | null }>;
export type DaemonStatus = Readonly<{
  running: boolean;
  pid?: number;
  state?: 'starting' | 'running' | 'stopping' | 'unknown';
  configDir: string;
  logFile: string;
  errorLogFile: string;
}>;

export type StartOptions = {
  readonly workers?: string;
  readonly port?: string;
  readonly autoUpgrade?: boolean;
  /** Test/development-only direct Bun launch. It deliberately has no wrapper arguments. */
  readonly directLaunch?: LaunchDescriptor;
  readonly launchDescriptor?: LaunchDescriptor;
};

type SpawnedChild = {
  readonly pid?: number;
  readonly unref: () => void;
  readonly once?: (event: string, listener: (...args: any[]) => void) => void;
  readonly kill?: (signal?: NodeJS.Signals | number) => boolean;
};
export type DaemonSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => SpawnedChild;
type ProcessControl = { readonly kill: (pid: number, signal: NodeJS.Signals | number) => void };
export type DaemonManagerDependencies = {
  readonly runtimeDirectory?: string;
  readonly dataDirectory?: string;
  readonly logsDirectory?: string;
  readonly configDirectory?: string;
  readonly pidFile?: string;
  readonly logFile?: string;
  readonly errorLogFile?: string;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly directLaunch?: LaunchDescriptor;
  readonly launchDescriptor?: LaunchDescriptor;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly currentPid?: () => number;
  readonly probeProcess?: (pid: number, identity: ProcessIdentity, bootNonce: string) => Promise<ProcessProbe>;
  readonly probeCurrentUser?: (pid: number) => Promise<ProcessUserProbe>;
  readonly probePid?: (pid: number) => Promise<ProcessAliveProbe>;
  readonly findProcess?: (bootNonce: string) => Promise<MarkerProbe>;
  readonly findProcessDetailed?: (bootNonce: string, expected?: ProcessIdentity) => Promise<MarkerProbeResult>;
  readonly writePidMirror?: (path: string, pid: number) => Promise<void>;
  readonly httpRequest?: (url: string, init: RequestInit) => Promise<Response>;
  readonly taskkill?: (pid: number) => Promise<void>;
  readonly forceStop?: (metadata: DaemonMetadataV1) => Promise<void>;
  readonly processPlatform?: NodeJS.Platform;
  readonly filePlatform?: NodeJS.Platform;
  readonly gracefulDeadlineMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly forceWaitMs?: number;
  readonly windowsAcl?: WindowsAclAdapter;
};

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

type ChildObservation = { readonly error: { readonly value: unknown } | null; readonly exited: boolean; readonly done: Promise<void> };
const MAX_SHUTDOWN_RESPONSE_BYTES = 512;
type OwnerGoneResult = Readonly<{
  status: 'gone' | 'present' | 'unknown';
  diagnostic: Readonly<{
    pid_probe: ProcessProbe;
    marker_probe: MarkerProbe | 'not_run';
    marker_reason: MarkerProbeReason | 'not_run';
    metadata: 'removed';
    attempt: number;
  }>;
}>;
type MetadataRemovalResult = 'removed' | 'not_removed';
const MAX_OWNER_GONE_DIAGNOSTIC_ATTEMPT = 999;

function ownerGoneDiagnosticText(diagnostic: OwnerGoneResult['diagnostic']): string {
  return `pid_probe=${diagnostic.pid_probe}, marker_probe=${diagnostic.marker_probe}, marker_reason=${diagnostic.marker_reason ?? 'null'}, metadata=removed, attempt=${diagnostic.attempt}`;
}
async function readShutdownResponse(response: Response): Promise<string> {
  if (response.body === null || response.body === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SHUTDOWN_RESPONSE_BYTES) throw new Error('shutdown response is too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_SHUTDOWN_RESPONSE_BYTES) {
        await reader.cancel('shutdown response too large');
        throw new Error('shutdown response is too large');
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function observeChild(child: SpawnedChild): ChildObservation {
  let error: { value: unknown } | null = null;
  let exited = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const settle = () => { exited = true; finish(); };
  child.once?.('error', (value: unknown) => { error = { value }; });
  child.once?.('exit', settle);
  child.once?.('close', settle);
  return { get error() { return error; }, get exited() { return exited; }, done };
}

function canonicalLaunchDescriptor(descriptor: LaunchDescriptor): LaunchDescriptor {
  if (!isAbsolute(descriptor.executable) || descriptor.executable.includes('\0')) {
    throw new Error('Daemon executable must be an absolute path');
  }
  let executable: string;
  try { executable = realpathSync.native(descriptor.executable); }
  catch (error) { throw new Error(`Daemon executable cannot be canonicalized: ${errorText(error)}`); }
  if (descriptor.entrypoint === null) return { executable, entrypoint: null };
  if (!/^bun(?:\.exe)?$/i.test(basename(executable))) throw new Error('Direct daemon executable must be Bun');
  if (!isAbsolute(descriptor.entrypoint) || descriptor.entrypoint.includes('\0')
    || !/\.(?:js|ts)$/i.test(descriptor.entrypoint)) {
    throw new Error('Direct daemon entrypoint must be an absolute .js or .ts file');
  }
  if (/^(?:run|watch|shell|exec|x|--watch|--hot|--smol)(?:$|[=:/\\])/i.test(descriptor.entrypoint)) {
    throw new Error('Daemon launch wrappers are not allowed');
  }
  try { return { executable, entrypoint: realpathSync.native(descriptor.entrypoint) }; }
  catch (error) { throw new Error(`Daemon entrypoint cannot be canonicalized: ${errorText(error)}`); }
}

export class DaemonManager {
  private configDir: string;
  private pidFile: string;
  private logFile: string;
  private errorLogFile: string;
  private readonly metadataFile: string;
  private readonly runtimeDirectory: string;
  private readonly windowsAcl?: WindowsAclAdapter;
  private readonly processPlatform: NodeJS.Platform;
  private readonly filePlatform: NodeJS.Platform;
  private readonly dataDirectory: string;
  private readonly logsDirectory: string;
  private readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly currentPid: () => number;
  private readonly probeProcess: (pid: number, identity: ProcessIdentity, bootNonce: string) => Promise<ProcessProbe>;
  private readonly probeCurrentUser: (pid: number) => Promise<ProcessUserProbe>;
  private readonly findProcess: (bootNonce: string) => Promise<MarkerProbe>;
  private readonly findProcessDetailed: (bootNonce: string, expected?: ProcessIdentity) => Promise<MarkerProbeResult>;
  private readonly probePid: (pid: number) => Promise<ProcessAliveProbe>;
  private readonly injectedLaunch?: LaunchDescriptor;
  private readonly writePidMirror: (path: string, pid: number) => Promise<void>;
  private readonly httpRequest: (url: string, init: RequestInit) => Promise<Response>;
  private readonly forceStop: (metadata: DaemonMetadataV1) => Promise<void>;
  private readonly rpcTimeoutMs: number;
  private readonly forceWaitMs: number;
  private startTimeoutMs = 30_000;
  private stopTimeoutMs = 30_000;

  constructor(
    private readonly spawnDaemon: DaemonSpawn = spawn,
    private readonly processControl: ProcessControl = { kill: (pid, signal) => process.kill(pid, signal) },
    dependencies: DaemonManagerDependencies = {},
  ) {
    this.configDir = dependencies.configDirectory ?? ConfigPaths.CONFIG_DIR;
    this.pidFile = dependencies.pidFile ?? ConfigPaths.PID_FILE;
    this.logFile = dependencies.logFile ?? ConfigPaths.LOG_FILE;
    this.errorLogFile = dependencies.errorLogFile ?? ConfigPaths.ERROR_LOG_FILE;
    this.runtimeDirectory = dependencies.runtimeDirectory ?? ConfigPaths.RUNTIME_DIR;
    this.windowsAcl = dependencies.windowsAcl;
    this.processPlatform = dependencies.processPlatform ?? process.platform;
    this.filePlatform = dependencies.filePlatform ?? process.platform;
    this.dataDirectory = dependencies.dataDirectory ?? ConfigPaths.DATA_DIR;
    this.logsDirectory = dependencies.logsDirectory ?? ConfigPaths.LOGS_DIR;
    this.inheritedEnvironment = dependencies.inheritedEnvironment ?? process.env;
    this.metadataFile = join(this.runtimeDirectory, 'daemon.json');
    this.now = dependencies.now ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.currentPid = dependencies.currentPid ?? (() => process.pid);
    const baseProbe = dependencies.probeProcess ?? ((pid, identity, bootNonce) => probeDaemonProcess(pid, identity, bootNonce, { platform: this.processPlatform }));
    this.probeCurrentUser = dependencies.probeCurrentUser
      ?? (dependencies.probeProcess === undefined ? (pid) => probeDaemonProcessUser(pid, { platform: this.processPlatform }) : async () => 'same');
    this.probeProcess = async (pid, identity, bootNonce) => {
      const probe = await baseProbe(pid, identity, bootNonce);
      if (probe !== 'exact') return probe;
      return await this.probeCurrentUser(pid) === 'same' ? 'exact' : 'unknown';
    };
    this.findProcessDetailed = dependencies.findProcessDetailed
      ?? (dependencies.findProcess === undefined
        ? (bootNonce, expected) => findExactDaemonProcessDetailed(bootNonce, expected, { platform: this.processPlatform })
        : async (bootNonce) => ({ status: await dependencies.findProcess!(bootNonce), reason: null }));
    this.findProcess = dependencies.findProcess ?? (async (bootNonce) => (await this.findProcessDetailed(bootNonce)).status);
    this.probePid = dependencies.probePid ?? (dependencies.probeProcess === undefined
      ? ((pid) => probeProcessAlive(pid, { platform: this.processPlatform }))
      : async (pid) => {
        try { this.processControl.kill(pid, 0); return 'alive'; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'alive' : 'unknown';
        }
      });
    this.injectedLaunch = dependencies.directLaunch ?? dependencies.launchDescriptor;
    this.writePidMirror = dependencies.writePidMirror ?? writeLegacyPidMirror;
    this.httpRequest = dependencies.httpRequest ?? ((url, init) => fetch(url, init));
    this.rpcTimeoutMs = dependencies.rpcTimeoutMs ?? 3_000;
    this.forceWaitMs = dependencies.forceWaitMs ?? 1_500;
    this.forceStop = dependencies.forceStop ?? ((metadata) => forceStopDaemon(metadata, {
      platform: this.processPlatform, probeProcess: this.probeProcess, findProcess: this.findProcess,
      kill: (pid, signal) => this.processControl.kill(pid, signal), taskkill: dependencies.taskkill,
      now: this.now, sleep: this.sleep, forceWaitMs: this.forceWaitMs,
    }));
    if (!Number.isSafeInteger(this.rpcTimeoutMs) || this.rpcTimeoutMs <= 0
      || !Number.isSafeInteger(this.forceWaitMs) || this.forceWaitMs <= 0) throw new Error('daemon stop timing is invalid');
    if (dependencies.gracefulDeadlineMs !== undefined) this.stopTimeoutMs = dependencies.gracefulDeadlineMs;

    ConfigPaths.ensureConfigDir();
    ConfigPaths.ensureDataDir();
    ConfigPaths.ensureLogsDir();
  }

  private fileOptions(): DaemonFileOptions {
    return { runtimeDirectory: this.runtimeDirectory, platform: this.filePlatform, windowsAcl: this.windowsAcl };
  }

  async isRunning(): Promise<boolean> {
    const status = await this.getStatus();
    return status.running;
  }

  async getPid(): Promise<number | null> {
    try {
      const metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions());
      if (metadata.state === 'launching') return null;
      const probe = await this.probeProcess(metadata.pid, {
        executable: metadata.executable, entrypoint: metadata.entrypoint,
      }, metadata.boot_nonce);
      return probe === 'exact' ? metadata.pid : null;
    } catch (error) {
      if (!isMissing(error)) return null;
      await readLegacyPidFile(this.pidFile);
      return null;
    }
  }

  private async pidAliveStatus(pid: number): Promise<ProcessAliveProbe> {
    return this.probePid(pid);
  }

  private async pidIsAlive(pid: number): Promise<boolean> {
    return await this.pidAliveStatus(pid) === 'alive';
  }

  private async inspectExisting(): Promise<void> {
    let metadata: DaemonMetadataV1;
    try { metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions()); }
    catch (error) {
      if (!isMissing(error)) {
        // Invalid and permission-denied metadata are intentionally indistinguishable to start.
        const aclDiagnostic = formatDaemonFileAclError(error);
        if (aclDiagnostic !== null) throw new Error(`Cannot safely inspect daemon metadata: ${aclDiagnostic}`);
        if (error instanceof DaemonFileError && error.code === 'acl') throw new Error('Cannot safely inspect daemon metadata');
        throw new Error(`Cannot safely inspect daemon metadata: ${errorText(error)}`);
      }
      const legacy = await readLegacyPidFile(this.pidFile);
      if (legacy.kind === 'unsafe' || legacy.kind === 'unknown') {
        throw new Error('Cannot safely inspect the legacy Bungee PID file');
      }
      if (legacy.kind === 'valid') {
        const alive = await this.pidAliveStatus(legacy.pid);
        if (alive === 'alive') {
          throw new Error('A legacy Bungee daemon appears to be running; upgrade or stop it before starting');
        }
        if (alive === 'unknown') throw new Error('Cannot safely inspect the legacy Bungee process');
        await deleteLegacyPidFile(this.pidFile, legacy.identity);
      }
      return;
    }

    if (metadata.state === 'launching') {
      const launcher = await this.pidAliveStatus(metadata.launcher_pid);
      if (launcher === 'alive') throw new Error('Bungee start is already in progress');
      if (launcher === 'unknown') throw new Error('Cannot safely inspect the existing daemon launcher');
      const marker = await this.findProcess(metadata.boot_nonce);
      if (marker === 'found' || marker === 'unknown') throw new Error('A daemon launch is owned by another process');
      await deleteDaemonMetadataAfterOwnerExit(this.metadataFile, {
        bootNonce: metadata.boot_nonce, state: 'launching', shutdownSecret: metadata.shutdown_secret,
      }, this.fileOptions());
      return;
    }

    const probe = await this.probeProcess(metadata.pid, {
      executable: metadata.executable, entrypoint: metadata.entrypoint,
    }, metadata.boot_nonce);
    if (probe === 'exact') throw new Error('Bungee is already running or starting');
    if (probe === 'unknown') throw new Error('Cannot safely inspect the existing Bungee process');
    await deleteDaemonMetadataAfterOwnerExit(this.metadataFile, {
      bootNonce: metadata.boot_nonce, state: metadata.state, shutdownSecret: metadata.shutdown_secret,
    }, this.fileOptions());
  }

  private async launchDescriptor(options: StartOptions): Promise<LaunchDescriptor> {
    if (options.directLaunch !== undefined) return canonicalLaunchDescriptor(options.directLaunch);
    if (options.launchDescriptor !== undefined) return canonicalLaunchDescriptor(options.launchDescriptor);
    if (this.injectedLaunch !== undefined) return canonicalLaunchDescriptor(this.injectedLaunch);
    const binaryPath = await BinaryManager.ensureBinary({ autoUpgrade: options.autoUpgrade });
    try { return { executable: realpathSync.native(binaryPath), entrypoint: null }; }
    catch (error) { throw new Error(`Daemon executable cannot be canonicalized: ${errorText(error)}`); }
  }

  private async cleanupAfterChildExit(state: DaemonMetadataV1, childDead = false): Promise<void> {
    if (state.state === 'launching') {
      await deleteDaemonMetadataForLauncher(this.metadataFile, {
        bootNonce: state.boot_nonce, shutdownSecret: state.shutdown_secret,
      }, this.fileOptions()).catch(() => undefined);
      return;
    }
    const probe = childDead ? 'dead' : await this.probeProcess(state.pid, { executable: state.executable, entrypoint: state.entrypoint }, state.boot_nonce);
    if (probe === 'dead') {
      await deleteDaemonMetadataAfterOwnerExit(this.metadataFile, {
        bootNonce: state.boot_nonce, state: state.state, shutdownSecret: state.shutdown_secret,
      }, this.fileOptions());
    }
  }

  private async childIsGone(child: SpawnedChild, observation: ChildObservation): Promise<boolean> {
    if (observation.exited) return true;
    if (child.kill === undefined) return false;
    try { return child.kill(0) === false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  private async cleanupObservedChild(observation: ChildObservation): Promise<void> {
    let metadata: DaemonMetadataV1;
    try { metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions()); }
    catch { return; }
    if (observation.exited) await this.cleanupAfterChildExit(metadata, true);
  }

  private async terminateAfterDetachFailure(child: SpawnedChild, observation: ChildObservation): Promise<boolean> {
    if (child.kill === undefined) return false;
    try { child.kill('SIGTERM'); } catch { return false; }
    try {
      await Promise.race([observation.done, new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      })]);
    } catch { return false; }
    if (!observation.exited) return false;
    await this.cleanupObservedChild(observation);
    return true;
  }

  private async pollStartup(child: SpawnedChild, observation: ChildObservation, descriptor: LaunchDescriptor, bootNonce: string): Promise<Extract<DaemonMetadataV1, { state: 'armed' }>> {
    const deadline = this.now() + this.startTimeoutMs;
    while (this.now() < deadline) {
      if (observation.error !== null) {
        if (await this.childIsGone(child, observation)) {
          await this.cleanupObservedChild({ ...observation, exited: true });
          throw new Error('Daemon child failed before startup');
        }
        throw new Error('Daemon child reported an error; metadata retained');
      }
      let metadata: DaemonMetadataV1;
      try { metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions()); }
      catch (error) {
        if (error instanceof DaemonFileError && error.code === 'race') { await this.sleep(100); continue; }
        throw new Error(`Daemon startup metadata is unavailable: ${errorText(error)}`);
      }
      if (metadata.boot_nonce !== bootNonce) throw new Error('Daemon startup boot nonce was replaced');
      if (metadata.state === 'launching') {
        const probe = await this.probeProcess(child.pid!, descriptor, bootNonce);
        if (probe === 'dead' || observation.exited) { await this.cleanupAfterChildExit(metadata, observation.exited); throw new Error('Daemon child exited before takeover'); }
        if (probe === 'mismatch') throw new Error('Daemon child launch identity does not match');
      } else if (metadata.state === 'starting') {
        if (metadata.pid !== child.pid) throw new Error('Daemon startup PID does not match the spawned child');
        const probe = await this.probeProcess(metadata.pid, descriptor, bootNonce);
        if (probe === 'dead' || observation.exited) {
          await this.cleanupAfterChildExit(metadata, observation.exited);
          throw new Error('Daemon child exited during startup');
        }
        if (probe === 'mismatch') throw new Error('Daemon child launch identity does not match');
        if (probe === 'unknown') throw new Error('Daemon child identity could not be proven');
      } else if (metadata.state === 'armed') {
        if (metadata.pid !== child.pid) throw new Error('Daemon armed PID does not match the spawned child');
        const probe = await this.probeProcess(metadata.pid, descriptor, bootNonce);
        if (probe === 'dead' || observation.exited) { await this.cleanupAfterChildExit(metadata, observation.exited); throw new Error('Daemon child exited after arming'); }
        if (probe !== 'exact') throw new Error('Daemon armed process identity could not be proven');
        return metadata;
      } else {
        throw new Error(`Daemon metadata entered illegal state: ${metadata.state}`);
      }
      await this.sleep(100);
    }
    throw new Error(`Daemon did not become armed within ${this.startTimeoutMs / 1000} seconds; metadata retained`);
  }

  async start(options: StartOptions = {}): Promise<void> {
    await this.inspectExisting();
    const descriptor = await this.launchDescriptor(options);
    const bootNonce = randomUUID().toLowerCase();
    const shutdownSecret = encodeDaemonShutdownSecret(randomBytes(32));
    const launching: DaemonMetadataV1 = {
      schema: 'bungee-daemon-metadata-v1', state: 'launching', launcher_pid: this.currentPid(), boot_nonce: bootNonce,
      executable: descriptor.executable, shutdown_secret: shutdownSecret, entrypoint: descriptor.entrypoint,
      pid: null, instance_id: null, management_host: null, management_port: null,
    };
    try {
      await createLaunchingDaemonMetadataFile(this.metadataFile, launching, this.fileOptions());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // The loser must inspect the winner's record; it never repairs or replaces it.
        await readDaemonMetadataFile(this.metadataFile, this.fileOptions());
        throw new Error('Bungee start lost ownership to a concurrent launcher');
      }
      throw error;
    }

    const runtime = createDaemonRuntime({
      dataDirectory: this.dataDirectory, logsDirectory: this.logsDirectory, workers: options.workers,
      port: options.port, inheritedEnvironment: this.inheritedEnvironment,
    });
    const env = {
      ...runtime.env,
      BUNGEE_ROLE: 'master',
      BUNGEE_DAEMON_METADATA_PATH: this.metadataFile,
      BUNGEE_DAEMON_BOOT_NONCE: bootNonce,
      BUNGEE_DAEMON_SHUTDOWN_SECRET: shutdownSecret,
    };
    let logFd: number | undefined;
    let errorLogFd: number | undefined;
    let child: SpawnedChild;
    try {
      logFd = fs.openSync(this.logFile, 'a');
      errorLogFd = fs.openSync(this.errorLogFile, 'a');
      const args = descriptor.entrypoint === null
        ? [`--bungee-daemon-boot=${bootNonce}`]
        : [descriptor.entrypoint, `--bungee-daemon-boot=${bootNonce}`];
      child = this.spawnDaemon(descriptor.executable, args, {
        detached: true, stdio: ['ignore', logFd, errorLogFd], env, cwd: runtime.cwd,
      });
    } catch (error) {
      if (logFd !== undefined) try { fs.closeSync(logFd); } catch { /* best effort */ }
      if (errorLogFd !== undefined) try { fs.closeSync(errorLogFd); } catch { /* best effort */ }
      await deleteDaemonMetadataForLauncher(this.metadataFile, { bootNonce, shutdownSecret }, this.fileOptions()).catch(() => undefined);
      throw new Error(`Failed to spawn daemon: ${errorText(error)}`);
    }
    const observation = observeChild(child);
    try { if (logFd !== undefined) fs.closeSync(logFd); } catch { /* already closed */ }
    try { if (errorLogFd !== undefined) fs.closeSync(errorLogFd); } catch { /* already closed */ }
    if (child.pid === undefined) {
      await deleteDaemonMetadataForLauncher(this.metadataFile, { bootNonce, shutdownSecret }, this.fileOptions()).catch(() => undefined);
      throw new Error('Daemon process did not return a PID');
    }
    try {
      child.unref();
    } catch (error) {
      await this.terminateAfterDetachFailure(child, observation);
      throw new Error(`Failed to detach daemon: ${errorText(error)}`);
    }
    try {
      const armed = await this.pollStartup(child, observation, descriptor, bootNonce);
      try {
        await this.writePidMirror(this.pidFile, armed.pid);
      } catch {
        console.warn('⚠️ Bungee PID mirror unavailable; daemon metadata remains authoritative');
      }
    } catch (error) {
      throw new Error(errorText(error));
    }
    console.log('✅ Bungee daemon started successfully');
    console.log(`📋 PID: ${child.pid}`);
    console.log(`💾 Data: ${this.dataDirectory}`);
    console.log(`📝 Logs: ${this.logFile}`);
  }

  private async warnLegacyMirror(expectedPid?: number): Promise<void> {
    try {
      const legacy = await readLegacyPidFile(this.pidFile);
      if (legacy.kind === 'absent') return;
      if (legacy.kind !== 'valid' || (expectedPid !== undefined && legacy.pid !== expectedPid)) {
        console.warn('⚠️ Legacy Bungee PID mirror is unsafe and was not removed');
        return;
      }
      if (expectedPid === undefined) {
        const alive = await this.pidAliveStatus(legacy.pid);
        if (alive !== 'dead') {
          console.warn('⚠️ Legacy Bungee PID mirror is not proven dead and was not removed');
          return;
        }
      }
      await deleteLegacyPidFile(this.pidFile, legacy.identity);
    } catch { console.warn('⚠️ Legacy Bungee PID mirror could not be removed'); }
  }

  private async removeDeadMetadata(metadata: DaemonMetadataV1): Promise<MetadataRemovalResult> {
    const deleted = await deleteDaemonMetadataAfterOwnerExit(this.metadataFile, {
      bootNonce: metadata.boot_nonce, state: metadata.state, shutdownSecret: metadata.shutdown_secret,
    }, this.fileOptions());
    if (!deleted) return 'not_removed';
    await this.warnLegacyMirror(metadata.pid === null ? undefined : metadata.pid);
    return 'removed';
  }

  private async ownerGoneAfterMetadataRemoval(metadata: DaemonMetadataV1, attempt = 1): Promise<OwnerGoneResult> {
    const boundedAttempt = Math.min(attempt, MAX_OWNER_GONE_DIAGNOSTIC_ATTEMPT);
    const pidProbe = metadata.pid === null ? 'dead' : await this.probeProcess(metadata.pid, {
      executable: metadata.executable, entrypoint: metadata.entrypoint,
    }, metadata.boot_nonce);
    if (pidProbe === 'exact') {
      return { status: 'present', diagnostic: { pid_probe: pidProbe, marker_probe: 'not_run', marker_reason: 'not_run', metadata: 'removed', attempt: boundedAttempt } };
    }
    if (pidProbe === 'unknown') {
      return { status: 'unknown', diagnostic: { pid_probe: pidProbe, marker_probe: 'not_run', marker_reason: 'not_run', metadata: 'removed', attempt: boundedAttempt } };
    }
    const marker = await this.findProcessDetailed(metadata.boot_nonce, {
      executable: metadata.executable, entrypoint: metadata.entrypoint,
    });
    if (marker.status === 'unknown') {
      return { status: 'unknown', diagnostic: { pid_probe: pidProbe, marker_probe: marker.status, marker_reason: marker.reason, metadata: 'removed', attempt: boundedAttempt } };
    }
    if (marker.status === 'found') {
      return { status: 'present', diagnostic: { pid_probe: pidProbe, marker_probe: marker.status, marker_reason: marker.reason, metadata: 'removed', attempt: boundedAttempt } };
    }
    await this.warnLegacyMirror(metadata.pid === null ? undefined : metadata.pid);
    return { status: 'gone', diagnostic: { pid_probe: pidProbe, marker_probe: marker.status, marker_reason: marker.reason, metadata: 'removed', attempt: boundedAttempt } };
  }

  private async waitForOwnerGoneAfterMetadataRemoval(metadata: DaemonMetadataV1, deadline: number): Promise<OwnerGoneResult> {
    let attempt = 1;
    let owner = await this.ownerGoneAfterMetadataRemoval(metadata, attempt++);
    while (owner.status !== 'gone' && this.now() < deadline) {
      await this.sleep(Math.min(50, Math.max(1, deadline - this.now())));
      owner = await this.ownerGoneAfterMetadataRemoval(metadata, attempt++);
    }
    return owner;
  }

  private ownerGoneFailure(owner: OwnerGoneResult): Error {
    const reason = owner.status === 'unknown'
      ? 'Cannot safely inspect the daemon after metadata removal'
      : 'Daemon metadata was removed before the old process exit was proven';
    return new Error(`${reason} (${ownerGoneDiagnosticText(owner.diagnostic)})`);
  }

  private async resolveFailedMetadataRemoval(metadata: DaemonMetadataV1, deadline: number): Promise<void> {
    try {
      const current = await readDaemonMetadataFile(this.metadataFile, this.fileOptions());
      if (current.boot_nonce !== metadata.boot_nonce) throw new Error('Daemon metadata boot was replaced while stopping');
      throw new Error('Cannot safely inspect daemon metadata after guarded delete');
    } catch (error) {
      if (!isMissing(error)) throw error;
      const owner = await this.waitForOwnerGoneAfterMetadataRemoval(metadata, deadline);
      if (owner.status === 'gone') return;
      throw this.ownerGoneFailure(owner);
    }
  }

  private async stopWithoutMetadata(): Promise<void> {
    const legacy = await readLegacyPidFile(this.pidFile);
    if (legacy.kind === 'valid') {
      if (await this.pidIsAlive(legacy.pid)) throw new Error('A legacy Bungee daemon appears to be running; upgrade or stop it manually');
      await this.warnLegacyMirror(legacy.pid);
    } else if (legacy.kind !== 'absent') {
      console.warn('⚠️ Legacy Bungee PID mirror is unsafe and was not removed');
    }
    console.log('✅ Bungee daemon is already stopped');
  }

  private async requestShutdown(metadata: Extract<DaemonMetadataV1, { state: 'armed' | 'stopping' }>, timeoutMs = this.rpcTimeoutMs): Promise<boolean> {
    if (!['127.0.0.1', '::1'].includes(metadata.management_host) || isIP(metadata.management_host) === 0 || !Number.isSafeInteger(metadata.management_port)
      || metadata.management_port < 1 || metadata.management_port > 65_535) throw new Error('Daemon management endpoint is invalid');
    const host = metadata.management_host === '::1' ? `[${metadata.management_host}]` : metadata.management_host;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = this.httpRequest(`http://${host}:${metadata.management_port}${DAEMON_SHUTDOWN_PATH}`, {
      method: 'POST', body: null, signal: controller.signal,
      headers: {
        [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
        'content-length': '0',
        [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
        [DAEMON_INSTANCE_HEADER]: metadata.instance_id,
        [DAEMON_PID_HEADER]: String(metadata.pid),
      },
    }).then(async (response) => ({ status: response.status, body: await readShutdownResponse(response) }));
    try {
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
      const result = await Promise.race([request, timeout]);
      if (result === null || result.status !== 202) return false;
      return result.body === JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid });
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }

  private async waitAfterForce(metadata: DaemonMetadataV1): Promise<void> {
    if (metadata.pid === null) throw new Error('Daemon PID is unavailable while stopping');
    const pid = metadata.pid;
    const deadline = this.now() + this.forceWaitMs;
    while (this.now() < deadline) {
      const probe = await this.probeProcess(pid, { executable: metadata.executable, entrypoint: metadata.entrypoint }, metadata.boot_nonce);
      if (probe === 'unknown') throw new Error('Daemon identity became unknown while stopping');
      if (probe !== 'exact') {
        if (await this.removeDeadMetadata(metadata) === 'not_removed') {
          await this.resolveFailedMetadataRemoval(metadata, deadline);
          return;
        }
        const owner = await this.waitForOwnerGoneAfterMetadataRemoval(metadata, deadline);
        if (owner.status === 'gone') return;
        throw this.ownerGoneFailure(owner);
      }
      await this.sleep(50);
    }
    throw new Error('Forced daemon stop did not prove process exit');
  }

  async stop(): Promise<void> {
    const deadline = this.now() + this.stopTimeoutMs;
    let bootNonce: string | undefined;
    let lastOwner: DaemonMetadataV1 | undefined;
    let shutdownAccepted = false;
    let retryDelay = 100;
    let lastState: DaemonMetadataV1['state'] | undefined;
    let metadataRemovalAttempt = 0;
    const wait = async () => {
      const remaining = deadline - this.now();
      if (remaining <= 0) return;
      await this.sleep(Math.min(retryDelay, remaining));
      retryDelay = retryDelay === 100 ? 250 : 500;
    };
    while (this.now() < deadline) {
      let metadata: DaemonMetadataV1;
      try { metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions()); }
      catch (error) {
        if (isMissing(error)) {
          if (lastOwner !== undefined) {
            const owner = await this.ownerGoneAfterMetadataRemoval(lastOwner, ++metadataRemovalAttempt);
            if (owner.status === 'gone') { console.log('✅ Bungee daemon stopped successfully'); return; }
            await wait(); continue;
          }
          await this.stopWithoutMetadata(); return;
        }
        if (error instanceof DaemonFileError && error.code === 'race') { await wait(); continue; }
        const aclDiagnostic = formatDaemonFileAclError(error);
        if (aclDiagnostic !== null) throw new Error(`Cannot safely inspect daemon metadata: ${aclDiagnostic}`);
        if (error instanceof DaemonFileError && error.code === 'acl') throw new Error('Cannot safely inspect daemon metadata');
        throw new Error(`Cannot safely inspect daemon metadata: ${errorText(error)}`);
      }
      bootNonce ??= metadata.boot_nonce;
      if (metadata.boot_nonce !== bootNonce) throw new Error('Daemon metadata boot was replaced while stopping');
      if (metadata.state !== lastState) { lastState = metadata.state; retryDelay = 100; }
      lastOwner = metadata;
      if (metadata.state === 'launching') {
        const launcher = await this.pidAliveStatus(metadata.launcher_pid);
        if (launcher === 'alive') { await wait(); continue; }
        if (launcher === 'unknown') throw new Error('Cannot safely inspect the daemon launcher');
        const marker = await this.findProcess(metadata.boot_nonce);
        if (marker === 'none') {
          if (await this.removeDeadMetadata(metadata) === 'not_removed') { await wait(); continue; }
          const owner = await this.ownerGoneAfterMetadataRemoval(metadata, ++metadataRemovalAttempt);
          if (owner.status === 'gone') { console.log('✅ Bungee daemon was not running'); return; }
        }
        await wait(); continue;
      }
      const probe = await this.probeProcess(metadata.pid, { executable: metadata.executable, entrypoint: metadata.entrypoint }, metadata.boot_nonce);
      if (probe === 'unknown') throw new Error('Cannot safely inspect the daemon process');
      if (probe !== 'exact') {
        if (await this.removeDeadMetadata(metadata) === 'not_removed') { await wait(); continue; }
        const owner = await this.ownerGoneAfterMetadataRemoval(metadata, ++metadataRemovalAttempt);
        if (owner.status === 'gone') { console.log('✅ Bungee daemon was not running'); return; }
        await wait(); continue;
      }
      if (metadata.state === 'starting') { await wait(); continue; }
      if (!shutdownAccepted) {
        shutdownAccepted = await this.requestShutdown(metadata, Math.min(this.rpcTimeoutMs, Math.max(1, deadline - this.now())));
        if (shutdownAccepted) retryDelay = 100;
      }
      await wait();
    }

    let metadata: DaemonMetadataV1;
    try { metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions()); }
    catch (error) {
      if (isMissing(error)) {
        if (lastOwner !== undefined) {
          const owner = await this.ownerGoneAfterMetadataRemoval(lastOwner, ++metadataRemovalAttempt);
          if (owner.status === 'gone') { console.log('✅ Bungee daemon stopped successfully'); return; }
          throw this.ownerGoneFailure(owner);
        }
        throw new Error('Daemon metadata was removed before the old process exit was proven');
      }
      const aclDiagnostic = formatDaemonFileAclError(error);
      if (aclDiagnostic !== null) throw new Error(`Cannot safely inspect daemon metadata: ${aclDiagnostic}`);
      if (error instanceof DaemonFileError && error.code === 'acl') throw new Error('Cannot safely inspect daemon metadata');
      throw new Error(`Cannot safely inspect daemon metadata: ${errorText(error)}`);
    }
    if (bootNonce !== undefined && metadata.boot_nonce !== bootNonce) throw new Error('Daemon metadata boot was replaced before force stop');
    bootNonce ??= metadata.boot_nonce;
    if (metadata.state === 'launching') throw new Error('Daemon is still launching; force stop is unavailable');
    const probe = await this.probeProcess(metadata.pid, { executable: metadata.executable, entrypoint: metadata.entrypoint }, metadata.boot_nonce);
    if (probe === 'unknown') throw new Error('Cannot safely force stop an unknown daemon process');
    if (probe !== 'exact') {
      const removalDeadline = this.now() + this.forceWaitMs;
      if (await this.removeDeadMetadata(metadata) === 'not_removed') {
        await this.resolveFailedMetadataRemoval(metadata, removalDeadline);
        return;
      }
      const owner = await this.waitForOwnerGoneAfterMetadataRemoval(metadata, removalDeadline);
      if (owner.status === 'gone') return;
      throw this.ownerGoneFailure(owner);
    }
    await this.forceStop(metadata);
    await this.waitAfterForce(metadata);
  }

  async restart(options: StartOptions = {}): Promise<void> {
    console.log('🔄 Restarting Bungee daemon...');
    await this.stop();
    await this.start(options);
  }

  async getStatus(): Promise<DaemonStatus> {
    try {
      const metadata = await readDaemonMetadataFile(this.metadataFile, this.fileOptions());
      if (metadata.state === 'launching') {
        return { running: false, state: 'starting', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
      }
      const probe = await this.probeProcess(metadata.pid, {
        executable: metadata.executable, entrypoint: metadata.entrypoint,
      }, metadata.boot_nonce);
      if (probe === 'unknown') return { running: false, state: 'unknown', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
      return probe === 'exact'
        ? { running: true, pid: metadata.pid, state: metadata.state === 'armed' ? 'running' : 'starting', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile }
        : { running: false, state: metadata.state === 'stopping' ? 'stopping' : 'unknown', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
    } catch (error) {
      if (!isMissing(error)) return { running: false, state: 'unknown', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
      const legacy = await readLegacyPidFile(this.pidFile);
      if (legacy.kind === 'unsafe' || legacy.kind === 'unknown'
        || (legacy.kind === 'valid' && await this.pidAliveStatus(legacy.pid) !== 'dead')) {
        return { running: false, state: 'unknown', configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
      }
      return { running: false, configDir: this.configDir, logFile: this.logFile, errorLogFile: this.errorLogFile };
    }
  }

  async getLogs(lines: number = 50, follow: boolean = false): Promise<void> {
    if (!fs.existsSync(this.logFile)) { console.log('No logs found. Make sure Bungee is running or has been started.'); return; }
    if (follow) {
      const tail = spawn('tail', ['-f', '-n', String(lines), this.logFile], { stdio: 'inherit' });
      process.on('SIGINT', () => { tail.kill(); process.exit(0); });
      return;
    }
    const content = await readFile(this.logFile, 'utf8');
    console.log(content.split('\n').slice(-lines).join('\n'));
  }
}
