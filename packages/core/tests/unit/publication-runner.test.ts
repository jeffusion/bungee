import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { ProcessIdentityAllocator } from '../../src/config-publication/process-identity';
import { OwnedProcessCollection } from '../../src/config-publication/process-cleanup';
import { runPublication } from '../../src/config-publication/publication-runner';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;

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
});
