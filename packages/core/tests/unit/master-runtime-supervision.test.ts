import { describe, expect, test } from 'bun:test';
import type { StartupPublicationOutcome } from '../../src/config-publication';
import { serving, settle, supervisionFixture, type RepairContext } from './master-runtime-supervision.fixtures';

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MasterRuntime worker supervision', () => {
  test('removes an exited worker before serialized replacement commits', async () => {
    // Given
    const fixture = supervisionFixture();
    const gate = deferred();
    fixture.setRepair(async (context) => {
      expect(context.survivors.map(({ process }) => process.pid)).toEqual([7001]);
      await gate.promise;
      return fixture.replace(context);
    });
    await fixture.runtime.start();

    // When
    fixture.pool.exit(fixture.initial[0]);
    await settle();

    // Then
    expect(fixture.admission.snapshot().map(({ process }) => process.pid)).toEqual([7001]);
    expect(fixture.admission.select()?.process.pid).toBe(7001);
    gate.resolve();
    await settle();
    expect(fixture.admission.snapshot().map(({ process }) => process.pid)).toEqual([7100, 7001]);
  });

  test('clears admission when all exit and recomputes survivors after a dirty repair', async () => {
    // Given
    const fixture = supervisionFixture();
    const gate = deferred();
    fixture.setRepair(async (context): Promise<StartupPublicationOutcome> => {
      if (context.round === 1) {
        await gate.promise;
        return { kind: 'startup_failed', failures: [], serving: context.survivors };
      }
      return fixture.replace(context);
    });
    await fixture.runtime.start();

    // When
    fixture.pool.exit(fixture.initial[0]);
    fixture.pool.exit(fixture.initial[1]);
    await settle();

    // Then
    expect(fixture.admission.snapshot()).toEqual([]);
    expect(fixture.admission.select()).toBeNull();
    gate.resolve();
    await settle();
    expect(fixture.repairCalls.map((workers) => workers.map(({ process }) => process.pid))).toEqual([[], []]);
    expect(fixture.admission.snapshot()).toHaveLength(2);
  });

  test('reconciles an admitted exit raised during listener startup', async () => {
    // Given
    const fixture = supervisionFixture();
    fixture.setListenerStart(() => { fixture.pool.exit(fixture.initial[0]); });

    // When
    await fixture.runtime.start();
    await settle();

    // Then
    expect(fixture.repairCalls.map((workers) => workers.map(({ process }) => process.pid))).toEqual([[7001]]);
    expect(fixture.admission.snapshot()).toHaveLength(2);
  });

  test('ignores an exited worker that is no longer admitted', async () => {
    // Given
    const fixture = supervisionFixture();
    await fixture.runtime.start();
    const drained = serving(0, 6999);
    fixture.pool.add(drained);

    // When
    fixture.pool.exit(drained);
    await settle();

    // Then
    expect(fixture.repairCalls).toEqual([]);
    expect(fixture.admission.snapshot().map(({ process }) => process.pid)).toEqual([7000, 7001]);
  });

  test('repairs an unavailable admitted worker once without requiring an exit', async () => {
    const fixture = supervisionFixture();
    await fixture.runtime.start();
    fixture.pool.unavailable(fixture.initial[0]);
    await settle();
    expect(fixture.repairCalls.map((workers) => workers.map(({ process }) => process.pid))).toEqual([[7001]]);
    expect(fixture.admission.snapshot().map(({ process }) => process.pid)).toEqual([7100, 7001]);
  });

  test('coalesces repeated unavailable notifications into one replacement batch', async () => {
    const fixture = supervisionFixture();
    await fixture.runtime.start();
    fixture.pool.unavailable(fixture.initial[0]);
    fixture.pool.unavailable(fixture.initial[0]);
    await settle();
    expect(fixture.repairCalls).toHaveLength(1);
  });

  test('repairs once when recovery gate releases without a worker exit', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const generation = fixture.gate!.activate();
    await fixture.runtime.start();

    fixture.gate!.release(generation);
    await settle();

    expect(fixture.repairCalls).toHaveLength(1);
  });

  test('SUP release-during-starting schedules one repair after startup', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const generation = fixture.gate!.activate();
    fixture.setListenerStart(() => { fixture.gate!.release(generation); });

    await fixture.runtime.start();
    await settle();

    expect(fixture.repairCalls).toHaveLength(1);
  });

  test('SUP ignores a gate release while idle', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const generation = fixture.gate!.activate();
    fixture.gate!.release(generation);

    await settle();

    expect(fixture.repairCalls).toEqual([]);
  });

  test('SUP ignores a gate release while stopped', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    await fixture.runtime.start();
    await fixture.runtime.shutdown();
    const generation = fixture.gate!.activate();
    fixture.gate!.release(generation);

    await settle();

    expect(fixture.repairCalls).toEqual([]);
  });

  test('ignores old-generation success and repairs the latest released generation', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const oldRepair = deferred();
    const contexts: RepairContext[] = [];
    fixture.setRepair(async (context) => {
      contexts.push(context);
      if (context.round === 1) {
        await oldRepair.promise;
        return { kind: 'startup_ready', serving: fixture.initial };
      }
      return fixture.replace(context);
    });
    const oldGeneration = fixture.gate!.activate();
    await fixture.runtime.start();
    fixture.gate!.release(oldGeneration);
    await settle();

    const newGeneration = fixture.gate!.activate();
    fixture.gate!.release(newGeneration);
    oldRepair.resolve();
    await settle();

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.generation).toBe(oldGeneration);
    expect(contexts[1]?.generation).toBe(newGeneration);
    expect(contexts[0]?.signal).not.toBe(contexts[1]?.signal);
    expect(fixture.repairCalls).toHaveLength(2);
  });

  test('coalesces duplicate release notifications for one generation', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const generation = fixture.gate!.activate();
    await fixture.runtime.start();

    fixture.gate!.release(generation);
    fixture.gate!.release(generation);
    await settle();

    expect(fixture.gate!.releaseCount).toBe(1);
    expect(fixture.repairCalls).toHaveLength(1);
  });

  test('isolates a release listener scheduling error', async () => {
    const failures: Error[] = [];
    const fixture = supervisionFixture((error) => { failures.push(error); }, { recoveryGate: true });
    const generation = fixture.gate!.activate();
    await fixture.runtime.start();
    fixture.setRecoveryEnqueue(() => { throw new Error('release listener failed'); });

    expect(() => fixture.gate!.release(generation)).not.toThrow();
    await settle();
    await fixture.runtime.shutdown().catch(() => undefined);

    expect(failures).toHaveLength(1);
  });

  test('detaches listeners before cleanup can race with gate release', async () => {
    const fixture = supervisionFixture(undefined, { recoveryGate: true });
    const cleanup = deferred();
    const cleanupEntered = deferred();
    fixture.setBeforeCleanup(async () => {
      cleanupEntered.resolve();
      await cleanup.promise;
    });
    const generation = fixture.gate!.activate();
    await fixture.runtime.start();

    const shutdown = fixture.runtime.shutdown();
    await cleanupEntered.promise;
    fixture.gate!.release(generation);

    expect(fixture.pool.listeners.size).toBe(0);
    expect(fixture.gate!.listeners.size).toBe(0);
    cleanup.resolve();
    await shutdown;
  });

  test('reports an unavailable admission outcome unknown exactly once', async () => {
    const failures: Error[] = [];
    const fixture = supervisionFixture((error) => { failures.push(error); });
    fixture.setRepair(async ({ survivors }) => ({ kind: 'startup_degraded', http_status: 202,
      error_code: 'admission_outcome_unknown', recovery_disposition: 'fatal', failures: [], serving: survivors }));
    await fixture.runtime.start();
    fixture.pool.unavailable(fixture.initial[0]);
    await settle();
    await fixture.runtime.shutdown().catch(() => undefined);
    expect(failures).toHaveLength(1);
  });

  test('fails exactly once for every hostile startup evidence dimension without committing it', async () => {
    const hostile = [
      (workers: readonly any[]) => workers.map((worker) => ({ ...worker, revision: worker.revision - 1 })),
      (workers: readonly any[]) => workers.map((worker) => ({ ...worker, content_hash: 'sha256:' + 'c'.repeat(64) })),
      (workers: readonly any[]) => workers.map((worker) => ({ ...worker, plugin_catalog_hash: 'sha256:' + 'c'.repeat(64) })),
      (workers: readonly any[]) => [workers[0], workers[0]],
      (workers: readonly any[]) => [workers[0]],
      (workers: readonly any[]) => workers.map((worker, index) => index === 0
        ? { ...worker, process: { ...worker.process, slot: 2 } } : worker),
      (workers: readonly any[]) => workers.map((worker, index) => index === 0
        ? { ...worker, process: { ...worker.process, identity: { ...worker.process.identity, worker_slot: 1 } } } : worker),
      (workers: readonly any[]) => workers.map((worker) => ({ ...worker, private_port: worker.private_port + 1 })),
    ];
    for (const makeEvidence of hostile) {
      const failures: Error[] = [];
      const fixture = supervisionFixture((error) => { failures.push(error); });
      // Keep process objects admitted: each case isolates evidence metadata, not a prior identity rejection.
      fixture.setRepair(async () => ({ kind: 'startup_ready', serving: makeEvidence(fixture.initial) }));
      await fixture.runtime.start();
      fixture.pool.unavailable(fixture.initial[0]);
      await settle();
      const admittedBeforeShutdown = fixture.admission.snapshot();
      await fixture.runtime.shutdown().catch(() => undefined);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: 'repair_failed' });
      expect(admittedBeforeShutdown).toEqual([]);
      expect(fixture.repairCalls).toHaveLength(1);
    }
  });

  test('fails exactly once when the evidence process is no longer pool-owned', async () => {
    const failures: Error[] = [];
    const fixture = supervisionFixture((error) => { failures.push(error); });
    fixture.setRepair(async () => ({ kind: 'startup_ready', serving: fixture.initial }));
    await fixture.runtime.start();
    let admissionBeforeShutdownCleanup: ReturnType<typeof fixture.admission.snapshot> | undefined;
    const clearAdmission = fixture.admission.clear.bind(fixture.admission);
    fixture.admission.clear = () => {
      admissionBeforeShutdownCleanup = fixture.admission.snapshot();
      clearAdmission();
    };
    fixture.pool.owned.delete(fixture.initial[0].process);
    fixture.pool.unavailable(fixture.initial[0]);
    await settle();
    expect(admissionBeforeShutdownCleanup).toEqual(fixture.initial);
    expect(failures).toHaveLength(1);
    await fixture.runtime.shutdown().catch(() => undefined);
    expect(fixture.admission.snapshot()).toEqual([]);
  });

  test('fails startup before binding when admitted evidence is not pool-owned', async () => {
    // Given
    const fixture = supervisionFixture();
    fixture.pool.owned.delete(fixture.initial[0].process);

    // When
    const error = await fixture.runtime.start().catch((failure: unknown) => failure);

    // Then
    expect(String(error)).toContain('admission');
    expect(fixture.runtime.publicPort).toBeNull();
  });

  test('fails closed once after three failed repair rounds without an unhandled rejection', async () => {
    // Given
    const fixture = supervisionFixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    fixture.setRepair(async ({ survivors }: RepairContext) =>
      ({ kind: 'startup_failed', failures: [], serving: survivors }));
    await fixture.runtime.start();

    // When
    fixture.pool.exit(fixture.initial[0]);
    await settle();
    await fixture.runtime.shutdown().catch(() => undefined);

    // Then
    process.off('unhandledRejection', onUnhandled);
    expect(fixture.repairCalls).toHaveLength(3);
    expect(fixture.pool.shutdownCount).toBe(1);
    expect(fixture.pool.unsubscribeCount).toBe(1);
    expect(fixture.runtime.publicPort).toBeNull();
    const error = await fixture.runtime.shutdown().catch((failure: unknown) => failure);
    expect(String(error)).toContain('repair');
    expect(unhandled).toEqual([]);
  });

  test('reports fatal supervision only after shutdown cleanup completes', async () => {
    let fixture: ReturnType<typeof supervisionFixture>;
    const failures: Error[] = [];
    fixture = supervisionFixture((error) => {
      expect(fixture.pool.shutdownCount).toBe(1);
      expect(fixture.runtime.publicPort).toBeNull();
      expect(fixture.admission.snapshot()).toEqual([]);
      failures.push(error);
    });
    fixture.setRepair(async ({ survivors }: RepairContext) =>
      ({ kind: 'startup_failed', failures: [], serving: survivors }));
    await fixture.runtime.start();

    fixture.pool.exit(fixture.initial[0]);
    await settle();
    await fixture.runtime.shutdown().catch(() => undefined);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'MasterRuntimeError', code: 'repair_failed' });
  });

  test('unsubscribes before normal shutdown worker termination', async () => {
    // Given
    const fixture = supervisionFixture();
    const gate = deferred();
    fixture.setRepair(async (context) => {
      await gate.promise;
      return fixture.replace(context);
    });
    await fixture.runtime.start();
    fixture.pool.exit(fixture.initial[0]);

    // When
    const shutdown = fixture.runtime.shutdown();

    // Then
    expect(fixture.pool.unsubscribeCount).toBe(1);
    expect(fixture.pool.listeners.size).toBe(0);
    expect(fixture.pool.shutdownCount).toBe(0);
    gate.resolve();
    await shutdown;
    expect(fixture.pool.shutdownCount).toBe(1);
  });
});
