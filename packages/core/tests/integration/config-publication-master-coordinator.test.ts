import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import { ConfigRepository } from '../../src/config-storage';
import {
  MasterConfigPublicationCoordinator as BaseMasterConfigPublicationCoordinator,
  type MasterConfigPublicationCoordinatorOptions,
  type ConfigPublicationWorkerProcess,
  type ConfigPublicationWorkerFactory,
  MasterConfigPublicationError,
  type ConfigPublicationRepository,
  type PublicationScheduler,
  type PreparedWorkerAdmission,
  type ScheduledTimeout,
  type ServingConfigWorker,
  type WorkerAdmissionController,
  type WorkerExitEvidence,
  WorkerAdmissionRegistry,
} from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity, ConfigPublicationIdentity } from '../../src/config-publication/messages';

const CREATED_AT = 1_700_000_000_000;
const MASTER_GENERATION = '10000000-0000-4000-8000-000000000001';
const PLUGIN_CATALOG_HASH: Sha256Digest = `sha256:${'c'.repeat(64)}`;
const OTHER_PLUGIN_CATALOG_HASH: Sha256Digest = `sha256:${'d'.repeat(64)}`;
let nextInstance = 1;
const createWorkerInstanceId = (): string =>
  `20000000-0000-4000-8000-${String(nextInstance++).padStart(12, '0')}`;
const AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: true, tokens: ['literal'] }, services: [], routes: [], plugins: [],
  },
  plugin_activations: [],
};
const SETUP_AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
};
const roots: string[] = [];
const repositories: ConfigRepository[] = [];

type MessageListener = (message: unknown) => void;
type ExitListener = (evidence: WorkerExitEvidence) => void;

class FakeWorker implements ConfigPublicationWorkerProcess {
  readonly sent: ConfigMasterMessage[] = [];
  readonly events: string[];
  readonly messageListeners = new Set<MessageListener>();
  readonly exitListeners = new Set<ExitListener>();
  private exitEvidence: WorkerExitEvidence | null = null;
  private readonly processIdentity: ConfigProcessIdentity;

  constructor(
    readonly slot: number,
    readonly pid: number,
    events: string[],
    public terminateExits = true,
    identity?: ConfigProcessIdentity,
  ) {
    this.events = events;
    this.processIdentity = identity ?? {
      master_generation: MASTER_GENERATION,
      worker_instance_id: `30000000-0000-4000-8000-${String(pid).padStart(12, '0')}`,
      worker_slot: slot,
    };
  }

  get identity(): ConfigProcessIdentity {
    if (this.identityReadError !== null) throw this.identityReadError;
    return this.processIdentity;
  }

  async send(message: ConfigMasterMessage): Promise<void> {
    if (this.sendError !== null) throw this.sendError;
    if (this.sendNeverSettles) return await new Promise<void>(() => undefined);
    this.sent.push(message);
    this.events.push(`send:${this.pid}:${'command' in message ? message.command : message.status}`);
  }

  subscribeMessage(listener: MessageListener): () => void {
    if (this.messageSubscribeFailures > 0) {
      this.messageSubscribeFailures -= 1;
      throw new Error('injected message subscription failure');
    }
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
      if (this.messageUnsubscribeFails) throw new Error('injected message unsubscribe failure');
    };
  }

  subscribeExit(listener: ExitListener): () => void {
    if (this.exitSubscribeFailures > 0) {
      this.exitSubscribeFailures -= 1;
      throw new Error('injected exit subscription failure');
    }
    this.exitListeners.add(listener);
    if (this.exitEvidence !== null) listener(this.exitEvidence);
    return () => {
      this.exitListeners.delete(listener);
      if (this.exitUnsubscribeFails) throw new Error('injected exit unsubscribe failure');
    };
  }

  async terminate(mode: 'graceful' | 'force'): Promise<void> {
    if (this.terminationError !== null) throw this.terminationError;
    this.events.push(`terminate:${this.pid}:${mode}`);
    if (this.terminateExits) this.exit();
    if (this.terminationErrorAfterExit !== null) throw this.terminationErrorAfterExit;
  }

  sendError: Error | null = null;
  sendNeverSettles = false;
  terminationError: Error | null = null;
  terminationErrorAfterExit: Error | null = null;
  messageSubscribeFailures = 0;
  exitSubscribeFailures = 0;
  messageUnsubscribeFails = false;
  exitUnsubscribeFails = false;
  identityReadError: Error | null = null;

  emit(message: unknown): void {
    const identified = typeof message === 'object' && message !== null
      ? { ...this.identity, ...message }
      : message;
    for (const listener of this.messageListeners) listener(identified);
  }

  exit(): void {
    if (this.exitEvidence !== null) return;
    const evidence = { exited: true as const, pid: this.pid };
    this.exitEvidence = evidence;
    for (const listener of this.exitListeners) listener(evidence);
  }

  emitExitPid(pid: number): void {
    for (const listener of this.exitListeners) listener({ exited: true, pid });
  }
}

class ManualScheduler implements PublicationScheduler {
  private readonly pending = new Set<() => void>();
  scheduleFailures = 0;
  cancelFails = false;

  schedule(_delayMs: number, callback: () => void): ScheduledTimeout {
    if (this.scheduleFailures > 0) {
      this.scheduleFailures -= 1;
      throw new Error('injected schedule failure');
    }
    this.pending.add(callback);
    return { cancel: () => {
      this.pending.delete(callback);
      if (this.cancelFails) throw new Error('injected cancel failure');
    } };
  }

  fireAll(): void {
    const callbacks = [...this.pending];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }

  get size(): number { return this.pending.size; }
}

class SynchronousScheduler implements PublicationScheduler {
  active = 0;

  schedule(_delayMs: number, callback: () => void): ScheduledTimeout {
    this.active += 1;
    callback();
    return { cancel: () => { this.active -= 1; } };
  }
}

class FakeFactory implements ConfigPublicationWorkerFactory {
  readonly workers: FakeWorker[] = [];
  private nextPid = 100;

  failAtSpawn: number | null = null;

  constructor(private readonly events: string[]) {}

  spawn(identity: ConfigProcessIdentity): FakeWorker {
    if (this.failAtSpawn === this.workers.length + 1) throw new Error('injected spawn failure');
    const worker = new FakeWorker(identity.worker_slot, this.nextPid, this.events, true, identity);
    this.nextPid += 1;
    this.workers.push(worker);
    return worker;
  }
}

class FaultRepository implements ConfigPublicationRepository {
  beginAttemptFailureAt: number | null = null;
  recordFailureAt: number | null = null;
  markDrainingError: Error | null = null;
  finalizeError: Error | null = null;
  private beginAttemptCalls = 0;
  private drainingRecoveryCalls = 0;
  private recordCalls = 0;

  constructor(private readonly repository: ConfigRepository, private readonly events: string[] = []) {}

  getSnapshot(): ReturnType<ConfigRepository['getSnapshot']> { return this.repository.getSnapshot(); }
  getActivePublication(): ReturnType<ConfigRepository['getActivePublication']> {
    return this.repository.getActivePublication();
  }
  beginPublication(...parameters: Parameters<ConfigRepository['beginPublication']>): ReturnType<ConfigRepository['beginPublication']> {
    return this.repository.beginPublication(...parameters);
  }
  beginWorkerAttempt(...parameters: Parameters<ConfigRepository['beginWorkerAttempt']>): ReturnType<ConfigRepository['beginWorkerAttempt']> {
    this.beginAttemptCalls += 1;
    if (this.beginAttemptFailureAt === this.beginAttemptCalls) throw new Error('injected attempt failure');
    return this.repository.beginWorkerAttempt(...parameters);
  }
  beginDrainingRecovery(...parameters: Parameters<ConfigRepository['beginDrainingRecovery']>): ReturnType<ConfigRepository['beginDrainingRecovery']> {
    this.drainingRecoveryCalls += 1;
    return this.repository.beginDrainingRecovery(...parameters);
  }
  recordWorkerResult(...parameters: Parameters<ConfigRepository['recordWorkerResult']>): ReturnType<ConfigRepository['recordWorkerResult']> {
    this.recordCalls += 1;
    if (this.recordFailureAt === this.recordCalls) throw new Error('injected record failure');
    return this.repository.recordWorkerResult(...parameters);
  }
  markDraining(...parameters: Parameters<ConfigRepository['markDraining']>): ReturnType<ConfigRepository['markDraining']> {
    this.events.push('markDraining');
    if (this.markDrainingError !== null) throw this.markDrainingError;
    return this.repository.markDraining(...parameters);
  }
  finalizePublication(...parameters: Parameters<ConfigRepository['finalizePublication']>): ReturnType<ConfigRepository['finalizePublication']> {
    if (this.finalizeError !== null) throw this.finalizeError;
    return this.repository.finalizePublication(...parameters);
  }

