/** Proxy-observed byte-stream lifecycle, independent of HTTP and application protocols. */
export const TRANSPORT_OUTCOMES = ['pending', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type TransportOutcome = typeof TRANSPORT_OUTCOMES[number];
export interface HttpStatusCounts {
  status2xx: number; status3xx: number; status4xx: number; status5xx: number; statusOther: number;
}
export interface RequestCounts { success: number; failed: number; }
export const emptyRequestCounts = (): RequestCounts => ({ success: 0, failed: 0 });
export interface TransportCounts {
  pending: number; completed: number; failed: number; cancelled: number; unknown: number;
}
export const emptyHttpCounts = (): HttpStatusCounts => ({ status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 });
export const emptyTransportCounts = (): TransportCounts => ({ pending: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 });

/** No decoding, prefetching or protocol inference; preserves consumer backpressure. */
export function observeTransportResponse(
  response: Response,
  signal: AbortSignal,
  record: (outcome: TransportOutcome, code?: string) => void,
  failureCode: () => string | undefined = () => undefined,
): Response {
  let settled = false;
  const observedFailureCode = () => {
    try { return failureCode(); } catch { return undefined; }
  };
  const finish = (outcome: TransportOutcome, code?: string) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    // Diagnostics must not change the response lifecycle.
    try { record(outcome, code); } catch { /* log sink failure is independent */ }
  };
  const onAbort = () => {
    const code = observedFailureCode();
    finish(code ? 'failed' : 'cancelled', code ?? 'client_cancelled');
  };
  if (!response.body) {
    finish(signal.aborted ? 'cancelled' : 'completed', signal.aborted ? 'client_cancelled' : undefined);
    return response;
  }
  const reader = response.body.getReader();
  let cancelling = false;
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (cancelling) return;
        if (part.done) { finish('completed'); controller.close(); reader.releaseLock(); }
        else controller.enqueue(part.value);
      } catch (error) {
        if (cancelling) return;
        const code = observedFailureCode();
        finish(signal.aborted && !code ? 'cancelled' : 'failed', code ?? (signal.aborted ? 'client_cancelled' : 'stream_read_failed'));
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelling = true;
      const code = observedFailureCode();
      finish(code ? 'failed' : 'cancelled', code);
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
