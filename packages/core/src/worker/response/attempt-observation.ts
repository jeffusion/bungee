import { createParser } from 'eventsource-parser';
import type { AttemptObservationEvent } from '../../hooks/plugin-hooks';
import { decodeStream, isObjectBody } from '../request/body-source';

const BODY_LIMIT = 1024 * 1024;
const QUEUE_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
let observerBytes = 0;
type IncompleteReason = Extract<AttemptObservationEvent,{phase:'incomplete'}>['reason'];
export interface AttemptResponseObservationContext { readonly requestId:string;readonly routeId:string;readonly attemptId:string;readonly upstreamId:string;readonly status:number }
export interface ByteObservation extends TransformStream<Uint8Array,Uint8Array> { completion:Promise<void>; finish():void }

/** Copies a bounded side queue; slow or failing observers cannot stall wire delivery. */
export function createAttemptResponseObserver(
  protocol:'json'|'sse', context:AttemptResponseObservationContext,
  dispatch:(event:AttemptObservationEvent)=>Promise<void>,onComplete:()=>void=()=>undefined,
  coding='',phase:'request'|'response'='response',url='', signal?:AbortSignal,
): ByteObservation {
  let held = 0; let queued = 0; let stopped = false; let eof = false; let callbackQueue = 0;
  const chunks:Uint8Array[]=[]; let wake:(()=>void)|undefined;
  let observerDisabled=false;
  let callbacks=Promise.resolve(); const incomplete=new Set<IncompleteReason>();
  const reserve = (bytes:number) => { if(observerBytes+bytes>TOTAL_LIMIT)return false;observerBytes+=bytes;held+=bytes;return true; };
  const release = (bytes:number) => { observerBytes-=bytes;held-=bytes; };
  const deliver = (event:AttemptObservationEvent,size=0) => {
    if (callbackQueue+size>QUEUE_LIMIT || !reserve(size)) { notify('buffer-limit'); return; }
    callbackQueue+=size;
    callbacks=callbacks.then(async()=>{ let timer:ReturnType<typeof setTimeout>|undefined;let active=true;
      try {
        if(observerDisabled && event.phase !== 'incomplete')return;
        const timedOut=await Promise.race([dispatch(Object.freeze({...event,isActive:()=>active})).then(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(true),250);})]);
        if(timedOut && event.phase !== 'incomplete'){observerDisabled=true;notify('observer-timeout');}
      }
      catch {observerDisabled=true;if(event.phase !== 'incomplete')notify('observer-error');}
      finally {active=false;if(timer)clearTimeout(timer);callbackQueue-=size;release(size);}
    });
  };
  const notify = (reason:IncompleteReason) => { if(incomplete.has(reason))return;incomplete.add(reason);deliver(Object.freeze({...context,phase:'incomplete',reason,isActive:()=>true})); };
  const stop = (reason:IncompleteReason) => { if(stopped)return;stopped=true;notify(reason);wake?.(); };
  const input=new ReadableStream<Uint8Array>({
    async pull(controller){while(!chunks.length&&!eof&&!stopped)await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
      const chunk=chunks.shift();if(chunk){queued-=chunk.byteLength;release(chunk.byteLength);controller.enqueue(chunk);}else controller.close();},
    cancel(){stopped=true;wake?.();},
  },{highWaterMark:0});
  const onAbort = () => { stopped=true;wake?.(); };
  signal?.addEventListener('abort',onAbort,{once:true});
  const work=(async()=>{
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined; let buffered=0; let decodedHeld=0;
    try {
      reader=decodeStream(input,coding,Number.MAX_SAFE_INTEGER,signal,true).getReader();
      const decoder=new TextDecoder('utf-8',{fatal:true});const encoder=new TextEncoder();
      let text='';let frameBytes=0;let pendingData=false;
      const observeBody=(body:Record<string,unknown>,envelope?:unknown)=> {
        const size=Buffer.byteLength(JSON.stringify(body));
        deliver(Object.freeze(phase==='request'
          ? {...context,phase:'request',url,body:cloneFrozenObservationBody(body),isActive:()=>true}
          : {...context,phase:'response',protocol,body:cloneFrozenObservationBody(body),envelope,isActive:()=>true}) as AttemptObservationEvent,size);
      };
      const parser=createParser({onEvent(event){frameBytes=0;if(event.data.trim()==='[DONE]')return;try{const body:unknown=JSON.parse(event.data);if(isObjectBody(body))observeBody(body,{data:event.data,json:body,event:event.event,id:event.id});}catch{} }});
      while(!stopped){const part=await reader.read();if(part.done)break;
        if(protocol==='json'){
          buffered+=part.value.byteLength;if(buffered>BODY_LIMIT||!reserve(part.value.byteLength)){stop('buffer-limit');break;}
          text+=decoder.decode(part.value,{stream:true});
        } else {
          // Feed complete lines so one unbounded event is never retained in parser state.
          if(!reserve(part.value.byteLength)){stop('buffer-limit');break;}decodedHeld+=part.value.byteLength;
          text+=decoder.decode(part.value,{stream:true});
          let match:RegExpExecArray|null;
          while((match=/\r\n|\r(?!$)|\n/.exec(text))){const line=text.slice(0,match.index+match[0].length);text=text.slice(line.length);frameBytes+=encoder.encode(line).byteLength;
            if(frameBytes>BODY_LIMIT){stop('frame-limit');break;} if (/^data(?::|[\r\n])/.test(line)) pendingData=true; parser.feed(line.replace(/[\r\n]+$/, '')+'\n');if(!line.replace(/[\r\n]/g,'')){frameBytes=0;pendingData=false;}}
          const needed=encoder.encode(text).byteLength+frameBytes;if(decodedHeld>needed){release(decodedHeld-needed);decodedHeld=needed;}
          if(needed>BODY_LIMIT){stop('frame-limit');break;}
        }
      }
      if(!stopped){text+=decoder.decode();if(protocol==='json'){try{const body:unknown=JSON.parse(text);if(isObjectBody(body))observeBody(body);else notify('decode-error');}catch{notify('decode-error');}}
        else {
          // A final CR is a complete line separator at EOF, even without LF.
          if(text.endsWith('\r')) {
            if(/^data(?::|[\r\n])/.test(text))pendingData=true;
            parser.feed(text.slice(0,-1)+'\n');if(text==='\r')pendingData=false;text='';
          }
          if(pendingData || /^data(?::|$)/.test(text))notify('frame-truncated');
        }}
    }catch(error){notify(coding && !['gzip','zstd','identity'].includes(coding.toLowerCase())?'unsupported-encoding':'decode-error');}
    finally{stopped=true;wake?.();await reader?.cancel().catch(()=>undefined);for(const chunk of chunks.splice(0))release(chunk.byteLength);let drain:Promise<void>;do{drain=callbacks;await drain;}while(drain!==callbacks);signal?.removeEventListener('abort',onAbort);if(held)release(held);onComplete();}
  })();
  const tap=new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){controller.enqueue(chunk);if(stopped)return;
      if(chunk.byteLength+queued>QUEUE_LIMIT || !reserve(chunk.byteLength)){stop('buffer-limit');return;}
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
