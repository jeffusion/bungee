export type SubmissionPhase = 'idle' | 'unknown' | 'rejected' | 'active' | 'terminal';
import { pendingPublicationKey } from './workspace';
import { ApiError } from '../../../api/client';
import type { ConfigurationPublication, ConfigurationRuntimeHealth } from '$api/config';
import { servingStatus } from './workspace';

export function historicalDrainFailure(publication: ConfigurationPublication | null, fresh: boolean): boolean {
  return fresh && servingStatus(publication, fresh) === 'confirmed'
    && publication?.operation?.state === 'degraded'
    && publication.operation.error_code === 'old_worker_drain_failed'
    && publication.cleanup?.active !== true;
}

export function publicationMessage(publication: ConfigurationPublication | null, fresh: boolean): 'statusUnavailable' | 'pending' | 'publishing' | 'draining' | 'degraded' | 'superseded' | 'supersededFailed' | 'drainFailed' | 'drainUnconfirmed' | 'historicalDrainFailure' | 'effective' | 'converged' {
  if (!fresh || !publication) return 'statusUnavailable';
  if (historicalDrainFailure(publication, fresh)) return 'historicalDrainFailure';
  const confirmed = servingStatus(publication, fresh) === 'confirmed';
  if (publication.cleanup?.active && publication.cleanup.state === 'stopped') return confirmed ? 'drainFailed' : 'drainUnconfirmed';
  if (publication.operation?.error_code === 'old_worker_drain_failed') return confirmed ? 'drainFailed' : 'drainUnconfirmed';
  if (publication.operation?.state === 'superseded') {
    // A superseded record is history when a newer target is already the latest desired configuration.
    if (publication.target_revision > publication.operation.committed_revision) return 'pending';
    return cleanupAttention(publication) ? 'supersededFailed' : 'superseded';
  }
  if (publication.operation?.state === 'degraded') return 'degraded';
  if (publication.operation?.state === 'pending') return 'pending';
  if (publication.operation?.state === 'draining') return confirmed ? 'draining' : 'publishing';
  if (publication.operation?.state === 'converged') return confirmed ? 'effective' : 'converged';
  return 'publishing';
}

/** Cancellation cleanup is only a fault when it is active, stopped or left unconfirmed members. */
export function cleanupAttention(publication: ConfigurationPublication | null): boolean {
  const cleanup = publication?.cleanup;
  return !!cleanup && (cleanup.active || cleanup.state === 'stopped' || cleanup.failed_count > 0
    || cleanup.unknown_count > 0 || cleanup.exit_unknown_count > 0);
}

export function preCommitRejection(error: unknown, accepted: boolean) {
  if (accepted || !(error instanceof ApiError) || error.status !== 503) return null;
  const body = error.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const code = Object.getOwnPropertyDescriptor(body, 'error')?.value;
  if (code !== 'control_recovering' && code !== 'control_readiness_failed') return null;
  const reason = Object.getOwnPropertyDescriptor(body, 'reason')?.value;
  const safeReason = typeof reason === 'string' && [
    'ingress_unavailable', 'admission_recovering', 'readiness_check_failed', 'not_attached', 'authority_mismatch',
    'lease_margin', 'active_missing', 'prepared_pending', 'retired_pending', 'retired_release_pending',
    'active_operation', 'active_revision_mismatch', 'active_content_mismatch', 'plugin_catalog_mismatch',
  ].includes(reason) ? reason : '';
  return { code, summary: `HTTP 503 · ${code}${safeReason ? ` · ${safeReason}` : ''}` };
}

export function retainAccepted(id: string, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    (storage ?? sessionStorage).setItem(pendingPublicationKey, JSON.stringify({ version: 1, mutationId: id, accepted: true }));
    return true;
  } catch { return false; }
}
export function forgetDispatch(storage?: Pick<Storage, 'removeItem'>): boolean {
  try { (storage ?? sessionStorage).removeItem(pendingPublicationKey); return true; } catch { return false; }
}
export const submissionLocked = (phase: SubmissionPhase) => phase === 'unknown';
export const isTerminal = (state: unknown) => state === 'converged' || state === 'degraded' || state === 'superseded';

export function queryFailure(status?: number): 'queryNotFound' | 'queryUnauthorized' | 'queryNetwork' {
  return status === 404 ? 'queryNotFound' : status === 401 || status === 403 ? 'queryUnauthorized' : 'queryNetwork';
}
export function runtimeHealthFault(health: ConfigurationRuntimeHealth | null | undefined, fresh: boolean): boolean {
  return fresh && !!health && (health.component_recovery.some(item => item.state !== 'healthy')
    || health.dependencies.some(item => !item.fresh || item.state !== 'ready' || item.observed_at === null));
}
