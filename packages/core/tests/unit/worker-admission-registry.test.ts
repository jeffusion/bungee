import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import {
  MasterConfigPublicationError,
  type ConfigPublicationWorkerProcess,
  type ServingConfigWorker,
} from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/messages';
import { WorkerAdmissionRegistry } from '../../src/public-listener/admission-registry';

const MASTER_GENERATION = '10000000-0000-4000-8000-000000000001';
const CONTENT_HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;
const CATALOG_HASH: Sha256Digest = `sha256:${'b'.repeat(64)}`;

class FakeProcess implements ConfigPublicationWorkerProcess {
  readonly identity: ConfigProcessIdentity;

  constructor(readonly slot: number, readonly pid: number, instance: number) {
    this.identity = {
      master_generation: MASTER_GENERATION,
      worker_instance_id: `20000000-0000-4000-8000-${String(instance).padStart(12, '0')}`,
      worker_slot: slot,
    };
  }

  async send(_message: ConfigMasterMessage): Promise<void> {}
  subscribeMessage(_listener: (message: unknown) => void): () => void { return () => undefined; }
  subscribeExit(_listener: (evidence: { readonly exited: true; readonly pid: number }) => void): () => void {
    return () => undefined;
  }
  async terminate(_mode: 'graceful' | 'force'): Promise<void> {}
}

function serving(slot: number, pid = 100 + slot): ServingConfigWorker {
  return {
    process: new FakeProcess(slot, pid, slot + 1),
    revision: 7,
    content_hash: CONTENT_HASH,
    plugin_catalog_hash: CATALOG_HASH,
    private_port: 41_000 + slot,
    publication: {
      mutation_id: 'registry-test',
      attempt_no: 1,
      drain_recovery_generation: 0,
    },
  };
}

describe('WorkerAdmissionRegistry', () => {
  test('commits a frozen slot-sorted snapshot and selects it round-robin', () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    const workers = [serving(2), serving(0), serving(1)];

    // When
    registry.prepare(workers).commit();

    // Then
    expect(registry.snapshot().map(({ process }) => process.slot)).toEqual([0, 1, 2]);
    expect([registry.select()?.process.slot, registry.select()?.process.slot,
      registry.select()?.process.slot, registry.select()?.process.slot]).toEqual([0, 1, 2, 0]);
    expect(Object.isFrozen(registry.snapshot())).toBeTrue();
    expect(registry.snapshot().every(Object.isFrozen)).toBeTrue();
    expect(Object.isFrozen(registry.snapshot()[0]?.publication)).toBeTrue();
    expect(Reflect.set(registry.snapshot(), '0', serving(9))).toBeFalse();
    const first = registry.snapshot()[0];
    if (first === undefined) throw new Error('admitted worker missing');
    expect(Reflect.set(first, 'revision', 99)).toBeFalse();
  });

  test('isolates a prepared snapshot from later input mutation and commits idempotently', () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    const worker = {
      process: new FakeProcess(0, 100, 1),
      revision: 7,
      content_hash: CONTENT_HASH,
      plugin_catalog_hash: CATALOG_HASH,
      private_port: 41_000,
      publication: {
        mutation_id: 'registry-test',
        attempt_no: 1,
        drain_recovery_generation: 0,
      },
    } satisfies ServingConfigWorker;
    const workers: ServingConfigWorker[] = [worker];
    const prepared = registry.prepare(workers);

    // When
    worker.revision = 99;
    worker.private_port = 49_999;
    worker.publication.attempt_no = 9;
    workers.splice(0, 1, serving(1));
    prepared.commit();
    prepared.commit();

    // Then
    expect(registry.snapshot()).toMatchObject([{ revision: 7, private_port: 41_000 }]);
    expect(registry.snapshot()[0]?.publication?.attempt_no).toBe(1);
    expect(registry.snapshot()[0]?.process.slot).toBe(0);
  });

  test('rejects empty, malformed, inconsistent, and duplicate serving evidence', () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    const malformed = { ...serving(0), private_port: 0 };
    const extra = { ...serving(0), unexpected: true };
    const inconsistentRevision = [serving(0), { ...serving(1), revision: 8 }];
    const inconsistentContent = [serving(0), { ...serving(1), content_hash: `sha256:${'c'.repeat(64)}` as const }];
    const inconsistentCatalog = [serving(0), { ...serving(1), plugin_catalog_hash: `sha256:${'d'.repeat(64)}` as const }];
    const duplicateProcess = serving(0);
    const duplicatePid = serving(1, duplicateProcess.process.pid);

    // When / Then
    for (const evidence of [[], [malformed], [extra], inconsistentRevision,
      inconsistentContent, inconsistentCatalog, [duplicateProcess, duplicateProcess],
      [duplicateProcess, duplicatePid]]) {
      expect(() => registry.prepare(evidence)).toThrow(MasterConfigPublicationError);
    }
    expect(registry.snapshot()).toEqual([]);
  });

  test('resets round-robin on commit and clears admission for shutdown', () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([serving(0), serving(1)]).commit();
    const replaced = registry.snapshot()[0]?.process;
    registry.select();

    // When
    registry.prepare([serving(2), serving(1)]).commit();

    // Then
    expect(registry.snapshot().some(({ process }) => process === replaced)).toBeFalse();
    expect(registry.select()?.process.slot).toBe(1);
    registry.clear();
    expect(registry.select()).toBeNull();
    expect(registry.snapshot()).toEqual([]);
  });
});
