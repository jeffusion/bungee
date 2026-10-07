import type { BodyHandle, BodyConsumer } from '@jeffusion/bungee-core/plugin';
import { BodySource, BodyProcessingError, bodySourceFor, readBodyChunk, cancelBodyReader } from '../worker/request/body-source';

/** Drive a decorated transport only when the cache owner cannot drive that decoration itself. */
export async function readControlledBody<T>(source: BodySource, input: ReadableStream<Uint8Array> | null,
  read: () => Promise<T>, signal?: AbortSignal, consumerManaged=false): Promise<T> {
  const shared = input && bodySourceFor(input) === source;
  const work = consumerManaged?read():source.consumerWork(read,{id:'controlled-body',mandatory:true,signal});
  void work.catch(() => undefined);
  if (shared && input && !input.locked && source.mode !== 'replayable-bytes') {
    const reader=input.getReader();
    const drive=(async()=>{try {while(!(await readBodyChunk(reader,source.signal)).done) { /* Shared pulls belong to the source, not one consumer. */ }}
      catch(error) {await cancelBodyReader(reader,error).catch(()=>undefined);throw error;}
      finally {try{reader.releaseLock();}catch{}}})();
    void drive.catch(()=>undefined);
    // Successful finite reads include the decoration's EOF/flush. A cancelled
    // consumer can leave while the same driver remains useful to another one.
    return work.then(async value=>{await drive;return value;});
  }
  return work;
}
export function controlledBodyHandle(source:BodySource,input:ReadableStream<Uint8Array>|null,
  handle:BodyHandle,signal?:AbortSignal):BodyHandle {
  const consumerWithSignal=(consumer?:BodyConsumer):BodyConsumer|undefined=>consumer?.signal||!signal?consumer:{id:consumer?.id??'controlled-body-view',...consumer,signal};
  const read = <T>(consumer:BodyConsumer|undefined,work:()=>Promise<T>) =>
    readControlledBody(source,input,work,consumer?.signal ?? signal,true);
  return Object.freeze({...handle,
    bytes:(consumer?:BodyConsumer)=>{consumer=consumerWithSignal(consumer);return read(consumer,()=>handle.bytes(consumer));},
    decoded:(consumer?:BodyConsumer)=>{consumer=consumerWithSignal(consumer);return read(consumer,()=>handle.decoded(consumer));},
    json:(consumer?:BodyConsumer,emptyObject?:boolean)=>{consumer=consumerWithSignal(consumer);return read(consumer,()=>handle.json(consumer,emptyObject)).catch(error=>{
      if(consumer?.mandatory!==false && handle.identity.direction==='response' && error instanceof BodyProcessingError && error.status===400)
        throw new BodyProcessingError(502,'invalid_response_body');
      throw error;
    });},
    events:(consumer?:BodyConsumer)=>{
      consumer=consumerWithSignal(consumer);
      const iterable=handle.events(consumer);
      return {async *[Symbol.asyncIterator](){
        if(!input || input.locked || bodySourceFor(input)!==source){yield* iterable;return;}
        const iterator=iterable[Symbol.asyncIterator]();const reader=input.getReader();let eof=false;let failed=false;
        let pendingRead:Promise<Awaited<ReturnType<typeof reader.read>>>|undefined;
        try{while(true){
          const event=iterator.next();void event.catch(()=>undefined);let next;
          while(!eof){
            pendingRead??=readBodyChunk(reader,source.signal);void pendingRead.catch(()=>undefined);
            const result=await Promise.race([event.then(part=>({kind:'event' as const,part})),pendingRead.then(part=>({kind:'wire' as const,part}))]);
            if(result.kind==='event'){next=result.part;break;}
            pendingRead=undefined;eof=result.part.done;
          }
          next??=await event;if(next.done)return;yield next.value;
        }}catch(error){failed=!(error instanceof BodyProcessingError && error.code==='body_consumer_cancelled');throw error;}finally{
          await iterator.return?.();
          if(!eof && (source.hasActiveConsumers || consumer?.mandatory===false)){
            // The current consumer no longer owns this reader; another
            // subscriber still needs the same wire, so transfer the drive.
            const pending=pendingRead;
            void (async()=>{try{let part=pending?await pending:await reader.read();while(!part.done)part=await readBodyChunk(reader,source.signal);}
              catch(error){await cancelBodyReader(reader,error).catch(()=>undefined);}
              finally{try{reader.releaseLock();}catch{}}})();
          }else{
            const cleanup=async()=>{if(!eof)await cancelBodyReader(reader,'controlled body consumer ended').catch(()=>undefined);
              try{reader.releaseLock();}catch{}};
            // A known parsing failure must surface even if the source's cancel never settles.
            if(failed)void cleanup();else await cleanup();
          }
        }
      }};
    },
  });
}
