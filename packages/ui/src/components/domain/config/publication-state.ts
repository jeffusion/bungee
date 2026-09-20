export type SubmissionPhase = 'idle' | 'unknown' | 'rejected' | 'active' | 'terminal';
import { pendingPublicationKey } from './workspace';
import { ApiError } from '../../../api/client';

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
export const submissionLocked = (phase: SubmissionPhase) => phase === 'unknown' || phase === 'active';
export const isTerminal = (state: unknown) => state === 'converged' || state === 'degraded';

export function queryFailure(status?: number): 'queryNotFound' | 'queryUnauthorized' | 'queryNetwork' {
  return status === 404 ? 'queryNotFound' : status === 401 || status === 403 ? 'queryUnauthorized' : 'queryNetwork';
}
const safeInteger = (value: unknown, max = 100000) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
export function replacementSummary(workers: unknown): Array<{ slot: number | null; attempt: number | null; revision: number | null; state: string }> {
  if (!Array.isArray(workers)) return [];
  return workers.slice(0, 128).map(worker => ({ slot: safeInteger(worker?.worker_slot), attempt: safeInteger(worker?.attempt_no),
    revision: safeInteger(worker?.applied_revision, Number.MAX_SAFE_INTEGER),
    state: ['pending', 'converged', 'failed'].includes(worker?.state) ? worker.state : 'unknown' }));
}
export function drainSummary(code: unknown, detail: unknown): { relevant: boolean; hidden: boolean; rows: Array<{ slot: number; code: 'timeout' | 'exit_unconfirmed' }> } {
  if (code !== 'old_worker_drain_failed') return { relevant: false, hidden: false, rows: [] };
  if (typeof detail !== 'string' || detail.length > 256) return { relevant: true, hidden: true, rows: [] };
  const pieces = detail.split(', ');
  if (!pieces.length || pieces.length > 16 || pieces.some(p => !/^\d{1,4}:(?:timeout|exit_unconfirmed|exit-unconfirmed)$/.test(p))) return { relevant: true, hidden: true, rows: [] };
  return { relevant: true, hidden: false, rows: pieces.map(p => {
    const [slot, code] = p.split(':'); return { slot: Number(slot), code: code === 'timeout' ? 'timeout' : 'exit_unconfirmed' };
  }) };
}
