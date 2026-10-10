import {expect,test} from 'bun:test';
import {gzipSync} from 'node:zlib';
import {BodySource,bindBodySource} from '../src/gateway/body-service';
import {controlledBodyHandle,readControlledBody} from '../src/gateway/controlled-views';
import {observeBodyStream} from '../src/gateway/body-observation-stream';
import {createAttemptResponseObserver} from '../src/worker/response/attempt-observation';
import {snapshotBodyResources} from '../src/gateway/body-resources';
import {sharedSSEResponse} from '../src/gateway/sse-response';

const encode=(text:string)=>new TextEncoder().encode(text);
const context={requestId:'synthetic-lifecycle',routeId:'r',attemptId:'a',upstreamId:'u',status:200};
const identity={requestId:'synthetic-lifecycle',attemptId:'a',direction:'response' as const,stage:'upstream-response' as const,version:0,contentType:'text/event-stream',contentEncoding:''};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('SSE signal cancellation waits for the last mandatory native cancel gate',async()=>{
  for(const decorated of [false,true]){
    let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});let cancelled=0;
    const input=new ReadableStream<Uint8Array>({cancel(){cancelled++;return gate;}},{highWaterMark:0});
    const source=new BodySource(input,1024,'',undefined,identity);const wire=source.take() as ReadableStream<Uint8Array>;
    const abort=new AbortController();const handle=decorated?controlledBodyHandle(source,wire,source.handle()):source.handle();
    const iterator=handle.events({id:'signal-gate',mandatory:true,signal:abort.signal})[Symbol.asyncIterator]();
    // Bare event handles receive wire from their transport owner.
    const driver=decorated?undefined:new Response(wire).arrayBuffer().catch(()=>undefined);
    let settled=false;const pending=iterator.next().catch(error=>error).finally(()=>{settled=true;});
    await tick();abort.abort();await tick();expect(cancelled).toBe(1);expect(settled).toBe(false);expect(input.locked).toBe(true);
    open();expect((await pending).code).toBe('body_consumer_cancelled');await driver;await tick();expect(input.locked).toBe(false);source.dispose();
  }
});

test('SSE conversion failure surfaces before native cancellation settles',async()=>{
  let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});let cancelled=0;let sent=false;
  const input=new ReadableStream<Uint8Array>({pull(c){if(!sent){sent=true;c.enqueue(encode('data: {"x":1}\n\n'));}},cancel(){cancelled++;return gate;}},{highWaterMark:0});
  const source=new BodySource(input,1024,'',undefined,identity);
  const chain={async onStreamChunk(){return [{}];}} as any;
  const context={headers:{},body:{},url:{pathname:'/',search:'',host:'test',protocol:'http:'},method:'GET',env:{}};
  const reader=sharedSSEResponse(source.take() as ReadableStream<Uint8Array>,source.handle(),{},context,chain).getReader();
  try{await expect(reader.read()).rejects.toMatchObject({status:502,code:'invalid_response_body'});expect(cancelled).toBe(1);expect(input.locked).toBe(true);}
  finally{open();await tick();source.dispose();}
});

test('SSE frame errors retain their code even when cancellation rejects',async()=>{
  let sent=false;
  const input=new ReadableStream<Uint8Array>({pull(c){if(!sent){sent=true;c.enqueue(encode('data: '+ 'x'.repeat(32)+'\n\n'));}},cancel(){throw new Error('synthetic cancel failure');}},{highWaterMark:0});
  const source=new BodySource(input,16,'',undefined,identity);
  const context={headers:{},body:{},url:{pathname:'/',search:'',host:'test',protocol:'http:'},method:'GET',env:{}};
  const reader=sharedSSEResponse(source.take() as ReadableStream<Uint8Array>,source.handle(),{},context).getReader();
  try{await expect(reader.read()).rejects.toMatchObject({status:413,code:'body_sse_frame_too_large'});}
  finally{await tick();source.dispose();}
});

test('controlled legacy reads and handle fallback signals own their deadline cancellation',async()=>{
  for(const legacy of [true,false]){
    let cancelled=0;const input=new ReadableStream<Uint8Array>({cancel(){cancelled++;}},{highWaterMark:0});const source=new BodySource(input,1024);
    const controller=new AbortController();const handle=controlledBodyHandle(source,input,source.handle(),controller.signal);
    const pending=(legacy?readControlledBody(source,input,()=>source.json('legacy-demand'),controller.signal):handle.json({id:'fallback-signal',mandatory:true})).catch(error=>error);
    await tick();controller.abort();expect((await pending).code).toBe('body_consumer_cancelled');expect(cancelled).toBe(1);await tick();expect(input.locked).toBe(false);source.dispose();
  }
});

