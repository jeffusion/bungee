import type { RepositorySnapshot } from '../../src/config-storage';
import type {
  ConfigMasterMessage,
  ConfigProcessIdentity,
  ConfigPublicationWorkerProcess,
  ServingConfigWorker,
  StartupPublicationOutcome,
  WorkerExitEvidence,
} from '../../src/config-publication';
import {
  MasterRuntime,
  type MasterRuntimeIngressBootRecoveryGate,
  type MasterRuntimeWorkerExitListener,
} from '../../src/master-runtime/runtime';
import type { RecoveryTaskResult } from '../../src/master-runtime/publication-task-manager';
import { WorkerAdmissionRegistry } from '../../src/public-listener';
import type { MasterIngressStartupFailureDisposition } from '../../src/ingress/master-controller';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG_HASH = `sha256:${'b'.repeat(64)}` as const;
const STARTUP_DISPOSITION: MasterIngressStartupFailureDisposition = Object.freeze({
  kind: 'preserved', origin: null,
  evidence: Object.freeze({ registry: null, statusRefreshed: false, pendingAdmission: false, uncertainAdmission: false, pendingRetiredRelease: false, reason: 'unowned' }),
});
const SNAPSHOT: RepositorySnapshot = {
  revision: 4,
  content_hash: HASH,
  aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
};

class TestProcess implements ConfigPublicationWorkerProcess {
  readonly identity: ConfigProcessIdentity;

  constructor(readonly slot: number, readonly pid: number) {
    this.identity = {
      master_generation: '50000000-0000-4000-8000-000000000001',
      worker_instance_id: `60000000-0000-4000-8000-${String(pid).padStart(12, '0')}`,
      worker_slot: slot,
    };
  }

  async send(_message: ConfigMasterMessage): Promise<void> {}
  subscribeMessage(_listener: (message: unknown) => void): () => void { return () => undefined; }
  subscribeExit(_listener: (evidence: WorkerExitEvidence) => void): () => void { return () => undefined; }
  async terminate(_mode: 'graceful' | 'force'): Promise<void> {}
}

export function serving(slot: number, pid: number): ServingConfigWorker {
  return { process: new TestProcess(slot, pid), revision: 4, content_hash: HASH,
    plugin_catalog_hash: CATALOG_HASH, private_port: 4100 + slot, publication: null };
}

class TestPool {
  readonly owned = new Set<ConfigPublicationWorkerProcess>();
  readonly listeners = new Set<MasterRuntimeWorkerExitListener>();
  readonly unavailableListeners = new Set<(process: ConfigPublicationWorkerProcess, evidence: { readonly kind: 'unavailable'; readonly pid: number }) => void>();
  unsubscribeCount = 0;
  shutdownCount = 0;

  add(worker: ServingConfigWorker): void { this.owned.add(worker.process); }
  owns(process: ConfigPublicationWorkerProcess): boolean { return this.owned.has(process); }
  pids(): readonly number[] { return [...this.owned].map(({ pid }) => pid); }
  subscribeExit(listener: MasterRuntimeWorkerExitListener): () => void {
    this.listeners.add(listener);
    return () => { if (this.listeners.delete(listener)) this.unsubscribeCount += 1; };
  }

  subscribeUnavailable(listener: (process: ConfigPublicationWorkerProcess, evidence: { readonly kind: 'unavailable'; readonly pid: number }) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => { this.unavailableListeners.delete(listener); };
  }
  disconnectAll(): void {}
  markCommitted(): void {}
  exit(worker: ServingConfigWorker): void {
    if (!this.owned.delete(worker.process)) return;
    const evidence = { exited: true, pid: worker.process.pid } as const;
    for (const listener of [...this.listeners]) listener(worker.process, evidence);
  }
  unavailable(worker: ServingConfigWorker): void {
    const evidence = { kind: 'unavailable' as const, pid: worker.process.pid };
    for (const listener of [...this.unavailableListeners]) listener(worker.process, evidence);
  }
  async shutdownAll() {
    this.shutdownCount += 1;
    const processes = [...this.owned];
    this.owned.clear();
    return processes.map((process) => ({ process, exitEvidence: { exited: true as const, pid: process.pid } }));
  }
}

type RecoveryGateFixture = MasterRuntimeIngressBootRecoveryGate & {
  readonly listeners: Set<() => void>;
  readonly releaseCount: number;
  activate(): number;
  release(generation?: number): void;
};

