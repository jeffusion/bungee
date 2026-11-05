import { resolve } from 'node:path';
import type { ConfigRepository } from '../../src/config-storage';

let sequence = 0;

function nextUuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** A synthetic pre-fork identity and original guard facts for storage tests. */
export function launchFixture(slot = 0) {
  const workerInstanceId = nextUuid();
  return {
    identity: { master_generation: '00000000-0000-4000-8000-000000000001', worker_instance_id: workerInstanceId, worker_slot: slot },
    guard: {
      schema: 'bungee-process-lifetime-guard-v1' as const,
      identity: nextUuid(),
      process_instance_id: workerInstanceId,
      path: resolve(`/tmp/worker-launch-fixture-${sequence}`),
      device: '2049',
      inode: '42',
      host_boot_id: `linux:${'00000000-0000-4000-8000-000000000002'}`,
      domain: 'bungee-local-flock' as const,
    },
  };
}

/** Records a real launch and proves exit plus cleanup for the exact attempt. */
export function settleWorkerLaunch(
  repository: ConfigRepository, mutationId: string, workerSlot: number, attemptNo: number, now: number,
): void {
  const { identity, guard } = launchFixture(workerSlot);
  repository.registerWorkerLaunch(identity, guard,
    { mutation_id: mutationId, worker_slot: workerSlot, attempt_no: attemptNo }, now);
  repository.recordWorkerLaunchAdmitted(identity.worker_instance_id, now);
  repository.recordWorkerLaunchExit(identity.worker_instance_id,
    { kind: 'exited', cleanup: 'released' }, now);
}

/** Proves the attempt never forked; use only when the test did not simulate a process. */
export function fenceWorkerLaunch(
  repository: ConfigRepository, mutationId: string, workerSlot: number, attemptNo: number, now: number,
): void {
  repository.fenceWorkerLaunchNotStarted(mutationId, workerSlot, attemptNo, now);
}
