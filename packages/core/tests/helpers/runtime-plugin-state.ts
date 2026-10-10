import type { PluginStateClient } from '../../src/plugin-state/client';
import { DurableStateConflictError, type DurableRecord, type PluginDurableState } from '../../src/plugin-durable-state';

/** In-memory composition fixture; the production capability remains Worker backed. */
export function runtimePluginState(onClose: () => void = () => undefined): PluginStateClient {
  const namespaces = new Map<string, Map<string, DurableRecord>>();
  const unexpected = (): never => { throw new Error('unexpected fixture storage capability'); };
  const durable = { forNamespace(namespace: string): PluginDurableState {
    let rows = namespaces.get(namespace);
    if (!rows) { rows = new Map(); namespaces.set(namespace, rows); }
    return {
      get: async key => rows.get(key) ?? null,
      list: async () => [...rows.values()],
      transact: async mutations => {
        for (const mutation of mutations) if ((rows.get(mutation.key)?.version ?? 0) !== mutation.expectedVersion) throw new DurableStateConflictError();
        return mutations.map(mutation => {
          const record = { key: mutation.key, version: mutation.expectedVersion + 1, value: structuredClone(mutation.value) };
          rows.set(record.key, record); return record;
        });
      },
    };
  } };
  return {
    durable,
    secretStores: { create: unexpected, revoke: unexpected, clear: unexpected },
    storage: { create: unexpected, revoke: unexpected },
    eventLogFactory: unexpected, snapshotStore: unexpected,
    channelStore: () => ({ get: async () => null, put: async () => undefined }),
    executorProofPage: async () => [], executorHasPending: async () => false,
    journalNamespaces: async () => [], journal: unexpected,
    close: async () => { onClose(); },
  } as unknown as PluginStateClient;
}
