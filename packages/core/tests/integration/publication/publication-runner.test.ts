import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { ProcessIdentityAllocator } from '../../../src/config-publication/process-identity';
import { OwnedProcessCollection } from '../../../src/config-publication/process-cleanup';
import { runPublication } from '../../../src/config-publication/publication-runner';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;
const NEXT_HASH: Sha256Digest = `sha256:${'c'.repeat(64)}`;

function servingWorker(slot: number, origin: string | undefined, exitProven = false) {
  const exitListeners: Array<(evidence: any) => void> = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const pid = 100 + slot;
  const bootNonce = `50000000-0000-4000-8000-${String(slot).padStart(12, '0')}`;
  const kernelBootId = 'linux:11111111-1111-4111-8111-111111111111';
  const identity = {
    master_generation: '30000000-0000-4000-8000-000000000001',
    worker_instance_id: `40000000-0000-4000-8000-00000000000${slot + 1}`,
    worker_slot: slot,
  };
  let current: any = null;
  const process = {
    slot, pid, kernelBootId, identity, ...(origin === undefined ? {} : { origin }),
    async send(command: any) {
      if (command.command !== 'drain-worker') return;
      const started = { status: 'worker-draining', ...identity, boot_nonce: bootNonce, pid,
        revision: 7, content_hash: HASH, plugin_catalog_hash: HASH, drain_id: command.drain_id,
        policy: command.policy, remaining_ms: command.policy.drain_timeout_ms, publication: null };
      current = started;
      for (const listener of messageListeners) listener(started);
      current = exitProven
        ? { ...started, status: 'worker-drained', boot_id: kernelBootId, exit_deadline_ns: '123456789000',
          exit_remaining_ms: command.policy.worker_exit_timeout_ms, cleanup_state: 'pending' }
        : { ...started, status: 'worker-drain-failed', error_code: 'timeout', http_stopped: true,
          boot_id: kernelBootId, exit_deadline_ns: '123456789000',
          exit_remaining_ms: command.policy.worker_exit_timeout_ms, cleanup_state: 'pending' };
      for (const listener of messageListeners) listener(current);
    },
    async drainStatus() { return current; },
    verifyExactExit: async () => exitProven && current !== null
      ? { exited: true, pid, terminalDrain: { ...current,
        exit_remaining_ms: Math.max(1, current.policy.worker_exit_timeout_ms - 1), cleanup_state: 'success' } } : null,
    subscribeMessage(listener: (message: unknown) => void) { messageListeners.push(listener); return () => undefined; },
    subscribeExit(listener: (evidence: any) => void) { exitListeners.push(listener); return () => undefined; },
    async terminate() {
      if (exitProven) for (const listener of [...exitListeners]) listener({ exited: true, pid,
        terminalDrain: { ...current, exit_remaining_ms: Math.max(1, current.policy.worker_exit_timeout_ms - 1), cleanup_state: 'success' } });
    },
  } as any;
  return { process, boot_nonce: bootNonce, revision: 7, content_hash: HASH, plugin_catalog_hash: HASH,
    publication: null, private_port: 10_000 + slot } as any;
}

function candidateWorker(identity: any, exitOnTerminate: boolean, cleanupState: 'success' | 'failed' = 'success', emitReady = true, readyDelayMs = 0) {
  const exitListeners: Array<(evidence: any) => void> = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const bootNonce = '60000000-0000-4000-8000-000000000001';
  const process = {
    slot: identity.worker_slot, identity, pid: 300 + identity.worker_slot,
    async send(command: any) {
      if (!emitReady || command.command !== 'start-config-worker') return;
      const ready = { status: 'config-ready', boot_nonce: bootNonce, pid: 300 + identity.worker_slot,
        revision: command.revision, content_hash: command.content_hash,
        plugin_catalog_hash: command.plugin_catalog_hash, private_port: 20_000 + identity.worker_slot,
        plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [],
        publication: command.publication, ...identity };
      if (readyDelayMs > 0) setTimeout(() => { for (const listener of messageListeners) listener(ready); }, readyDelayMs);
      else for (const listener of messageListeners) listener(ready);
    },
    subscribeMessage(listener: (message: unknown) => void) { messageListeners.push(listener); return () => undefined; },
    subscribeExit(listener: (evidence: any) => void) { exitListeners.push(listener); return () => undefined; },
    async terminate() {
      if (exitOnTerminate) for (const listener of [...exitListeners]) listener({ exited: true, pid: 300 + identity.worker_slot,
        terminalDrain: { status: 'worker-drained', cleanup_state: cleanupState } });
    },
  } as any;
  return process;
}

