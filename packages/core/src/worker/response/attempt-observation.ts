import { createBodySource } from '../../gateway/body-factory';
import type { AttemptObservationEvent } from '../../hooks/plugin-hooks';
import { BodyBufferLease, BodyProcessingError, type BodySource, bodySourceForHandle, isObjectBody } from '../request/body-source';

import type { BodyHandle } from '../../gateway/body-contracts';
import { bodyResources, DEFAULT_BODY_PARSER_BYTES } from '../../gateway/body-resources';
export interface AttemptBodyOptions { maxBytes?:number; bodyHandle?:BodyHandle; backlogBytes?:number; backlogEvents?:number }
type IncompleteReason = Extract<AttemptObservationEvent,{phase:'incomplete'}>['reason'];
export interface AttemptResponseObservationContext { readonly requestId:string;readonly routeId:string;readonly attemptId:string;readonly upstreamId:string;readonly status:number }
export interface ByteObservation extends TransformStream<Uint8Array,Uint8Array> { completion:Promise<void>; finish():void }

/** Copies a bounded side queue; slow or failing observers cannot stall wire delivery. */
export function createAttemptResponseObserver(
  protocol:'json'|'sse', context:AttemptResponseObservationContext,
  dispatch:(event:AttemptObservationEvent)=>Promise<void>,onComplete:()=>void=()=>undefined,
  coding='',phase:'request'|'response'='response',url='', signal?:AbortSignal, options:AttemptBodyOptions = {},
): ByteObservation {
  const BODY_LIMIT=options.maxBytes??DEFAULT_BODY_PARSER_BYTES;
  const QUEUE_LIMIT=options.backlogBytes??bodyResources.observerBacklogBytes;
  const eventLimit=options.backlogEvents??bodyResources.observerBacklogEvents;
  const lease=new BodyBufferLease(true);
  let held = 0; let callbackEvents=0; let queued = 0; let stopped = false; let eof = false; let callbackQueue = 0;
  const chunks:Uint8Array[]=[]; let wake:(()=>void)|undefined;
  let observerDisabled=false;
  let callbacks=Promise.resolve(); const incomplete=new Set<IncompleteReason>();
  const reserve = (bytes:number) => {try{lease.add(bytes);held+=bytes;return true;}catch{return false;} };
  const release = (bytes:number) => { lease.release(bytes);held-=bytes; };
  const deliver = (event:AttemptObservationEvent,size=0) => {
    if(event.phase!=='incomplete' && (callbackEvents>=eventLimit || !reserve(128))){observerDisabled=true;notify('buffer-limit');return;}
    const charged=event.phase==='incomplete'?0:128;callbackEvents++;
    callbackQueue+=size;
    callbacks=callbacks.then(async()=>{ let timer:ReturnType<typeof setTimeout>|undefined;let active=true;
      try {
        if(observerDisabled && event.phase !== 'incomplete')return;
        const timedOut=await Promise.race([dispatch(Object.freeze({...event,isActive:()=>active})).then(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(true),bodyResources.callbackMs);})]);
        if(timedOut && event.phase !== 'incomplete'){observerDisabled=true;notify('observer-timeout');}
      }
      catch {observerDisabled=true;if(event.phase !== 'incomplete')notify('observer-error');}
      finally {active=false;if(timer)clearTimeout(timer);callbackQueue-=size;callbackEvents--;release(charged);}
    });
    return callbacks;
  };
  const notify = (reason:IncompleteReason) => { if(incomplete.has(reason))return;incomplete.add(reason);deliver(Object.freeze({...context,phase:'incomplete',reason,direction:phase,representation:protocol==='json'?'json':'sse',view:options.bodyHandle?.identity,consumerId:'token-observer',isActive:()=>true})); };
  const stop = (reason:IncompleteReason) => { if(stopped)return;stopped=true;notify(reason);wake?.(); };
  const input=new ReadableStream<Uint8Array>({
    async pull(controller){while(!chunks.length&&!eof&&!stopped)await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
      const chunk=chunks.shift();if(chunk){queued-=chunk.byteLength;release(chunk.byteLength);controller.enqueue(chunk);}else controller.close();},
    cancel(){stopped=true;wake?.();},
  },{highWaterMark:0});
  const onAbort = () => { stopped=true;wake?.(); };
  signal?.addEventListener('abort',onAbort,{once:true});
  let sharedRelease=()=>{};
  if(protocol==='json' && options.bodyHandle)sharedRelease=bodySourceForHandle(options.bodyHandle)?.retain(BODY_LIMIT,()=>stop('buffer-limit'))??(()=>{});
  const work=(async()=>{
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined; let releaseView=()=>{};let owner:BodySource|undefined;
    try {
      if(protocol==='json'){
        owner=options.bodyHandle?undefined:createBodySource(input,BODY_LIMIT,coding,signal);
        releaseView=owner?.retain(BODY_LIMIT,()=>stop('buffer-limit'))??(()=>{});
        {
          if(owner)await owner.buffer('observer',true);else{while(!eof&&!stopped)await new Promise<void>(resolve=>{wake=resolve;});}
          if(!stopped){const body=await (options.bodyHandle??owner!.handle()).json({id:'token-observer',mandatory:false,signal});
            if(isObjectBody(body))deliver(Object.freeze(phase==='request'?{...context,phase:'request',url,body,isActive:()=>true}:{...context,phase:'response',protocol,body,isActive:()=>true}));else notify('decode-error');}
        }
        return;
      }
      owner=options.bodyHandle?undefined:createBodySource(input,BODY_LIMIT,coding,signal);
      const handle=options.bodyHandle??owner!.handle();
      // The side stream feeds the single session while consumers receive frame references.
      const frames=handle.events({id:'token-observer',mandatory:false,signal,backlogBytes:QUEUE_LIMIT,backlogEvents:eventLimit});
      const drain=owner?(async()=>{const stream=owner!.take() as ReadableStream<Uint8Array>;const r=stream.getReader();try{while(!(await r.read()).done){}}finally{r.releaseLock();}})():undefined;
      try{for await(const envelope of frames){
        if(stopped)break;if(envelope.hasData===false)continue;if(envelope.truncated){notify('frame-truncated');continue;}if(envelope.data.trim()==='[DONE]')continue;
        if(isObjectBody(envelope.json))await deliver(Object.freeze(phase==='request'?{...context,phase:'request',url,body:envelope.json,isActive:()=>true}:{...context,phase:'response',protocol,body:envelope.json,envelope,isActive:()=>true}));
      }}finally{await drain;}
    }catch(error){if(error instanceof BodyProcessingError&&error.code==='body_sse_frame_truncated')notify('frame-truncated');else if(error instanceof BodyProcessingError&&error.code==='body_sse_frame_too_large')notify('frame-limit');else if(error instanceof BodyProcessingError&&(error.status===503||error.status===413))notify('buffer-limit');else notify(coding && !['gzip','zstd','identity'].includes(coding.toLowerCase())?'unsupported-encoding':'decode-error');}
    finally{stopped=true;wake?.();await reader?.cancel().catch(()=>undefined);for(const chunk of chunks.splice(0))release(chunk.byteLength);let drain:Promise<void>;do{drain=callbacks;await drain;}while(drain!==callbacks);signal?.removeEventListener('abort',onAbort);sharedRelease();releaseView();owner?.dispose();if(held)release(held);onComplete();}
  })();
  const tap=new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){controller.enqueue(chunk);if(stopped)return;
      if(options.bodyHandle)return;
      if(chunk.byteLength+queued>Math.max(QUEUE_LIMIT,BODY_LIMIT) || !reserve(chunk.byteLength)){stop('buffer-limit');return;}
      const copied=chunk.slice();chunks.push(copied);queued+=copied.byteLength;wake?.();},
    flush(){eof=true;wake?.();},
  }) as ByteObservation;
  // Cancelling a TransformStream's readable side does not run flush. Wake the
  // independently owned decoder as well, so replacing/cancelling the wire
  // stream cannot leave a side reader waiting forever for its queue.
  const outputReader = tap.readable.getReader();
  const output = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const part = await outputReader.read(); if (part.done) controller.close(); else controller.enqueue(part.value); }
      catch (error) { stop('raw-response-incomplete'); controller.error(error); }
    },
    cancel(reason) { stop('raw-response-incomplete'); return outputReader.cancel(reason); },
  }, {highWaterMark:0});
  Object.defineProperty(tap, 'readable', {value:output});
  tap.finish = () => { if (!eof && !stopped) stop('raw-response-incomplete'); };
  tap.completion=work;return tap;
}
export function cloneFrozenObservationBody(body:Record<string,unknown>):Record<string,unknown>{
  const clone=structuredClone(body);const freeze=(value:unknown)=>{if(value===null||typeof value!=='object')return;Object.freeze(value);for(const child of Object.values(value))freeze(child);};freeze(clone);return clone;
}

export function freezeObservationBody(body:Record<string,unknown>):Record<string,unknown>{
  const freeze=(value:unknown)=>{if(value===null||typeof value!=='object'||Object.isFrozen(value))return;for(const child of Object.values(value))freeze(child);Object.freeze(value);};freeze(body);return body;
}
