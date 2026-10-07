import { describe, test, expect } from 'bun:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handleRequest } from '../../packages/core/src/worker/request/handler';
import { BodySource } from '../../packages/core/src/worker/request/body-source';
import { createSSEEnvelopeTransform, prepareResponse } from '../../packages/core/src/worker/response/processor';
import type { AppConfig } from '@jeffusion/bungee-types';
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const config = (target:string, route:Record<string,unknown> = {}, endpoint:Record<string,unknown> = {}):AppConfig => ({port:0,routes:[{path:'/test',...route,endpoints:[{target,...endpoint}]}]} as AppConfig);
const logging = { accessLogWriter:{write(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{write(){}} };
async function run(payload:Uint8Array,coding:string,route:Record<string,unknown>={},endpoint:Record<string,unknown>={}, type='application/json') {
  let received:Uint8Array | undefined; let headers:Headers | undefined;
  const upstream = Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){ received = new Uint8Array(await req.arrayBuffer()); headers = req.headers; return new Response(received,{headers:{'content-type':type,...(req.headers.get('content-encoding')?{'content-encoding':req.headers.get('content-encoding')!}:{})}}); }});
  try {
    const response = await handleRequest(new Request('http://gateway/test',{method:'POST',body:payload,headers:{'content-type':type,...(coding?{'content-encoding':coding}:{})}}),config(upstream.url.origin,route,endpoint),{logging});
    const bytes = new Uint8Array(await response.arrayBuffer()); return {response,bytes,received:received!,headers:headers!};
  } finally { await upstream.stop(true); }
}
describe('opaque transport',()=>{
  test('wire bytes and coding remain identical without a body demand',async()=>{
    const json=encoder.encode('{ "x":1 }');
    for(const [payload,coding,type] of [[zstdCompressSync(json),'zstd','application/json'],[gzipSync(json),'gzip','application/json'],[encoder.encode('{invalid'),'','application/json'],[new Uint8Array([0,255,128,1]),'unknown','application/octet-stream']] as const){
      const result=await run(payload,coding); expect(result.response.status).toBe(200); expect(hash(result.received)).toBe(hash(payload)); expect(hash(result.bytes)).toBe(hash(payload)); expect(result.response.headers.get('content-encoding')).toBe(coding || null);
    }
  });
  test('readonly header expression decodes zstd once and preserves wire',async()=>{
    const payload=zstdCompressSync(encoder.encode('{"model":"test"}'));
    const result=await run(payload,'zstd',{request:{headers:{add:{'x-model':'{{body.model}}'}}}});
    expect(result.headers.get('x-model')).toBe('test');expect(hash(result.received)).toBe(hash(payload));expect(hash(result.bytes)).toBe(hash(payload));
  });
  test('directional rules merge independently and reconcile coding',async()=>{
    const result=await run(zstdCompressSync(encoder.encode('{"x":1}')),'zstd',
      {request:{body:{add:{a:1,x:2}}},response:{body:{add:{a:3,z:false}}}},
      {request:{body:{add:{x:4}}},response:{body:{add:{a:2,b:null}}}});
    // Upstream echoes identity after request modification.
    expect(JSON.parse(new TextDecoder().decode(result.received))).toEqual({x:4,a:1});expect(result.headers.get('content-encoding')).toBeNull();
    expect(result.response.status).toBe(200);expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({x:4,a:3,b:null,z:false});expect(result.response.headers.get('content-encoding')).toBeNull();expect(result.response.headers.get('content-length')).toBe(String(result.bytes.byteLength));
  });
  test('empty modification blocks retain malformed JSON wire',async()=>{
    const payload=encoder.encode('{bad');const result=await run(payload,'',{request:{body:{add:{},remove:[]}},response:{body:{}}}); expect(hash(result.bytes)).toBe(hash(payload));
  });
  test('opaque response first chunk arrives before EOF',async()=>{
    let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
    const upstream=Bun.serve({port:0,hostname:'127.0.0.1',fetch(){return new Response(new ReadableStream({async start(controller){controller.enqueue(encoder.encode('first'));await gate;controller.enqueue(encoder.encode('last'));controller.close();}}),{headers:{'content-type':'application/octet-stream'}});}});
    try { const response=await handleRequest(new Request('http://gateway/test'),config(upstream.url.origin),{logging});const reader=response.body!.getReader();const first=await reader.read();expect(new TextDecoder().decode(first.value)).toBe('first');finish();expect((await reader.read()).done).toBe(false);expect((await reader.read()).done).toBe(true); } finally {finish();await upstream.stop(true);}
  });
  test('SSE frame splitting preserves event id retry comments and DONE',async()=>{
    const text=': hello\r\nevent: named\r\nid: 7\r\nretry: 12\r\ndata: {"type":"different","x":1}\r\n\r\ndata: [DONE]\r\n\r\n';
    const source=new ReadableStream<Uint8Array>({start(controller){for(const byte of encoder.encode(text))controller.enqueue(new Uint8Array([byte]));controller.close();}});
    const transformed=source.pipeThrough(createSSEEnvelopeTransform({add:{x:2}}, {headers:{},body:{},url:{pathname:'/',search:'',host:'a',protocol:'http:'},method:'POST',env:{}},1024));
    const result=await new Response(transformed).text();expect(result).toContain(': hello\nevent: named\nid: 7\nretry: 12\ndata: {"type":"different","x":2}\n\n');expect(result).toEndWith('data: [DONE]\r\n\r\n');expect(result).not.toContain('event: different');expect(result).not.toContain('_event');
  });
  test('false/null/zero/empty values survive readonly JSON',async()=>{for(const value of [false,null,0,'']){const bytes=encoder.encode(JSON.stringify(value));const source=new BodySource(new Response(bytes).body,1024);try{expect(await source.json('read')).toBe(value);expect(hash(new Uint8Array(await new Response(source.take()).arrayBuffer()))).toBe(hash(bytes));}finally{source.dispose();}}});
  test('necessary parsing enforces encoding, corruption and limits',async()=>{
    for(const [bytes,coding,status] of [[encoder.encode('{}'),'unknown',415],[encoder.encode('bad'),'gzip',400],[encoder.encode('{bad'),'',400]] as const){const source=new BodySource(new Response(bytes).body,1024,coding);try{await expect(source.json('necessary')).rejects.toMatchObject({status});}finally{source.dispose();}}
    const source=new BodySource(new Response(gzipSync(encoder.encode(' '.repeat(4096)))).body,1024,'gzip');try{await expect(source.json('necessary')).rejects.toMatchObject({status:413});}finally{source.dispose();}
  });
});

