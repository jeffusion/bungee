import { writable } from 'svelte/store';
import { forgetDispatch, retainAccepted } from '$components/domain/config/publication-state';
import { pendingPublicationKey, readPendingPublication } from '$components/domain/config/workspace';

/** The one configuration write this tab cannot yet account for. Only identities are stored. */
export type PendingConfigurationWrite = { readonly mutationId: string; readonly accepted: boolean };
export type ConfigurationWriteState = {
  readonly pending: PendingConfigurationWrite | null;
  readonly corrupt: boolean;
  /** False when the identity could not be written to sessionStorage: it only lives in this page. */
  readonly persisted: boolean;
};

function read(): ConfigurationWriteState {
  if (typeof sessionStorage === 'undefined') return { pending: null, corrupt: false, persisted: true };
  try {
    return { pending: readPendingPublication(sessionStorage), corrupt: false, persisted: true };
  } catch {
    return { pending: null, corrupt: true, persisted: true };
  }
}

const store = writable<ConfigurationWriteState>(read());
let persisted = true;

export const configurationWrite = {
  subscribe: store.subscribe,
  /** The request was sent but its outcome is not known yet. */
  markDispatched(mutationId: string): boolean {
    try { sessionStorage.setItem(pendingPublicationKey, mutationId); persisted = true; }
    catch { persisted = false; }
    store.set({ pending: { mutationId, accepted: false }, corrupt: false, persisted });
    return persisted;
  },
  markAccepted(mutationId: string): boolean {
    const stored = retainAccepted(mutationId);
    persisted = persisted && stored;
    store.set({ pending: { mutationId, accepted: true }, corrupt: false, persisted });
    return stored;
  },
  clear(): boolean {
    const removed = forgetDispatch();
    persisted = true;
    store.set({ pending: null, corrupt: false, persisted: true });
    return removed;
  },
};
