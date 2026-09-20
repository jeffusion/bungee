import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  signWorkerDescriptor,
  type WorkerDescriptorBody,
} from '../../src/supervision';
import { discoverSupervisedWorkers } from '../../src/master-runtime/supervised-worker-discovery';
import type { WorkerControllerClient, WorkerStatusPayload } from '../../src/master-runtime/supervised-worker-client';

const ROOT = new Uint8Array(32).fill(8);
const AUTHORITY = { controller_epoch: 3, controller_id: '80000000-0000-4000-8000-000000000001' } as const;
const GENERATION = '10000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;

function worker(workerInstanceId: string, bootNonce: string, controlPort: number, pid: number, privatePort: number) {
  const credential = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(ROOT, GENERATION, workerInstanceId, 0), bootNonce,
  );
  const message = {
    status: 'config-ready' as const, master_generation: GENERATION, worker_instance_id: workerInstanceId,
    worker_slot: 0, boot_nonce: bootNonce, pid, revision: 1, content_hash: HASH,
    plugin_catalog_hash: CATALOG, private_port: privatePort, plugin_runtime_generation: 1,
    required_plugins: [], serving_plugins: [], publication: null,
  };
  const body: WorkerDescriptorBody = {
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: GENERATION,
    worker_instance_id: workerInstanceId, worker_slot: 0, boot_nonce: bootNonce, pid, control_port: controlPort,
    master_control_port: 3011, phase: 'serving', frozen: false, private_port: privatePort, revision: 1, content_hash: HASH,
    plugin_catalog_hash: CATALOG, started_at: 1, evidence: { kind: 'ready', message },
  };
  const status = {
    schema: 'bungee-worker-status-v1' as const, role: 'worker' as const, master_generation: GENERATION,
    worker_instance_id: workerInstanceId, worker_slot: 0, boot_nonce: bootNonce, pid, control_port: controlPort,
    master_control_port: 3011, phase: 'serving' as const, frozen: false, private_port: privatePort, revision: 1, content_hash: HASH,
    plugin_catalog_hash: CATALOG, started_at: 1, evidence: { kind: 'ready' as const, message }, authority: AUTHORITY,
    snapshot_hash: HASH, request_correlation: '90000000-0000-4000-8000-000000000001', replay: { sequence: 1, request_id: 'a0000000-0000-4000-8000-000000000001' },
  } as WorkerStatusPayload;
  return { credential, descriptor: signWorkerDescriptor(body, credential.process_key), status };
}

test('orphan-inventory returns authenticated overlapping workers while exact-admission fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-discovery-'));
  const a = worker('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 43101, 101, 44101);
  const b = worker('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 43102, 102, 44102);
  const files = [
    [join(directory, 'a.json'), a], [join(directory, 'b.json'), b],
  ] as const;
  for (const [file, value] of files) await writeFile(file, JSON.stringify(value.descriptor));
  const clientFor = (identity: { readonly worker_instance_id: string }) => ({
    attach: async () => identity.worker_instance_id === a.status.worker_instance_id ? a.status : b.status,
  } as unknown as WorkerControllerClient);
  try {
    const inventory = await discoverSupervisedWorkers({
      runtimeWorkersDirectory: directory, rootKey: ROOT, authority: AUTHORITY, masterControlPort: 3011, mode: 'orphan-inventory', clientFor,
    });
    expect(inventory.workers).toHaveLength(2);
    expect(inventory.issues.some((item) => item.kind === 'duplicate')).toBe(true);

    const exact = await discoverSupervisedWorkers({
      runtimeWorkersDirectory: directory, rootKey: ROOT, authority: AUTHORITY, masterControlPort: 3011, mode: 'exact-admission',
      expectedAdmission: {
        master_generation: GENERATION, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
        workers: [{ master_generation: GENERATION, worker_instance_id: a.status.worker_instance_id, worker_slot: 0,
          boot_nonce: a.status.boot_nonce, private_port: a.status.private_port! }],
      }, clientFor,
    });
    expect(exact.workers).toHaveLength(1);
    expect(exact.workers[0]!.status.worker_instance_id).toBe(a.status.worker_instance_id);

    for (const [label, status, expectedKind] of [
      ['same-port-other-evidence', { ...a.status, revision: 2 }, 'malformed'],
      ['missing-master-port', { ...a.status, master_control_port: undefined }, 'master_control_mismatch'],
      ['different-master-port', { ...a.status, master_control_port: 3012 }, 'master_control_mismatch'],
    ] as const) {
      const result = await discoverSupervisedWorkers({
        runtimeWorkersDirectory: directory, rootKey: ROOT, authority: AUTHORITY, masterControlPort: 3011, mode: 'exact-admission',
        expectedAdmission: {
          master_generation: GENERATION, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
          workers: [{ master_generation: GENERATION, worker_instance_id: a.status.worker_instance_id, worker_slot: 0,
            boot_nonce: a.status.boot_nonce, private_port: a.status.private_port! }],
        },
        clientFor: (identity) => ({ attach: async () => identity.worker_instance_id === a.status.worker_instance_id ? status : b.status } as unknown as WorkerControllerClient),
      });
      expect(result.issues.some((issue) => issue.kind === expectedKind), label).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('orphan-inventory reports tampered descriptors without authenticating or returning them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-discovery-tampered-'));
  const value = worker('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', 43103, 103, 44103);
  const tampered = { ...value.descriptor, pid: value.descriptor.pid + 1 };
  await writeFile(join(directory, 'tampered.json'), JSON.stringify(tampered));
  let attaches = 0;
  try {
    const result = await discoverSupervisedWorkers({
      runtimeWorkersDirectory: directory, rootKey: ROOT, authority: AUTHORITY, masterControlPort: 3011, mode: 'orphan-inventory',
      clientFor: () => { attaches += 1; throw new Error('must not attach'); },
    });
    expect(result.workers).toHaveLength(0);
    expect(result.issues[0]?.kind).toBe('tampered');
    expect(attaches).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