test('response readonly expression preserves compressed entity and current direction',async()=>{
  const bytes=zstdCompressSync(encoder.encode('{ "n": 7 }'));
  const result=await run(bytes,'zstd',{response:{headers:{add:{'x-result':'{{response.body.n}}'}}}});
  expect(result.response.headers.get('x-result')).toBe('7');expect(result.response.headers.get('content-encoding')).toBe('zstd');expect(hash(result.bytes)).toBe(hash(bytes));
});
test('empty POST add creates an object; GET body rules never generate a body',async()=>{
  let forwarded:string|undefined;
  const upstream=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){forwarded=await req.text();return new Response(forwarded);}});
  try{
    const cfg=config(upstream.url.origin,{request:{body:{add:{enabled:false,missing:null},default:{count:0,text:''}}}});
    const post=await handleRequest(new Request('http://gateway/test',{method:'POST'}),cfg,{logging});await post.text();expect(JSON.parse(forwarded!)).toEqual({enabled:false,missing:null,count:0,text:''});
    const get=await handleRequest(new Request('http://gateway/test'),cfg,{logging});await get.text();expect(forwarded).toBe('');
  }finally{await upstream.stop(true);}
});
test('Route body format selection overrides Endpoint and SSE remains raw',async()=>{
  const payload=encoder.encode('event: custom\ndata: {"x":1}\n\ndata: [DONE]\n\n');
  const result=await run(payload,'',{response:{body_formats:['json']}},{response:{body_formats:['json','sse-json'],body:{add:{x:2}}}},'text/event-stream');
  expect(hash(result.bytes)).toBe(hash(payload));
});
test('configured retry buffers and replays the exact compressed wire',async()=>{
  const payload=zstdCompressSync(encoder.encode('{ "model": "m" }'));let attempts=0;const hashes:string[]=[];
  const upstream=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){hashes.push(hash(new Uint8Array(await req.arrayBuffer())));return new Response('ok',{status:++attempts===1?503:200});}});
  try{const res=await handleRequest(new Request('http://gateway/test',{method:'POST',body:payload,headers:{'content-type':'application/json','content-encoding':'zstd'}}),config(upstream.url.origin,{retry:{enabled:true,retry_on:[503],max_retries:1}}),{logging});expect(res.status).toBe(200);await res.text();expect(hashes).toEqual([hash(payload),hash(payload)]);}finally{await upstream.stop(true);}
});
test('Content-Length rejects before dispatch; raw chunked limit cancels source',async()=>{
  let calls=0;const upstream=Bun.serve({port:0,hostname:'127.0.0.1',fetch(){calls++;return new Response('ok');}});
  try{const cfg={...config(upstream.url.origin),body_parser_limit:'1kb'};const res=await handleRequest(new Request('http://gateway/test',{method:'POST',body:'x',headers:{'content-length':'2048'}}),cfg,{logging});expect(res.status).toBe(413);expect(calls).toBe(0);}finally{await upstream.stop(true);}
  let cancelled=false;const source=new BodySource(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;}}),1024);
  try{await expect(new Response(source.take()).arrayBuffer()).rejects.toMatchObject({status:413});expect(cancelled).toBe(true);}finally{source.dispose();}
});
test('two necessary async decoders reserve their slots and a third fails capacity',async()=>{
  const {decodeStream}=await import('../../packages/core/src/worker/request/body-source');
  const sources=[0,1].map(()=>decodeStream(new ReadableStream<Uint8Array>(),'gzip',1024).getReader());
  try{expect(()=>decodeStream(new ReadableStream<Uint8Array>(),'zstd',1024)).toThrow('body_decoder_capacity');}finally{await Promise.all(sources.map(reader=>reader.cancel()));}
});
test('generic raw completion records cancel and read failure without fabricating bytes',async()=>{
  const {completionStream}=await import('../../packages/core/src/worker/response/processor');
  let outcome:unknown;let cancelled=false;const state={interrupted:false,cancelled:false,complete(value:unknown){outcome=value;}};
  const stream=completionStream(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(encoder.encode('first'));},cancel(){cancelled=true;}}),state);
  const reader=stream.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');await reader.cancel();expect(cancelled).toBe(true);expect(outcome).toEqual({status:'cancelled'});
  const failed=completionStream(new ReadableStream<Uint8Array>({pull(controller){controller.error(new Error('upstream disconnected'));}}),state);
  await expect(new Response(failed).text()).rejects.toThrow('upstream disconnected');expect(outcome).toEqual({status:'failed',code:'stream_read_failed'});
});
test('shared body pool rejects concurrent retained payloads at 128MiB and releases capacity',async()=>{
  const bytes=new Uint8Array(40*1024*1024);const owners=[0,1,2].map(()=>new BodySource(new Response(bytes).body,50*1024*1024));
  try{await owners[0]!.buffer('replay');await owners[1]!.buffer('replay');await expect(owners[2]!.buffer('replay')).rejects.toMatchObject({status:503,code:'body_buffer_capacity'});}finally{for(const owner of owners)owner.dispose();}
  const after=new BodySource(new Response('{}').body,1024);try{expect(await after.json('after')).toEqual({});}finally{after.dispose();}
});
test('direct response rules ignore upstream body-demand configuration',async()=>{
  const cfg=config('http://127.0.0.1:1',{request:{body:{add:{x:1}}},response_rules:[{path:'/test',match_type:'exact',enabled:true,type:'response',status:201,body:'local'}]});
  const response=await handleRequest(new Request('http://gateway/test',{method:'POST',body:'{bad',headers:{'content-type':'application/json','content-encoding':'unknown'}}),cfg,{logging});expect(response.status).toBe(201);expect(await response.text()).toBe('local');
});
test('binary request body rules skip without decoding while static headers still apply',async()=>{
  const bytes=new Uint8Array([255,128,0,1]);
  const result=await run(bytes,'unknown',{request:{body:{add:{x:'{{body.x}}'}},headers:{add:{'x-static':'ok'}}}},{},'application/octet-stream');
  expect(result.headers.get('x-static')).toBe('ok');expect(hash(result.received)).toBe(hash(bytes));
});
test('typed SSE plugin N:M output and final flush retain explicit metadata',async()=>{
  const chain={async onStreamChunk(event:any,ctx:any){ctx.streamState.set('last',event);return [event,{...event,json:{...event.json,part:2}}];},
    async onFlushStream(_events:any[],ctx:any){return [{...ctx.streamState.get('last'),event:'explicit-final',json:{finished:true}}];}};
  const input='id: abc\nretry: 12\nevent: source\ndata: {"type":"do-not-infer","part":1}\n\n';
  const body=new Response(input).body!.pipeThrough(createSSEEnvelopeTransform(undefined,{} as any,1024,chain as any));
  const output=await new Response(body).text();
  expect(output.match(/data:/g)).toHaveLength(3);expect(output.match(/event: source/g)).toHaveLength(2);
  expect(output).toContain('event: explicit-final');expect(output).not.toContain('event: do-not-infer');
  expect(output.match(/id: abc/g)).toHaveLength(3);
});
test('registered SSE callback with an empty declared demand keeps opaque bytes',async()=>{
  const {createPluginHooks}=await import('../../packages/core/src/hooks');
  const {getScopedPluginRegistry,setScopedPluginRegistry}=await import('../../packages/core/src/scoped-plugin-registry');
  const previous=getScopedPluginRegistry();let invocations=0;const hooks=createPluginHooks();
  const handler={pluginName:'disabled-observer',config:{},bodyRequirements(){return {request:'none' as const};},register(){}};
  const phase={handlers:[handler],hooks,hasStreamCallbacks:true,hasResponseCallbacks:false,hasInterceptCallbacks:false,metadata:{createdAt:0,pluginCount:1,pluginNames:['disabled-observer'],scope:'route'}};
  const inbound={async onResponse(res:Response){return res;},async onStreamChunk(chunk:unknown){invocations++;return [chunk];},async onFlushStream(chunks:unknown[]){return chunks;},async onError(){}};
  const registry={getPrecompiledHooks(){return {routePhase:phase,upstreamPhase:{...phase,handlers:[]},servicePhase:null,globalPrecompiled:null,routePrecompiled:phase,inbound};},getGlobalAdmissionHandlers(){return [];},getAttemptObservationOwners(){return [];}};
  setScopedPluginRegistry(registry as any);
  try{const payload=new Uint8Array([255,128,0,13,10,13,10]);const result=await run(payload,'',{},{},'text/event-stream');expect(result.response.status).toBe(200);expect(hash(result.bytes)).toBe(hash(payload));expect(invocations).toBe(0);}finally{setScopedPluginRegistry(previous);}
});
