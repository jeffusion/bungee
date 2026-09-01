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

    // Then
    expect(fixture.admission.snapshot()).toEqual([]);
    expect(fixture.admission.select()).toBeNull();
    gate.resolve();
    await settle();
    expect(fixture.repairCalls.map((workers) => workers.map(({ process }) => process.pid))).toEqual([[7001], []]);
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
