import {afterAll,afterEach,describe,expect,test,spyOn} from 'bun:test';
import {createDataPlaneRuntime} from '../helpers/data-plane-runtime';
const runtime=await createDataPlaneRuntime();
const {ScopedPluginRegistry,getScopedPluginRegistry,setScopedPluginRegistry}=await import('../../src/scoped-plugin-registry');
const {handleRequest}=await import('../../src/worker/request/handler');
const {initializeRuntimeState,cleanupRuntimeState,runtimeState,getActiveRequestCount}=await import('../../src/worker/state/runtime-state');
const {setWorkerAdmissionSession}=await import('../../src/data-admission/worker');
const {DataAdmissionError}=await import('../../src/data-admission/errors');
const {generateWorkerTransportSecret,restoreWorkerTransportRequest}=await import('../../src/config-worker/private-transport');
const {privateRequestHeaders}=await import('../../src/public-listener/headers');
import type {AppConfig,Service,ServiceReference,Endpoint} from '@jeffusion/bungee-types';
const originalFetch=globalThis.fetch;
const originalRegistry=getScopedPluginRegistry();
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
const ref=(id:string,weight=100,priority=1):ServiceReference=>({id:`ref-${id}`,service_id:id,position:0,weight,priority,is_disabled:false});
const endpoint=(id:string,extra:Partial<Endpoint>={}):Endpoint=>({id,target:`http://${id}.test`,...extra});
const service=(id:string,endpoints:Endpoint[],extra:Partial<Service>={}):Service=>({id,name:id,endpoints,...extra});
const configFor=(services:Service[],references:ServiceReference[],failover=true):AppConfig=>({services,routes:[{id:'entry',path:'/entry',service_references:references,failover:{enabled:failover,retry_on:[503]},load_balancing:{policy:'round_robin'}}]});
const fetchMock=(callback:(url:URL,options:RequestInit)=>Response|Promise<Response>)=>{globalThis.fetch=Object.assign(async(input:any,options:any)=>callback(new URL(typeof input==='string'?input:input.url??input.href),options),{preconnect(){}}) as typeof fetch;};
const completions=new WeakMap<Response,Promise<unknown>>();
async function send(config:AppConfig,signal?:AbortSignal){let completion:Promise<unknown>|undefined;const response=await handleRequest(new Request('http://client/entry',{method:'POST',headers:{'content-type':'application/json'},body:'{"seed":true}',signal}),config,{logging,onCompletion:value=>{completion=value;}});if(completion)completions.set(response,completion);return response;}
async function consume(response:Response){const text=await response.text();await completions.get(response);return text;}
let registry:InstanceType<typeof ScopedPluginRegistry>|undefined;
const stateKeys:string[]=[];
async function install(config:AppConfig){registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);initializeRuntimeState(config);}
afterEach(async()=>{globalThis.fetch=originalFetch;setWorkerAdmissionSession(null);setScopedPluginRegistry(originalRegistry);cleanupRuntimeState();await registry?.destroy();registry=undefined;for(const key of stateKeys.splice(0))delete (globalThis as any)[key];});
afterAll(()=>runtime.close());
describe('layered Service execution',()=>{
  test('an existing Endpoint selector override still selects within a leaf Service',async()=>{
    const config=configFor([service('a',[endpoint('first'),endpoint('second')])],[ref('a')],false);
    await install(config);const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({ok:true});});
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(new Request('http://client/entry'),config,{logging,onCompletion:value=>{completion=value;}},upstreams=>upstreams.at(-1));
    expect(response.status).toBe(200);await response.text();await completion;
    expect(calls).toEqual(['second.test']);
  });
  test('a failed access log write preserves an Endpoint refusal and all request cleanup hooks',async()=>{
    const key=`log-failure-${crypto.randomUUID()}`;stateKeys.push(key);const trace:string[]=[];(globalThis as any)[key]=trace;
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;
    const plugin=(label:string,extra:Record<string,unknown>={})=>({name:'service-frame-fixture',path,options:{key,label,...extra}});
    const config=configFor([service('a',[endpoint('unused',{plugins:[plugin('E',{model:'forbidden'})]})],{plugins:[plugin('S')]})],[ref('a')]);
    config.plugins=[plugin('G')];config.routes[0].plugins=[plugin('R')];await install(config);
    let sends=0;fetchMock(()=>{sends++;return Response.json({unexpected:true});});
    setWorkerAdmissionSession({admission:async(operation,payload:any)=>{
      if(operation==='inspect')return {policyVersion:1,requirements:{}};
      if(operation==='authorize'){
        if(payload.target.model==='forbidden')throw new DataAdmissionError(403,'fixture.scope_denied');
        return {policyVersion:1};
      }
      if(operation==='preview')throw new DataAdmissionError(403,'fixture.scope_denied');
      throw Error(`unexpected admission operation ${operation}`);
    }});
    const secret=generateWorkerTransportSecret();
    const source=new Request('http://client/entry',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"allowed"}'});
    const transport=new Request(source.url,{method:'POST',headers:privateRequestHeaders(source,secret,'127.0.0.1',{requestId:crypto.randomUUID(),principal:{domain:'data',keyId:'fixture-key',credentialVersion:1}}),body:source.body});
    const restored=restoreWorkerTransportRequest(transport,secret);if(!restored.ok)throw Error('trusted fixture request rejected');
    let writes=0;
    const failingLogging={...logging,accessLogWriter:{...logging.accessLogWriter,write(){writes++;throw Error('controlled access log failure');}}};
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(restored.request,config,{logging:failingLogging,onCompletion:value=>{completion=value;}});
    expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'fixture.scope_denied'});
    await completion;
    expect(writes).toBeGreaterThan(0);expect(sends).toBe(0);
    expect(trace.filter(value=>value.endsWith(':finally'))).toEqual(['E:finally','S:finally','R:finally','G:finally']);
    expect(getActiveRequestCount('entry','ref-a')).toBe(0);
  });
  test.each(['allowed','forbidden'])('Service local responses authorize the current frame model %s and identity',async(model)=>{
    const key=`local-${crypto.randomUUID()}`;stateKeys.push(key);(globalThis as any)[key]=[];
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;
    const config=configFor([service('a',[endpoint('unused')],{plugins:[{name:'service-frame-fixture',path,options:{key,label:'A',model,respond:true}}]})],[ref('a')]);
    await install(config);let sends=0;fetchMock(()=>{sends++;return Response.json({unexpected:true});});
    const authorized:any[]=[];
    setWorkerAdmissionSession({admission:async(operation,payload:any)=>{
      if(operation==='inspect')return {policyVersion:1,requirements:{}};
      if(operation==='authorize'){
        authorized.push(payload.target);
        if(payload.target.model!=='allowed')throw new DataAdmissionError(403,'fixture.scope_denied');
        return {policyVersion:1};
      }
      throw Error(`unexpected admission operation ${operation}`);
    }});
    const secret=generateWorkerTransportSecret();
    const source=new Request('http://client/entry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'allowed'})});
    const transport=new Request(source.url,{method:'POST',headers:privateRequestHeaders(source,secret,'127.0.0.1',{requestId:crypto.randomUUID(),principal:{domain:'data',keyId:'fixture-key',credentialVersion:1}}),body:source.body});
    const restored=restoreWorkerTransportRequest(transport,secret);if(!restored.ok)throw Error('trusted fixture request rejected');
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(restored.request,config,{logging,onCompletion:value=>{completion=value;}});
    await response.text();await completion;
    expect(response.status).toBe(model==='allowed'?200:403);
    expect(authorized).toHaveLength(1);expect(authorized[0]).toMatchObject({model,serviceId:'a',url:'http://client/service-local'});
    expect(sends).toBe(0);
  });
  test.each(['admission','plugin'] as const)('WebSocket %s hook errors terminate without selecting a backup',async(handshakeError)=>{
    const key=`ws-denied-${crypto.randomUUID()}`;stateKeys.push(key);(globalThis as any)[key]=[];
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;
    const config=configFor([service('a',[endpoint('a1',{priority:1,plugins:[{name:'service-frame-fixture',path,options:{key,label:'E1',handshakeError}}]}),endpoint('a2',{priority:2})],{failover:{enabled:true,retry_on:[503]}}),service('b',[endpoint('b1')])],[ref('a'),ref('b')]);
    config.routes[0].websocket={enabled:true};await install(config);
    const request=new Request('http://client/entry',{headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}});
    const calls:string[]=[];let completion:Promise<void>|undefined;
    const bridge={limits:{handshakeTimeoutMs:1000},async upgrade(_request:Request,_server:unknown,options:any){calls.push(options.url.hostname);return undefined;}};
    const result=await registry!.getGatewayHooks().onGatewayWebSocket.promise({request,nativeRequest:request,config,bridge:bridge as any,server:{} as any,servingRevision:1,retain:value=>{completion=value;}});
    expect(result?.response?.status).toBe(handshakeError==='admission'?403:502);
    expect(await result!.response!.json()).toEqual({error:handshakeError==='admission'?'fixture.scope_denied':'websocket_handshake_failed'});
    await completion;expect(calls).toEqual([]);expect(getActiveRequestCount('entry','ref-a')).toBe(0);
  });
  test('a mixed pool at 60/40 and its child at 25/75 select 60/10/30 independently',async()=>{
    const config=configFor([service('a',[endpoint('e1',{weight:60,position:0})],{service_references:[{...ref('b',40),position:1}]}),
      service('b',[endpoint('b1',{weight:25}),endpoint('b2',{weight:75})])],[ref('a')]);
    const calls:Record<string,number>={};fetchMock(url=>{calls[url.hostname]=(calls[url.hostname]??0)+1;return Response.json({ok:true});});
    await install(config);
    const random=spyOn(Math,'random');
    try{for(let i=0;i<100;i++){let step=0;random.mockImplementation(()=>step++===0?(i<60?.1:.9):((i%20)+.5)/20);const response=await send(config);expect(response.status).toBe(200);await consume(response);}}
    finally{random.mockRestore();}
    expect(calls).toEqual({'e1.test':60,'b1.test':10,'b2.test':30});
  });
  test.each([[false,false],[false,true],[true,false],[true,true]])('parent %p and child %p control only their own layer',async(parent,child)=>{
    const config=configFor([service('a',[endpoint('a1'),endpoint('a2')],{load_balancing:{policy:'round_robin'},failover:{enabled:child,retry_on:[503]}}),service('b',[endpoint('b1')])],[ref('a'),ref('b')],parent);
    const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({ok:url.hostname==='b1.test'},{status:url.hostname==='b1.test'?200:503});});
    await install(config);const response=await send(config);await consume(response);
    expect(calls).toEqual(['a1.test',...(child?['a2.test']:[]),...(parent?['b1.test']:[])]);expect(response.status).toBe(parent?200:503);
    expect(runtimeState.get('a')!.upstreams.map(endpoint=>endpoint.consecutive_failures)).toEqual(child?[1,1]:[0,0]);
  });
  test('initial selection skips unavailable priorities even with failover disabled; unknown and restored children are available',async()=>{
    const config=configFor([service('a',[endpoint('a1')]),service('b',[endpoint('b1')])],[ref('a',100,1),ref('b',100,2)],false);
    await install(config);const a=runtimeState.get('a')!.upstreams[0];a.status='UNHEALTHY';a.last_failure_time=Date.now();
    const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({ok:true});});
    const first=await send(config);await consume(first);expect(calls).toEqual(['b1.test']);
    a.status='HEALTHY';const second=await send(config);await consume(second);expect(calls).toEqual(['b1.test','a1.test']);
  });
  test('Service frames enter once, failed branches close before DAG reentry, and their edits stay isolated',async()=>{
    const key=`frame-${crypto.randomUUID()}`;stateKeys.push(key);const trace:string[]=[];(globalThis as any)[key]=trace;
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;
    const plugin=(label:string)=>({name:'service-frame-fixture',path,options:{key,label,write:true}});
    const config=configFor([service('a',[],{plugins:[plugin('A')],service_references:[ref('shared')],failover:{enabled:false}}),service('b',[],{plugins:[plugin('B')],service_references:[ref('shared')]}),service('shared',[endpoint('e',{plugins:[plugin('E')]})],{plugins:[plugin('S')]})],[ref('a'),ref('b')]);
    config.plugins=[plugin('G')];config.routes[0].plugins=[plugin('R')];
    const bodies:any[]=[];fetchMock((_url,options)=>{bodies.push(JSON.parse(options.body as string));return Response.json({ok:true},{status:bodies.length===1?503:200});});
    await install(config);const registrations=trace.filter(value=>value.endsWith(':register')).length;const response=await send(config);await consume(response);
    expect(trace.filter(value=>value.endsWith(':register'))).toHaveLength(registrations);
    expect(response.status).toBe(200);expect(bodies).toEqual([{seed:true,R:true,A:true,S:true,E:true},{seed:true,R:true,B:true,S:true,E:true}]);
    expect(trace.filter(item=>item.endsWith(':request'))).toEqual(['R:request','A:request','S:request','E:request','B:request','S:request','E:request']);
    expect(trace.indexOf('S:finally')).toBeLessThan(trace.indexOf('B:request'));expect(trace.indexOf('A:finally')).toBeLessThan(trace.indexOf('B:request'));
    expect(trace.filter(item=>item.endsWith(':response')).slice(-5)).toEqual(['E:response','S:response','B:response','R:response','G:response']);
    expect(getActiveRequestCount('entry','ref-a')).toBe(0);expect(getActiveRequestCount('entry','ref-b')).toBe(0);
  });
  test('cancellation stops all layers without opening another upstream',async()=>{
    const config=configFor([service('a',[endpoint('a1'),endpoint('a2')],{failover:{enabled:true,retry_on:[503]}}),service('b',[endpoint('b1')])],[ref('a'),ref('b')]);
    const controller=new AbortController();let sends=0;fetchMock(()=>{sends++;controller.abort();throw new DOMException('cancelled','AbortError');});
    await install(config);try{await send(config,controller.signal);}catch{}expect(sends).toBe(1);
    expect(getActiveRequestCount('entry','ref-a')).toBe(0);
  });
  test('physical retry budget deduplicates a shared Endpoint across repeated DAG paths',async()=>{
    const config=configFor([service('a',[],{service_references:[ref('shared')]}),service('b',[],{service_references:[ref('shared')]}),service('c',[],{service_references:[ref('shared')]}),
      service('shared',[endpoint('e')])],[ref('a'),ref('b'),ref('c')]);
    config.routes[0].retry={enabled:true,max_retries:1,retry_on:[503]};
    await install(config);let sends=0;fetchMock(()=>{sends++;return Response.json({ok:false},{status:503});});
    const response=await send(config);await consume(response);
    expect(response.status).toBe(503);expect(sends).toBe(3);
    expect(getActiveRequestCount('entry','ref-c')).toBe(0);
  });
  test('SSE uses the winning Service stack and a committed stream never switches upstream',async()=>{
    const key=`sse-${crypto.randomUUID()}`;stateKeys.push(key);const trace:string[]=[];(globalThis as any)[key]=trace;
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;const plugin=(label:string)=>({name:'service-frame-fixture',path,options:{key,label}});
    const config=configFor([service('a',[endpoint('e',{plugins:[plugin('E')]})],{plugins:[plugin('A')]}),service('b',[endpoint('backup')])],[ref('a'),ref('b')]);
    config.routes[0].plugins=[plugin('R')];await install(config);let sends=0;
    fetchMock(()=>{sends++;return new Response('data: {"value":1}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});});
    const response=await send(config);expect(await consume(response)).toContain('data: {"value":1}');
    expect(trace.filter(value=>value.endsWith(':chunk')).slice(0,3)).toEqual(['E:chunk','A:chunk','R:chunk']);expect(sends).toBe(1);
    expect(getActiveRequestCount('entry','ref-a')).toBe(0);
  });
  test('WebSocket handshake fails over inside a Service before its parent and retains only the connected branch',async()=>{
    const key=`ws-${crypto.randomUUID()}`;stateKeys.push(key);const trace:string[]=[];(globalThis as any)[key]=trace;
    const path=new URL('../fixtures/service-frame-plugin.ts',import.meta.url).pathname;const plugin=(label:string)=>({name:'service-frame-fixture',path,options:{key,label}});
    const config=configFor([service('a',[endpoint('a1',{plugins:[plugin('E1')],priority:1}),endpoint('a2',{plugins:[plugin('E2')],priority:2})],{plugins:[plugin('A')],failover:{enabled:true,retry_on:[503]}}),
      service('b',[endpoint('b1',{plugins:[plugin('E3')]})],{plugins:[plugin('B')]})],[ref('a'),ref('b')]);
    config.routes[0].websocket={enabled:true};config.routes[0].plugins=[plugin('R')];await install(config);
    const request=new Request('http://client/entry',{headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}});
    const calls:string[]=[];let connected:any;let completion:Promise<void>|undefined;
    const bridge={limits:{handshakeTimeoutMs:1000},async upgrade(_request:Request,_server:unknown,options:any){calls.push(options.url.hostname);if(options.url.hostname!=='b1.test')return new Response('retry',{status:503});connected=options;await options.onOpen();return undefined;}};
    const result=await registry!.getGatewayHooks().onGatewayWebSocket.promise({request,nativeRequest:request,config,bridge:bridge as any,server:{} as any,servingRevision:1,retain:value=>{completion=value;}});
    expect(result?.response).toBeUndefined();expect(calls).toEqual(['a1.test','a2.test','b1.test']);
    expect(trace.filter(value=>value.endsWith(':handshake'))).toEqual(['R:handshake','A:handshake','E1:handshake','E2:handshake','B:handshake','E3:handshake']);
    expect(trace.indexOf('A:finally')).toBeLessThan(trace.indexOf('B:handshake'));expect(getActiveRequestCount('entry','ref-b')).toBe(1);
    await connected.onClose(1000,'closed',{durationMs:1,clientMessages:0,upstreamMessages:0,clientBytes:0,upstreamBytes:0});await completion;
    expect(getActiveRequestCount('entry','ref-b')).toBe(0);expect(calls).toHaveLength(3);
  });

  test('unselected Service conditions do not force JSON decoding of an opaque request',async()=>{
    const config=configFor([service('opaque',[endpoint('plain')]),service('json',[endpoint('conditional',{condition:'{{body.allowed}}'})])],[ref('opaque'),ref('json')],false);
    await install(config);const wire=Uint8Array.from([255,0,3]);let sent:Uint8Array|undefined;
    fetchMock(async(_url,options)=>{sent=new Uint8Array(await new Response(options.body as BodyInit).arrayBuffer());return new Response('ok');});
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(new Request('http://client/entry',{method:'POST',headers:{'content-type':'application/octet-stream'},body:wire}),config,{logging,onCompletion:value=>{completion=value;}});
    expect(await response.text()).toBe('ok');await completion;expect(sent).toEqual(wire);
  });

  test('OAuth Service conversion state survives child failover without rerunning its request hook',async()=>{
    const path=new URL('../../../../plugins/chatgpt-oauth/server/index.ts',import.meta.url).pathname;
    const config:AppConfig={services:[service('chatgpt',[{id:'first',target:'https://chatgpt.com',priority:1},{id:'second',target:'https://chatgpt.com',priority:2}],
      {plugins:[{name:'chatgpt-oauth',path}],failover:{enabled:true,retry_on:[503]}})],routes:[{path:'/v1/chat/completions',service_references:[ref('chatgpt')]}]};
    await install(config);let sends=0;
    fetchMock(()=>{sends++;if(sends===1)return Response.json({error:{message:'temporarily unavailable'}},{status:503});
      return new Response('data: {"type":"response.created","response":{"id":"r1","created_at":1,"model":"codex"}}\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});});
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(new Request('http://client/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:'codex',messages:[{role:'user',content:'hello'}],stream:false})}),config,{logging,onCompletion:value=>{completion=value;}});
    const body=await response.json();await completion;expect(response.status).toBe(200);expect(body.choices[0].message.content).toBe('ok');expect(sends).toBe(2);
  });

  test('a Route owning upstreams and Service references fails over across both in priority order',async()=>{
    const config=configFor([service('a',[endpoint('a1')]),service('b',[endpoint('b1')])],[ref('a',100,2),ref('b',100,3)]);
    config.routes[0].endpoints=[endpoint('direct',{priority:1})];
    await install(config);const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({ok:url.hostname==='b1.test'},{status:url.hostname==='b1.test'?200:503});});
    const response=await send(config);await consume(response);
    expect(response.status).toBe(200);expect(calls).toEqual(['direct.test','a1.test','b1.test']);
  });
  test('mixed Service references B1 then B2 fail over before owned Endpoints E1 then E2',async()=>{
    const config=configFor([service('a',[endpoint('e1',{position:2,priority:3}),endpoint('e2',{position:3,priority:4})],
      {service_references:[{...ref('b1',100,1),position:0},{...ref('b2',100,2),position:1}],failover:{enabled:true,retry_on:[503]}}),
      service('b1',[endpoint('b1-up')]),service('b2',[endpoint('b2-up')])],[ref('a')],false);
    await install(config);const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({ok:true},{status:url.hostname==='e2.test'?200:503});});
    const response=await send(config);await consume(response);expect(response.status).toBe(200);expect(calls).toEqual(['b1-up.test','b2-up.test','e1.test','e2.test']);
  });
  test('least requests counts a selected reference until that branch stream has ended',async()=>{
    const config=configFor([service('a',[endpoint('e1',{position:1})],{load_balancing:{policy:'least_requests'},service_references:[{...ref('b'),position:0}]}),service('b',[endpoint('b1')])],[ref('a')],false);
    await install(config);const calls:string[]=[];fetchMock(url=>{calls.push(url.hostname);return Response.json({host:url.hostname});});
    const first=await send(config);let second:Response|undefined;
    try{expect(getActiveRequestCount('a','ref-b')).toBe(1);second=await send(config);expect(calls).toEqual(['b1.test','e1.test']);}
    finally{await consume(first);if(second)await consume(second);}
    expect(getActiveRequestCount('a','ref-b')).toBe(0);
  });

});
