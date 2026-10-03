import type { DurableJson } from '../plugin-durable-state';

interface Entry { key: string; value: DurableJson; expires: number; index: number }
/** One indexed heap entry per key: updates cannot accumulate stale expiry tickets. */
export class KeyedAdmissionState {
  private entries = new Map<string, Entry>();
  private heap: Entry[] = [];
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid keyed state capacity');
  }
  get size() { return this.entries.size; }
  get(key: string): DurableJson { return this.entries.get(key)?.value ?? null; }
  hasRoom(key: string): boolean { return this.entries.has(key) || this.size < this.capacity; }
  private swap(a: number, b: number) {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
    this.heap[a]!.index = a; this.heap[b]!.index = b;
  }
  private repair(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent]!.expires <= this.heap[index]!.expires) break;
      this.swap(parent, index); index = parent;
    }
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.heap[child + 1]!.expires < this.heap[child]!.expires) child++;
      if (this.heap[index]!.expires <= this.heap[child]!.expires) break;
      this.swap(index, child); index = child;
    }
  }
  set(key: string, value: DurableJson, expires: number) {
    if (!Number.isFinite(expires) || !this.hasRoom(key)) throw new Error('invalid keyed state entry');
    let entry = this.entries.get(key);
    if (entry) { entry.value = value; entry.expires = expires; this.repair(entry.index); }
    else {
      entry = {key, value, expires, index: this.heap.length};
      this.entries.set(key, entry); this.heap.push(entry); this.repair(entry.index);
    }
  }
  sweep(now: number, limit = 256): number {
    let removed = 0;
    while (removed < limit && this.heap.length && this.heap[0]!.expires <= now) {
      const first = this.heap[0]!, last = this.heap.pop()!;
      this.entries.delete(first.key);
      if (this.heap.length) { this.heap[0] = last; last.index = 0; this.repair(0); }
      removed++;
    }
    return removed;
  }
  /** Rebuild off the request path; callers swap only after every publication validates. */
  reconcile(transform: (key: string, value: DurableJson) => {value: DurableJson; expires: number}, now = -Infinity): KeyedAdmissionState {
    const next = new KeyedAdmissionState(this.capacity);
    for (const entry of this.entries.values()) {
      if (entry.expires <= now) continue;
      const result = transform(entry.key, structuredClone(entry.value));
      next.set(entry.key, result.value, result.expires);
    }
    return next;
  }
}