test('the last mandatory consumer cancels the physical reader once and waits for its cancel gate',async()=>{
  const before=snapshotBodyResources();let cancelled=0;let unlock!:()=>void;
  const gate=new Promise<void>(resolve=>{unlock=resolve;});
  const input=new ReadableStream<Uint8Array>({start(c){c.enqueue(encode('{"partial":"'+'x'.repeat(128)));},cancel(){cancelled++;return gate;}},{highWaterMark:0});
  const source=new BodySource(input,1024);const controller=new AbortController();
  const handle=controlledBodyHandle(source,input,source.handle());let settled=false;
  const work=handle.json({id:'mandatory-json',mandatory:true,signal:controller.signal});
  const result=work.catch(error=>error).finally(()=>{settled=true;});
  await tick();expect(snapshotBodyResources().retainedBytes).toBeGreaterThan(before.retainedBytes);controller.abort('consumer deadline');await tick();
  expect(cancelled).toBe(1);expect(settled).toBe(false);
  unlock();expect(await result).toMatchObject({code:'body_consumer_cancelled'});
  await expect(source.completion).rejects.toMatchObject({code:'body_consumer_cancelled'});
  await tick();expect(input.locked).toBe(false);source.dispose();
  expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});

test('one mandatory or optional JSON cancellation leaves the other mandatory reader usable',async()=>{
  for(const mandatory of [true,false]){
    let cancelled=0;let wire!:ReadableStreamDefaultController<Uint8Array>;
    const input=new ReadableStream<Uint8Array>({start(c){wire=c;},cancel(){cancelled++;}},{highWaterMark:0});
    const source=new BodySource(input,1024);const handle=controlledBodyHandle(source,input,source.handle());const controller=new AbortController();
    const leaving=handle.json({id:'leaving',mandatory,signal:controller.signal}).catch(error=>error);
    const staying=handle.json({id:'staying',mandatory:true});
    await tick();controller.abort();expect(await leaving).toMatchObject({code:'body_consumer_cancelled'});expect(cancelled).toBe(0);
    wire.enqueue(encode('{"usage":7}'));wire.close();expect(await staying).toEqual({usage:7});expect(cancelled).toBe(0);source.dispose();
  }
});

test('mandatory SSE cancellation releases a live decoder and source lock',async()=>{
  const before=snapshotBodyResources();let cancelled=0;
  const compressed=new Uint8Array(gzipSync(encode('data: {"x":1}\n\n')));
  let sent=false;const input=new ReadableStream<Uint8Array>({pull(c){if(!sent){sent=true;c.enqueue(compressed);}},cancel(){cancelled++;}},{highWaterMark:0});
  const source=new BodySource(input,4096,'gzip',undefined,{...identity,contentEncoding:'gzip'});const wire=source.take() as ReadableStream<Uint8Array>;
  const controller=new AbortController();const handle=controlledBodyHandle(source,wire,source.handle());
  const iterator=handle.events({id:'necessary-frames',mandatory:true,signal:controller.signal})[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.json).toEqual({x:1});
  const pending=iterator.next().catch(error=>error);controller.abort('SSE deadline');
  expect((await pending).code).toBe('body_consumer_cancelled');await tick();
  expect(cancelled).toBe(1);expect(input.locked).toBe(false);source.dispose();
  expect(snapshotBodyResources().activeDecoders).toBe(before.activeDecoders);expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});

test('a cancelled SSE driver transfers its wire read to the remaining mandatory subscriber',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;let cancelled=0;
  const input=new ReadableStream<Uint8Array>({start(c){controller=c;},cancel(){cancelled++;}},{highWaterMark:0});
  const source=new BodySource(input,1024,'',undefined,identity);const wire=source.take() as ReadableStream<Uint8Array>;
  const handle=controlledBodyHandle(source,wire,source.handle());const abort=new AbortController();
  const first=handle.events({id:'leaving',mandatory:true,signal:abort.signal})[Symbol.asyncIterator]();
  const second=handle.events({id:'staying',mandatory:true})[Symbol.asyncIterator]();
  const leaving=first.next().catch(error=>error);const staying=second.next();await tick();abort.abort();
  expect((await leaving).code).toBe('body_consumer_cancelled');expect(cancelled).toBe(0);
  controller.enqueue(encode('data: {"x":2}\n\ndata: [DONE]\n\n'));controller.close();
  expect((await staying).value?.json).toEqual({x:2});expect((await second.next()).value?.data).toBe('[DONE]');expect((await second.next()).done).toBe(true);
  expect(cancelled).toBe(0);source.dispose();
});

test('optional SSE cancellation does not cancel another optional subscriber or its wire drive',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;let cancelled=0;
  const input=new ReadableStream<Uint8Array>({start(c){controller=c;},cancel(){cancelled++;}},{highWaterMark:0});
  const source=new BodySource(input,1024,'',undefined,identity);const wire=source.take() as ReadableStream<Uint8Array>;
  const handle=controlledBodyHandle(source,wire,source.handle());const abort=new AbortController();
  const first=handle.events({id:'optional-leaving',mandatory:false,signal:abort.signal})[Symbol.asyncIterator]();
  const second=handle.events({id:'optional-staying',mandatory:false})[Symbol.asyncIterator]();
  const leaving=first.next().catch(error=>error);const staying=second.next();await tick();abort.abort();
  expect((await leaving).code).toBe('body_consumer_cancelled');expect(cancelled).toBe(0);
  controller.enqueue(encode('data: {"x":3}\n\n'));controller.close();expect((await staying).value?.json).toEqual({x:3});expect((await second.next()).done).toBe(true);
  expect(cancelled).toBe(0);source.dispose();
});

