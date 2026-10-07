import { expect, test } from 'bun:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { BodySource, bodySourceFor } from '../src/gateway/body-service';
import { snapshotBodyResources } from '../src/gateway/body-resources';
import { captureBody } from '../src/logger/body-capture';
import { createAttemptResponseObserver } from '../src/worker/response/attempt-observation';
const context={requestId:'synthetic',routeId:'r',attemptId:'a',upstreamId:'u',status:200};
const encoder=new TextEncoder();
test('800 KiB and greater than 1 MiB JSON in a single wire chunk are observed completely',async()=>{
  for(const size of [800*1024,2*1024*1024]){
    const text=JSON.stringify({input:'x'.repeat(size),usage:{total_tokens:3}});const events:any[]=[];
    const observer=createAttemptResponseObserver('json',context,async event=>{events.push(event);});
    expect(await new Response(new Response(text).body!.pipeThrough(observer)).text()).toBe(text);await observer.completion;
    expect(events.filter(e=>e.phase==='incomplete')).toEqual([]);
    expect(events.find(e=>e.phase==='response')?.body.input.length).toBe(size);
  }
});
test('mandatory parsing, logging and observation share a decode and canonical parse',async()=>{
  for(const [coding,compress] of [['gzip',gzipSync],['zstd',zstdCompressSync]] as const){
    const original=JSON.stringify({input:'x'.repeat(800*1024),usage:{total_tokens:7}});const wire=new Uint8Array(compress(encoder.encode(original)));let saved:unknown;const errors:string[]=[];
    const before=snapshotBodyResources();
    const capture=captureBody(new Response(wire).body!,2*1024*1024,coding,async value=>{saved=value;},reason=>errors.push(reason),undefined,'application/json');
    const source=new BodySource(capture.body,4*1024*1024,coding);
    expect(source===bodySourceFor(capture.body)).toBe(true);
    const handle=source.handle();const mandatory=await handle.json({id:'rules',mandatory:true});const observed:any[]=[];
    const observer=createAttemptResponseObserver('json',context,async event=>{observed.push(event);},undefined,coding,'response','',undefined,{bodyHandle:handle,maxBytes:4*1024*1024});
    const output=source.take();
    expect(new Uint8Array(await new Response(new Response(output).body!.pipeThrough(observer)).arrayBuffer())).toEqual(wire);
    await Promise.all([capture.completion,observer.completion]);
    expect(observed.find(e=>e.phase==='response')?.body).toBe(mandatory);
    expect(saved).toBe(original);expect(errors).toEqual([]);
    const after=snapshotBodyResources();expect(after.decompressions-before.decompressions).toBe(1);expect(after.jsonParses-before.jsonParses).toBe(1);
    source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
  }
});
test('a cancelled consumer leaves mandatory and another optional consumer usable',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const before=snapshotBodyResources();const source=new BodySource(new ReadableStream({start(c){controller=c;}},{highWaterMark:0}),1024);const handle=source.handle();
  const abort=new AbortController();const optional=handle.json({id:'cancelled-log',mandatory:false,signal:abort.signal});const mandatory=handle.json({id:'rules',mandatory:true});
  abort.abort();controller.enqueue(encoder.encode('{"x":1}'));controller.close();
  await expect(optional).rejects.toMatchObject({code:'body_consumer_cancelled'});
  expect(await mandatory).toEqual({x:1});expect(await handle.json({id:'token',mandatory:false})).toBe(await mandatory);
  source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('log max size disables only that consumer and the mandatory/observer views remain intact',async()=>{
  const text=JSON.stringify({x:'x'.repeat(800*1024)});const reasons:string[]=[];
  const capture=captureBody(new Response(text).body!,64,'',async()=>{throw Error('must not save');},reason=>reasons.push(reason));
  const source=new BodySource(capture.body,2*1024*1024);expect((await source.handle().json({id:'rules',mandatory:true}) as any).x.length).toBe(800*1024);
  await capture.completion;expect(reasons).toEqual(['size_limit']);expect((await source.json('legacy-mutable')).x.length).toBe(800*1024);source.dispose();
});
test('opaque no-demand representation remains unread until transport pulls',async()=>{
  let pulls=0;const source=new BodySource(new ReadableStream({pull(c){pulls++;c.enqueue(Uint8Array.of(255,0));c.close();}},{highWaterMark:0}),1024,'unknown');
  source.handle();expect(pulls).toBe(0);expect(new Uint8Array(await new Response(source.take()).arrayBuffer())).toEqual(Uint8Array.of(255,0));source.dispose();
});
test('streaming gzip and zstd SSE logging and observation share framing and decoding',async()=>{
  for(const [coding,compress] of [['gzip',gzipSync],['zstd',zstdCompressSync]] as const){
    const text='event: named\ndata: {"usage":{"total_tokens":1}}\n\ndata: [DONE]\n\n';const wire=new Uint8Array(compress(encoder.encode(text)));const before=snapshotBodyResources();let saved:unknown;const reasons:string[]=[];
    const capture=captureBody(new Response(wire).body!,1024,coding,async value=>{saved=value;},reason=>reasons.push(reason),undefined,'text/event-stream');
    const owner=bodySourceFor(capture.body)!;const events:any[]=[];
    const observer=createAttemptResponseObserver('sse',context,async event=>{events.push(event);},undefined,coding,'response','',undefined,{bodyHandle:owner.handle(),maxBytes:1024});
    expect(new Uint8Array(await new Response(capture.body.pipeThrough(observer)).arrayBuffer())).toEqual(wire);
    await Promise.all([observer.completion,capture.completion]);
    expect(saved).toEqual([{event:'named',data:{usage:{total_tokens:1}}},{event:'message',data:'[DONE]'}]);expect(reasons).toEqual([]);
    expect(events.filter(e=>e.phase==='response')).toHaveLength(1);
    const after=snapshotBodyResources();expect(after.decompressions-before.decompressions).toBe(1);expect(after.sseParses-before.sseParses).toBe(1);expect(after.retainedBytes).toBe(before.retainedBytes);owner.dispose();
  }
});
test('SSE frame limit is per frame, with a cumulative stream much larger than that limit',async()=>{
  const frame=encoder.encode('data: {"x":"'+'x'.repeat(4096)+'"}\n\n');let emitted=0;let count=0;const before=snapshotBodyResources();
  const source=new BodySource(new ReadableStream<Uint8Array>({pull(c){if(emitted++<100)c.enqueue(frame);else c.close();}},{highWaterMark:0}),8192,'',undefined,{requestId:'r',attemptId:'a',direction:'response',stage:'upstream-response',version:0,contentType:'text/event-stream',contentEncoding:''});
  const observer=createAttemptResponseObserver('sse',context,async e=>{if(e.phase==='response')count++;},undefined,'','response','',undefined,{bodyHandle:source.handle(),maxBytes:8192});
  const bytes=await new Response((source.take() as ReadableStream<Uint8Array>).pipeThrough(observer)).arrayBuffer();await observer.completion;
  expect(bytes.byteLength).toBe(frame.byteLength*100);expect(count).toBe(100);source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('an opaque request with a shared optional handle observes EOF without upgrading mandatory reads',async()=>{
  const before=snapshotBodyResources();const capture=captureBody(new Response('{"x":1}').body!,1024,'',async()=>{},()=>{});const owner=bodySourceFor(capture.body)!;const events:any[]=[];
  const observer=createAttemptResponseObserver('json',context,async e=>{events.push(e);},undefined,'','request','/test',undefined,{bodyHandle:owner.handle(),maxBytes:1024});
  expect(await new Response(capture.body.pipeThrough(observer)).text()).toBe('{"x":1}');await Promise.all([observer.completion,capture.completion]);
  expect(events.find(e=>e.phase==='request')?.body).toEqual({x:1});owner.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('central SSE full frames retain raw CR/LF bytes, control-only frames and EOF tails',async()=>{
  const {BodySSEFramer}=await import('../src/gateway/body-events');
  const raw='\uFEFF: comment\r\nid: 3\r\nretry: 007\r\n\r\nevent: named\rdata: {"x":1}\r\rdata: [DONE]\n\n: tail';const frames:any[]=[];
  const parser=new BodySSEFramer(1024,event=>frames.push(event));for(const byte of encoder.encode(raw))parser.feed(Uint8Array.of(byte));parser.finish(true);
  expect(frames.map(frame=>frame.raw).join('')).toBe(raw);expect(frames[0].hasData).toBe(false);expect(frames[0].retry).toBe('007');expect(frames[1].json).toEqual({x:1});expect(frames.at(-1).hasData).toBe(false);expect(frames.at(-1).truncated).toBe(true);
});
test('missing SSE Content-Type reuses streaming decode while retaining common Accept fallback',async()=>{
  const before=snapshotBodyResources();const text='event: named\ndata: {"x":1}\n\ndata: [DONE]\n\n';const wire=new Uint8Array(gzipSync(encoder.encode(text)));let saved:unknown;
  const capture=captureBody(new Response(wire).body!,1024,'gzip',async value=>{saved=value;},()=>{},undefined,'','text/event-stream');const owner=bodySourceFor(capture.body)!;
  const observer=createAttemptResponseObserver('sse',context,async()=>{},undefined,'gzip','response','',undefined,{bodyHandle:owner.handle(),maxBytes:1024});
  expect(new Uint8Array(await new Response(capture.body.pipeThrough(observer)).arrayBuffer())).toEqual(wire);await Promise.all([observer.completion,capture.completion]);
  expect(saved).toEqual([{event:'named',data:{x:1}},{event:'message',data:'[DONE]'}]);expect(snapshotBodyResources().decompressions-before.decompressions).toBe(1);expect(snapshotBodyResources().jsonParses-before.jsonParses).toBe(2);owner.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('shared optional response limit never truncates the wire or fails another log consumer',async()=>{
  const before=snapshotBodyResources();const text=JSON.stringify({x:'x'.repeat(2048)});let saved:unknown;
  const source=new BodySource(new Response(text).body!,1024,'',undefined,{requestId:'r',attemptId:'a',direction:'response',stage:'upstream-response',version:0,contentType:'application/json',contentEncoding:''});
  const wire=source.take() as ReadableStream<Uint8Array>;const capture=captureBody(wire,4096,'',async value=>{saved=value;},()=>{});const events:any[]=[];
  const observer=createAttemptResponseObserver('json',context,async e=>{events.push(e);},undefined,'','response','',undefined,{maxBytes:1024,bodyHandle:source.handle()});
  expect(await new Response(capture.body.pipeThrough(observer)).text()).toBe(text);await Promise.all([capture.completion,observer.completion]);
  expect(saved).toBe(text);expect(events.filter(e=>e.phase==='incomplete').map(e=>e.reason)).toEqual(['buffer-limit']);source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('different JSON parser and log-save limits share compressed decoding without cross-consumer failure',async()=>{
  const before=snapshotBodyResources();const text=JSON.stringify({x:'x'.repeat(2048)});const wire=new Uint8Array(gzipSync(encoder.encode(text)));let saved:unknown;
  const source=new BodySource(new Response(wire).body!,1024,'gzip',undefined,{requestId:'r',attemptId:'a',direction:'response',stage:'upstream-response',version:0,contentType:'application/json',contentEncoding:'gzip'});
  const capture=captureBody(source.take() as ReadableStream<Uint8Array>,4096,'gzip',async value=>{saved=value;},()=>{});const events:any[]=[];
  const observer=createAttemptResponseObserver('json',context,async e=>{events.push(e);},undefined,'gzip','response','',undefined,{maxBytes:1024,bodyHandle:source.handle()});
  expect(new Uint8Array(await new Response(capture.body.pipeThrough(observer)).arrayBuffer())).toEqual(wire);await Promise.all([capture.completion,observer.completion]);
  expect(saved).toBe(text);expect(events.filter(e=>e.phase==='incomplete').map(e=>e.reason)).toEqual(['buffer-limit']);expect(snapshotBodyResources().decompressions-before.decompressions).toBe(1);source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});
test('readonly JSON freezing does not add an implicit nesting limit',async()=>{
  const text='['.repeat(5000)+'0'+']'.repeat(5000);const source=new BodySource(new Response(text).body!,64*1024);
  let value:any=await source.handle().json({id:'mandatory',mandatory:true});for(let i=0;i<5000;i++){expect(Object.isFrozen(value)).toBe(true);value=value[0];}expect(value).toBe(0);source.dispose();
});
test('mandatory SSE events, token observation and logging share one decoder and parsed frame',async()=>{
  const before=snapshotBodyResources();const text='data: {"x":1}\n\ndata: [DONE]\n\n';const wire=new Uint8Array(gzipSync(encoder.encode(text)));let saved:unknown;
  const capture=captureBody(new Response(wire).body!,1024,'gzip',async value=>{saved=value;},()=>{},undefined,'text/event-stream');const source=bodySourceFor(capture.body)!;const required:any[]=[];const observed:any[]=[];
  const mandatory=(async()=>{for await(const event of source.handle().events({id:'rules',mandatory:true}))if(event.json)required.push(event.json);})();
  const observer=createAttemptResponseObserver('sse',context,async event=>{if(event.phase==='response')observed.push(event.body);},undefined,'gzip','response','',undefined,{bodyHandle:source.handle(),maxBytes:1024});
  expect(new Uint8Array(await new Response(capture.body.pipeThrough(observer)).arrayBuffer())).toEqual(wire);await Promise.all([mandatory,capture.completion,observer.completion]);
  expect(observed[0]).toBe(required[0]);expect((saved as any[])[0].data).toBe(required[0]);expect(snapshotBodyResources().decompressions-before.decompressions).toBe(1);expect(snapshotBodyResources().sseParses-before.sseParses).toBe(1);
  source.dispose();expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);expect(snapshotBodyResources().activeDecoders).toBe(before.activeDecoders);
});
