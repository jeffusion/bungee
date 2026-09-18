import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { ProcessIdentityAllocator } from '../../src/config-publication/process-identity';
import { OwnedProcessCollection } from '../../src/config-publication/process-cleanup';
import { runPublication } from '../../src/config-publication/publication-runner';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;

function servingWorker(slot: number, origin: string | undefined, exitProven = false) {
  const exitListeners: ((evidence: { exited: true; pid: number }) => void)[] = [];
  const pid = 100 + slot;
  const identity = {
    master_generation: '30000000-0000-4000-8000-000000000001',
    worker_instance_id: `40000000-0000-4000-8000-00000000000${slot + 1}`,
    worker_slot: slot,
  };
  const process = {
    slot,
    pid,
    identity,
    ...(origin === undefined ? {} : { origin }),
    send: async () => undefined,
    subscribeMessage: (listener: (message: unknown) => void) => {
      if (exitProven) listener({
        status: 'worker-drained', ...identity,
        boot_nonce: `50000000-0000-4000-8000-0000000000${slot}${slot}`,
        pid, revision: 7, content_hash: HASH, plugin_catalog_hash: HASH, publication: null,
      });
      return () => undefined;
    },
    subscribeExit: (listener: (evidence: { exited: true; pid: number }) => void) => {
      exitListeners.push(listener);
      return () => undefined;
    },
    terminate: async () => {
      if (exitProven) for (const listener of [...exitListeners]) listener({ exited: true, pid });
    },
  } as any;
  return {
    process, revision: 7, content_hash: HASH, plugin_catalog_hash: HASH,
    publication: null, private_port: 10_000 + slot,
  } as any;
}

function publicationHarness(oldWorkers: readonly any[], options: { readonly recoveringMaster?: boolean } = {}) {
  const active = {
    operation: { mutation_id: 'mutation-1', state: 'committed', drain_recovery_generation: 0 },
    snapshot: { revision: 7, content_hash: HASH, aggregate: { plugin_activations: [] } },
    targets: [],
  } as any;
  const factoryOwned = new Set(oldWorkers.map(({ process }) => process));
  const repository = {
    beginPublication: () => undefined,
    getActivePublication: () => active,
    markDraining: () => undefined,
    finalizePublication: (_mutationId: string, outcome: unknown) => {
      active.finalOutcome = outcome;
      return active.operation;
    },
  } as any;
  const workerFactory = {
    spawn: () => { throw new Error('unexpected spawn'); },
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
      '30000000-0000-4000-8000-000000000001', 0,
      () => '40000000-0000-4000-8000-000000000001',
    ),
    oldWorkers,
    pluginCatalogHash: HASH,
    admission: { prepare: async () => ({
      commit: async () => undefined, abort: async () => undefined,
      releaseRetiredAfterExitProof: async () => { retiredReleases += 1; },
    }) },
    recoveringMaster: options.recoveringMaster ?? false,
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
      operation, snapshot: { revision: 7, content_hash: HASH, aggregate: {} }, targets: [],
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
      admission: { prepare: async () => ({ commit: async () => undefined }) } as any,
      recoveringMaster: false, stderr: { write: (line: string) => { lines.push(line); } },
    }, active(), []);

    const events = lines.map((line) => JSON.parse(line));
    expect(events.map(({ phase, boundary }) => `${phase}:${boundary}`)).toEqual([
      'awaitReplacements:enter', 'awaitReplacements:exit',
      'admission.prepare:enter', 'admission.prepare:exit',
      'markDraining:enter', 'markDraining:exit',
      'admission.commit:enter', 'admission.commit:exit',
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

  test('retains ownership and fails fatally when adopted old workers have no exit proof', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'adopted')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(harness.factoryOwned.size).toBe(2);
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('recovering master really drains adopted old workers and converges on exact exit proof', async () => {
    const oldWorkers = [servingWorker(0, 'adopted', true)];
    const harness = publicationHarness(oldWorkers, { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'converged', old_workers_exited: true });
  });

  test('recovering master without old-worker exit proof fails fatally and retains ownership', async () => {
    const oldWorkers = [servingWorker(0, 'adopted')];
    const harness = publicationHarness(oldWorkers, { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(harness.factoryOwned.size).toBe(1);
    expect(harness.active.finalOutcome).toBeUndefined();
  });

  test('recovering master without rebuilt old-worker ownership treats an empty drain set as missing proof', async () => {
    const harness = publicationHarness([], { recoveringMaster: true });

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect((outcome as { readonly error?: unknown }).error).toBeInstanceOf(TypeError);
    // No finalize, no retired release; admission and ownership stay exactly as committed.
    expect(harness.active.finalOutcome).toBeUndefined();
    expect(harness.retiredReleases()).toBe(0);
  });

  test('non-recovery publication with zero old workers still converges', async () => {
    const harness = publicationHarness([]);

    const outcome = await runPublication(harness.options, harness.active, []);

    expect(outcome).toMatchObject({ kind: 'converged', http_status: 200 });
    expect(harness.active.finalOutcome).toMatchObject({ outcome: 'converged', old_workers_exited: true });
    expect(harness.retiredReleases()).toBe(1);
  });

  test('does not release mixed adopted and spawned unconfirmed old workers', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'spawned')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(harness.factoryOwned.size).toBe(2);
    expect(harness.active.finalOutcome).toBeUndefined();
  });
});