function publicationHarness(oldWorkers: readonly any[], options: {
  readonly recoveringMaster?: boolean; readonly commitError?: Error;
  readonly targets?: readonly any[];
  readonly spawn?: (identity: any) => any;
  readonly workerCount?: number;
} = {}) {
  const active = {
    operation: { mutation_id: 'mutation-1', state: 'committed', committed_revision: 7, drain_recovery_generation: 0 },
    snapshot: { revision: 7, content_hash: HASH, aggregate: { plugin_activations: [], logical_configuration: { services: [], routes: [], plugins: [] } } },
    targets: options.targets ?? [],
  } as any;
  const factoryOwned = new Set(oldWorkers.map(({ process }) => process));
  const repository = {
    beginPublication: () => undefined,
    getActivePublication: () => active,
    beginWorkerAttempt: (_mutationId: string, workerSlot: number, previousAttemptNo: number) => ({
      mutation_id: 'mutation-1', worker_slot: workerSlot,
      attempt_no: previousAttemptNo + 1, drain_recovery_generation: 0,
    }),
    recordWorkerResult: () => undefined,
    recordPublicationCandidateExit: () => undefined,
    markDraining: () => undefined,
    finalizePublication: (_mutationId: string, outcome: unknown) => {
      active.finalOutcome = outcome;
      return active.operation;
    },
  } as any;
  const workerFactory = {
    spawn: options.spawn ?? (() => { throw new Error('unexpected spawn'); }),
    markCommitted: () => undefined,
    disconnectProcesses: () => { throw new Error('unexpected disconnect'); },
    discardConfirmedUncommitted: async () => undefined,
  };
  let retiredReleases = 0;
  const harnessOptions = {
    repository,
    workerFactory,
    clock: { now: () => 1 },
    scheduler: { schedule: (_delay: number, callback: () => void) => {
      callback();
      return { cancel: () => undefined };
    } },
    applyTimeoutMs: 10,
    drainTimeoutMs: 10,
    owned: new OwnedProcessCollection(),
    identities: new ProcessIdentityAllocator(
      '30000000-0000-4000-8000-000000000001', options.workerCount ?? 0,
      () => '40000000-0000-4000-8000-000000000001',
    ),
    oldWorkers,
    pluginCatalogHash: HASH,
    admission: { prepare: async () => ({
      commit: async () => { if (options.commitError !== undefined) throw options.commitError; }, abort: async () => undefined,
      releaseRetiredAfterExitProof: async () => { retiredReleases += 1; },
       handoffStatus: async () => ({ retired_id: `sha256:${'e'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 }),
    }) },
    recoveringMaster: options.recoveringMaster ?? false,
    ensureCreationPermitted: async () => ({ allowed: true as const }),
  } as any;
  return { active, factoryOwned, options: harnessOptions, retiredReleases: () => retiredReleases };
}

describe('publication phase diagnostics', () => {
  test('emits only ordered, allowlisted phase fields', async () => {
    const lines: string[] = [];
    let operation: any = {
      mutation_id: 'mutation-1', state: 'committed', drain_recovery_generation: 0,
    };
    const active = () => ({
      operation, snapshot: { revision: 7, content_hash: HASH, aggregate: { plugin_activations: [], logical_configuration: { services: [], routes: [], plugins: [] } } }, targets: [],
    }) as any;
    const repository = {
      beginPublication: () => { operation = { ...operation, state: 'publishing' }; },
      getActivePublication: active,
      markDraining: () => { operation = { ...operation, state: 'draining' }; },
      finalizePublication: () => operation,
    } as any;

    await runPublication({
      repository, workerFactory: { markCommitted: () => undefined } as any,
      clock: { now: () => 1 }, scheduler: { schedule: () => ({ cancel: () => undefined }) },
      applyTimeoutMs: 10, drainTimeoutMs: 10,
      identities: new ProcessIdentityAllocator(
        '30000000-0000-4000-8000-000000000001', 1,
        () => '40000000-0000-4000-8000-000000000001',
      ),
      oldWorkers: [], owned: new OwnedProcessCollection(), pluginCatalogHash: HASH,
      latestRevision: () => 7,
      admission: { prepare: async () => ({ commit: async () => undefined }) } as any,
      recoveringMaster: false, stderr: { write: (line: string) => { lines.push(line); } },
      ensureCreationPermitted: async () => ({ allowed: true as const }),
    }, active(), []);

    const events = lines.map((line) => JSON.parse(line));
    expect(events.map(({ phase, boundary }) => `${phase}:${boundary}`)).toEqual([
      'awaitReplacements:enter', 'awaitReplacements:exit',
      'admission.prepare:enter', 'admission.prepare:exit',
      'markDraining:enter', 'markDraining:exit',
      'admission.commit:enter', 'admission.commit:exit',
      'admission.handoff:enter', 'admission.handoff:exit',
      'drainWorkers:enter', 'drainWorkers:exit',
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['boundary', 'event', 'mutation_id', 'phase', 'revision']);
      expect(event).toMatchObject({ event: 'publication_phase', mutation_id: 'mutation-1', revision: 7 });
    }
  });

  test('drains adopted old workers to converged when exact exit proof arrives', async () => {
    const oldWorkers = [servingWorker(0, 'adopted', true), servingWorker(1, 'adopted', true)];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'converged', old_workers_exited: true });
  });

  test('a transient handoff read cannot strand a committed publication in draining', async () => {
    const oldWorkers = [servingWorker(0, 'adopted', true)];
    const harness = publicationHarness(oldWorkers);
    let reads = 0;
    let commits = 0;
    harness.options.admission.prepare = async () => ({
      async commit() { commits += 1; }, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        if (++reads === 1) throw new Error('handoff status connection reset');
        return { retired_id: `sha256:${'e'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 };
      },
    });
    const outcome = await runPublication(harness.options, harness.active, oldWorkers);
    expect(outcome).toMatchObject({ kind: 'converged' });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'converged', old_workers_exited: true });
    expect(reads).toBe(2);
    expect(commits).toBe(1);
  });

  test('reports a fixed handoff reason while retaining unknown retired ownership', async () => {
    const oldWorkers = [servingWorker(0, 'adopted', true)];
    const harness = publicationHarness(oldWorkers);
    const lines: string[] = [];
    harness.options.stderr = { write: (line: string) => lines.push(line) };
    harness.options.admission.prepare = async () => ({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() { throw new Error('must retain retired set'); },
      async handoffStatus() { throw Object.assign(new Error('hidden protocol details'), { code: 'invalid_mac' }); },
    });
    expect(await runPublication(harness.options, harness.active, oldWorkers))
      .toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect(harness.active.finalOutcome).toBeUndefined();
    const events = lines.map(line => JSON.parse(line));
    expect(events.at(-1)).toEqual({ event: 'publication_phase', phase: 'admission.handoff', boundary: 'exit',
      mutation_id: 'mutation-1', revision: 7, handoff_reason: 'unavailable' });
    expect(lines.join('')).not.toContain('hidden');
  });

  test('retains retired ownership nonfatally when the new target is committed but old exit is unknown', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'adopted')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect(harness.factoryOwned.size).toBe(2);
    expect(harness.active.finalOutcome).toBeUndefined();
    expect(harness.retiredReleases()).toBe(0);
  });

  test('recovering master drains adopted old workers and retains a historical degraded audit', async () => {
    const oldWorkers = [servingWorker(0, 'adopted', true)];
    const harness = publicationHarness(oldWorkers, { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed' });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'degraded', old_workers_exited: true });
  });

  test('recovering master with known new target and old-worker exit unknown remains nonfatal', async () => {
    const oldWorkers = [servingWorker(0, 'adopted')];
    const harness = publicationHarness(oldWorkers, { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect(harness.factoryOwned.size).toBe(1);
    expect(harness.active.finalOutcome).toBeUndefined();
    expect(harness.retiredReleases()).toBe(0);
  });

  test('recovering master without rebuilt old-worker ownership treats an empty drain set as missing proof', async () => {
    const harness = publicationHarness([], { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect((outcome as { readonly error?: unknown }).error).toBeInstanceOf(TypeError);
    // No finalize, no retired release; admission and ownership stay exactly as committed.
    expect(harness.active.finalOutcome).toBeUndefined();
    expect(harness.retiredReleases()).toBe(0);
  });

  test('draining stopped retries preserve verified serving and never create another attempt', async () => {
    const harness = publicationHarness([], { recoveringMaster: true });
    harness.active.operation.state = 'draining';
    let spawns = 0; let generations = 0; let releases = 0;
    const serving = servingWorker(0, 'adopted');
    harness.options.workerFactory.spawn = () => { spawns += 1; throw new Error('must not spawn'); };
    harness.options.repository.beginDrainingRecovery = () => { generations += 1; throw new Error('must not fence a new attempt'); };
    harness.options.recoveredActive = { workers: [serving], admission: {
      commit: async () => { throw new Error('must not commit again'); }, abort: async () => { throw new Error('must preserve active serving'); },
      handoffStatus: async () => null, releaseRetiredAfterExitProof: async () => { releases += 1; },
    } };
    harness.options.confirmPreviousWorkersExited = async () => false;
    for (let retry = 0; retry < 3; retry += 1) {
      const outcome = await runPublication(harness.options, harness.active, []);
      expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
      expect(outcome.serving).toEqual([serving]);
      expect(harness.active.finalOutcome).toBeUndefined();
    }
    expect(spawns).toBe(0); expect(generations).toBe(0); expect(releases).toBe(0);
  });

  test('denies draining recovery creation before fencing a generation or attempt', async () => {
    const harness = publicationHarness([], { recoveringMaster: true });
    harness.active.operation.state = 'draining';
    harness.options.priorAttemptExited = true;
    harness.options.ensureCreationPermitted = async () => ({ allowed: false, error: new Error('historical launch debt') });
    let generations = 0; let attempts = 0; let allocations = 0; let spawns = 0; let prepares = 0;
    harness.options.repository.beginDrainingRecovery = () => { generations += 1; throw new Error('must not fence a generation'); };
    harness.options.repository.beginWorkerAttempt = () => { attempts += 1; throw new Error('must not begin an attempt'); };
    harness.options.identities.allocate = () => { allocations += 1; throw new Error('must not reserve identities'); };
    harness.options.workerFactory.spawn = () => { spawns += 1; throw new Error('must not spawn'); };
    harness.options.admission.prepare = async () => { prepares += 1; throw new Error('must not prepare admission'); };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect({ generations, attempts, allocations, spawns, prepares }).toEqual({
      generations: 0, attempts: 0, allocations: 0, spawns: 0, prepares: 0 });
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('does not fence a draining generation when the permit is cancelled while waiting', async () => {
    const harness = publicationHarness([], { recoveringMaster: true });
    harness.active.operation.state = 'draining';
    harness.options.priorAttemptExited = true;
    const controller = new AbortController();
    harness.options.signal = controller.signal;
    let release!: (permit: { readonly allowed: true }) => void;
    let permitRequested!: () => void;
    const requested = new Promise<void>((resolve) => { permitRequested = resolve; });
    harness.options.ensureCreationPermitted = () => {
      permitRequested();
      return new Promise((resolve) => { release = resolve; });
    };
    let generations = 0; let attempts = 0; let spawns = 0;
    harness.options.repository.beginDrainingRecovery = () => { generations += 1; throw new Error('must not fence a generation'); };
    harness.options.repository.beginWorkerAttempt = () => { attempts += 1; throw new Error('must not begin an attempt'); };
    harness.options.workerFactory.spawn = () => { spawns += 1; throw new Error('must not spawn'); };

    const pending = runPublication(harness.options, harness.active, []);
    await requested;
    controller.abort();
    release({ allowed: true });

    await expect(pending).rejects.toThrow('configuration publication cancelled');
    expect({ generations, attempts, spawns }).toEqual({ generations: 0, attempts: 0, spawns: 0 });
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('keeps admission commit identity uncertainty fatal before classifying retired-only uncertainty', async () => {
    const commitError = Object.assign(new Error('signed active admission identity is unknown'), { code: 'control_recovering' });
    const harness = publicationHarness([], { commitError });
    const outcome = await runPublication(harness.options, harness.active, []);
    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'admission_outcome_unknown' });
    expect(harness.active.finalOutcome).toBeUndefined();
    expect(harness.retiredReleases()).toBe(0);
  });

  test('continues serving real HTTP requests on the committed new worker while retired exit is unknown', async () => {
    const masterGeneration = '30000000-0000-4000-8000-000000000001';
    const newIdentity = { master_generation: masterGeneration,
      worker_instance_id: '60000000-0000-4000-8000-000000000001', worker_slot: 0 };
    const bootNonce = '70000000-0000-4000-8000-000000000001';
    const policy = { drain_start_timeout_ms: 1_000, drain_timeout_ms: 1_000, worker_exit_timeout_ms: 1_000 };
    const oldWorker = servingWorker(0, 'adopted');
    const workerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('new-generation') });
    const messageListeners = new Set<(message: unknown) => void>();
    const newProcess: any = {
      slot: 0, pid: process.pid + 100, identity: newIdentity, kernelBootId: 'linux:11111111-1111-4111-8111-111111111111',
      async send(message: any) {
        if (message.command !== 'start-config-worker') throw new Error('unexpected command to new worker');
        const ready = { status: 'config-ready', ...newIdentity, boot_nonce: bootNonce, pid: process.pid + 100,
          revision: 8, content_hash: NEXT_HASH, plugin_catalog_hash: HASH, private_port: workerServer.port,
          plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: message.publication };
        for (const listener of messageListeners) listener(ready);
      },
      subscribeMessage(listener: (message: unknown) => void) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
      subscribeExit() { return () => undefined; },
      async terminate() {},
      async verifyExactExit() { return null; },
    };
    let committed = false;
    let retiredReleaseCount = 0;
    const admissionServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => {
      if (!committed) return new Response('old-generation');
      return await fetch(`http://127.0.0.1:${workerServer.port}`);
    } });
    const target = { mutation_id: 'mutation-http-unknown', worker_slot: 0, target_revision: 8,
      drain_recovery_generation: 0, attempt_no: 1, last_begin_previous_attempt_no: null,
      last_begin_reason: null, updated_at: 1, state: 'pending', applied_revision: null, last_error: null };
    const active: any = {
      operation: { mutation_id: target.mutation_id, state: 'committed', drain_recovery_generation: 0 },
      snapshot: { revision: 8, content_hash: NEXT_HASH, aggregate: { plugin_activations: [],
        logical_configuration: { publication: policy } } },
      targets: [target],
    };
    const repository: any = {
      beginPublication() {}, getActivePublication: () => active,
      beginWorkerAttempt: () => target,
      recordWorkerResult() {}, markDraining() { active.operation.state = 'draining'; },
      finalizePublication(_id: string, outcome: unknown) { active.finalOutcome = outcome; return active.operation; },
    };
    const owned = new OwnedProcessCollection();
    const workerFactory: any = {
      spawn: () => newProcess,
      markCommitted() {}, disconnectProcesses() {}, discardConfirmedUncommitted: async () => undefined,
    };
    const prepared = {
      commit: async () => { committed = true; }, abort: async () => undefined,
      handoffStatus: async () => ({ retired_id: `sha256:${'f'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 }),
      releaseRetiredAfterExitProof: async () => { retiredReleaseCount += 1; },
    };
    try {
      const outcome = await runPublication({
        repository, workerFactory, clock: { now: () => 1 },
        scheduler: { schedule(delay, callback) { const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) }; } },
        applyTimeoutMs: 100, drainTimeoutMs: 20, identities: new ProcessIdentityAllocator(masterGeneration, 1,
          () => newIdentity.worker_instance_id), owned, pluginCatalogHash: HASH,
        admission: { prepare: async () => prepared } as any,
        oldWorkers: [oldWorker],
        latestRevision: () => active.operation.committed_revision,
        recoveringMaster: false,
        ensureCreationPermitted: async () => ({ allowed: true as const }),
      }, active, [oldWorker]);
      expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
      expect(outcome.serving).toHaveLength(1);
      expect((await (await fetch(`http://127.0.0.1:${admissionServer.port}`)).text())).toBe('new-generation');
      expect(active.finalOutcome).toBeUndefined();
      expect(retiredReleaseCount).toBe(0);
      expect(committed).toBe(true);
    } finally {
      admissionServer.stop(true);
      workerServer.stop(true);
    }
  });

  test('non-recovery publication with zero old workers still converges', async () => {
    const harness = publicationHarness([]);

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'converged', old_workers_exited: true });
    expect(harness.retiredReleases()).toBe(1);
  });

  test('keeps mixed adopted and spawned retired workers nonfatally when only exit proof is unknown', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'spawned')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect(harness.factoryOwned.size).toBe(2);
    expect(harness.active.finalOutcome).toBeUndefined();
  });
});

