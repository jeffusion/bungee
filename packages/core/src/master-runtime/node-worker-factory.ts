import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import type {
  ConfigPublicationWorkerFactory,
  ConfigPublicationWorkerProcess,
  PublicationScheduler,
  WorkerExitEvidence,
} from '../config-publication/coordinator-types';
import { NodeChildProcessAdapter } from '../config-publication/node-child-process';
import type { ProcessCleanupResult } from '../config-publication/process-cleanup';
import { terminateWithEscalation } from '../config-publication/process-termination';
import type { ConfigProcessIdentity } from '../config-publication/types';
import { bestEffort } from '../config-publication/waiter-safety';
import { CONFIG_WORKER_ENV_NAMES } from '../config-worker/process-environment';
import { timeoutScheduler } from '../config-worker/timeout-scheduler';
import {
  MasterHeartbeatSender,
  type HeartbeatIntervalScheduler,
} from './heartbeat-sender';
import type { WorkerLaunch } from './process-options';

const STRIPPED_ENV_NAMES = [
  'CONFIG_PATH',
  'PORT',
  'WORKER_ID',
  'HOST',
  'WORKER_COUNT',
  'BUNGEE_PLUGIN_SECRETS_KEY',
] as const;

export type ConfigWorkerSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type NodeConfigWorkerFactoryOptions = {
  readonly launch: WorkerLaunch;
  /** Working directory shared by master and production workers. */
  readonly cwd?: string;
  readonly masterPid: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly transportSecret: string;
  readonly accessLogDbPath: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly spawn?: ConfigWorkerSpawn;
  readonly adapterFactory?: (
    child: ChildProcess,
    identity: ConfigProcessIdentity,
  ) => ConfigPublicationWorkerProcess;
  readonly heartbeatScheduler?: HeartbeatIntervalScheduler;
  readonly terminationScheduler?: PublicationScheduler;
  readonly onSpawn?: (process: ConfigPublicationWorkerProcess) => void;
  readonly onDisconnect?: (process: ConfigPublicationWorkerProcess) => void;
};

export type NodeConfigWorkerFactoryErrorCode = 'duplicate_identity';

export type ConfigWorkerExitListener = (
  process: ConfigPublicationWorkerProcess,
  evidence: WorkerExitEvidence,
) => void;

export class NodeConfigWorkerFactoryError extends Error {
  readonly name = 'NodeConfigWorkerFactoryError';

  constructor(readonly code: NodeConfigWorkerFactoryErrorCode, message: string) {
    super(message);
  }
}

type OwnedWorker = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly identityKey: string;
  unsubscribeExit: () => void;
  unsubscribeDisconnect: () => void;
};

const DEFAULT_SPAWN: ConfigWorkerSpawn = (executable, args, options) =>
  spawnChild(executable, [...args], options);

const DEFAULT_ADAPTER_FACTORY = (
  child: ChildProcess,
  identity: ConfigProcessIdentity,
): ConfigPublicationWorkerProcess => new NodeChildProcessAdapter(child, identity);

export class NodeConfigWorkerFactory implements ConfigPublicationWorkerFactory {
  private readonly owned = new Map<ConfigPublicationWorkerProcess, OwnedWorker>();
  private readonly identities = new Set<string>();
  private readonly exitListeners = new Set<ConfigWorkerExitListener>();
  private readonly heartbeat: MasterHeartbeatSender;
  private readonly spawnWorker: ConfigWorkerSpawn;
  private readonly adapterFactory: (
    child: ChildProcess,
    identity: ConfigProcessIdentity,
  ) => ConfigPublicationWorkerProcess;
  private readonly terminationScheduler: PublicationScheduler;

  constructor(private readonly options: NodeConfigWorkerFactoryOptions) {
    this.spawnWorker = options.spawn ?? DEFAULT_SPAWN;
    this.adapterFactory = options.adapterFactory ?? DEFAULT_ADAPTER_FACTORY;
    this.terminationScheduler = options.terminationScheduler ?? timeoutScheduler;
    this.heartbeat = new MasterHeartbeatSender({
      masterPid: options.masterPid,
      intervalMs: options.heartbeatIntervalMs,
      ...(options.heartbeatScheduler === undefined ? {} : { scheduler: options.heartbeatScheduler }),
    });
  }

