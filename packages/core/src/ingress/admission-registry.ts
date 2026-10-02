import { DEFAULT_PUBLICATION_POLICY } from '@jeffusion/bungee-types';
import { admissionSetIdentity, admissionSetRetiredId, parseAdmissionSet, type AdmissionSet, type AdmissionWorker } from './admission-set';
import type { RateLimitWorkerAuthorization, RateLimitWorkerIdentity } from '../rate-limit';

export type AdmissionRegistryStatus = {
  readonly active: AdmissionSet | null;
  readonly prepared: AdmissionSet | null;
  readonly retired: readonly AdmissionSet[];
  readonly handoff?: { readonly retired_id: string; readonly pending: number; readonly complete: boolean; readonly remaining_ms: number } | null;
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
  private activeRetiredId: string | null = null;
  private prepared: { readonly identity: string; readonly set: AdmissionSet; readonly handoffTimeoutMs: number } | null = null;
  private retired: readonly AdmissionSet[] = EMPTY;
  private nextIndex = 0;
  private frozen = false;
  private readonly retiredCapacity = 2;
  private readonly aborted = new Map<string, AdmissionSet>();
  private readonly releasedRetired = new Map<string, AdmissionSet>();
  private readonly pendingByAdmission = new Map<string, number>();
  private handoff: { readonly retiredId: string; readonly deadline: number } | null = null;

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (frozen) this.prepared = null;
  }

  prepare(input: unknown, handoffTimeoutMs = DEFAULT_PUBLICATION_POLICY.drain_timeout_ms): AdmissionSet {
    if (this.frozen) throw new AdmissionRegistryError('frozen', 'admission registry is frozen');
    if (!Number.isSafeInteger(handoffTimeoutMs) || handoffTimeoutMs <= 0 || handoffTimeoutMs > 2_147_483_000) {
      throw new AdmissionRegistryError('conflict', 'handoff timeout is invalid');
    }
    const set = parseAdmissionSet(input);
    const identity = admissionSetIdentity(set);
    const activeSequence = this.active?.admission_sequence ?? 0;
    if (set.admission_sequence <= activeSequence) {
      throw new AdmissionRegistryError('stale', 'admission sequence is not newer than active');
    }
    if (this.prepared !== null) {
      if (this.prepared.identity === identity) {
        if (this.prepared.handoffTimeoutMs !== handoffTimeoutMs) {
          throw new AdmissionRegistryError('conflict', 'prepared handoff timeout conflicts');
        }
        return this.prepared.set;
      }
      if (set.admission_sequence <= this.prepared.set.admission_sequence) {
        throw new AdmissionRegistryError('conflict', 'prepared admission is newer or conflicts');
      }
    }
    this.prepared = Object.freeze({ identity, set, handoffTimeoutMs });
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
    const retiredId = this.activeRetiredId;
    if (old !== null && this.retired.length >= this.retiredCapacity) {
      throw new AdmissionRegistryError('capacity', 'retired admission capacity is exhausted');
    }
    const nextRetired = old === null ? this.retired : Object.freeze([old, ...this.retired]);
    this.active = this.prepared.set;
    this.activeRetiredId = admissionSetRetiredId(this.active);
    this.handoff = old === null ? null : {
      retiredId: retiredId ?? admissionSetRetiredId(old),
      deadline: this.monotonicNow() + this.prepared.handoffTimeoutMs,
    };
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
    if (this.handoff?.retiredId === admissionSetRetiredId(set)) this.handoff = null;
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

  acquire(): { readonly worker: Pick<AdmissionWorker, 'private_port'> | null; release(): void } {
    const set = this.active;
    const identity = this.activeRetiredId;
    if (set === null || identity === null || set.workers.length === 0) return { worker: null, release() {} };
    const worker = set.workers[this.nextIndex % set.workers.length] ?? null;
    this.nextIndex = (this.nextIndex + 1) % set.workers.length;
    if (worker === null) return { worker: null, release() {} };
    this.pendingByAdmission.set(identity, (this.pendingByAdmission.get(identity) ?? 0) + 1);
    let released = false;
    return {
      worker,
      release: () => {
        if (released) return;
        released = true;
        const pending = this.pendingByAdmission.get(identity) ?? 0;
        if (pending <= 1) this.pendingByAdmission.delete(identity);
        else this.pendingByAdmission.set(identity, pending - 1);
      },
    };
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
    const handoff = this.handoff;
    return Object.freeze({
      active: this.active,
      prepared: this.prepared?.set ?? null,
      retired: this.retired,
      handoff: handoff === null ? null : Object.freeze({
        retired_id: handoff.retiredId,
        pending: this.pendingByAdmission.get(handoff.retiredId) ?? 0,
        complete: (this.pendingByAdmission.get(handoff.retiredId) ?? 0) === 0,
        remaining_ms: Math.max(0, Math.floor(handoff.deadline - this.monotonicNow())),
      }),
    });
  }
}
