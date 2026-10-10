import { afterEach, describe, expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { createPluginHooks, SyncBailHook, type AttemptObservationEvent } from '../src/hooks';
import { createGatewayHooks, gatewayBuiltins } from '../src/gateway/runtime';
import { getScopedPluginRegistry, setScopedPluginRegistry, ScopedPluginRegistry } from '../src/scoped-plugin-registry';
import { handleRequest } from '../src/worker/request/handler';
import { bodyMetrics } from '../src/gateway/body-resources';
import { BodyServicePlugin } from '../src/gateway/body-plugin';
import { gzipSync } from 'node:zlib';
import { DataAdmissionError } from '../src/data-admission/errors';
import { runtimeState, getActiveRequestCount } from '../src/worker/state/runtime-state';
import type { RuntimeUpstream } from '../src/worker/types';

const previousRegistry = getScopedPluginRegistry();
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch=originalFetch;setScopedPluginRegistry(previousRegistry);});
const logging = {accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
function fixtures(responseJson = false, observers: Array<{name:string;scope?:string;callback:(event:AttemptObservationEvent)=>Promise<void>}> = []) {
  const hooks=createPluginHooks();
  const handler={pluginName:'test',config:{},bodyRequirements(){return {request:responseJson ? 'none' as const:'json-read' as const,response:responseJson ? ['json' as const]:[]};},register(){}};
  const phase={handlers:[handler],hooks,hasStreamCallbacks:false,hasRawResponseCallbacks:false,hasResponseCallbacks:responseJson,hasInterceptCallbacks:false,
    metadata:{createdAt:0,pluginCount:1,pluginNames:['test'],scope:'route'}};
  const providers=createGatewayHooks();
  const owners=observers.map(({name,scope,callback})=>{const isolated=createPluginHooks();isolated.onAttemptObservation.tapPromise(name,callback);
    return {pluginName:name,scopeKey:scope??'route:/gateway-test',hooks:isolated.onAttemptObservation,observe:{request:true,response:true,sse:true}};});
  const inbound={async onResponse(res:Response,ctx:any){return hooks.onResponse.promise(res,ctx);},async onRawResponse(result:any,ctx:any){return hooks.onRawResponse.promise(result,ctx);},async onError(){},async onStreamChunk(chunk:unknown){return [chunk];},async onFlushStream(chunks:unknown[]){return chunks;}};
  setScopedPluginRegistry({getGatewayHooks(){return providers;},getPrecompiledHooks(){return {routePhase:phase,upstreamPhase:{...phase,handlers:[]},servicePhase:null,globalPrecompiled:null,routePrecompiled:phase,inbound};},
    runWithRequestLeases(_leases:unknown,run:()=>unknown){return run();},
    async dispatchRequest(){return undefined;},
    getGlobalAdmissionHandlers(){return [];},getAttemptObservationOwners(){return owners;}} as any);
  const config={routes:[{path:'/gateway-test',endpoints:[{target:'http://pipeline.test'}]}]} as AppConfig;
  globalThis.fetch=Object.assign(async (_input:any,init?:RequestInit)=>{if(init?.body)await new Response(init.body).arrayBuffer();return Response.json({usage:{output_tokens:7},value:1});},{preconnect(){}}) as typeof fetch;
  return {providers,hooks,config,phase};
}
async function settled(events:AttemptObservationEvent[]) {
  const until=Date.now()+1000;
  while(!events.some(event=>event.phase==='request-end')&&Date.now()<until)await Bun.sleep(1);
  expect(events.some(event=>event.phase==='request-end')).toBe(true);
}
describe('registered gateway pipeline',()=>{
  test('an empty configuration still assembles required providers and serves the no-route response',async()=>{
    const registry=new ScopedPluginRegistry(import.meta.dir);
    await registry.initializeFromConfig({routes:[]});setScopedPluginRegistry(registry);
    try{
      expect(registry.getGatewayHooks().onGatewayBody.getStats().tapCount).toBe(1);
      expect((await handleRequest(new Request('http://local/health'),{routes:[]} as AppConfig,{logging})).status).toBe(404);
    }finally{await registry.destroy();}
  });
  test('a required SSE converter can suppress an early frame without stalling the client reader',async()=>{
    const path=new URL('./fixtures/response-view-plugin.ts',import.meta.url).pathname;
    const config={routes:[{path:'/filtered',plugins:[{name:'response-view-fixture',path,options:{key:'',mode:'filter'}}],endpoints:[{target:'http://views.test'}]}]} as AppConfig;
    const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
    globalThis.fetch=Object.assign(async()=>new Response('data: {"value":1}\n\ndata: {"value":2}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{preconnect(){}}) as typeof fetch;
    try{
      const response=await handleRequest(new Request('http://local/filtered'),config,{logging});
      const wire=await response.text();expect(wire).not.toContain('"value":1');expect(wire).toContain('"value":2');expect(wire).toContain('[DONE]');
    }finally{await registry.destroy();}
  });
  test.each([{raw:false,same:true},{raw:false,same:false},{raw:true,same:true},{raw:true,same:false}])('every response tap refreshes the representation: $raw raw, $same same scope',async({raw,same})=>{
    const key=`response-views-${crypto.randomUUID()}`;(globalThis as any)[key]=[];
    const path=new URL('./fixtures/response-view-plugin.ts',import.meta.url).pathname;
    const plugin=(mode:string)=>({name:'response-view-fixture',path,options:{key,mode,raw}});
    const config={plugins:same?[]:[plugin('read')],routes:[{path:'/views',plugins:same?[plugin('all')]:[plugin('second')],
      endpoints:[{id:'primary',target:'http://views.test',plugins:same?[]:[plugin('first')]}]}]} as AppConfig;
    const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
    globalThis.fetch=Object.assign(async()=>new Response(gzipSync('{"value":1}'),{headers:{'content-type':'application/json','content-encoding':'gzip'}}),{preconnect(){}}) as typeof fetch;
    try{
      const response=await handleRequest(new Request('http://local/views'),config,{logging});expect(await response.json()).toEqual({value:3});
      expect(response.headers.get('content-encoding')).toBeNull();
      expect((globalThis as any)[key]).toEqual([
        {value:1,version:0,type:'application/json',coding:'gzip',metadata:true},
        {value:2,version:1,type:'application/vendor+json',coding:'',metadata:true},
        {value:3,version:2,type:'application/json',coding:'',metadata:true},
      ]);
    }finally{await registry.destroy();delete (globalThis as any)[key];}
  });
  test('fails startup when a mandatory provider is absent or duplicated',()=>{
    expect(()=>createGatewayHooks(gatewayBuiltins().filter(plugin=>!(plugin instanceof BodyServicePlugin)))).toThrow('onGatewayBody');
    expect(()=>createGatewayHooks([...gatewayBuiltins(),new BodyServicePlugin()])).toThrow('onGatewayBody');
    expect(()=>createGatewayHooks([])).toThrow('requires exactly one provider');
    expect(()=>createGatewayHooks([...gatewayBuiltins(),...gatewayBuiltins()])).toThrow('received 2');
  });
  test('synchronous service providers share Hook ordering and statistics and reject async providers',()=>{
    const hook=new SyncBailHook<[number],number>('test-provider');
    hook.tap({name:'late',stage:2},()=>99);
    hook.tap({name:'provider',stage:1},value=>value+1);
    expect(hook.call(4)).toBe(5);expect(hook.getStats()).toMatchObject({tapCount:2,callCount:1});
    expect(()=>hook.tapPromise()).toThrow('synchronous provider requires tap');
    expect(()=>hook.tapAsync()).toThrow('synchronous provider requires tap');
    const invalid=new SyncBailHook('invalid');invalid.tap('async',async()=>1);
    expect(()=>invalid.call()).toThrow('synchronous provider returned a Promise');
  });
  test('HTTP decisions, forwarding, response rules and final logging execute registered providers',async()=>{
    const {providers,config}=fixtures();
    const response=await handleRequest(new Request('http://local/gateway-test',{method:'POST',body:'{"value":1}',headers:{'content-type':'application/json'}}),config,{logging});
    expect((await response.json() as any).value).toBe(1);
    for(const name of ['onGatewayBody','onGatewayRequest','onGatewayRoute','onGatewayAdmission','onGatewaySelect','onGatewayRetry','onGatewayForward','onGatewayResponseRules','onGatewayLog'] as const)
      expect(providers[name].getStats().callCount).toBeGreaterThan(0);
  });
  test.each([false,true])('bundled local rejection retains details and never trips upstream health (runtime tracking: %s)',async(tracked)=>{
    const {config,hooks}=fixtures();
    const stateKey=config.routes[0]!.path;
    const saved=runtimeState.get(stateKey);
    const upstream:RuntimeUpstream={target:'http://pipeline.test',upstream_id:'primary',status:'HEALTHY',consecutive_failures:0,consecutive_successes:0,recovery_attempt_count:0};
    config.routes[0]!.endpoints![0]!.id='primary';
    if(tracked)runtimeState.set(stateKey,{upstreams:[upstream]});else runtimeState.delete(stateKey);
    // Separate bundles have separate class identities, but share this public error contract.
    class BundledAdmissionError extends Error {
      readonly name='DataAdmissionError';readonly status=422;readonly code='llm_adapter_unsupported_reasoning';
      readonly details={message:'Selected reasoning effort cannot be honored by the actual target',param:'reasoning.effort'};
    }
    expect(new BundledAdmissionError()).not.toBeInstanceOf(DataAdmissionError);
    let reject=true,fetches=0;
    hooks.onValidateOutbound.tapPromise('bundled-rejection',async()=>{if(reject)throw new BundledAdmissionError();});
    globalThis.fetch=Object.assign(async()=>{fetches++;return Response.json({value:1});},{preconnect(){}}) as typeof fetch;
    try{
      for(let i=0;i<5;i++){
        const response=await handleRequest(new Request('http://local/gateway-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),config,{logging});
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({error:'llm_adapter_unsupported_reasoning',...new BundledAdmissionError().details});
        expect(fetches).toBe(0);
        expect(upstream).toMatchObject({status:'HEALTHY',consecutive_failures:0,recovery_attempt_count:0});
        expect(upstream.last_failure_time).toBeUndefined();
        expect(getActiveRequestCount(stateKey,'primary')).toBe(0);
      }
      reject=false;
      const response=await handleRequest(new Request('http://local/gateway-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),config,{logging});
      expect(response.status).toBe(200);expect(await response.json()).toEqual({value:1});expect(fetches).toBe(1);
      expect(upstream).toMatchObject({status:'HEALTHY',consecutive_failures:0});
    }finally{if(saved)runtimeState.set(stateKey,saved);else runtimeState.delete(stateKey);}
  });
  test('a request retains its provider assembly when the serving registry changes during fetch',async()=>{
    const {providers,config,hooks}=fixtures(true);
    const replacement=createGatewayHooks();
    hooks.onResponse.tapPromise('read',async(response,context)=>{expect(await context.bodyHandle!.json()).toEqual({value:1});return response;});
    globalThis.fetch=Object.assign(async()=>{
      setScopedPluginRegistry({getGatewayHooks(){return replacement;}} as any);
      return Response.json({value:1});
    },{preconnect(){}}) as typeof fetch;
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    expect(await response.json()).toEqual({value:1});
    expect(providers.onGatewayBody.getStats().callCount).toBeGreaterThan(1);
    expect(replacement.onGatewayBody.getStats().callCount).toBe(0);
    expect(replacement.onGatewayResponseRules.getStats().callCount).toBe(0);
  });
  test('request observer failure is local to its consumer and direction, retaining official response usage',async()=>{
    const healthy:AttemptObservationEvent[]=[];const broken:AttemptObservationEvent[]=[];
    const {config}=fixtures(false,[{name:'broken',async callback(event){broken.push(event);if(event.phase==='request')throw new Error('broken request observer');}},
      {name:'healthy',async callback(event){healthy.push(event);}}]);
    const response=await handleRequest(new Request('http://local/gateway-test',{method:'POST',body:'{"value":1}',headers:{'content-type':'application/json'}}),config,{logging});
    expect((await response.json() as any).usage.output_tokens).toBe(7);
    await settled(healthy);
    expect(healthy.filter(event=>event.phase==='incomplete')).toHaveLength(0);
    expect(broken.find(event=>event.phase==='incomplete')).toMatchObject({direction:'request',reason:'observer-error',consumerId:'broken\0route:/gateway-test'});
    expect(healthy.find(event=>event.phase==='response')).toMatchObject({body:{usage:{output_tokens:7}},direction:'response'});
    expect(broken.find(event=>event.phase==='response')).toMatchObject({body:{usage:{output_tokens:7}},direction:'response'});
  });
  test('JSON SDK response uses a single controlled immutable cache and preserves wire on read-only hooks',async()=>{
    const {config,hooks}=fixtures(true);
    let reads=0;
    hooks.onResponse.tapPromise('reader',async (response,context)=>{
      expect(response.body).toBeNull();expect(context.bodyHandle).toBeDefined();
      const first=await context.bodyHandle!.json({id:'first'});
      const second=await context.bodyHandle!.json({id:'second'});
      expect(first).toBe(second);expect(Object.isFrozen(first)).toBe(true);reads++;
      response.headers.set('x-reader','yes');return response;
    });
    const before=bodyMetrics.jsonParses;
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    expect((await response.json() as any).value).toBe(1);expect(response.headers.get('x-reader')).toBe('yes');expect(reads).toBe(1);
    // One request empty-body canonical parse and one response parse; repeated SDK reads add none.
    expect(bodyMetrics.jsonParses-before).toBeLessThanOrEqual(2);
  });
  test('a read-only SDK callback retains compressed wire entity headers',async()=>{
    const {config,hooks}=fixtures(true);
    const bytes=gzipSync('{"value":1}');
    globalThis.fetch=Object.assign(async()=>new Response(bytes,{headers:{'content-type':'application/json','content-encoding':'gzip','content-length':String(bytes.byteLength)}}),{preconnect(){}}) as typeof fetch;
    hooks.onResponse.tapPromise('reader',async(response,context)=>{
      expect(await context.bodyHandle!.json()).toEqual({value:1});
      response.headers.delete('content-encoding');response.headers.set('content-length','1');return response;
    });
    hooks.onResponse.tapPromise('next-reader',async(response,context)=>{
      expect(context.bodyHandle!.identity.contentEncoding).toBe('gzip');
      expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));return response;
    });
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    expect(response.headers.get('content-encoding')).toBe('gzip');expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });
  test('same plugin name in independent consumer scopes isolates response failures',async()=>{
    const healthy:AttemptObservationEvent[]=[];const broken:AttemptObservationEvent[]=[];
    const {config}=fixtures(false,[{name:'usage',scope:'route:/broken',async callback(event){broken.push(event);if(event.phase==='response')throw new Error('broken response observer');}},
      {name:'usage',scope:'global',async callback(event){healthy.push(event);}}]);
    const response=await handleRequest(new Request('http://local/gateway-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),config,{logging});
    expect((await response.json() as any).usage.output_tokens).toBe(7);await settled(healthy);
    expect(healthy.filter(event=>event.phase==='incomplete')).toHaveLength(0);
    expect(healthy.find(event=>event.phase==='response')).toMatchObject({consumerId:'usage\0global',body:{usage:{output_tokens:7}}});
    expect(broken.find(event=>event.phase==='incomplete')).toMatchObject({consumerId:'usage\0route:/broken',direction:'response'});
    expect(broken.some(event=>event.phase==='request-end')).toBe(true);
  });
  test('raw JSON SDK reads share observation cache and can return the unchanged wire',async()=>{
    const observations:AttemptObservationEvent[]=[];
    const {config,hooks,phase}=fixtures(true,[{name:'usage',async callback(event){observations.push(event);}}]);
    phase.hasRawResponseCallbacks=true;
    hooks.onRawResponse.tapPromise('raw-reader',async(result,context)=>{
      expect((await context.bodyHandle!.json({id:'raw-reader'})) as any).toMatchObject({value:1});return result;
    });
    const before=bodyMetrics.jsonParses;
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    expect((await response.json() as any).value).toBe(1);await settled(observations);
    expect(bodyMetrics.jsonParses-before).toBe(1);
    expect(observations.some(event=>event.phase==='response')).toBe(true);
  });
  test('raw SSE SDK event consumer drives the shared owner without native response reads',async()=>{
    const observations:AttemptObservationEvent[]=[];
    const {config,hooks,phase}=fixtures(true,[{name:'usage',async callback(event){observations.push(event);}}]);
    phase.hasRawResponseCallbacks=true;
    const wire='data: {"value":1,"usage":{"output_tokens":7}}\n\ndata: [DONE]\n\n';
    globalThis.fetch=Object.assign(async()=>new Response(gzipSync(wire),{headers:{'content-type':'text/event-stream','content-encoding':'gzip'}}),{preconnect(){}}) as typeof fetch;
    hooks.onRawResponse.tapPromise('raw-events',async(result,context)=>{
      const frames:string[]=[];for await(const event of context.bodyHandle!.events({id:'raw-events'}))frames.push(event.raw!);
      const headers=new Headers(result.response.headers);headers.delete('content-encoding');
      return {...result,response:new Response(frames.join(''),{status:result.response.status,headers})};
    });
    const before={...bodyMetrics};
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    expect(await response.text()).toBe(wire);await settled(observations);
    expect(bodyMetrics.decompressions-before.decompressions).toBe(1);
    expect(bodyMetrics.sseParses-before.sseParses).toBe(1);
  });
  test('required SSE rules share one decoder and framer with raw usage observation',async()=>{
    const observations:AttemptObservationEvent[]=[];
    const {config}=fixtures(true,[{name:'usage',async callback(event){observations.push(event);}}]);
    config.routes[0]!.response={body:{add:{value:2}},body_formats:['sse-json']};
    const control=': heartbeat\r\n\r\n';
    const wire=control+'id: abc\r\nretry: 007\r\ndata: {"value":1,"usage":{"output_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n';
    globalThis.fetch=Object.assign(async ()=>new Response(gzipSync(wire),{headers:{'content-type':'text/event-stream','content-encoding':'gzip'}}),{preconnect(){}}) as typeof fetch;
    const before={...bodyMetrics};
    const response=await handleRequest(new Request('http://local/gateway-test'),config,{logging});
    const result=await response.text();
    expect({status:response.status,body:result.startsWith(control)?control:result}).toEqual({status:200,body:control});
    expect(result).toContain('"value":2');expect(result).toContain('retry: 007');
    expect(result.endsWith('data: [DONE]\r\n\r\n')).toBe(true);
    expect(response.headers.get('content-encoding')).toBeNull();
    await settled(observations);
    expect(observations.find(event=>event.phase==='response')).toMatchObject({body:{value:1,usage:{output_tokens:7}},direction:'response',representation:'sse'});
    expect(bodyMetrics.decompressions-before.decompressions).toBe(1);
    expect(bodyMetrics.sseParses-before.sseParses).toBe(1);
  });
});
