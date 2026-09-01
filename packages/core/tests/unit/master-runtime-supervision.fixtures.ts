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
  type MasterRuntimeWorkerExitListener,
} from '../../src/master-runtime/runtime';
import { WorkerAdmissionRegistry } from '../../src/public-listener';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG_HASH = `sha256:${'b'.repeat(64)}` as const;
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
  unsubscribeCount = 0;
  shutdownCount = 0;

  add(worker: ServingConfigWorker): void { this.owned.add(worker.process); }
  owns(process: ConfigPublicationWorkerProcess): boolean { return this.owned.has(process); }
  pids(): readonly number[] { return [...this.owned].map(({ pid }) => pid); }
  subscribeExit(listener: MasterRuntimeWorkerExitListener): () => void {
    this.listeners.add(listener);
    return () => { if (this.listeners.delete(listener)) this.unsubscribeCount += 1; };
  }
  exit(worker: ServingConfigWorker): void {
    if (!this.owned.delete(worker.process)) return;
    const evidence = { exited: true, pid: worker.process.pid } as const;
    for (const listener of [...this.listeners]) listener(worker.process, evidence);
  }
  async shutdownAll() {
    this.shutdownCount += 1;
    const processes = [...this.owned];
    this.owned.clear();
    return processes.map((process) => ({ process, exitEvidence: { exited: true as const, pid: process.pid } }));
  }
}

export type RepairContext = {
  readonly round: number;
  readonly survivors: readonly ServingConfigWorker[];
};

export function supervisionFixture(onFatal?: (error: Error) => void | Promise<void>) {
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
    admission.prepare(replacement).commit();
    return { kind: 'startup_ready', serving: replacement };
  };
  let repair = replace;
  let onListenerStart = (): void => undefined;
  let startCalls = 0;
  let port: number | null = null;
  let publicationFatal = (_error: Error): void => undefined;
  const runtime = new MasterRuntime({
    workerCount: 2,
    repository: { getSnapshot: () => SNAPSHOT, close: () => undefined },
    coordinator: {
      async recoverAndPublish() { return null; },
      async startCurrent(_snapshot, survivors = []) {
        startCalls += 1;
        if (startCalls === 1) {
          admission.prepare(initial).commit();
          return { kind: 'startup_ready', serving: initial };
        }
        repairCalls.push(survivors);
        return repair({ round: startCalls - 1, survivors });
      },
    },
    publicationTasks: { enqueue() {}, setFatalHandler(handler) { publicationFatal = handler; }, async stop() {} },
    admission,
    publicListener: {
      get port() { return port; },
      start() { port = 8088; onListenerStart(); },
      async stop() { port = null; },
    },
    workerPool: pool,
    instanceLock: { async release() {} },
    ...(onFatal === undefined ? {} : { onFatal }),
  });
  return {
    admission, initial, pool, repairCalls, runtime,
    replace,
    setRepair(next: typeof repair) { repair = next; },
    setListenerStart(next: () => void) { onListenerStart = next; },
    failPublication(error: Error) { publicationFatal(error); },
  };
}

export async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}
