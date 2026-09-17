import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { ProcessIdentityAllocator } from '../../src/config-publication/process-identity';
import { OwnedProcessCollection } from '../../src/config-publication/process-cleanup';
import { runPublication } from '../../src/config-publication/publication-runner';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;

function servingWorker(slot: number, origin: string | undefined) {
  const process = {
    slot,
    pid: 100 + slot,
    identity: {
      master_generation: '30000000-0000-4000-8000-000000000001',
      worker_instance_id: `40000000-0000-4000-8000-00000000000${slot + 1}`,
      worker_slot: slot,
    },
    ...(origin === undefined ? {} : { origin }),
    send: async () => undefined,
    subscribeMessage: () => () => undefined,
    subscribeExit: () => () => undefined,
    terminate: async () => undefined,
  } as any;
  return {
    process, revision: 7, content_hash: HASH, plugin_catalog_hash: HASH,
    publication: null, private_port: 10_000 + slot,
  } as any;
}

function publicationHarness(oldWorkers: readonly any[]) {
  const active = {
    operation: { mutation_id: 'mutation-1', state: 'committed', drain_recovery_generation: 0 },
    snapshot: { revision: 7, content_hash: HASH, aggregate: { plugin_activations: [] } },
    targets: [],
  } as any;
  const factoryOwned = new Set(oldWorkers.map(({ process }) => process));
  const forgotten: any[][] = [];
  const repository = {
    beginPublication: () => undefined,
    getActivePublication: () => active,
    markDraining: () => undefined,
    finalizePublication: (_mutationId: string, outcome: unknown) => {
      active.finalOutcome = outcome;
      return active.operation;
    },
  } as any;
  const options = {
    repository,
    workerFactory: {
      spawn: () => { throw new Error('unexpected spawn'); },
      markCommitted: () => undefined,
      disconnectProcesses: () => { throw new Error('unexpected disconnect'); },
      forgetProcessesWithoutExitProof: (processes: readonly any[]) => {
        forgotten.push([...processes]);
        for (const process of processes) factoryOwned.delete(process);
      },
      discardConfirmedUncommitted: async () => undefined,
    },
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
      commit: async () => undefined, abort: async () => undefined, releaseRetiredAfterExitProof: async () => undefined,
    }) },
  } as any;
  return { active, factoryOwned, forgotten, options };
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

  test('forgets all unconfirmed adopted old workers without retaining ownership', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'adopted')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'degraded', error_code: 'old_worker_drain_failed' });
    expect(harness.forgotten).toEqual([[oldWorkers[0].process, oldWorkers[1].process]]);
    expect(harness.factoryOwned.size).toBe(0);
    expect(harness.active.finalOutcome).toMatchObject({ retired_without_exit_proof: true });
  });

  test('does not forget mixed adopted and spawned unconfirmed old workers', async () => {
    const oldWorkers = [servingWorker(0, 'adopted'), servingWorker(1, 'spawned')];
    const harness = publicationHarness(oldWorkers);

    const outcome = await runPublication(harness.options, harness.active, oldWorkers);

    expect(outcome).toMatchObject({ kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed' });
    expect(harness.forgotten).toEqual([]);
    expect(harness.factoryOwned.size).toBe(2);
    expect(harness.active.finalOutcome).toBeUndefined();
  });
});