test('installing observation is lazy and a later mandatory subscriber retains first frame, DONE and all statistics',async()=>{
  const before=snapshotBodyResources();const text='data: {"usage":{"total_tokens":1}}\n\ndata: {"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n';let pulls=0;const observed:any[]=[];
  const source=new BodySource(new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(encode(text));c.close();}},{highWaterMark:0}),4096,'',undefined,identity);
  const observer=createAttemptResponseObserver('sse',context,async event=>{observed.push(event);},undefined,'','response','',undefined,{bodyHandle:source.handle(),maxBytes:4096});
  const wire=observeBodyStream(source.take() as ReadableStream<Uint8Array>,observer);bindBodySource(wire,source);
  for(let i=0;i<30;i++)await Promise.resolve();expect(pulls).toBe(0);expect(observed).toEqual([]);
  const frames:any[]=[];const handle=controlledBodyHandle(source,wire,source.handle());
  for await(const frame of handle.events({id:'late-mandatory',mandatory:true}))frames.push(frame);
  await observer.completion;
  expect(frames.map(frame=>frame.raw).join('')).toBe(text);expect(frames[0].json.usage.total_tokens).toBe(1);expect(frames.at(-1).data).toBe('[DONE]');
  expect(observed.filter(event=>event.phase==='response').map(event=>event.body.usage.total_tokens)).toEqual([1,2]);
  expect(snapshotBodyResources().sseParses-before.sseParses).toBe(1);source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});

test('a controlled finite JSON view waits for lazy decoration EOF without bypassing its observer',async()=>{
  const source=new BodySource(new Response('{"usage":{"total_tokens":11}}').body!,4096,'',undefined,{...identity,contentType:'application/json'});const observed:any[]=[];
  const observer=createAttemptResponseObserver('json',context,async event=>{observed.push(event);},undefined,'','response','',undefined,{bodyHandle:source.handle(),maxBytes:4096});
  const wire=observeBodyStream(source.take() as ReadableStream<Uint8Array>,observer);bindBodySource(wire,source);
  const handle=controlledBodyHandle(source,wire,source.handle());expect(await handle.json({id:'raw-plugin-json',mandatory:true})).toEqual({usage:{total_tokens:11}});
  observer.finish();await observer.completion;
  expect(observed.filter(event=>event.phase==='response').map(event=>event.body.usage.total_tokens)).toEqual([11]);expect(observed.filter(event=>event.phase==='incomplete')).toEqual([]);source.dispose();
});

test('lazy observation cancellation awaits the actual source gate and closes pending read and observer',async()=>{
  let cancelled=0;let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});
  const observer=createAttemptResponseObserver('sse',context,async()=>{});
  const wire=observeBodyStream(new ReadableStream<Uint8Array>({cancel(){cancelled++;return gate;}},{highWaterMark:0}),observer);const reader=wire.getReader();
  const pending=reader.read();let complete=false;const cancel=reader.cancel('test cancellation').then(()=>{complete=true;});await tick();
  expect(cancelled).toBe(1);expect(complete).toBe(false);open();await cancel;expect((await pending).done).toBe(true);await observer.completion;
});

test('cancelling an installed observer before its first pull cancels once without reading',async()=>{
  let pulls=0;let cancelled=0;
  const observer=createAttemptResponseObserver('sse',context,async()=>{});
  const wire=observeBodyStream(new ReadableStream<Uint8Array>({pull(){pulls++;},cancel(){cancelled++;}},{highWaterMark:0}),observer);
  await wire.cancel('unused wire');await observer.completion;expect(pulls).toBe(0);expect(cancelled).toBe(1);
});

test('lazy observation preserves source failure and rejects a real cancel failure',async()=>{
  const failure=new Error('synthetic wire failure');
  const observer=createAttemptResponseObserver('sse',context,async()=>{});
  const wire=observeBodyStream(new ReadableStream<Uint8Array>({pull(c){c.error(failure);}},{highWaterMark:0}),observer);
  await expect(wire.getReader().read()).rejects.toBe(failure);await observer.completion;
  const second=createAttemptResponseObserver('sse',context,async()=>{});let cancelled=0;
  const rejected=observeBodyStream(new ReadableStream<Uint8Array>({cancel(){cancelled++;throw failure;}},{highWaterMark:0}),second);
  await expect(rejected.cancel()).rejects.toBe(failure);await second.completion;expect(cancelled).toBe(1);
});
