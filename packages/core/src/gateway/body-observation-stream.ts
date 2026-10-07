import type { ByteObservation } from '../worker/response/attempt-observation';
import { cancelBodyReader } from './body-service';
import type { TransportOutcome } from '../logger/transport-outcome';

/** Install a tap without starting a pipe pump. Only the final reader advances wire bytes. */
export function observeBodyStream(source:ReadableStream<Uint8Array>,observer:ByteObservation):ReadableStream<Uint8Array> {
  // Reserve ownership immediately without reading. The cache owner must wait
  // for this decoration instead of acquiring its original output behind it.
  const input=source.getReader();
  const observed=observer.readable.getReader();const writer=observer.writable.getWriter();
  let ended=false;let cancellation:Promise<void>|undefined;
  const release=()=>{try{input.releaseLock();}catch{}try{observed.releaseLock();}catch{}try{writer.releaseLock();}catch{}};
  const cancel=(reason?:unknown):Promise<void>=>{
    if(cancellation)return cancellation;ended=true;observer.finish();
    cancellation=(async()=>{const physical=cancelBodyReader(input,reason);
      const settled=await Promise.allSettled([physical,observed.cancel(reason),writer.abort(reason)]);release();
      if(settled[0].status==='rejected')throw settled[0].reason;
    })();void cancellation.catch(()=>undefined);return cancellation;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller){if(ended)return;
      try{const part=await input.read();if(ended)return;
        if(part.done){await Promise.all([writer.close(),observed.read().then(result=>{if(!result.done)throw Error('body observer produced unexpected trailing bytes');})]);ended=true;release();controller.close();return;}
        const [result]=await Promise.all([observed.read(),writer.write(part.value)]);if(ended)return;
        if(result.done)throw Error('body observer closed before wire EOF');controller.enqueue(result.value);
      }catch(error){await cancel(error).catch(()=>undefined);try{controller.error(error);}catch{}}
    },cancel,
  },{highWaterMark:0});
}

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