  get beginDrainingRecoveryCalls(): number { return this.drainingRecoveryCalls; }
}

class FakeAdmissionController implements WorkerAdmissionController {
  readonly registry = new WorkerAdmissionRegistry();
  prepareError: Error | null = null;
  afterCommit: (() => void) | null = null;

  constructor(private readonly events: string[] = []) {}

  prepare(workers: readonly ServingConfigWorker[]): PreparedWorkerAdmission {
    this.events.push('prepare');
    if (this.prepareError !== null) throw this.prepareError;
    const prepared = this.registry.prepare(workers);
    return Object.freeze({
      commit: (): void => {
        this.events.push('commit');
        prepared.commit();
        this.afterCommit?.();
      },
    });
  }
}

function openRepository(): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-master-publication-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'));
  repositories.push(repository);
  return { repository, dbPath: join(root, 'config.db') };
}

function reopen(repository: ConfigRepository, dbPath: string): ConfigRepository {
  repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
  const reopened = ConfigRepository.open(dbPath);
  repositories.push(reopened);
  return reopened;
}

function commit(repository: ConfigRepository, mutationId: string, slots: readonly number[]): void {
  expect(repository.commit({
    mutation_id: mutationId,
    expected_revision: 1,
    aggregate: AGGREGATE,
    kind: 'config',
    created_at: CREATED_AT,
    target_worker_slots: slots,
  }).kind).toBe('committed');
}

function publicationReady(worker: FakeWorker, publication: ConfigPublicationIdentity, revision: number, hash: Sha256Digest): void {
  worker.events.push(`ready:${worker.pid}`);
  worker.emit({
    status: 'config-ready', worker_slot: worker.slot, pid: worker.pid, revision,
    content_hash: hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
    private_port: 41_000 + worker.slot, plugin_runtime_generation: 0,
    required_plugins: [], serving_plugins: [],
    publication,
  });
}

const PROCESS_OPTIONS = {
  masterGeneration: MASTER_GENERATION,
  createWorkerInstanceId,
  pluginCatalogHash: PLUGIN_CATALOG_HASH,
};

class MasterConfigPublicationCoordinator extends BaseMasterConfigPublicationCoordinator {
  constructor(options: Omit<MasterConfigPublicationCoordinatorOptions, 'pluginCatalogHash' | 'admission'> & {
    readonly admission?: WorkerAdmissionController;
  }) {
    super({ admission: options.admission ?? new WorkerAdmissionRegistry(), ...PROCESS_OPTIONS, ...options });
  }
}

function serving(worker: FakeWorker, revision: number, contentHash: Sha256Digest): ServingConfigWorker {
  return { process: worker, revision, content_hash: contentHash,
    plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41_000 + worker.slot, publication: null };
}

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

