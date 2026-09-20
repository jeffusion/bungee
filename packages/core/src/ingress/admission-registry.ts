import { admissionSetIdentity, parseAdmissionSet, type AdmissionSet, type AdmissionWorker } from './admission-set';
import type { RateLimitWorkerAuthorization, RateLimitWorkerIdentity } from '../rate-limit';

export type AdmissionRegistryStatus = {
  readonly active: AdmissionSet | null;
  readonly prepared: AdmissionSet | null;
  readonly retired: readonly AdmissionSet[];
};

export class AdmissionRegistryError extends Error {
  readonly name = 'AdmissionRegistryError';
  constructor(readonly code: 'stale' | 'conflict' | 'missing' | 'frozen' | 'capacity', message: string) {
    super(message);
  }
}

const EMPTY: readonly AdmissionSet[] = Object.freeze([]);

export class IngressAdmissionRegistry {
  private active: AdmissionSet | null = null;
  private prepared: { readonly identity: string; readonly set: AdmissionSet } | null = null;
  private retired: readonly AdmissionSet[] = EMPTY;
  private nextIndex = 0;
  private frozen = false;
  private readonly retiredCapacity = 2;
  private readonly aborted = new Map<string, AdmissionSet>();
  private readonly releasedRetired = new Map<string, AdmissionSet>();

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (frozen) this.prepared = null;
  }

  prepare(input: unknown): AdmissionSet {
    if (this.frozen) throw new AdmissionRegistryError('frozen', 'admission registry is frozen');
    const set = parseAdmissionSet(input);
    const identity = admissionSetIdentity(set);
    const activeSequence = this.active?.admission_sequence ?? 0;
    if (set.admission_sequence <= activeSequence) {
      throw new AdmissionRegistryError('stale', 'admission sequence is not newer than active');
    }
    if (this.prepared !== null) {
      if (this.prepared.identity === identity) return this.prepared.set;
      if (set.admission_sequence <= this.prepared.set.admission_sequence) {
        throw new AdmissionRegistryError('conflict', 'prepared admission is newer or conflicts');
      }
    }
    this.prepared = Object.freeze({ identity, set });
    return set;
  }

  commit(input: unknown): void {
    if (this.frozen) throw new AdmissionRegistryError('frozen', 'admission registry is frozen');
    const set = parseAdmissionSet(input);
    const identity = admissionSetIdentity(set);
    if (this.active !== null && admissionSetIdentity(this.active) === identity) return;
    if (this.retired.some((candidate) => admissionSetIdentity(candidate) === identity)) return;
    if (this.releasedRetired.has(identity)) return;
    if (this.prepared === null || this.prepared.identity !== identity) {
      throw new AdmissionRegistryError('missing', 'commit identity does not match prepared admission');
    }
    const old = this.active;
    if (old !== null && this.retired.length >= this.retiredCapacity) {
      throw new AdmissionRegistryError('capacity', 'retired admission capacity is exhausted');
    }
    const nextRetired = old === null ? this.retired : Object.freeze([old, ...this.retired]);
    this.active = this.prepared.set;
    this.prepared = null;
    this.nextIndex = 0;
    this.retired = nextRetired;
  }

  abort(input: unknown): void {
    if (this.frozen) throw new AdmissionRegistryError('frozen', 'admission registry is frozen');
    const set = parseAdmissionSet(input);
    const identity = admissionSetIdentity(set);
    if (this.prepared === null || this.prepared.identity !== identity) {
      if (this.aborted.has(identity)) return;
      throw new AdmissionRegistryError('missing', 'abort identity does not match prepared admission');
    }
    this.prepared = null;
    this.aborted.delete(identity);
    this.aborted.set(identity, set);
    while (this.aborted.size > this.retiredCapacity) this.aborted.delete(this.aborted.keys().next().value!);
  }

  releaseRetired(input: unknown): void {
    if (this.frozen) throw new AdmissionRegistryError('frozen', 'admission registry is frozen');
    const set = parseAdmissionSet(input);
    const identity = admissionSetIdentity(set);
    const index = this.retired.findIndex((candidate) => admissionSetIdentity(candidate) === identity);
    if (index < 0) {
      if (this.releasedRetired.has(identity)) return;
      throw new AdmissionRegistryError('missing', 'retired admission identity is unknown');
    }
    this.retired = Object.freeze(this.retired.filter((_, candidateIndex) => candidateIndex !== index));
    this.releasedRetired.delete(identity);
    this.releasedRetired.set(identity, set);
    while (this.releasedRetired.size > this.retiredCapacity) {
      this.releasedRetired.delete(this.releasedRetired.keys().next().value!);
    }
  }

  select(): Pick<AdmissionWorker, 'private_port'> | null {
    const snapshot = this.active;
    if (snapshot === null || snapshot.workers.length === 0) return null;
    const worker = snapshot.workers[this.nextIndex % snapshot.workers.length] ?? null;
    this.nextIndex = (this.nextIndex + 1) % snapshot.workers.length;
    return worker;
  }

  /** Maps a signed rate-limit worker identity to the current admission state. */
  authorizeRateLimitWorker(worker: RateLimitWorkerIdentity): RateLimitWorkerAuthorization {
    const includes = (set: AdmissionSet | null): boolean => set?.workers.some((candidate) => (
      candidate.master_generation === worker.master_generation
      && candidate.worker_instance_id === worker.process_instance_id
      && candidate.boot_nonce === worker.boot_nonce
      && candidate.worker_slot === worker.worker_slot
    )) ?? false;
    if (includes(this.active)) return 'active';
    if (this.retired.some((set) => includes(set))) return 'retired';
    if (includes(this.prepared?.set ?? null)) return 'prepared';
    return 'unknown';
  }

  status(): AdmissionRegistryStatus {
    return Object.freeze({ active: this.active, prepared: this.prepared?.set ?? null, retired: this.retired });
  }
}
