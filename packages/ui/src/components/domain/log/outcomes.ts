import type { ChainEntry, LogEntry, TransportOutcome } from '../../../api/logs';

export const TRANSPORT_OUTCOMES: TransportOutcome[] = ['pending', 'completed', 'failed', 'cancelled', 'unknown'];
export function transportOutcome(value: unknown): TransportOutcome {
  return TRANSPORT_OUTCOMES.includes(value as TransportOutcome) ? value as TransportOutcome : 'unknown';
}
/** The representative row may be an earlier attempt. Only chain metadata describes the final result. */
export function chainTransportOutcome(chain: ChainEntry): TransportOutcome {
  return transportOutcome(chain.chainTransportOutcome);
}
export function transportTone(value: unknown): string {
  switch (transportOutcome(value)) {
    case 'completed': return 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300';
    case 'failed': return 'border-red-500/60 bg-red-500/10 text-red-300';
    case 'cancelled': return 'border-amber-500/60 bg-amber-500/10 text-amber-300';
    case 'pending': return 'border-nexus-500/60 bg-nexus-500/10 text-nexus-300';
    default: return 'border-carbon-500 bg-carbon-700/50 text-zinc-400';
  }
}
export function httpStatusLabel(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : '—';
}
/** Translate recorded causes only; unknown codes remain available verbatim. */
export function transportExplanation(code: string | undefined): string | undefined {
  const keys: Record<string, string> = {
    request_timeout: 'logs.detail.requestTimeout',
    first_response_timeout: 'logs.detail.firstResponseTimeout',
    stream_read_failed: 'logs.detail.streamReadFailed',
    client_cancelled: 'logs.detail.clientCancelled',
  };
  return code ? keys[code] : undefined;
}
/** Accept exact status lists and HTTP classes, without silently truncating invalid input. */
export function parseStatusFilter(input: string): number | number[] | undefined {
  if (!input.trim()) return undefined;
  const values = input.trim().split(/[,，、\s]+/).flatMap(token => {
    if (/^[1-5]xx$/i.test(token)) {
      const base = Number(token[0]) * 100;
      return Array.from({ length: 100 }, (_, index) => base + index);
    }
    if (!/^[1-5]\d\d$/.test(token)) throw new Error('logs.invalidStatus');
    return [Number(token)];
  });
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : unique;
}
export type BodyTab = 'original' | 'transformed' | 'response';
/** Historical evidence only: do not use today's logging configuration. */
export function bodyRecordingEvidence(log: LogEntry, tab: BodyTab): { key: string; reason?: string } {
  const type = tab === 'original' ? 'original-request' : tab === 'transformed' ? 'request' : 'response';
  const step = log.processingSteps?.findLast(step => {
    if (step.step === 'body_recording_skipped') return step.detail?.type === type;
    return step.step === 'body_logging_incomplete' && tab !== 'original' && step.detail?.direction === type;
  });
  if (!step) return { key: 'logs.detail.bodyReasonUnknown' };
  const reason = typeof step.detail?.reason === 'string' ? step.detail.reason : undefined;
  if (reason === 'size_limit') return { key: 'logs.detail.bodySizeLimit' };
  if (reason === 'opaque_body_not_observed') return { key: 'logs.detail.bodyNotObserved' };
  return { key: step.step === 'body_recording_skipped' ? 'logs.detail.bodySkipped' : 'logs.detail.bodyIncomplete', reason };
}
export function diagnosticExport(log: LogEntry): Record<string, unknown> {
  return { transportOutcome: transportOutcome(log.transportOutcome), transportCode: log.transportCode,
    protocolOutcome: log.protocolOutcome, protocolCode: log.protocolCode };
}
