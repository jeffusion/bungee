import type {DurableMutation, DurableRecord, PluginDurableState} from '../../../packages/core/src/plugin-durable-state';
/** Asynchronous, detached reads and atomic CAS; no sync facade or command history. */
export class AsyncFakeState implements PluginDurableState {
  private records = new Map<string, DurableRecord>();
  readonly writes: string[][] = [];
  beforeTransact?: (mutations: readonly DurableMutation[]) => Promise<void>;
  rejectNext?: unknown;
  async get(key: string): Promise<DurableRecord | null> { await Promise.resolve(); return structuredClone(this.records.get(key) ?? null); }
  async list(): Promise<readonly DurableRecord[]> { await Promise.resolve(); return structuredClone([...this.records.values()]); }
  async transact(mutations: readonly DurableMutation[]): Promise<readonly DurableRecord[]> {
    await Promise.resolve(); const hook = this.beforeTransact; this.beforeTransact = undefined; if (hook) await hook(mutations);
    if (this.rejectNext) { const error = this.rejectNext; this.rejectNext = undefined; throw error; }
    const keys = new Set<string>();
    for (const m of mutations) {
      if (keys.has(m.key)) throw new Error('duplicate mutation'); keys.add(m.key);
      if ((this.records.get(m.key)?.version ?? 0) !== m.expectedVersion) throw Object.assign(new Error('remote version conflict'), {code: 'durable_state_conflict'});
    }
    const records = mutations.map(m => ({key: m.key, version: m.expectedVersion + 1, value: structuredClone(m.value)}));
    for (const r of records) this.records.set(r.key, r); this.writes.push([...keys]); return structuredClone(records);
  }
}