async function fireSchedulerRounds(scheduler: ManualScheduler, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await flushMicrotasks();
    scheduler.fireAll();
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MasterConfigPublicationCoordinator', () => {
  test('starts a later setup revision with the exact current message shape', async () => {
    // Given
    const { repository } = openRepository();
    const committed = repository.commit({
      mutation_id: 'setup-current', expected_revision: 1, aggregate: SETUP_AGGREGATE,
      kind: 'config', created_at: CREATED_AT, target_worker_slots: [0],
    });
    expect(committed.kind).toBe('committed');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const snapshot = repository.getSnapshot();

    // When
    const pending = coordinator.startCurrent(snapshot);
    const worker = factory.workers[0];
    if (worker === undefined) throw new Error('current worker missing');
    worker.emit({
      status: 'config-ready', worker_slot: 0, pid: worker.pid,
      revision: snapshot.revision, content_hash: snapshot.content_hash,
      plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41_000,
      plugin_runtime_generation: 0, required_plugins: [], serving_plugins: [], publication: null,
    });
    const outcome = await pending;

    // Then
    expect(outcome.kind).toBe('startup_ready');
    expect(snapshot).toMatchObject({ revision: 2 });
    expect(worker.sent[0]).toEqual({
      command: 'start-current-config-worker',
      ...worker.identity,
      revision: 2,
      content_hash: snapshot.content_hash,
      plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      aggregate: snapshot.aggregate,
      activated_plugin_names: [],
      publication: null,
    });
  });

  test('starts current revision without creating a durable operation', async () => {
    // Given
    const { repository } = openRepository();
    const events: string[] = [];
    const factory = new FakeFactory(events);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 },
      startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(repository.getSnapshot());
    for (const worker of factory.workers) {
      const snapshot = repository.getSnapshot();
      worker.emit({
        status: 'config-ready', worker_slot: worker.slot, pid: worker.pid,
        revision: snapshot.revision, content_hash: snapshot.content_hash,
        plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41_000 + worker.slot,
        plugin_runtime_generation: 0, required_plugins: [], serving_plugins: [], publication: null,
      });
    }
    const outcome = await pending;

    // Then
    expect(outcome.kind).toBe('startup_ready');
    expect(outcome.serving.map(({ process }) => process.slot)).toEqual([0, 1]);
    expect(outcome.serving.map(({ plugin_catalog_hash, private_port }) =>
      [plugin_catalog_hash, private_port])).toEqual([
      [PLUGIN_CATALOG_HASH, 41_000], [PLUGIN_CATALOG_HASH, 41_001],
    ]);
    expect(factory.workers.every(({ sent }) => sent[0] !== undefined
      && 'plugin_catalog_hash' in sent[0]
      && sent[0].plugin_catalog_hash === PLUGIN_CATALOG_HASH
      && 'activated_plugin_names' in sent[0]
      && sent[0].activated_plugin_names.join(',') === repository.getSnapshot().aggregate.plugin_activations
        .map(({ plugin_name }) => plugin_name).join(','))).toBeTrue();
    expect(repository.getActivePublication()).toBeNull();
    expect(factory.workers.every(({ messageListeners, exitListeners }) =>
      messageListeners.size === 0 && exitListeners.size === 0)).toBeTrue();
  });

  test('commits the exact ready current set before reporting startup ready', async () => {
    // Given
    const { repository } = openRepository();
    const events: string[] = [];
    const admission = new FakeAdmissionController(events);
    const factory = new FakeFactory(events);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(repository.getSnapshot());
    const worker = factory.workers[0];
    if (worker === undefined) throw new Error('current worker missing');
    worker.events.push(`ready:${worker.pid}`);
    worker.emit({ status: 'config-ready', pid: worker.pid, revision: 1,
      content_hash: repository.getSnapshot().content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_000, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const outcome = await pending;

    // Then
    expect(outcome.kind).toBe('startup_ready');
    expect(events.filter((event) => event === 'prepare' || event === 'commit' || event.startsWith('ready:')))
      .toEqual([`ready:${worker.pid}`, 'prepare', 'commit']);
    expect(admission.registry.select()?.process).toBe(worker);
  });

  test('cleans newly ready current workers and preserves existing admission when prepare fails', async () => {
    // Given
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const events: string[] = [];
    const existing = new FakeWorker(0, 40, events);
    const existingEvidence = serving(existing, 1, snapshot.content_hash);
    const admission = new FakeAdmissionController(events);
    admission.registry.prepare([existingEvidence]).commit();
    admission.prepareError = new Error('injected startup prepare failure');
    const factory = new FakeFactory(events);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(snapshot, [existingEvidence]);
    await flushMicrotasks();
    existing.emit({ status: 'config-ready', pid: existing.pid, revision: 1,
      content_hash: snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_000, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const spawned = factory.workers[0];
    if (spawned === undefined) throw new Error('current replacement missing');
    spawned.emit({ status: 'config-ready', pid: spawned.pid, revision: 1,
      content_hash: snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_001, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_outcome_unknown', code: 'startup_failure' });
    expect(admission.registry.select()?.process).toBe(existing);
    expect(spawned.events).toContain(`terminate:${spawned.pid}:graceful`);
    expect(existing.events.some((event) => event.startsWith(`terminate:${existing.pid}:`))).toBeFalse();
  });

  test('fails current startup on timeout and cleans every new worker listener and timer', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(repository.getSnapshot());
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_failed', serving: [] });
    expect(repository.getActivePublication()).toBeNull();
    expect(factory.workers.every(({ messageListeners, exitListeners }) =>
      messageListeners.size === 0 && exitListeners.size === 0)).toBeTrue();
    expect(scheduler.size).toBe(0);
  });

  test('repairs a missing slot around a published admitted survivor without restarting it', async () => {
    // Given
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const existing = new FakeWorker(0, 10, []);
    const admission = new WorkerAdmissionRegistry();
    const existingEvidence = {
      ...serving(existing, 1, snapshot.content_hash),
      publication: { mutation_id: 'published-survivor', attempt_no: 1, drain_recovery_generation: 0 },
    } satisfies ServingConfigWorker;
    admission.prepare([existingEvidence]).commit();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(snapshot, [existingEvidence]);
    await flushMicrotasks();
    const spawned = factory.workers[0];
    if (spawned === undefined) throw new Error('missing current worker was not spawned');
    spawned.emit({ status: 'config-ready', worker_slot: 1, pid: spawned.pid, revision: 1,
      content_hash: snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_001, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const outcome = await pending;

    // Then
    expect(factory.workers).toHaveLength(1);
    expect(existing.sent).toEqual([]);
    expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10, 100]);
    expect(admission.snapshot().map(({ process }) => process.pid)).toEqual([10, 100]);
  });

  test('rejects wrong-generation existing workers before repairing current capacity', async () => {
    // Given
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      ...PROCESS_OPTIONS,
    });

    // When
    const stale = new FakeWorker(0, 11, [], true, {
      master_generation: 'f0000000-0000-4000-8000-000000000001',
      worker_instance_id: '30000000-0000-4000-8000-000000000011',
      worker_slot: 0,
    });
    const staleCall = coordinator.startCurrent(snapshot, [serving(stale, 1, snapshot.content_hash)]);

    // Then
    expect(staleCall).rejects.toMatchObject({ code: 'invalid_options' });
    expect(factory.workers).toEqual([]);
  });

  test('rejects duplicate generated instance ids before publication factory effects', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'duplicate-generated-instance', [0, 1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const duplicate = '70000000-0000-4000-8000-000000000001';
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      masterGeneration: MASTER_GENERATION, createWorkerInstanceId: () => duplicate,
    });

    // When
    const pending = coordinator.publish(active, []);
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(factory.workers).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true });
  });

  test('rejects malformed generated instance ids before publication factory effects', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'malformed-generated-instance', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      masterGeneration: MASTER_GENERATION,
      createWorkerInstanceId: () => '70000000-0000-4000-8000-00000000000A',
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(factory.workers).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'repository_failure' });
  });

  test('rejects replacement PID or instance conflicts before draining old workers', async () => {
    // Given / When / Then
    for (const conflict of ['pid', 'instance'] as const) {
      const { repository } = openRepository();
      commit(repository, `replacement-${conflict}-conflict`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const old = new FakeWorker(0, 100, []);
      const spawnedEvents: string[] = [];
      const factory = new FakeFactory([]);
      factory.spawn = (identity): FakeWorker => {
        const spawnedIdentity = conflict === 'instance'
          ? { ...identity, worker_instance_id: old.identity.worker_instance_id }
          : identity;
        const worker = new FakeWorker(identity.worker_slot,
          conflict === 'pid' ? old.pid : 101, spawnedEvents, true, spawnedIdentity);
        factory.workers.push(worker);
        return worker;
      };
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });

      const outcome = await coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);

      expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
        code: 'repository_failure' });
      expect(old.sent).toEqual([]);
      expect(spawnedEvents).toEqual([]);
    }
  });

  test('rejects a replacement that reuses the old process object without terminating it', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'replacement-reference-conflict', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const old = new FakeWorker(0, 55, []);
    const factory = new FakeFactory([]);
    factory.spawn = (): FakeWorker => old;
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'repository_failure' });
    expect(old.sent).toEqual([]);
    expect(old.events).toEqual([]);
  });

  test('does not signal a current-startup process whose PID conflicts with an existing worker', async () => {
    // Given
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const existing = new FakeWorker(0, 70, []);
    const spawnedEvents: string[] = [];
    const factory = new FakeFactory([]);
    factory.spawn = (identity): FakeWorker => {
      const worker = new FakeWorker(identity.worker_slot, existing.pid, spawnedEvents, true, identity);
      factory.workers.push(worker);
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.startCurrent(snapshot, [serving(existing, 1, snapshot.content_hash)]);

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_outcome_unknown', serving: [
      expect.objectContaining({ process: existing }),
    ] });
    expect(existing.events).toEqual([]);
    expect(spawnedEvents).toEqual([]);
  });

  test('does not signal a later replacement whose PID conflicts with a prior replacement', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'prior-replacement-pid-conflict', [0, 1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const factory = new FakeFactory([]);
    factory.spawn = (identity): FakeWorker => {
      const events = identity.worker_slot === 0 ? firstEvents : secondEvents;
      const worker = new FakeWorker(identity.worker_slot, 80, events, true, identity);
      factory.workers.push(worker);
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'repository_failure', serving: [] });
    expect(firstEvents).toContain('terminate:80:graceful');
    expect(secondEvents).toEqual([]);
  });

  test('rejects an instance id reused by a later publication attempt', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const duplicate = '70000000-0000-4000-8000-000000000002';
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      masterGeneration: MASTER_GENERATION, createWorkerInstanceId: () => duplicate,
    });
    const startup = coordinator.startCurrent(repository.getSnapshot());
    const current = factory.workers[0];
    if (current === undefined) throw new Error('current worker missing');
    current.emit({ status: 'config-ready', pid: current.pid, revision: 1,
      content_hash: repository.getSnapshot().content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_000, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const startupOutcome = await startup;
    if (startupOutcome.kind !== 'startup_ready') throw new Error('startup must be ready');
    commit(repository, 'later-duplicate-instance', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');

    // When
    const pending = coordinator.publish(active, startupOutcome.serving);
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(factory.workers).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true });
  });

  test('rejects malformed old process sets before spawning replacements', async () => {
    // Given / When / Then
    for (const malformed of ['pid', 'generation', 'duplicate-reference'] as const) {
      const { repository } = openRepository();
      commit(repository, `invalid-old-${malformed}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const scheduler = new ManualScheduler();
      const factory = new FakeFactory([]);
      const identity = malformed === 'generation'
        ? { master_generation: 'f0000000-0000-4000-8000-000000000001',
          worker_instance_id: '30000000-0000-4000-8000-000000000001', worker_slot: 0 }
        : undefined;
      const old = new FakeWorker(0, malformed === 'pid' ? 0 : 10, [], true, identity);
      const oldWorkers = malformed === 'duplicate-reference'
        ? [serving(old, 1, active.snapshot.content_hash), serving(old, 1, active.snapshot.content_hash)]
        : [serving(old, 1, active.snapshot.content_hash)];
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1, scheduler,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
        ...PROCESS_OPTIONS,
      });

      const pending = coordinator.publish(active, oldWorkers);
      expect(pending).rejects.toMatchObject({ code: 'invalid_options' });

      expect(factory.workers).toEqual([]);
      expect(old.sent).toEqual([]);
    }
  });

  test('rejects distinct old workers with duplicate slot PID or instance', async () => {
    // Given / When / Then
    for (const duplicate of ['slot', 'pid', 'instance'] as const) {
      const { repository } = openRepository();
      commit(repository, `duplicate-old-${duplicate}`, [0, 1]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const sharedInstance = '30000000-0000-4000-8000-000000000099';
      const first = new FakeWorker(0, 10, [], true, {
        master_generation: MASTER_GENERATION,
        worker_instance_id: duplicate === 'instance' ? sharedInstance : '30000000-0000-4000-8000-000000000010',
        worker_slot: 0,
      });
      const secondSlot = duplicate === 'slot' ? 0 : 1;
      const second = new FakeWorker(secondSlot, duplicate === 'pid' ? 10 : 11, [], true, {
        master_generation: MASTER_GENERATION,
        worker_instance_id: duplicate === 'instance' ? sharedInstance : '30000000-0000-4000-8000-000000000011',
        worker_slot: secondSlot,
      });
      const factory = new FakeFactory([]);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 2,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });

      const pending = coordinator.publish(active, [
        serving(first, 1, active.snapshot.content_hash),
        serving(second, 1, active.snapshot.content_hash),
      ]);

      expect(pending).rejects.toMatchObject({ code: 'invalid_options' });
      expect(factory.workers).toEqual([]);
    }
  });

  test('marks draining before draining old workers and finalizes only after exit proof', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'normal-publication', [0, 1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const factory = new FakeFactory(events);
    const oldZero = new FakeWorker(0, 10, events);
    const oldOne = new FakeWorker(1, 11, events);
    const oldWorkers = [
      serving(oldZero, 1, repository.getSnapshot().content_hash),
      serving(oldOne, 1, repository.getSnapshot().content_hash),
    ];
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 },
      startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, oldWorkers);
    await flushMicrotasks();
    const publishing = repository.getActivePublication();
    expect(publishing?.operation.state).toBe('publishing');
    for (const worker of factory.workers) {
      const target = repository.getActivePublication()?.targets.find(({ worker_slot }) => worker_slot === worker.slot);
      if (target === undefined) throw new Error('target missing');
      publicationReady(worker, {
        mutation_id: active.operation.mutation_id,
        attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation,
      }, active.snapshot.revision, active.snapshot.content_hash);
    }
    await flushMicrotasks();
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
    for (const old of [oldZero, oldOne]) {
    old.emit({ status: 'worker-drained', worker_slot: old.slot, pid: old.pid, revision: 1,
      content_hash: active.snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      publication: null });
    }
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(repository.getOperation('normal-publication')).toMatchObject({ state: 'converged', result_status: 200 });
    expect(factory.workers.every(({ sent }) => sent[0] !== undefined
      && 'activated_plugin_names' in sent[0]
      && sent[0].activated_plugin_names.join(',') === active.snapshot.aggregate.plugin_activations
        .map(({ plugin_name }) => plugin_name).join(','))).toBeTrue();
    expect(events.indexOf('send:10:drain-worker')).toBeGreaterThan(events.indexOf('send:101:start-config-worker'));
    expect(events).toContain('terminate:10:graceful');
    expect(events).toContain('terminate:11:graceful');
  });

  test('switches admission between durable draining mark and the first old-worker drain command', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'atomic-admission-order', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const admission = new FakeAdmissionController(events);
    const faultRepository = new FaultRepository(repository, events);
    const factory = new FakeFactory(events);
    const old = new FakeWorker(0, 10, events);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: faultRepository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const replacement = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (replacement === undefined || target === undefined) throw new Error('replacement missing');
    publicationReady(replacement, { mutation_id: 'atomic-admission-order', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    await flushMicrotasks();
    old.emit({ status: 'worker-drained', pid: old.pid, revision: 1,
      content_hash: active.snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: null });
    await pending;

    // Then
    expect(events.filter((event) => event.startsWith('ready:') || event === 'prepare'
      || event === 'markDraining' || event === 'commit' || event === 'send:10:drain-worker'))
      .toEqual([`ready:${replacement.pid}`, 'prepare', 'markDraining', 'commit', 'send:10:drain-worker']);
  });

  test('keeps old admission when prepare or markDraining fails before commit', async () => {
    // Given / When / Then
    for (const failurePoint of ['prepare', 'markDraining'] as const) {
      const { repository } = openRepository();
      commit(repository, `precommit-${failurePoint}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const events: string[] = [];
      const old = new FakeWorker(0, failurePoint === 'prepare' ? 20 : 21, events);
      const oldEvidence = serving(old, 1, active.snapshot.content_hash);
      const admission = new FakeAdmissionController(events);
      admission.registry.prepare([oldEvidence]).commit();
      if (failurePoint === 'prepare') admission.prepareError = new Error('injected prepare failure');
      const faultRepository = new FaultRepository(repository, events);
      if (failurePoint === 'markDraining') faultRepository.markDrainingError = new Error('injected mark failure');
      const factory = new FakeFactory(events);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository: faultRepository, workerFactory: factory, workerCount: 1, admission,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      const pending = coordinator.publish(active, [oldEvidence]);
      await flushMicrotasks();
      const replacement = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (replacement === undefined || target === undefined) throw new Error('replacement missing');

      publicationReady(replacement, { mutation_id: `precommit-${failurePoint}`, attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
      const outcome = await pending;

      expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'repository_failure' });
      expect(admission.registry.select()?.process).toBe(old);
      expect(replacement.events).toContain(`terminate:${replacement.pid}:graceful`);
      expect(old.sent).toEqual([]);
      expect(events).not.toContain('commit');
    }
  });

  test('keeps committed replacements alive and admitted when old-worker drain initialization throws', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'postcommit-drain-throw', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const admission = new FakeAdmissionController(events);
    const factory = new FakeFactory(events);
    const old = new FakeWorker(0, 30, events);
    admission.afterCommit = () => { old.identityReadError = new Error('injected drain identity failure'); };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const replacement = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (replacement === undefined || target === undefined) throw new Error('replacement missing');
    publicationReady(replacement, { mutation_id: 'postcommit-drain-throw', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'repository_failure' });
    expect(admission.registry.select()?.process).toBe(replacement);
    expect(replacement.events.some((event) => event.startsWith(`terminate:${replacement.pid}:`))).toBeFalse();
    expect(replacement.sent.some((message) => {
      if ('status' in message) return false;
      return message.command === 'drain-worker';
    })).toBeFalse();
    expect(outcome.serving.map(({ process }) => process.pid).sort()).toEqual([old.pid, replacement.pid].sort());
  });

  test('persists replacement failure, terminates new workers, and preserves old workers', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'replacement-failure', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const factory = new FakeFactory(events);
    const old = new FakeWorker(0, 10, events);
    const oldEvidence = serving(old, 1, active.snapshot.content_hash);
    const admission = new FakeAdmissionController(events);
    admission.registry.prepare([oldEvidence]).commit();
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 },
      startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [oldEvidence]);
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    if (target === undefined) throw new Error('target missing');
    factory.workers[0]?.emit({
      status: 'config-apply-failed', worker_slot: 0, pid: 100,
      target_revision: 2, target_content_hash: active.snapshot.content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'apply failed',
      publication: { mutation_id: 'replacement-failure', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation },
    });
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'replacement_convergence_failed' });
    expect(repository.getOperation('replacement-failure')).toMatchObject({ state: 'degraded' });
    expect(events).toContain('terminate:100:graceful');
    expect(events).not.toContain('send:10:drain-worker');
    expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10]);
    expect(admission.registry.select()?.process).toBe(old);
  });

  test('treats malformed, mismatched, and early-exit replacement signals as terminal failures', async () => {
    // Given / When / Then
    for (const signal of ['malformed', 'mismatched', 'exit'] as const) {
      const { repository } = openRepository();
      commit(repository, `signal-${signal}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const factory = new FakeFactory([]);
      const old = new FakeWorker(0, 10, []);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
      await flushMicrotasks();
      const worker = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (worker === undefined || target === undefined) throw new Error('signal target missing');
      switch (signal) {
        case 'malformed':
          worker.emit({ status: 'config-ready', worker_slot: 0 });
          break;
        case 'mismatched':
          publicationReady(worker, { mutation_id: active.operation.mutation_id,
            attempt_no: target.attempt_no, drain_recovery_generation: target.drain_recovery_generation },
          3, active.snapshot.content_hash);
          break;
        case 'exit':
          worker.exit();
          break;
        default:
          throw new Error(`unexpected signal: ${signal}`);
      }
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: 'degraded', error_code: 'replacement_convergence_failed' });
      expect(old.sent).toEqual([]);
      expect(worker.messageListeners.size).toBe(0);
      expect(worker.exitListeners.size).toBe(0);
    }
  });

  test('finalizes replacement timeout as 202 and leaves the old worker untouched', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'replacement-timeout', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const old = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'replacement_convergence_failed', failures: [expect.objectContaining({ code: 'timeout' })] });
    expect(old.sent).toEqual([]);
    expect(scheduler.size).toBe(0);
  });

  test('ignores duplicate ready after one terminal target decision', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'duplicate-ready', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const pending = coordinator.publish(active, []);
    await flushMicrotasks();
    const worker = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (worker === undefined || target === undefined) throw new Error('duplicate target missing');
    const identity = { mutation_id: 'duplicate-ready', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation };

    // When
    publicationReady(worker, identity, 2, active.snapshot.content_hash);
    publicationReady(worker, identity, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(repository.getOperation('duplicate-ready')).toMatchObject({ state: 'converged' });
    expect(worker.messageListeners.size).toBe(0);
  });

  test('ignores stale process identities even when publication identity is exact', async () => {
    // Given / When / Then
    for (const mismatch of ['master', 'instance', 'slot', 'pid'] as const) {
      const { repository } = openRepository();
      commit(repository, `stale-process-${mismatch}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const factory = new FakeFactory([]);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
        ...PROCESS_OPTIONS,
      });
      const pending = coordinator.publish(active, []);
      await flushMicrotasks();
      const worker = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (worker === undefined || target === undefined) throw new Error('target missing');
      const publication = { mutation_id: active.operation.mutation_id, attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation };
      const identity = mismatch === 'master'
        ? { ...worker.identity, master_generation: 'f0000000-0000-4000-8000-000000000001' }
        : mismatch === 'instance'
          ? { ...worker.identity, worker_instance_id: 'f0000000-0000-4000-8000-000000000002' }
          : mismatch === 'slot' ? { ...worker.identity, worker_slot: 1 } : worker.identity;
      worker.emit({ status: 'config-ready', ...identity,
        pid: mismatch === 'pid' ? worker.pid + 1 : worker.pid, revision: 2,
        content_hash: active.snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
        private_port: 41_000, plugin_runtime_generation: 0,
        required_plugins: [], serving_plugins: [], publication });
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: 'degraded', failures: [
        expect.objectContaining({ code: 'mismatched_message' }),
      ] });
    }
  });

  test('requires exact drain hash and publication before accepting drained ACK', async () => {
    // Given / When / Then
    for (const mismatch of ['hash', 'publication'] as const) {
      const { repository } = openRepository();
      commit(repository, `drain-ack-${mismatch}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const factory = new FakeFactory([]);
      const old = new FakeWorker(0, mismatch === 'hash' ? 40 : 41, []);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
      await flushMicrotasks();
      const replacement = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (replacement === undefined || target === undefined) throw new Error('replacement missing');
      publicationReady(replacement, { mutation_id: active.operation.mutation_id,
        attempt_no: target.attempt_no, drain_recovery_generation: target.drain_recovery_generation },
      active.snapshot.revision, active.snapshot.content_hash);
      await flushMicrotasks();
      old.emit({ status: 'worker-drained', pid: old.pid, revision: 1,
        content_hash: mismatch === 'hash' ? `sha256:${'f'.repeat(64)}` : active.snapshot.content_hash,
        plugin_catalog_hash: PLUGIN_CATALOG_HASH,
        publication: mismatch === 'publication'
          ? { mutation_id: 'wrong', attempt_no: 1, drain_recovery_generation: 0 } : null });
      const outcome = await pending;

      expect(outcome).toMatchObject({ kind: 'degraded', error_code: 'old_worker_drain_failed',
        failures: [expect.objectContaining({ code: 'mismatched_message' })] });
    }
  });

  test('finalizes old drain timeout only after confirmed forced exit', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'drain-timeout', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory(events);
    const old = new FakeWorker(0, 10, events);
    old.terminateExits = false;
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 },
      startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    if (target === undefined) throw new Error('target missing');
    publicationReady(factory.workers[0] ?? old, {
      mutation_id: active.operation.mutation_id, attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation,
    }, 2, active.snapshot.content_hash);
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler, 2);
    await flushMicrotasks();
    old.exit();
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'old_worker_drain_failed' });
    expect(repository.getOperation('drain-timeout')).toMatchObject({ state: 'degraded',
      error_code: 'old_worker_drain_failed' });
    expect(events).toContain('terminate:10:graceful');
    expect(events).toContain('terminate:10:force');
  });

  test('does not signal after replayed exit or force across the grace-to-force boundary', async () => {
    // Given / When / Then
    for (const timing of ['before-grace', 'between-phases'] as const) {
      const { repository } = openRepository();
      commit(repository, `continuous-exit-${timing}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const events: string[] = [];
      const scheduler = new ManualScheduler();
      const factory = new FakeFactory(events);
      const old = new FakeWorker(0, timing === 'before-grace' ? 20 : 21, events, false);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1, scheduler,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
        ...PROCESS_OPTIONS,
      });
      const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
      await flushMicrotasks();
      const replacement = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (replacement === undefined || target === undefined) throw new Error('replacement missing');
      publicationReady(replacement, { mutation_id: active.operation.mutation_id,
        attempt_no: target.attempt_no, drain_recovery_generation: target.drain_recovery_generation },
      active.snapshot.revision, active.snapshot.content_hash);
      await flushMicrotasks();
      old.emit({ status: 'worker-drained', pid: old.pid, revision: 1,
        content_hash: active.snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
        publication: null });
      if (timing === 'before-grace') old.exit();
      else {
        await flushMicrotasks();
        scheduler.fireAll();
        old.exit();
      }
      const outcome = await pending;

      expect(outcome.kind).toBe('converged');
      expect(events).not.toContain(`terminate:${old.pid}:force`);
      if (timing === 'before-grace') expect(events).not.toContain(`terminate:${old.pid}:graceful`);
    }
  });

  test('accepts exact exit proof even when the signal request reports an error', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'signal-error-with-exit', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const old = new FakeWorker(0, 30, []);
    old.terminationErrorAfterExit = new Error('signal raced with exit');
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      ...PROCESS_OPTIONS,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const replacement = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (replacement === undefined || target === undefined) throw new Error('replacement missing');
    publicationReady(replacement, { mutation_id: active.operation.mutation_id,
      attempt_no: target.attempt_no, drain_recovery_generation: target.drain_recovery_generation },
    active.snapshot.revision, active.snapshot.content_hash);
    await flushMicrotasks();
    old.emit({ status: 'worker-drained', pid: old.pid, revision: 1,
      content_hash: active.snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      publication: null });
    const outcome = await pending;

    // Then
    expect(outcome.kind).toBe('converged');
  });

  test('leaves draining operation nonterminal when forced exit cannot be proven', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'exit-unconfirmed', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory(events);
    const old = new FakeWorker(0, 10, events, false);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 },
      startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    if (target === undefined) throw new Error('target missing');
    publicationReady(factory.workers[0] ?? old, {
      mutation_id: active.operation.mutation_id, attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation,
    }, 2, active.snapshot.content_hash);
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'worker_exit_unconfirmed' });
    expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10, 100]);
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
  });

  test('reopens publishing and fences every target with master recovery attempts', async () => {
    // Given
    const opened = openRepository();
    commit(opened.repository, 'publishing-recovery', [0, 1]);
    opened.repository.beginPublication('publishing-recovery', CREATED_AT + 1);
    opened.repository.beginWorkerAttempt('publishing-recovery', 0, 0, 'initial', CREATED_AT + 2);
    opened.repository.recordWorkerResult('publishing-recovery', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    const repository = reopen(opened.repository, opened.dbPath);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const fenced = repository.getActivePublication();
    if (fenced === null) throw new Error('fenced publication missing');
    for (const worker of factory.workers) {
      const target = fenced.targets.find(({ worker_slot }) => worker_slot === worker.slot);
      if (target === undefined) throw new Error('target missing');
      publicationReady(worker, { mutation_id: 'publishing-recovery', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    }
    const outcome = await pending;

    // Then
    expect(fenced.targets.map(({ attempt_no, last_begin_reason }) => ({ attempt_no, last_begin_reason }))).toEqual([
      { attempt_no: 2, last_begin_reason: 'master_recovery' },
      { attempt_no: 1, last_begin_reason: 'master_recovery' },
    ]);
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'old_worker_drain_failed' });
  });

  test('reopens committed publication and begins master recovery attempts', async () => {
    // Given
    const opened = openRepository();
    commit(opened.repository, 'committed-recovery', [0]);
    const repository = reopen(opened.repository, opened.dbPath);
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const worker = factory.workers[0];
    const active = repository.getActivePublication();
    const target = active?.targets[0];
    if (worker === undefined || active === null || target === undefined) throw new Error('committed target missing');
    publicationReady(worker, { mutation_id: 'committed-recovery', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(target).toMatchObject({ attempt_no: 1, last_begin_reason: 'master_recovery' });
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'old_worker_drain_failed' });
  });

  test('returns null from recovery entrypoint when no active operation exists', async () => {
    // Given
    const { repository } = openRepository();
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.recoverAndPublish();

    // Then
    expect(outcome).toBeNull();
  });

  test('fences draining recovery once, admits fresh workers, and terminalizes without fake exit proof', async () => {
    // Given
    const opened = openRepository();
    commit(opened.repository, 'draining-recovery', [0]);
    opened.repository.beginPublication('draining-recovery', CREATED_AT + 1);
    opened.repository.beginWorkerAttempt('draining-recovery', 0, 0, 'initial', CREATED_AT + 2);
    opened.repository.recordWorkerResult('draining-recovery', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    opened.repository.markDraining('draining-recovery', CREATED_AT + 4);
    const repository = reopen(opened.repository, opened.dbPath);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const events: string[] = [];
    const factory = new FakeFactory(events);
    const admission = new FakeAdmissionController(events);
    const faultRepository = new FaultRepository(repository, events);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: faultRepository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      ...PROCESS_OPTIONS,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const recovered = repository.getActivePublication();
    const worker = factory.workers[0];
    const target = recovered?.targets[0];
    if (worker === undefined || recovered === null || target === undefined) throw new Error('recovery target missing');
    publicationReady(worker, { mutation_id: 'draining-recovery', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, recovered.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(faultRepository.beginDrainingRecoveryCalls).toBe(1);
    expect(target).toMatchObject({ attempt_no: 2, last_begin_reason: 'master_recovery',
      drain_recovery_generation: 1 });
    expect(events).toContain('prepare');
    expect(events).toContain('commit');
    expect(events.some((event) => event.includes('drain-worker'))).toBeFalse();
    expect(admission.registry.select()?.process).toBe(worker);
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'old_worker_drain_failed' });
    expect(repository.getActivePublication()).toBeNull();
  });

  test('keeps draining recovery active and nonfatal when cleaned replacements fail', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'draining-replacement-failure', [0]);
    repository.beginPublication('draining-replacement-failure', CREATED_AT + 1);
    repository.beginWorkerAttempt('draining-replacement-failure', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('draining-replacement-failure', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('draining-replacement-failure', CREATED_AT + 4);
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    const worker = factory.workers[0];
    if (target === undefined || worker === undefined) throw new Error('recovery failure target missing');
    worker.emit({ status: 'config-apply-failed', worker_slot: 0, pid: worker.pid,
      target_revision: 2, target_content_hash: repository.getSnapshot().content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'recovery failed',
      publication: { mutation_id: 'draining-replacement-failure', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation } });
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false,
      code: 'recovery_replacements_failed', serving: [], pending: [] });
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
    expect(worker.events).toContain(`terminate:${worker.pid}:graceful`);
  });

  test('terminalizes cleaned committed recovery replacement failure as conservative 202', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'committed-replacement-failure', [0]);
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    const worker = factory.workers[0];
    if (target === undefined || worker === undefined) throw new Error('committed recovery target missing');
    worker.emit({ status: 'config-apply-failed', worker_slot: 0, pid: worker.pid,
      target_revision: 2, target_content_hash: repository.getSnapshot().content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'recovery failed',
      publication: { mutation_id: 'committed-replacement-failure', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation } });
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'replacement_convergence_failed', serving: [] });
    expect(repository.getOperation('committed-replacement-failure')?.state).toBe('degraded');
  });

  test('retains admitted recovery workers when conservative finalization fails', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'recovery-finalize-failure', [0]);
    const faultRepository = new FaultRepository(repository);
    faultRepository.finalizeError = new Error('injected recovery finalize failure');
    const admission = new FakeAdmissionController();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: faultRepository, workerFactory: factory, workerCount: 1, admission,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const active = repository.getActivePublication();
    const target = active?.targets[0];
    const worker = factory.workers[0];
    if (active === null || target === undefined || worker === undefined) throw new Error('finalize target missing');
    publicationReady(worker, { mutation_id: 'recovery-finalize-failure', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'repository_failure' });
    expect(admission.registry.select()?.process).toBe(worker);
    expect(worker.events.some((event) => event.startsWith(`terminate:${worker.pid}:`))).toBeFalse();
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
  });

  test('fences again after a second master crash during draining recovery', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'second-recovery-crash', [0]);
    repository.beginPublication('second-recovery-crash', CREATED_AT + 1);
    repository.beginWorkerAttempt('second-recovery-crash', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('second-recovery-crash', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('second-recovery-crash', CREATED_AT + 4);
    repository.beginDrainingRecovery('second-recovery-crash', 0, CREATED_AT + 5);
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.recoverAndPublish();
    await flushMicrotasks();
    const active = repository.getActivePublication();
    const target = active?.targets[0];
    const worker = factory.workers[0];
    if (active === null || target === undefined || worker === undefined) throw new Error('second recovery target missing');
    publicationReady(worker, { mutation_id: 'second-recovery-crash', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(target).toMatchObject({ attempt_no: 3, drain_recovery_generation: 2,
      last_begin_previous_attempt_no: 2, last_begin_reason: 'master_recovery' });
    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202,
      error_code: 'old_worker_drain_failed' });
  });

  test('rejects same and different mutation while a publication is in flight', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'serialized', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const first = coordinator.publish(active, []);
    expect(coordinator.publish(active, [])).rejects.toBeInstanceOf(MasterConfigPublicationError);
    expect(coordinator.publish({ ...active,
      operation: { ...active.operation, mutation_id: 'different' } }, [])).rejects
      .toBeInstanceOf(MasterConfigPublicationError);

    // Then
    await flushMicrotasks();
    const target = repository.getActivePublication()?.targets[0];
    const worker = factory.workers[0];
    if (target === undefined || worker === undefined) throw new Error('serialized target missing');
    worker.emit({
      status: 'config-apply-failed', worker_slot: 0, pid: worker.pid,
      target_revision: 2, target_content_hash: active.snapshot.content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'finish test',
      publication: { mutation_id: 'serialized', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation },
    });
    await first;
  });

  test('rejects a durable target set that differs from canonical coordinator slots', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'target-mismatch', [1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When / Then
    expect(coordinator.publish(active, [])).rejects.toMatchObject({ code: 'target_set_mismatch' });
    expect(repository.getActivePublication()?.operation.state).toBe('committed');
  });

  test('returns outcome unknown without claiming a terminal result when repository write fails', async () => {
    // Given
    const opened = openRepository();
    commit(opened.repository, 'repository-unknown', [0]);
    const active = opened.repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    opened.repository.close();
    repositories.splice(repositories.indexOf(opened.repository), 1);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: opened.repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'repository_failure' });
  });

  test('does not finalize replacement failure while a ready replacement has unconfirmed exit', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'owned-ready-refuses-exit', [0, 1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const old = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const durable = repository.getActivePublication();
    const readyWorker = factory.workers[0];
    const failedWorker = factory.workers[1];
    const readyTarget = durable?.targets[0];
    const failedTarget = durable?.targets[1];
    if (readyWorker === undefined || failedWorker === undefined || readyTarget === undefined || failedTarget === undefined) {
      throw new Error('replacement targets missing');
    }
    readyWorker.terminateExits = false;
    publicationReady(readyWorker, { mutation_id: 'owned-ready-refuses-exit', attempt_no: readyTarget.attempt_no,
      drain_recovery_generation: readyTarget.drain_recovery_generation }, 2, active.snapshot.content_hash);
    failedWorker.emit({ status: 'config-apply-failed', worker_slot: 1, pid: failedWorker.pid,
      target_revision: 2, target_content_hash: active.snapshot.content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'apply failed',
      publication: { mutation_id: 'owned-ready-refuses-exit', attempt_no: failedTarget.attempt_no,
        drain_recovery_generation: failedTarget.drain_recovery_generation } });
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(repository.getActivePublication()?.operation.state).toBe('publishing');
    expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10, readyWorker.pid]);
    expect(readyWorker.exitListeners.size).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  test('retains ownership evidence when termination throws or reports the wrong pid', async () => {
    // Given / When / Then
    for (const mode of ['throws', 'wrong-pid'] as const) {
      const { repository } = openRepository();
      commit(repository, `cleanup-${mode}`, [0]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const scheduler = new ManualScheduler();
      const factory = new FakeFactory([]);
      const old = new FakeWorker(0, 10, []);
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: 1, scheduler,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
      await flushMicrotasks();
      const worker = factory.workers[0];
      const target = repository.getActivePublication()?.targets[0];
      if (worker === undefined || target === undefined) throw new Error('cleanup target missing');
      worker.terminateExits = false;
      if (mode === 'throws') worker.terminationError = new Error('termination refused');
      worker.emit({ status: 'config-apply-failed', worker_slot: 0, pid: worker.pid,
        target_revision: 2, target_content_hash: active.snapshot.content_hash,
        target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
        serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'apply failed',
        publication: { mutation_id: `cleanup-${mode}`, attempt_no: target.attempt_no,
          drain_recovery_generation: target.drain_recovery_generation } });
      await flushMicrotasks();
      if (mode === 'wrong-pid') worker.emitExitPid(worker.pid + 1);
      await fireSchedulerRounds(scheduler);
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'worker_exit_unconfirmed' });
      expect(repository.getActivePublication()?.operation.state).toBe('publishing');
      if (outcome.kind !== 'outcome_unknown') throw new Error('expected outcome_unknown');
      expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10]);
      expect(outcome.pending.map(({ process }) => process.pid)).toEqual([worker.pid]);
      expect(worker.exitListeners.size).toBe(0);
      expect(scheduler.size).toBe(0);
    }
  });

  test('does not terminalize when terminate throws even if exact exit is later observed', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'terminate-error-exits', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const old = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const worker = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (worker === undefined || target === undefined) throw new Error('termination target missing');
    worker.terminationError = new Error('termination command failed');
    worker.emit({ status: 'config-apply-failed', worker_slot: 0, pid: worker.pid,
      target_revision: 2, target_content_hash: active.snapshot.content_hash,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null, failed_plugins: [], error: 'apply failed',
      publication: { mutation_id: 'terminate-error-exits', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation } });
    await flushMicrotasks();
    worker.exit();
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'degraded', error_code: 'replacement_convergence_failed' });
    expect(repository.getOperation('terminate-error-exits')?.state).toBe('degraded');
  });

  test('cleans the first owned replacement when second spawn or attempt transition throws', async () => {
    // Given / When / Then
    for (const failure of ['spawn', 'attempt'] as const) {
      const { repository } = openRepository();
      commit(repository, `partial-${failure}`, [0, 1]);
      const active = repository.getActivePublication();
      if (active === null) throw new Error('active publication missing');
      const faultRepository = new FaultRepository(repository);
      const factory = new FakeFactory([]);
      if (failure === 'spawn') factory.failAtSpawn = 2;
      if (failure === 'attempt') faultRepository.beginAttemptFailureAt = 2;
      const coordinator = new MasterConfigPublicationCoordinator({
        repository: faultRepository, workerFactory: factory, workerCount: 2,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      const outcome = await coordinator.publish(active, []);
      expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'repository_failure' });
      expect(factory.workers).toHaveLength(1);
      expect(factory.workers[0]?.exitListeners.size).toBe(0);
      expect(factory.workers[0]?.sent).toEqual([]);
      expect(factory.workers[0]?.events).toContain('terminate:100:graceful');
      expect(repository.getActivePublication()?.operation.state).toBe('publishing');
    }
  });

  test('returns startup outcome unknown for send, partial spawn, and unconfirmed cleanup failures', async () => {
    // Given / When / Then
    for (const failure of ['send', 'spawn', 'unconfirmed'] as const) {
      const { repository } = openRepository();
      const scheduler = new ManualScheduler();
      const factory = new FakeFactory([]);
      if (failure === 'spawn') factory.failAtSpawn = 2;
      const coordinator = new MasterConfigPublicationCoordinator({
        repository, workerFactory: factory, workerCount: failure === 'spawn' ? 2 : 1, scheduler,
        clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      });
      if (failure === 'spawn') {
        const originalSpawn = factory.spawn.bind(factory);
        factory.spawn = (identity): FakeWorker => {
          const worker = originalSpawn(identity);
          worker.terminateExits = false;
          return worker;
        };
      }
      if (failure !== 'spawn') {
        const originalSpawn = factory.spawn.bind(factory);
        factory.spawn = (identity): FakeWorker => {
          const worker = originalSpawn(identity);
          if (failure === 'send') worker.sendError = new Error('send refused');
          worker.terminateExits = false;
          return worker;
        };
      }
      const pending = coordinator.startCurrent(repository.getSnapshot());
      await flushMicrotasks();
      await fireSchedulerRounds(scheduler);
      const outcome = await pending;
      expect(outcome).toMatchObject(failure === 'spawn'
        ? { kind: 'startup_outcome_unknown', code: 'worker_exit_unconfirmed' }
        : { kind: 'startup_outcome_unknown' });
      if (outcome.kind !== 'startup_outcome_unknown') throw new Error('expected startup_outcome_unknown');
      expect(outcome.serving).toEqual([]);
      expect(outcome.pending.map(({ process }) => process.pid)).toEqual([100]);
      expect(factory.workers[0]?.messageListeners.size).toBe(0);
      expect(factory.workers[0]?.exitListeners.size).toBe(0);
      expect(scheduler.size).toBe(0);
    }
  });

  test('rejects every overlapping coordinator call under one cross-api lease', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'lease-gate', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const startup = coordinator.startCurrent(repository.getSnapshot());
    const startupOverlap = coordinator.startCurrent(repository.getSnapshot());
    const publishOverlap = coordinator.publish(active, []);

    // Then
    expect(startupOverlap).rejects.toMatchObject({ code: 'concurrent_publication' });
    expect(publishOverlap).rejects.toMatchObject({ code: 'concurrent_publication' });
    await fireSchedulerRounds(scheduler);
    await startup;
    const publish = coordinator.publish(active, []);
    const sameMutation = coordinator.publish(active, [serving(new FakeWorker(0, 99, []), 1, active.snapshot.content_hash)]);
    const recoveryOverlap = coordinator.recoverAndPublish();
    expect(sameMutation).rejects.toMatchObject({ code: 'concurrent_publication' });
    expect(recoveryOverlap).rejects.toMatchObject({ code: 'concurrent_publication' });
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler);
    await publish;
  });

  test('rejects startCurrent while publish owns the coordinator lease', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'publish-blocks-start', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const publish = coordinator.publish(active, []);
    const startup = coordinator.startCurrent(repository.getSnapshot());

    // Then
    expect(startup).rejects.toMatchObject({ code: 'concurrent_publication' });
    await flushMicrotasks();
    await fireSchedulerRounds(scheduler);
    await publish;
  });

  test('settles every startup waiter immediately when one of multiple sends throws', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      if (identity.worker_slot === 0) worker.sendError = new Error('first send failed');
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.startCurrent(repository.getSnapshot());

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_outcome_unknown', code: 'startup_failure' });
    expect(factory.workers.every(({ messageListeners, exitListeners }) =>
      messageListeners.size === 0 && exitListeners.size === 0)).toBeTrue();
    expect(scheduler.size).toBe(0);
  });

  test('handles synchronous timeout scheduling without TDZ or leaked timeout state', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new SynchronousScheduler();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.startCurrent(repository.getSnapshot());

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_failed' });
    expect(factory.workers[0]?.exitListeners.size).toBe(0);
    expect(scheduler.active).toBe(0);
  });

  test('settles from waiter timeout when IPC send callback never arrives', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      worker.sendNeverSettles = true;
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(repository.getSnapshot());
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'startup_failed', failures: [
      expect.objectContaining({ code: 'timeout' }),
    ] });
  });

  test('does not attempt replacement convergence during unproven draining recovery', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'draining-retryable', [0]);
    repository.beginPublication('draining-retryable', CREATED_AT + 1);
    repository.beginWorkerAttempt('draining-retryable', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('draining-retryable', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('draining-retryable', CREATED_AT + 4);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('draining publication missing');
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'worker_exit_unconfirmed' });
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
    expect(outcome.serving).toEqual([]);
    expect(factory.workers).toEqual([]);
  });

  test('cleans every owned replacement after a repository result write fails', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'record-write-failure', [0, 1]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const faultRepository = new FaultRepository(repository);
    faultRepository.recordFailureAt = 1;
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: faultRepository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, []);
    await flushMicrotasks();
    const durable = repository.getActivePublication();
    if (durable === null) throw new Error('durable publication missing');
    for (const worker of factory.workers) {
      const target = durable.targets.find(({ worker_slot }) => worker_slot === worker.slot);
      if (target === undefined) throw new Error('record target missing');
      publicationReady(worker, { mutation_id: 'record-write-failure', attempt_no: target.attempt_no,
        drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    }
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'repository_failure' });
    expect(factory.workers.every(({ events }) => events.some((event) => event.startsWith('terminate:')))).toBeTrue();
    expect(factory.workers.every(({ exitListeners }) => exitListeners.size === 0)).toBeTrue();
    expect(repository.getActivePublication()?.operation.state).toBe('publishing');
  });

  test('does not touch recovery repository writes without old-generation exit proof', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'draining-repository-failure', [0]);
    repository.beginPublication('draining-repository-failure', CREATED_AT + 1);
    repository.beginWorkerAttempt('draining-repository-failure', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('draining-repository-failure', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('draining-repository-failure', CREATED_AT + 4);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('draining publication missing');
    const faultRepository = new FaultRepository(repository);
    faultRepository.recordFailureAt = 1;
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository: faultRepository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'worker_exit_unconfirmed' });
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
    expect(factory.workers).toEqual([]);
  });

  test('does not partially spawn during unproven draining recovery', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'draining-partial-spawn', [0, 1]);
    repository.beginPublication('draining-partial-spawn', CREATED_AT + 1);
    for (const slot of [0, 1]) {
      const attemptTime = CREATED_AT + 2 + (slot * 2);
      repository.beginWorkerAttempt('draining-partial-spawn', slot, 0, 'initial', attemptTime);
      repository.recordWorkerResult('draining-partial-spawn', slot, {
        kind: 'converged', attempt_no: 1, applied_revision: 2,
      }, attemptTime + 1);
    }
    repository.markDraining('draining-partial-spawn', CREATED_AT + 6);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('draining publication missing');
    const factory = new FakeFactory([]);
    factory.failAtSpawn = 2;
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 2,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true,
      code: 'worker_exit_unconfirmed' });
    expect(factory.workers).toEqual([]);
    expect(repository.getActivePublication()?.operation).toMatchObject({ state: 'draining',
      drain_recovery_generation: 0 });
  });

  test('cleans installed startup message listener when exit subscription initialization throws', async () => {
    // Given
    const { repository } = openRepository();
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      if (worker.pid === 100) worker.exitSubscribeFailures = 1;
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.startCurrent(repository.getSnapshot());
    const second = coordinator.startCurrent(repository.getSnapshot());
    const secondWorker = factory.workers[1];
    if (secondWorker === undefined) throw new Error('lease was not reacquired');
    secondWorker.emit({ status: 'config-ready', worker_slot: 0, pid: secondWorker.pid, revision: 1,
      content_hash: repository.getSnapshot().content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_000, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const secondOutcome = await second;

    // Then
    expect(outcome.kind).not.toBe('startup_ready');
    expect(secondOutcome.kind).toBe('startup_ready');
    expect(factory.workers[0]?.messageListeners.size).toBe(0);
    expect(factory.workers[0]?.exitListeners.size).toBe(0);
  });

  test('removes both startup subscriptions when scheduler initialization throws', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    scheduler.scheduleFailures = 1;
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.startCurrent(repository.getSnapshot());

    // Then
    expect(outcome.kind).not.toBe('startup_ready');
    expect(factory.workers[0]?.messageListeners.size).toBe(0);
    expect(factory.workers[0]?.exitListeners.size).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  test('retains replacement ownership when waiter initialization and exit cleanup cannot prove exit', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'waiter-init-unknown', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const scheduler = new ManualScheduler();
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      worker.exitSubscribeFailures = 2;
      worker.terminateExits = false;
      return worker;
    };
    const old = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await fireSchedulerRounds(scheduler);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(repository.getActivePublication()?.operation.state).toBe('publishing');
    if (outcome.kind !== 'outcome_unknown') throw new Error('expected outcome_unknown');
    expect(outcome.serving.map(({ process }) => process.pid)).toEqual([10]);
    expect(outcome.pending.map(({ process }) => process.pid)).toEqual([100]);
    expect(factory.workers[0]?.messageListeners.size).toBe(0);
    expect(factory.workers[0]?.exitListeners.size).toBe(0);
  });

  test('preserves an existing current worker private port without restarting it', async () => {
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const existing = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const evidence = { process: existing, revision: snapshot.revision,
      content_hash: snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41001, publication: null } satisfies ServingConfigWorker;

    const outcome = await coordinator.startCurrent(snapshot, [evidence]);
    existing.emit({ status: 'config-ready', pid: existing.pid, revision: snapshot.revision,
      content_hash: snapshot.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41002, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });

    expect(outcome).toMatchObject({ kind: 'startup_ready', serving: [evidence] });
    expect(existing.sent).toEqual([]);
  });

  test('rejects existing current evidence from a different plugin catalog', async () => {
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const existing = new FakeWorker(0, 10, []);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const evidence = { ...serving(existing, snapshot.revision, snapshot.content_hash),
      plugin_catalog_hash: OTHER_PLUGIN_CATALOG_HASH };

    expect(coordinator.startCurrent(snapshot, [evidence])).rejects.toMatchObject({ code: 'invalid_options' });
  });

  test('rejects invalid current serving evidence before spawning', async () => {
    const { repository } = openRepository();
    const snapshot = repository.getSnapshot();
    const factory = new FakeFactory([]);
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const existing = new FakeWorker(0, 10, []);
    const zeroPort = { ...serving(existing, snapshot.revision, snapshot.content_hash),
      private_port: 0 } satisfies ServingConfigWorker;
    const throwingRevision = {
      ...serving(existing, snapshot.revision, snapshot.content_hash),
      get revision(): number { throw new Error('injected evidence getter failure'); },
    } satisfies ServingConfigWorker;

    expect(coordinator.startCurrent(snapshot, [zeroPort])).rejects.toMatchObject({ code: 'invalid_options' });
    expect(coordinator.startCurrent(snapshot, [throwingRevision])).rejects.toMatchObject({ code: 'invalid_options' });
    expect(factory.workers).toEqual([]);
  });

  test.each([
    ['zero private port', (evidence: ServingConfigWorker): ServingConfigWorker => ({
      ...evidence, private_port: 0,
    })],
    ['wrong catalog hash', (evidence: ServingConfigWorker): ServingConfigWorker => ({
      ...evidence, plugin_catalog_hash: OTHER_PLUGIN_CATALOG_HASH,
    })],
    ['malformed publication', (evidence: ServingConfigWorker): ServingConfigWorker => ({
      ...evidence, publication: { mutation_id: 'invalid publication', attempt_no: 0, drain_recovery_generation: -1 },
    })],
  ])('rejects %s old serving evidence before repository mutation or spawn', async (_caseName, invalidate) => {
    const { repository } = openRepository();
    commit(repository, 'invalid-old-serving', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const replacement = originalSpawn(identity);
      replacement.sendError = new Error('replacement failed');
      return replacement;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });
    const old = invalidate(serving(new FakeWorker(0, 10, []), 1, active.snapshot.content_hash));

    expect(coordinator.publish(active, [old])).rejects.toMatchObject({ code: 'invalid_options' });
    expect(factory.workers).toEqual([]);
    expect(repository.getActivePublication()?.operation.state).toBe('committed');
  });

  test('rejects a malformed coordinator plugin catalog hash', () => {
    const { repository } = openRepository();
    expect(() => Reflect.construct(BaseMasterConfigPublicationCoordinator, [{
      repository, workerFactory: new FakeFactory([]), workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
      pluginCatalogHash: 'not-a-digest',
    }])).toThrow(MasterConfigPublicationError);
  });

  test('keeps cleanup total when exit wait and termination initialization throw together', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'cleanup-total', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      worker.exitSubscribeFailures = 2;
      worker.terminationError = new Error('terminate failed');
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const outcome = await coordinator.publish(active, []);

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'worker_exit_unconfirmed' });
    if (outcome.kind !== 'outcome_unknown') throw new Error('expected outcome_unknown');
    expect(outcome.serving).toEqual([]);
    expect(outcome.pending.map(({ process }) => process.pid)).toEqual([100]);
    expect(repository.getActivePublication()?.operation.state).toBe('publishing');
  });

  test('does not terminalize drain when acknowledgement initialization and exit proof fail', async () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'drain-init-total', [0]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('active publication missing');
    const factory = new FakeFactory([]);
    const old = new FakeWorker(0, 10, []);
    old.exitSubscribeFailures = 2;
    old.terminateExits = false;
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.publish(active, [serving(old, 1, active.snapshot.content_hash)]);
    await flushMicrotasks();
    const worker = factory.workers[0];
    const target = repository.getActivePublication()?.targets[0];
    if (worker === undefined || target === undefined) throw new Error('replacement target missing');
    publicationReady(worker, { mutation_id: 'drain-init-total', attempt_no: target.attempt_no,
      drain_recovery_generation: target.drain_recovery_generation }, 2, active.snapshot.content_hash);
    const outcome = await pending;

    // Then
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', code: 'worker_exit_unconfirmed' });
    expect(repository.getActivePublication()?.operation.state).toBe('draining');
  });

  test('ignores throwing unsubscribe and cancel callbacks without rejecting startup', async () => {
    // Given
    const { repository } = openRepository();
    const scheduler = new ManualScheduler();
    scheduler.cancelFails = true;
    const factory = new FakeFactory([]);
    const originalSpawn = factory.spawn.bind(factory);
    factory.spawn = (identity): FakeWorker => {
      const worker = originalSpawn(identity);
      worker.messageUnsubscribeFails = true;
      worker.exitUnsubscribeFails = true;
      return worker;
    };
    const coordinator = new MasterConfigPublicationCoordinator({
      repository, workerFactory: factory, workerCount: 1, scheduler,
      clock: { now: () => CREATED_AT + 100 }, startupApplyTimeoutMs: 100, drainTimeoutMs: 100,
    });

    // When
    const pending = coordinator.startCurrent(repository.getSnapshot());
    const worker = factory.workers[0];
    if (worker === undefined) throw new Error('startup worker missing');
    worker.emit({ status: 'config-ready', worker_slot: 0, pid: worker.pid, revision: 1,
      content_hash: repository.getSnapshot().content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: 41_000, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null });
    const outcome = await pending;

    // Then
    expect(outcome.kind).toBe('startup_ready');
    expect(worker.messageListeners.size).toBe(0);
    expect(worker.exitListeners.size).toBe(0);
    expect(scheduler.size).toBe(0);
  });
});
