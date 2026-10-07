import type { BodyConsumer, BodyEvent } from './body-contracts';
import { BodyBufferLease, BodyProcessingError, decodeStream, freezeBodyValue } from './body-service';
import { bodyMetrics, bodyResources } from './body-resources';

export class BodySSEFramer {
  private text='';private raw='';private data:string[]=[];private event='';private id:string|undefined;private retry:string|undefined;private comments:string[]=[];private count=0;private tail=false;private firstLine=true;
  private decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  constructor(readonly configuredMax:number|(()=>number),readonly emit:(event:BodyEvent,bytes:number)=>void) {}
  get maxBytes():number{return typeof this.configuredMax==='number'?this.configuredMax:this.configuredMax();}
  private line(line:string,delimiter='\n'):void {
    this.count+=Buffer.byteLength(line+delimiter);
    if(this.count>this.maxBytes)throw new BodyProcessingError(413,'body_sse_frame_too_large',this.maxBytes,this.count);
    this.raw+=line+delimiter;
    if(this.firstLine){this.firstLine=false;if(line.startsWith('\uFEFF'))line=line.slice(1);}
    if(line===''){
      if(this.raw){const data=this.data.join('\n');let json:unknown;if(this.data.length)try{bodyMetrics.jsonParses++;json=freezeBodyValue(JSON.parse(data));}catch{}
        this.emit(Object.freeze({data,hasData:this.data.length>0,json,event:this.event||undefined,id:this.id,retry:this.retry,comments:Object.freeze(this.comments) as unknown as string[],raw:this.raw,truncated:this.tail||undefined}),this.count);}
      this.raw='';this.data=[];this.event='';this.comments=[];this.count=0;this.retry=undefined;return;
    }
    if(line.startsWith(':')){this.comments.push(line.slice(1));return;}
    const colon=line.indexOf(':');const field=colon<0?line:line.slice(0,colon);let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
    if(field==='data')this.data.push(value);else if(field==='event')this.event=value;else if(field==='id'&&!value.includes('\0'))this.id=value;
    else if(field==='retry'&&/^\d+$/.test(value))this.retry=value;
  }
  get retainedBytes():number {return this.count*4+Buffer.byteLength(this.text)*2;}
  feed(bytes:Uint8Array):void {
    this.text+=this.decoder.decode(bytes,{stream:true});this.consume(false);
    if(this.count+Buffer.byteLength(this.text)>this.maxBytes)throw new BodyProcessingError(413,'body_sse_frame_too_large',this.maxBytes,this.count+Buffer.byteLength(this.text));
  }
  private consume(eof:boolean):void {
    let match:RegExpExecArray|null;
    while((match=/\r\n|\r(?!$)|\n/.exec(this.text))){const line=this.text.slice(0,match.index);this.text=this.text.slice(match.index+match[0].length);this.line(line,match[0]);}
    if(eof&&this.text.endsWith('\r')){this.line(this.text.slice(0,-1),'\r');this.text='';}
  }
  finish(retainTail=false):void {
    this.text+=this.decoder.decode();this.consume(true);
    if(retainTail){this.tail=true;if(this.text)this.line(this.text,'');if(this.raw)this.line('','');}
    else if(this.data.length||/^data(?::|$)/.test(this.text))throw new BodyProcessingError(400,'body_sse_frame_truncated');
  }
}
interface SharedFrame {event:BodyEvent;bytes:number;lease:BodyBufferLease;refs:number}
interface Subscriber {queue:SharedFrame[];held:number;current?:SharedFrame;wake?:()=>void;error?:unknown;done:boolean;consumer?:BodyConsumer}
/** A single decoder/framer fans out borrowed frame references to isolated bounded subscribers. */
export class BodyEventSession {
  private chunks:Uint8Array[]=[];private wireLease=new BodyBufferLease(true);private wake?:()=>void;private eof=false;private ended=false;private error?:unknown;
  private subscribers=new Set<Subscriber>();private work:Promise<void>;private decodedStream?:ReturnType<typeof decodeStream>;private pendingLease?:BodyBufferLease;
  constructor(readonly coding:string,public maxBytes:number,readonly signal?:AbortSignal,readonly decodedChunk?:(chunk:Uint8Array)=>void,readonly decodedEnd?:()=>void,readonly captureFrame?:(event:BodyEvent,bytes:number,retain:()=>()=>void)=>void) {
    const input=new ReadableStream<Uint8Array>({pull:async controller=>{
      while(!this.chunks.length&&!this.eof&&!this.ended)await new Promise<void>(resolve=>{this.wake=resolve;});this.wake=undefined;
      const chunk=this.chunks.shift();if(chunk){this.wireLease.release(chunk.byteLength);controller.enqueue(chunk);}else controller.close();
    }},{highWaterMark:0});
    this.work=(async()=>{let stream:ReturnType<typeof decodeStream>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const pending=new BodyBufferLease(true);this.pendingLease=pending;let pendingBytes=0;
      try{await Promise.resolve();stream=decodeStream(input,coding,Number.MAX_SAFE_INTEGER,signal,![...this.subscribers].some(s=>s.consumer?.mandatory!==false));this.decodedStream=stream;if([...this.subscribers].some(s=>s.consumer?.mandatory!==false)){this.wireLease.promote();pending.promote();}reader=stream.getReader();bodyMetrics.sseParses++;
        const parser=new BodySSEFramer(()=>this.maxBytes,(event,bytes)=>this.publish(event,bytes));
        while(this.subscribers.size || !this.ended){const part=await reader.read();if(part.done)break;
          this.decodedChunk?.(part.value);pending.add(part.value.byteLength*6);pendingBytes+=part.value.byteLength*6;parser.feed(part.value);
          // The framer bounds each frame. Keep a conservative one-frame lease between pulls.
          const release=Math.max(0,pendingBytes-parser.retainedBytes);pending.release(release);pendingBytes-=release;
        }this.decodedEnd?.();parser.finish(true);
      }catch(error){this.error=error;}
      finally{pending.dispose();stream?.dispose();await reader?.cancel().catch(()=>undefined);this.ended=true;this.wireLease.dispose();this.chunks=[];for(const sub of this.subscribers){sub.done=true;sub.error??=this.error;sub.wake?.();}}
    })();void this.work.catch(()=>undefined);
  }
  get completion():Promise<void>{return this.work;}
  push(chunk:Uint8Array):void {
    if(this.ended||!this.subscribers.size)return;
    try{this.wireLease.add(chunk.byteLength);this.chunks.push(new Uint8Array(chunk));this.wake?.();}
    catch(error){this.error=error;this.end();}
  }
  end(error?:unknown):void {this.error??=error;this.eof=true;this.wake?.();}
  private release(frame:SharedFrame):void {if(--frame.refs===0)frame.lease.dispose();}
  private clear(sub:Subscriber):void {for(const frame of sub.queue)this.release(frame);sub.queue=[];sub.held=0;if(sub.current){this.release(sub.current);sub.current=undefined;}sub.wake?.();}
  private publish(event:BodyEvent,bytes:number):void {
    const allocation=new BodyBufferLease(![...this.subscribers].some(s=>s.consumer?.mandatory!==false));allocation.add(128+bytes*4);
    const frame:SharedFrame={event,bytes,lease:allocation,refs:0};
    this.captureFrame?.(event,bytes,()=>{frame.refs++;return()=>this.release(frame);});
    for(const sub of this.subscribers){if(sub.done)continue;
      if((sub.consumer?.mandatory===false && sub.queue.length>=(sub.consumer?.backlogEvents??bodyResources.observerBacklogEvents)) || sub.held+bytes>(sub.consumer?.backlogBytes??(sub.consumer?.mandatory===false?bodyResources.observerBacklogBytes:bodyResources.workerMemoryBytes))){sub.error=new BodyProcessingError(503,'body_observer_backlog');sub.done=true;this.clear(sub);this.subscribers.delete(sub);continue;}
      frame.refs++;sub.queue.push(frame);sub.held+=bytes;sub.wake?.();
    }if(!frame.refs)allocation.dispose();if(!this.subscribers.size)this.end();
  }
  events(consumer?:BodyConsumer):AsyncIterable<BodyEvent> {
    const sub:Subscriber={queue:[],held:0,done:this.ended,error:this.error,consumer};
    if(consumer?.mandatory!==false)try{this.decodedStream?.promote?.();this.wireLease.promote();this.pendingLease?.promote();for(const sub of this.subscribers)for(const frame of sub.queue)frame.lease.promote();}catch(error){sub.done=true;sub.error=error;}
    if(!sub.done)this.subscribers.add(sub);
    const abort=()=>{sub.error=new BodyProcessingError(408,'body_consumer_cancelled');sub.done=true;this.clear(sub);this.subscribers.delete(sub);if(!this.subscribers.size)this.end();};
    consumer?.signal?.addEventListener('abort',abort,{once:true});if(consumer?.signal?.aborted)abort();
    const session=this;
    return {async *[Symbol.asyncIterator](){try{while(true){
      if(sub.current){session.release(sub.current);sub.current=undefined;}
      while(!sub.queue.length&&!sub.done)await new Promise<void>(resolve=>{sub.wake=resolve;});sub.wake=undefined;
      if(sub.error)throw sub.error;const frame=sub.queue.shift();if(!frame)break;sub.held-=frame.bytes;sub.current=frame;yield frame.event;
    }}finally{session.clear(sub);session.subscribers.delete(sub);consumer?.signal?.removeEventListener('abort',abort);if(!session.subscribers.size)session.end();}}};
  }
}