function recoveryGateFixture(): RecoveryGateFixture {
  let generation = 0;
  let active = false;
  let controller = new AbortController();
  const listeners = new Set<() => void>();
  let releaseCount = 0;
  return {
    get generation() { return generation; },
    isCurrent(candidate) { return active && candidate === generation; },
    get signal() { return controller.signal; },
    subscribeReleased(candidate, listener) {
      if (candidate !== 0 && candidate !== generation) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() {
      generation += 1;
      active = true;
      controller.abort('generation changed');
      controller = new AbortController();
      return generation;
    },
    release(candidate = generation) {
      if (!active || candidate !== generation) return;
      active = false;
      releaseCount += 1;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* gate release isolates listeners */ }
      }
    },
    get listeners() { return listeners; },
    get releaseCount() { return releaseCount; },
  };
}

export type RepairContext = {
  readonly round: number;
  readonly survivors: readonly ServingConfigWorker[];
  readonly generation?: number;
  readonly signal?: AbortSignal;
};

export function supervisionFixture(
  onFatal?: (error: Error) => void | Promise<void>,
  options: { readonly recoveryGate?: boolean } = {},
) {
  const admission = new WorkerAdmissionRegistry();
  const pool = new TestPool();
  const initial = [serving(0, 7000), serving(1, 7001)] as const;
  for (const worker of initial) pool.add(worker);
  const repairCalls: (readonly ServingConfigWorker[])[] = [];
  let nextPid = 7100;
  const replace = async ({ survivors }: RepairContext): Promise<StartupPublicationOutcome> => {
    const replacement = [0, 1].map((slot) => survivors.find(({ process }) => process.slot === slot)
      ?? serving(slot, nextPid++));
    for (const worker of replacement) pool.add(worker);
    await (await admission.prepare(replacement)).commit();
    return { kind: 'startup_ready', serving: replacement };
  };
  let repair = replace;
  let onListenerStart = (): void => undefined;
  let startCalls = 0;
  let port: number | null = null;
  let publicationFatal = (_error: Error): void => undefined;
  let enqueueRecovery: (task: () => Promise<RecoveryTaskResult>) => Promise<RecoveryTaskResult> = (task) => task();
  let beforeCleanup: (() => void | Promise<void>) | undefined;
  const gate = options.recoveryGate === true ? recoveryGateFixture() : undefined;
  const runtime = new MasterRuntime({
    workerCount: 2,
    expectedPluginCatalogHash: CATALOG_HASH,
    repository: { getSnapshot: () => SNAPSHOT, close: () => undefined },
    coordinator: {
      async recoverAndPublish() { return null; },
      async startCurrent(_snapshot, survivors = [], _retireWorkers, signal) {
        startCalls += 1;
        if (startCalls === 1) {
          await (await admission.prepare(initial)).commit();
          return { kind: 'startup_ready', serving: initial };
        }
        repairCalls.push(survivors);
        return repair({ round: startCalls - 1, survivors, generation: gate?.generation ?? 0, signal });
      },
    },
    publicationTasks: {
      enqueue() {},
      async enqueueRecovery(task) { return enqueueRecovery(task); },
      setFatalHandler(handler) { publicationFatal = handler; },
      async stop() {},
    },
    admission,
    publicListener: {
      get port() { return port; },
      start() { port = 8088; onListenerStart(); },
      async stop() { port = null; },
    },
    workerPool: pool,
    onWorkerUnavailable() {},
    instanceLock: { async release() {} },
    ...(gate === undefined ? {} : { ingressBootRecoveryGate: gate }),
    ancillary: { beforeCleanup: () => beforeCleanup?.(), cleanupAfterStartupFailure() { return STARTUP_DISPOSITION; }, closeForNormalShutdown() {} },
    ...(onFatal === undefined ? {} : { onFatal }),
  });
  return {
    admission, initial, pool, repairCalls, runtime,
    replace,
    setRepair(next: typeof repair) { repair = next; },
    setListenerStart(next: () => void) { onListenerStart = next; },
    failPublication(error: Error) { publicationFatal(error); },
    gate,
    setRecoveryEnqueue(next: typeof enqueueRecovery) { enqueueRecovery = next; },
    setBeforeCleanup(next: () => void | Promise<void>) { beforeCleanup = next; },
  };
}

export async function settle(): Promise<void> {
  for (let step = 0; step < 100; step += 1) await Promise.resolve();
}
