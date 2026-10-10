import { test, expect } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handleRequest } from '../../packages/core/src/worker/request/handler';
import { createPluginHooks } from '../../packages/core/src/hooks';
import { getScopedPluginRegistry, setScopedPluginRegistry } from '../../packages/core/src/scoped-plugin-registry';

async function withResponsePlugin(rewrite: boolean) {
  const wire = gzipSync(Buffer.from('{ "x": 1 }'));
  const previous = getScopedPluginRegistry();
  const hooks = createPluginHooks();
  const handler = {pluginName:'response-plugin', config:{}, bodyRequirements(){return {request:'none',response:['json']};},register(){}};
  const phase = {handlers:[handler],hooks,hasStreamCallbacks:false,hasRawResponseCallbacks:false,hasResponseCallbacks:true,hasInterceptCallbacks:false,
    metadata:{createdAt:0,pluginCount:1,pluginNames:['response-plugin'],scope:'route'}};
  const inbound = {
    async onResponse(res:Response) {
      res.headers.set('x-plugin', 'kept');
      return rewrite ? new Response('{"text":"a much longer payload"}', {headers:res.headers}) : res;
    }, async onError(){}, async onStreamChunk(chunk:unknown){return [chunk];}, async onFlushStream(chunks:unknown[]){return chunks;},
  };
  setScopedPluginRegistry({getPrecompiledHooks(){return {routePhase:phase,upstreamPhase:{...phase,handlers:[]},servicePhase:null,globalPrecompiled:null,routePrecompiled:phase,inbound};},
    runWithRequestLeases(_leases:unknown,run:()=>unknown){return run();},async dispatchRequest(){return undefined;},
    getGlobalAdmissionHandlers(){return [];},getAttemptObservationOwners(){return [];}} as any);
  const upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response(wire,{headers:{'content-type':'application/json','content-encoding':'gzip','content-length':String(wire.byteLength)}});}});
  const gateway = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return handleRequest(req,{routes:[{path:'/test',endpoints:[{target:upstream.url.origin}]}]},
    {logging:{accessLogWriter:{write(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{write(){}}}});}});
  try {
    const response = await fetch(new URL('/test',gateway.url),{decompress:false} as any);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {headers:response.headers,bytes,wire};
  } finally {await gateway.stop(true);await upstream.stop(true);setScopedPluginRegistry(previous);}
}
test('JSON response plugin replacement fixes entity headers over real HTTP',async()=>{
  const result = await withResponsePlugin(true);
  expect(new TextDecoder().decode(result.bytes)).toBe('{"text":"a much longer payload"}');
  expect(result.headers.get('content-encoding')).toBeNull();
  const length = result.headers.get('content-length');
  if (length !== null) expect(Number(length)).toBe(result.bytes.byteLength);
  expect(result.headers.get('x-plugin')).toBe('kept');
});
test('readonly JSON response plugin preserves wire and its business header edits',async()=>{
  const result = await withResponsePlugin(false);
  const digest = (bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  expect(digest(result.bytes)).toBe(digest(result.wire));
  expect(result.headers.get('content-encoding')).toBe('gzip');
  expect(result.headers.get('content-length')).toBe(String(result.wire.byteLength));
  expect(result.headers.get('x-plugin')).toBe('kept');
});