describe('publication candidate supersession', () => {
  function candidateHarness(latestRevision: number, exitOnTerminate = true,
    cleanupState: 'success' | 'failed' = 'success', emitReady = true, readyDelayMs = 0) {
    const harness = publicationHarness([], {
      targets: [{ worker_slot: 0, attempt_no: 0 }], workerCount: 1,
      spawn: (identity) => candidateWorker(identity, exitOnTerminate, cleanupState, emitReady, readyDelayMs),
    });
    harness.options.latestRevision = () => latestRevision;
    harness.options.scheduler = {
      schedule(delay: number, callback: () => void) {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    };
    return harness;
  }

  test('cancels a ready candidate before admission preparation and records exit evidence', async () => {
    const harness = candidateHarness(8);
    const calls: string[] = [];
    let preparations = 0;
    harness.options.admission.prepare = async () => { preparations += 1; throw new Error('must not prepare'); };
    harness.options.repository.requestPublicationCancellation = async () => {
      calls.push('cancel');
      return harness.active.operation;
    };
    harness.options.repository.enterPublicationPrepare = async () => {
      calls.push('prepare-decision');
      return { kind: 'cancelled' };
    };
    harness.options.repository.recordPublicationCandidateExit = async (
      _mutationId: string, _revision: number, workerSlot: number, attemptNo: number, evidence: unknown,
    ) => {
      calls.push(`exit:${workerSlot}:${attemptNo}:${JSON.stringify(evidence)}`);
    };
    harness.options.repository.confirmPublicationCandidateExited = async (
      _mutationId: string, _revision: number,
    ) => {
      calls.push('confirmed');
      return { ...harness.active.operation, state: 'superseded', result_status: 409,
        error_code: 'revision_superseded', error_detail: 'cancelled' };
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'superseded' });
    expect(preparations).toBe(0);
    expect(calls).toEqual([
      'cancel', 'prepare-decision',
      'exit:0:1:{"kind":"exited","cleanup":"released"}',
      'confirmed',
    ]);
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('keeps the original publication when preparation wins the cancellation race', async () => {
    const harness = candidateHarness(8);
    let preparations = 0;
    let supersessions = 0;
    harness.options.admission.prepare = async () => {
      preparations += 1;
      return { async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {} };
    };
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'granted' });
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      supersessions += 1;
      throw new Error('must not supersede a preparation winner');
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(preparations).toBe(1);
    expect(supersessions).toBe(0);
  });

  test('does not release publication ownership when the candidate exit stays unknown', async () => {
    const harness = candidateHarness(8, false);
    let supersessions = 0;
    harness.options.admission.prepare = async () => { throw new Error('must not prepare'); };
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'cancelled' });
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      supersessions += 1;
      return harness.active.operation;
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'worker_exit_unconfirmed' });
    expect(supersessions).toBe(0);
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('does not release a cancelled candidate when worker cleanup failed', async () => {
    const harness = candidateHarness(8, true, 'failed');
    let supersessions = 0;
    let evidence = 0;
    harness.options.admission.prepare = async () => { throw new Error('must not prepare'); };
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'cancelled' });
    harness.options.repository.recordPublicationCandidateExit = async () => { evidence += 1; };
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      supersessions += 1;
      return harness.active.operation;
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'worker_exit_unconfirmed' });
    expect(evidence).toBe(0);
    expect(supersessions).toBe(0);
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('does not supersede when candidate exit proof cannot be persisted', async () => {
    const harness = candidateHarness(8);
    let confirmations = 0;
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'cancelled' });
    harness.options.repository.recordPublicationCandidateExit = async () => { throw new Error('storage unavailable'); };
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      confirmations += 1;
      return harness.active.operation;
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'repository_failure' });
    expect((outcome as { readonly error: Error }).error.message).toBe('storage unavailable');
    expect(confirmations).toBe(0);
  });

  test('keeps an admitted group when the durable admitted proof fails', async () => {
    const harness = candidateHarness(7);
    let aborts = 0;
    harness.options.admission.prepare = async () => ({
      async commit() {},
      async abort() { aborts += 1; },
      async releaseRetiredAfterExitProof() {},
    });
    harness.options.workerFactory.markCommitted = async () => { throw new Error('ledger write failed'); };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'repository_failure' });
    expect(aborts).toBe(0);
  });

  test('cancels during candidate startup when a newer target is signalled', async () => {
    const harness = candidateHarness(8, true, 'success', false);
    const update = new AbortController();
    harness.options.updateSignal = update.signal;
    harness.options.applyTimeoutMs = 1_000;
    let preparations = 0;
    let supersessions = 0;
    harness.options.admission.prepare = async () => { preparations += 1; throw new Error('must not prepare'); };
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'cancelled' });
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      supersessions += 1;
      return { ...harness.active.operation, state: 'superseded', result_status: 409,
        error_code: 'revision_superseded', error_detail: 'startup update' };
    };

    const publication = runPublication(harness.options, harness.active, []);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    update.abort('newer target');
    const outcome = await publication;

    expect(outcome).toMatchObject({ kind: 'superseded' });
    expect(preparations).toBe(0);
    expect(supersessions).toBe(1);
  });

  test('ignores a late ready after startup cancellation', async () => {
    const harness = candidateHarness(8, true, 'success', true, 5);
    const update = new AbortController();
    harness.options.updateSignal = update.signal;
    harness.options.applyTimeoutMs = 1_000;
    let preparations = 0;
    let supersessions = 0;
    harness.options.admission.prepare = async () => { preparations += 1; throw new Error('must not prepare'); };
    harness.options.repository.requestPublicationCancellation = async () => harness.active.operation;
    harness.options.repository.enterPublicationPrepare = async () => ({ kind: 'cancelled' });
    harness.options.repository.confirmPublicationCandidateExited = async () => {
      supersessions += 1;
      return { ...harness.active.operation, state: 'superseded', result_status: 409,
        error_code: 'revision_superseded', error_detail: 'late ready' };
    };

    const publication = runPublication(harness.options, harness.active, []);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    update.abort('newer target');
    expect(await publication).toMatchObject({ kind: 'superseded' });
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(preparations).toBe(0);
    expect(supersessions).toBe(1);
  });

  test('does not spawn a candidate when a restart finds cancellation already requested', async () => {
    const harness = candidateHarness(7);
    harness.active.operation.cancel_requested = true;
    harness.active.operation.prepare_started = false;
    harness.active.operation.state = 'committed';
    harness.active.targets = [{ worker_slot: 0, attempt_no: 1 }];
    let spawns = 0;
    harness.options.workerFactory.spawn = (identity: any) => {
      spawns += 1;
      return candidateWorker(identity, true);
    };

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering' });
    expect(spawns).toBe(0);
    expect(harness.active.finalOutcome).toBeUndefined();
  });
});
