import { readable, writable } from 'svelte/store';
import { getRuntimeUpstreams, type RuntimeUpstreamsResponse } from '$api/runtime';
import { getRuntimeConfig, retryConfigurationPublication, type ConfigurationPublication, type ConfigurationRecovery, type ConfigurationRuntime } from '$api/config';
import { ApiError } from '$api/client';

// One poll shared by all mounted runtime views; no stale health after a failed read.
export const runtimeUpstreams = readable<RuntimeUpstreamsResponse | null>(null, (set) => {
  set(null);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  async function refresh() {
    try {
      const response = await getRuntimeUpstreams();
      if (!stopped) set(response);
    } catch {
      if (!stopped) set(null);
    } finally {
      if (!stopped) timer = setTimeout(refresh, 5000);
    }
  }
  void refresh();
  return () => { stopped = true; clearTimeout(timer); };
});

type ActiveRecovery = Pick<ConfigurationRecovery, 'recovery_id' | 'target_revision' | 'state'> & Partial<ConfigurationRecovery>;
export type PublicationRecoveryState = {
  readStatus: 'loading' | 'fresh' | 'stale' | 'paused';
  runtime: ConfigurationRuntime | null;
  fresh: boolean;
  updatedAt: number | null;
  publication: ConfigurationPublication | null;
  accepted: ActiveRecovery | null;
  pending: boolean;
  notice: 'unavailable' | 'refreshUnavailable' | 'storage' | 'conflict' | 'notRetryable' | 'unauthorized' | 'rejected' | 'failed' | null;
};

export function unresolvedPublication(publication: ConfigurationPublication | null): boolean {
  return publication?.operation?.state === 'degraded' && !publication.serving_complete;
}

export function publicationRetryKey(operationId: string, revision: number): string {
  return `bungee:publication-retry:${operationId}:${revision}`;
}

// Dashboard shares the same bounded poll lifecycle as upstream runtime, with a
// faster interval only while a configuration recovery is active.
export function createPublicationRecoveryStore({ staleAfterMs = 8000, readTimeoutMs = 8000 } = {}) {
  let state: PublicationRecoveryState = { readStatus: 'loading', runtime: null, fresh: false, updatedAt: null, publication: null, accepted: null, pending: false, notice: null };
  let stopped = true;
  let paused = false;
  let readHeaders: Headers | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let expiry: ReturnType<typeof setTimeout>;
  let controller: AbortController | undefined;
  const store = writable(state, () => {
    stopped = false;
    update({ readStatus: 'loading', fresh: false, runtime: null });
    void refresh();
    return () => { stopped = true; paused = false; readHeaders = undefined; clearTimeout(timer); clearTimeout(expiry); controller?.abort(); };
  });
  function update(patch: Partial<PublicationRecoveryState>) {
    state = { ...state, ...patch };
    store.set(state);
  }
  function clearRetryKey(publication: ConfigurationPublication | null) {
    const operationId = publication?.operation?.operation_id;
    if (operationId === undefined || publication === null) return;
    try {
      sessionStorage.removeItem(publicationRetryKey(operationId, publication.target_revision));
    } catch {
      // Best effort only: storage cleanup must not break a runtime refresh.
    }
  }
  async function refresh() {
    if (stopped || paused) return;
    clearTimeout(timer);
    controller?.abort();
    const current = controller = new AbortController();
    try {
      const runtime = await getRuntimeConfig(current.signal, readHeaders, readTimeoutMs);
      const { publication } = runtime;
      if (stopped || current.signal.aborted) return;
      const nextPublication = publication ?? null;
      const previousPublication = state.publication;
      const identityChanged = previousPublication?.operation?.operation_id !== nextPublication?.operation?.operation_id
        || previousPublication?.target_revision !== nextPublication?.target_revision;
      if (identityChanged) clearRetryKey(previousPublication);
      clearTimeout(expiry);
      expiry = setTimeout(() => { if (!stopped && !paused) update({ readStatus: 'stale', fresh: false, runtime: null, notice: 'refreshUnavailable' }); }, staleAfterMs);
      update({ readStatus: 'fresh', runtime, fresh: true, updatedAt: Date.now(), publication: publication ?? null, accepted: null,
        ...(identityChanged || !unresolvedPublication(publication) || state.notice === 'refreshUnavailable'
          ? { notice: null } : {}) });
    } catch {
      if (!stopped && !current.signal.aborted) update({ readStatus: 'stale', runtime: null, fresh: false,
        ...(!state.notice ? { notice: 'refreshUnavailable' as const } : {}) });
    } finally {
      if (!stopped && !current.signal.aborted) {
        const recovery = state.accepted ?? state.publication?.recovery;
        timer = setTimeout(refresh, recovery?.state === 'scheduled' || recovery?.state === 'running' ? 1000 : 5000);
      }
    }
  }
  async function retry() {
    const publication = state.publication;
    const recovery = state.accepted ?? publication?.recovery;
    if (stopped || !state.fresh || state.pending || state.accepted !== null || !publication?.operation || !unresolvedPublication(publication)
      || !publication.retryable || recovery?.state !== 'stopped'
      || publication.operation.error_code === 'old_worker_drain_failed') return;
    const { operation_id } = publication.operation;
    const revision = publication.target_revision;
    const key = publicationRetryKey(operation_id, revision);
    let requestId: string;
    try {
      requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, requestId);
    } catch {
      update({ notice: 'storage' });
      return; // Never issue a retry whose identity cannot survive a reload.
    }
    controller?.abort();
    clearTimeout(timer);
    update({ pending: true, notice: null });
    try {
      const accepted = await retryConfigurationPublication(operation_id, requestId, revision);
      try { sessionStorage.removeItem(key); } catch { /* The ACK remains useful without cleanup. */ }
      if (state.publication?.operation?.operation_id === operation_id && state.publication.target_revision === revision) {
        update({ accepted });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        sessionStorage.removeItem(key);
        const body = error.body as Record<string, unknown> | null;
        if (body?.error === 'recovery_in_progress' && typeof body.recovery_id === 'string'
          && body.target_revision === revision && (body.state === 'scheduled' || body.state === 'running')) {
          update({ accepted: { recovery_id: body.recovery_id, target_revision: revision, state: body.state }, notice: null });
        } else {
          update({ notice: body?.error === 'revision_conflict' || body?.error === 'idempotency_key_reused'
            || body?.error === 'recovery_in_progress' ? 'conflict'
            : body?.error === 'recovery_not_retryable' || body?.error === 'operation_not_degraded' ? 'notRetryable' : 'rejected' });
        }
      } else {
        update({ notice: error instanceof ApiError && error.status === 401 ? 'unauthorized'
          : error instanceof ApiError && error.status === 503 ? 'unavailable' : 'failed' });
      }
    } finally {
      update({ pending: false });
      await refresh();
    }
  }
  function pause() {
    paused = true; clearTimeout(timer); clearTimeout(expiry); controller?.abort();
    update({ readStatus: 'paused', fresh: false, runtime: null });
  }
  async function resume(headers?: Headers) {
    paused = false; readHeaders = headers;
    await refresh();
  }
  return { subscribe: store.subscribe, refresh, retry, pause, resume };
}

export const publicationRecovery = createPublicationRecoveryStore();