  spawn(identity: ConfigProcessIdentity): ConfigPublicationWorkerProcess {
    const identityKey = JSON.stringify([
      identity.master_generation,
      identity.worker_instance_id,
      identity.worker_slot,
    ]);
    if (this.identities.has(identityKey)) {
      throw new NodeConfigWorkerFactoryError('duplicate_identity', 'config worker identity is already owned');
    }

    const child = this.spawnWorker(this.options.launch.executable, this.options.launch.args, {
      detached: false,
      shell: false,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: this.workerEnvironment(identity),
    });
    let process: ConfigPublicationWorkerProcess;
    try {
      process = this.adapterFactory(child, identity);
    } catch (error) {
      this.forceChild(child);
      throw error;
    }

    const owned: OwnedWorker = {
      process, identityKey, unsubscribeExit: () => undefined, unsubscribeDisconnect: () => undefined,
    };
    this.owned.set(process, owned);
    this.identities.add(identityKey);
    try {
      let disconnected = false;
      const onDisconnect = (): void => {
        if (disconnected) return;
        disconnected = true;
        bestEffort(() => this.options.onDisconnect?.(process));
      };
      child.on('disconnect', onDisconnect);
      owned.unsubscribeDisconnect = () => { child.off('disconnect', onDisconnect); };
      this.options.onSpawn?.(process);
      owned.unsubscribeExit = process.subscribeExit((evidence) => {
        if (evidence.pid !== process.pid || !this.release(process)) return;
        for (const listener of [...this.exitListeners]) {
          bestEffort(() => { listener(process, evidence); });
        }
      });
      this.heartbeat.start(process);
    } catch (error) {
      this.release(process);
      this.forceChild(child);
      throw error;
    }
    return process;
  }

  snapshot(): readonly ConfigPublicationWorkerProcess[] {
    return [...this.owned.keys()];
  }

  pids(): readonly number[] {
    return this.snapshot().map(({ pid }) => pid);
  }

  owns(process: ConfigPublicationWorkerProcess): boolean {
    return this.owned.has(process);
  }

  subscribeExit(listener: ConfigWorkerExitListener): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  async shutdownAll(): Promise<readonly ProcessCleanupResult[]> {
    const processes = this.snapshot();
    for (const process of processes) this.heartbeat.stop(process);
    return Promise.all(processes.map(async (process): Promise<ProcessCleanupResult> => ({
      process,
      ...await terminateWithEscalation(
        process,
        this.terminationScheduler,
        this.options.shutdownTimeoutMs,
        this.options.shutdownTimeoutMs,
      ),
    })));
  }

  private workerEnvironment(identity: ConfigProcessIdentity): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    for (const name of STRIPPED_ENV_NAMES) delete env[name];
    return {
      ...env,
      BUNGEE_ROLE: 'worker',
      [CONFIG_WORKER_ENV_NAMES.masterGeneration]: identity.master_generation,
      [CONFIG_WORKER_ENV_NAMES.workerInstanceId]: identity.worker_instance_id,
      [CONFIG_WORKER_ENV_NAMES.workerSlot]: String(identity.worker_slot),
      [CONFIG_WORKER_ENV_NAMES.masterPid]: String(this.options.masterPid),
      [CONFIG_WORKER_ENV_NAMES.heartbeatTimeoutMs]: String(this.options.heartbeatTimeoutMs),
      [CONFIG_WORKER_ENV_NAMES.shutdownTimeoutMs]: String(this.options.shutdownTimeoutMs),
      [CONFIG_WORKER_ENV_NAMES.transportSecret]: this.options.transportSecret,
      [CONFIG_WORKER_ENV_NAMES.accessLogDbPath]: this.options.accessLogDbPath,
    };
  }

  private release(process: ConfigPublicationWorkerProcess): boolean {
    const owned = this.owned.get(process);
    if (owned === undefined) return false;
    this.heartbeat.stop(process);
    this.owned.delete(process);
    this.identities.delete(owned.identityKey);
    bestEffort(owned.unsubscribeExit);
    bestEffort(owned.unsubscribeDisconnect);
    return true;
  }

  private forceChild(child: ChildProcess): void {
    child.once('error', () => undefined);
    bestEffort(() => { child.kill('SIGKILL'); });
  }
}
