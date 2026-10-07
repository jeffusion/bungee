import { createBodySource } from '../gateway/body-factory';
import { BodyBufferLease, BodyProcessingError, bodySourceFor, bodySourceForHandle } from '../gateway/body-service';
import type { BodyHandle, BodyViewIdentity } from '../gateway/body-contracts';
import { bodyResources } from '../gateway/body-resources';
import { formatSSELog } from '@jeffusion/bungee-types';
let captures = 0;
const pending = new Set<Promise<void>>();
export function trackBodyLogTask(task: Promise<void>): void {
  pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));
}
export type BodyCapture = { body: ReadableStream<Uint8Array>; completion: Promise<void>; stop(): void };
export type BodyCaptureReason = 'size_limit' | 'buffer_capacity' | 'cancelled' | 'stream_failed' | 'not_consumed' | 'capture_failed' | 'decode_failed';
export interface BodyCaptureOptions { bodyHandle?: BodyHandle; identity?: BodyViewIdentity; maxBodyBytes?: number }
/** The transport owns reads. Logging holds a consumer lease on the shared representation. */
export function captureBody(
  source: ReadableStream<Uint8Array>, maxBytes: number, coding: string,
  save: (body: unknown) => Promise<void>, incomplete: (reason: BodyCaptureReason) => void,
  signal?: AbortSignal, contentType='', requestAccept='', options: BodyCaptureOptions = {},
): BodyCapture {
  if(source.locked)throw new TypeError('body stream is locked');
  const existing=bodySourceFor(source);
  // A logger alone imposes only its own save limit, never an HTTP body limit.
  const owner=existing??createBodySource(source,options.maxBodyBytes??Number.MAX_SAFE_INTEGER,coding,undefined,options.identity);
  const handle=options.bodyHandle??owner.handle(options.identity);
  const retainingOwner=bodySourceForHandle(handle)??owner;
  const allocation=new BodyBufferLease(true,true);
  const sse=Array.isArray(formatSSELog('',contentType));
  const sseAbort=new AbortController();const messages:{event:string;data:unknown}[]=[];let eventBytes=0;
  let stopped=false;let wireFinished=false;let admitted=false;let releaseRetention=()=>{};let resolve!:()=>void;
  const completion=new Promise<void>(done=>{resolve=done;});
  const release=()=>{sseAbort.abort();releaseRetention();allocation.dispose();if(admitted){captures--;admitted=false;}signal?.removeEventListener('abort',abort);};
  const notify=(reason:BodyCaptureReason)=>{try{incomplete(reason);}catch{}};
  const stop=(reason:BodyCaptureReason)=>{if(stopped || (wireFinished && reason==='not_consumed'))return;stopped=true;release();notify(reason);resolve();};
  const abort=()=>stop('cancelled');
  if(captures>=bodyResources.loggerConsumers)stop('buffer_capacity');
  else {admitted=true;captures++;if(!sse)releaseRetention=retainingOwner.retain(maxBytes,error=>stop(error.status===413?'size_limit':'buffer_capacity'),true);}
  if(!stopped)signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const events=sse&&!stopped?(async()=>{try{for await(const event of handle.events({id:'logging-sse',mandatory:false,signal:sseAbort.signal})){
    eventBytes+=Buffer.byteLength(event.raw??event.data);if(eventBytes>maxBytes){stop('size_limit');break;}
    if(event.hasData===false)continue;
    allocation.add(128+event.data.length*8);messages.push({event:event.event||'message',data:event.json===undefined?event.data:event.json});
  }}catch(error){if(!stopped)stop(error instanceof BodyProcessingError&&error.status===503?'buffer_capacity':'decode_failed');}})():undefined;
  const body=existing?source:owner.take() as ReadableStream<Uint8Array>;
  const work=owner.completion.then(async()=>{
    if(stopped)return;
    wireFinished=true;signal?.removeEventListener('abort',abort);
    try{
      if(events){await events;if(!stopped)await save(formatSSELog(messages,contentType,undefined,requestAccept));return;}
      let bytes:Uint8Array;let encoded=false;
      try{bytes=await handle.decoded({id:'logging',mandatory:false});}
      catch(error){
        if(error instanceof BodyProcessingError && (error.status===413 || error.status===503))throw error;
        bytes=await handle.bytes({id:'logging',mandatory:false});encoded=true;notify('decode_failed');
      }
      if(stopped)return;
      if(bytes.byteLength>maxBytes)throw new BodyProcessingError(413,'body_log_too_large');
      allocation.add(Math.ceil(bytes.byteLength*8/3));
      const normalized=coding.trim().toLowerCase();const base64=()=>Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');
      let value:unknown;
      if(encoded || (normalized && !['identity','gzip','zstd'].includes(normalized)))value={encoding:'base64',content_encoding:coding,data:base64()};
      else{try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{value={encoding:'base64',data:base64()};}}
      // Keep historical/save presentation detection identical, including final Accept fallback.
      const cachedMessages=retainingOwner.cachedLogMessages();
      if(cachedMessages)allocation.add(cachedMessages.length*128);
      value=formatSSELog(value,contentType,count=>allocation.add(count),requestAccept,cachedMessages);
      if(stopped)return;
      await save(value);
    }catch(error){if(!stopped)notify(error instanceof BodyProcessingError ? error.status===413?'size_limit':error.status===503?'buffer_capacity':'capture_failed':'capture_failed');}
    finally{stopped=true;release();resolve();}
  },error=>stop(signal?.aborted || (error instanceof BodyProcessingError&&error.code==='body_stream_cancelled')?'cancelled':'stream_failed'));
  void owner.completion.then(()=>{if(!stopped)trackBodyLogTask(work);},()=>undefined);
  return{body,completion,stop:()=>stop('not_consumed')};
}
export async function flushBodyCaptures(): Promise<void> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([(async()=>{while(pending.size)await Promise.all([...pending]);})(),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
