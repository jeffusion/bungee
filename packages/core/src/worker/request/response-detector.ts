import { createBodySource } from '../../gateway/body-factory';
import { isStreamingResponse } from '../response/streaming-response';
import { BodyProcessingError } from './body-source';
export const MAX_BODY_INSPECT=1024*1024;
export const MAX_PEEK_BYTES=4096;
export interface ResponseCheckResult {hit:boolean;matchedKeyword?:string;response?:Response}
/** A bounded owned prefix; no cloned/tee branch can accumulate a response. */
export async function checkResponseForFailover(response:Response,keywords:string[]):Promise<ResponseCheckResult>{
  const rules=keywords.map(value=>value.trim()).filter(Boolean);if(!rules.length||!response.body)return {hit:false,response};
  const limit=isStreamingResponse(response)?MAX_PEEK_BYTES:MAX_BODY_INSPECT;
  // Transport ownership: retain/replay only the bounded wire prefix, never clone or tee.
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;let eof=false;const decoder=new TextDecoder('utf-8',{fatal:true});let text='';
  const coding=response.headers.get('content-encoding')?.trim().toLowerCase() ?? '';
  let hit:string|undefined;
  try{
    while(size<limit){const part=await reader.read();if(part.done){eof=true;break;}chunks.push(part.value);size+=part.value.byteLength;
      if(!coding||coding==='identity'){text+=decoder.decode(part.value,{stream:true});hit=rules.find(keyword=>text.includes(keyword));if(hit)break; if(isStreamingResponse(response)&&/(?:\r\n|\n){2}/.test(text))break;}
    }
    if((!coding||coding==='identity')&&eof){text+=decoder.decode();hit=rules.find(keyword=>text.includes(keyword));}
    else if(coding&&eof&&size<=limit){const wire=new Uint8Array(size);let offset=0;for(const chunk of chunks){wire.set(chunk,offset);offset+=chunk.byteLength;}
      const source=createBodySource(new Response(wire).body,MAX_BODY_INSPECT,coding,undefined,
        {requestId:'',attemptId:'',direction:'response',stage:'upstream-response',version:0,contentType:response.headers.get('content-type')??'',contentEncoding:coding});
      try{ // JSON/text decoded views share the same bounded streaming codec as necessary rules.
        text=decoder.decode(await source.decoded('response-keyword'));hit=rules.find(keyword=>text.includes(keyword));
      }finally{source.dispose();}
    }
    if(hit){void reader.cancel('response keyword matched').catch(()=>undefined);return {hit:true,matchedKeyword:hit};}
  }catch{void reader.cancel('response inspection failed').catch(()=>undefined);throw new BodyProcessingError(502,'response_inspection_failed');}
  let index=0;const restored=new ReadableStream<Uint8Array>({async pull(controller){try{if(index<chunks.length){controller.enqueue(chunks[index++]!);return;}if(eof){controller.close();return;}const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value);}catch(error){controller.error(error);}},cancel(reason){return reader.cancel(reason);}}, {highWaterMark:0});
  return {hit:false,response:new Response(restored,{status:response.status,statusText:response.statusText,headers:response.headers})};
}
