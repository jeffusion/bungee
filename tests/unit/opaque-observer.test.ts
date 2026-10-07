import { test,expect } from 'bun:test';
import { gzipSync,zstdCompressSync } from 'node:zlib';
import { createAttemptResponseObserver } from '../../packages/core/src/worker/response/attempt-observation';
const context={requestId:'r',routeId:'route',attemptId:'a',upstreamId:'up',status:200};
const encoder=new TextEncoder();
test('slow side callback never stalls response bytes and side queue is bounded',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const events:any[]=[];
  const observer=createAttemptResponseObserver('sse',context,async(event)=>{events.push(event);if(event.phase==='response')await gate;});
  const payload=encoder.encode('data: {"x":1}\n\n'+'data: '+JSON.stringify({x:'x'.repeat(300000)})+'\n\n');
  const start=performance.now();const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode('data: {"x":1}\n\n'));controller.enqueue(payload.slice(15));controller.close();}});
  const bytes=await new Response(source.pipeThrough(observer)).arrayBuffer();
  expect(performance.now()-start).toBeLessThan(150);expect(new Uint8Array(bytes)).toEqual(payload);release();await observer.completion;
  expect(events.some(event=>event.phase==='incomplete'&&event.reason==='buffer-limit')).toBe(true);expect(events.some(event=>event.phase==='response')).toBe(true);
});
test('optional compressed JSON decode observes content independently from wire',async()=>{
  for(const [coding,compress] of [['gzip',gzipSync],['zstd',zstdCompressSync]] as const){const events:any[]=[];const payload=compress(encoder.encode('{"usage":{"total_tokens":3}}'));
    const observer=createAttemptResponseObserver('json',context,async(event)=>{events.push(event);},undefined,coding);
    const bytes=new Uint8Array(await new Response(new Response(payload).body!.pipeThrough(observer)).arrayBuffer());await observer.completion;
    expect(bytes).toEqual(payload);expect(events.find(event=>event.phase==='response')?.body).toEqual({usage:{total_tokens:3}});
  }
});
test('SSE observer metadata stays separate and does not inject JSON fields',async()=>{
  const events:any[]=[];const payload=encoder.encode('event: custom\nid: 7\ndata: {"usage":{"total_tokens":1}}\n\n');
  const observer=createAttemptResponseObserver('sse',context,async(event)=>{events.push(event);});await new Response(new Response(payload).body!.pipeThrough(observer)).text();await observer.completion;
  const event=events.find(event=>event.phase==='response');expect(event.body).toEqual({usage:{total_tokens:1}});expect(event.envelope.event).toBe('custom');expect(event.envelope.id).toBe('7');
});

test('CR-only SSE separators complete the last event for whole and bytewise input', async () => {
  const payload=encoder.encode('data: {"x":1}\r\r');
  for(const chunks of [[payload],Array.from(payload,byte=>Uint8Array.of(byte))]) {
    const events:any[]=[];const observer=createAttemptResponseObserver('sse',context,async event=>{events.push(event);});
    const source=new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
    expect(new Uint8Array(await new Response(source.pipeThrough(observer)).arrayBuffer())).toEqual(payload);await observer.completion;
    expect(events.filter(event=>event.phase==='response').map(event=>event.body)).toEqual([{x:1}]);
    expect(events.filter(event=>event.phase==='incomplete')).toHaveLength(0);
  }
});
