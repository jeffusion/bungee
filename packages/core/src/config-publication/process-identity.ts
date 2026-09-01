import { isLowercaseUuid } from '../config-storage/validation';
import type { ConfigProcessIdentity } from './types';
import { sameProcessIdentity } from './message-fields';
import {
  MasterConfigPublicationError,
  type ConfigPublicationWorkerProcess,
  type ServingConfigWorker,
} from './coordinator-types';

function invalid(message: string): never {
  throw new MasterConfigPublicationError('invalid_options', message);
}

function validProcess(
  process: ConfigPublicationWorkerProcess,
  masterGeneration: string,
  workerCount: number,
): boolean {
  return Number.isSafeInteger(process.pid) && process.pid > 0
    && Number.isSafeInteger(process.slot) && process.slot >= 0 && process.slot < workerCount
    && process.slot === process.identity.worker_slot
    && process.identity.master_generation === masterGeneration
    && isLowercaseUuid(process.identity.master_generation)
    && isLowercaseUuid(process.identity.worker_instance_id);
}

export function validateProcessSet(
  workers: readonly ServingConfigWorker[],
  masterGeneration: string,
  workerCount: number,
): void {
  const references = new Set<ConfigPublicationWorkerProcess>();
  const pids = new Set<number>();
  const slots = new Set<number>();
  const instances = new Set<string>();
  for (const { process } of workers) {
    if (!validProcess(process, masterGeneration, workerCount)
      || references.has(process) || pids.has(process.pid) || slots.has(process.slot)
      || instances.has(process.identity.worker_instance_id)) {
      invalid('worker process set is invalid');
    }
    references.add(process);
    pids.add(process.pid);
    slots.add(process.slot);
    instances.add(process.identity.worker_instance_id);
  }
}

export function validateReplacementProcess(
  process: ConfigPublicationWorkerProcess,
  expected: ConfigProcessIdentity,
  occupied: readonly ServingConfigWorker[],
  replacements: readonly ConfigPublicationWorkerProcess[],
  workerCount: number,
): void {
  if (!validProcess(process, expected.master_generation, workerCount)
    || process.slot !== expected.worker_slot || !sameProcessIdentity(process.identity, expected)) {
    invalid('spawned worker identity is invalid');
  }
  const others = [...occupied.map(({ process: current }) => current), ...replacements];
  if (others.some((other) => other === process || other.pid === process.pid
    || other.identity.worker_instance_id === process.identity.worker_instance_id)) {
    invalid('spawned worker conflicts with an existing process');
  }
}

export class ProcessIdentityAllocator {
  private readonly issued = new Map<string, ConfigPublicationWorkerProcess | null>();

  constructor(
    readonly masterGeneration: string,
    private readonly workerCount: number,
    private readonly createWorkerInstanceId: () => string,
  ) {
    if (!isLowercaseUuid(masterGeneration)) invalid('master generation must be a lowercase UUID');
  }

  allocate(slots: readonly number[]): readonly ConfigProcessIdentity[] {
    const identities = slots.map((workerSlot) => ({
      master_generation: this.masterGeneration,
      worker_instance_id: this.createWorkerInstanceId(),
      worker_slot: workerSlot,
    }));
    const batch = new Set<string>();
    for (const identity of identities) {
      if (!Number.isSafeInteger(identity.worker_slot) || identity.worker_slot < 0
        || identity.worker_slot >= this.workerCount || !isLowercaseUuid(identity.worker_instance_id)
        || this.issued.has(identity.worker_instance_id) || batch.has(identity.worker_instance_id)) {
        invalid('worker instance id allocation is invalid or duplicated');
      }
      batch.add(identity.worker_instance_id);
    }
    for (const identity of identities) this.issued.set(identity.worker_instance_id, null);
    return identities;
  }

  register(workers: readonly ServingConfigWorker[]): void {
    validateProcessSet(workers, this.masterGeneration, this.workerCount);
    for (const { process } of workers) {
      const registered = this.issued.get(process.identity.worker_instance_id);
      if (registered !== undefined && registered !== process) {
        invalid('worker instance id belongs to another process');
      }
    }
    for (const { process } of workers) {
      this.issued.set(process.identity.worker_instance_id, process);
    }
  }

  bind(identity: ConfigProcessIdentity, process: ConfigPublicationWorkerProcess): void {
    const registered = this.issued.get(identity.worker_instance_id);
    if (registered !== null) invalid('worker instance id was not freshly allocated');
    this.issued.set(identity.worker_instance_id, process);
  }
}
