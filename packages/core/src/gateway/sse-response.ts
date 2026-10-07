import type { BodyHandle, BodyEvent, SSEEnvelope, RequestContext } from '@jeffusion/bungee-core/plugin';
import type { ModificationRules } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';
import type { InboundChain } from '../scoped-plugin-registry';
import { applyBodyRules } from '../worker/rules/modifier';
import { hasBodyModification } from '../utils/expression-dependencies';
import { BodyProcessingError, isObjectBody, readBodyChunk, cancelBodyReader } from '../worker/request/body-source';

/** A required consumer drives the one wire owner up to the next shared event. */
export function sharedSSEResponse(input:ReadableStream<Uint8Array>,handle:BodyHandle,
  rules:ModificationRules['body'],context:ExpressionContext,chain?:InboundChain,
  request?:RequestContext,signal?:AbortSignal):ReadableStream<Uint8Array> {
  const events=handle.events({id:'gateway-response-rules',mandatory:true,signal})[Symbol.asyncIterator]();
  const reader=input.getReader();const encoder=new TextEncoder();const streamState=new Map<string,any>();
  let pendingRead:Promise<Awaited<ReturnType<typeof reader.read>>>|undefined;let eof=false;let index=0;let closed=false;
  const metadata=()=>({...request,chunkIndex:index,isFirstChunk:index===0,isLastChunk:false,streamState,request,strict:true});
  const serialize=(envelope:SSEEnvelope)=>{
    if(envelope.raw !== undefined && envelope.json === undefined)return envelope.raw;
    const fields=(envelope.comments??[]).map(comment=>`:${comment}`);
    for(const key of ['event','id','retry'] as const)if(envelope[key]!==undefined)fields.push(`${key}: ${envelope[key]}`);
    const data=envelope.json===undefined?envelope.data:JSON.stringify(envelope.json);
    for(const line of data.split('\n'))fields.push(`data: ${line}`);
    return `${fields.join('\n')}\n\n`;
  };
  const nextEvent=async():Promise<IteratorResult<BodyEvent>>=>{
    const pending=events.next();
    void pending.catch(()=>undefined);
    while(!eof){
      pendingRead??=readBodyChunk(reader,signal);
      const result=await Promise.race([
        pending.then(event=>({kind:'event' as const,event})),
        pendingRead.then(part=>({kind:'wire' as const,part})),
      ]);
      if(result.kind==='event')return result.event;
      pendingRead=undefined;if(result.part.done)eof=true;
    }
    return pending;
  };
  const cancel=async(reason?:unknown)=>{
    closed=true;streamState.clear();
    const settled=await Promise.allSettled([cancelBodyReader(reader,reason),events.return?.()]);
    try{reader.releaseLock();}catch{}
    if(settled[0].status==='rejected')throw settled[0].reason;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller){
      if(closed)return;
      try{
        // A converter may suppress a frame. Keep fulfilling this pull until
        // there is client output or EOF; an empty enqueue cannot trigger it.
        while(!closed){
        const part=await nextEvent();
        if(part.done){
          if(chain)for(const envelope of await chain.onFlushStream([],{...metadata(),isLastChunk:true}))controller.enqueue(encoder.encode(serialize(envelope)));
          closed=true;streamState.clear();reader.releaseLock();controller.close();return;
        }
        const frame=part.value;
        if(!isObjectBody(frame.json) || frame.data.trim()==='[DONE]' || frame.truncated){
          controller.enqueue(encoder.encode(frame.raw??''));return;
        }
        // Canonical frame/JSON is immutable and shared with accounting; modification gets one local copy.
        const envelope:SSEEnvelope={...frame,json:structuredClone(frame.json),comments:frame.comments?[...frame.comments]:undefined};
        const outputs=chain?await chain.onStreamChunk(envelope,metadata()):[envelope];index++;
        if(!outputs.length)continue;
        for(const output of outputs){
          if(!output || typeof output.data!=='string')throw new BodyProcessingError(502,'invalid_sse_plugin_envelope');
          let final=output;
          if(hasBodyModification(rules) && isObjectBody(output.json)) {
            const bodyContext={...context,headers:context.response?.headers??{},body:output.json,response:{headers:context.response?.headers??{},body:output.json}};
            final={...output,json:await applyBodyRules(output.json,rules,bodyContext,{})};
          }
          controller.enqueue(encoder.encode(serialize(final)));
        }
        return;
        }
      }catch(error){
        // A determined processing failure must survive even a rejecting or
        // indefinitely pending native cancellation. Explicit cancel still awaits it.
        controller.error(error instanceof BodyProcessingError && [408,413,503].includes(error.status)?error:new BodyProcessingError(502,'invalid_response_body'));
        void cancel(error).catch(()=>undefined);
      }
    },
    cancel,
  },{highWaterMark:0});
}
