import {afterEach,expect,test} from 'bun:test';
import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../src/scoped-plugin-registry';
import {handleRequest} from '../src/worker/request/handler';
import {emptyCatalogServiceHost} from './support/empty-catalog-service-host';
import capturedBase from '../../../plugins/codex-router/tests/fixtures/captured-app-base.json';
import capturedPreferences from '../../../plugins/codex-router/tests/fixtures/captured-app-preferences.json';
const originalFetch=globalThis.fetch,previous=getScopedPluginRegistry();afterEach(()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);});
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
const path=new URL('./fixtures/codex-dispatch-plugin.ts',import.meta.url).pathname;
for(const unavailable of ['missing','context','text'])test(`explicit source with ${unavailable} capability data refuses upstream dispatch`,async()=>{
  const config:any={routes:[{id:'e',path:'/codex',plugins:[{name:'codex-router',path,options:{unavailable,models:[{source:'original',provider:'p',model:'destination',target:{type:'route',id:'t',protocol:'responses'}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'t',path:'/target',endpoints:[{target:'http://upstream.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  let calls=0;globalThis.fetch=Object.assign(async()=>{calls++;return Response.json({});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'original',input:'hello'})}),config,{logging});
    expect(response.status).toBe(503);expect((await response.json() as any).error).toBe('codex_router_model_unavailable');expect(calls).toBe(0);
  }finally{await registry.destroy();}
});
for(const type of ['route','service'] as const)test(`explicit source forwards the destination model through a native Responses ${type}`,async()=>{
  const config:any={routes:[{id:'entry',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{source:'original',sourceProtocol:'responses',provider:'p',model:'destination',target:{type,id:'target',protocol:'responses'}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'target',path:'/target',endpoints:[{target:'http://route.test'}]}],
    services:[{id:'target',name:'target',endpoints:[{target:'http://service.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const calls:any[]=[];globalThis.fetch=Object.assign(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(await new Response(init.body).text())});return Response.json({id:'r',object:'response',status:'completed',model:'destination',output:[]});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'original',input:'hello'})}),config,{logging});
    expect(response.status).toBe(200);expect((await response.json() as any).model).toBe('original');expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(type==='route'?'route.test':'service.test');expect(calls[0].body.model).toBe('destination');
  }finally{await registry.destroy();}
});
test('empty Codex bindings retain a formal dispatch lease and preserve native catalog and generation',async()=>{
  const config:any={routes:[{id:'entry',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[]}}],endpoints:[{id:'native',target:'http://native.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir,emptyCatalogServiceHost());
  expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const calls:string[]=[];
  globalThis.fetch=Object.assign(async(url:any)=>{calls.push(String(url));return Response.json(String(url).endsWith('/models')?{models:[{slug:'native-only',extra:'kept'}]}:{id:'native-response',object:'response',status:'completed',output:[]});},{preconnect(){}}) as any;
  try{
    expect(registry.getDeclaredDispatchTargets('/codex')).toEqual([]);
    expect(registry.getRoutePluginOwners('/codex',true)).toHaveLength(1);
    const catalog=await handleRequest(new Request('http://local/codex/models'),config,{logging});
    expect(catalog.status).toBe(200);expect(await catalog.json()).toEqual({models:[{slug:'native-only',extra:'kept'}]});
    const generation=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'native-only',input:'hello'})}),config,{logging});
    expect(generation.status).toBe(200);expect(await generation.json()).toMatchObject({id:'native-response',status:'completed'});
    expect(calls).toHaveLength(2);
  }finally{await registry.destroy();}
});
for(const protocol of ['chat_completions','anthropic_messages'] as const)for(const streaming of [false,true])test(`actual pipeline binding ${protocol} ${streaming?'SSE':'JSON'}`,async()=>{
  const config:any={routes:[{id:'e',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{source:'client-model',provider:'p',model:'m',target:{type:'route',id:'t',protocol}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'t',path:'/target',path_rewrite:{'^/target':''},endpoints:[{id:'u',target:'http://upstream.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);const calls:any[]=[];
  globalThis.fetch=Object.assign(async(url:any,init:any)=>{
    calls.push({url:String(url),body:JSON.parse(await new Response(init.body).text())});
    if(!streaming)return Response.json(protocol==='chat_completions'?{choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}:{content:[{type:'text',text:'answer'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:1}});
    const events=protocol==='chat_completions'?[{choices:[{index:0,delta:{content:'answer'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:1}}]:[{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
    return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+(protocol==='chat_completions'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
  },{preconnect(){}}) as any;
  try{const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'client-model',input:'hello',stream:streaming})}),config,{logging});expect(response.status).toBe(200);const text=await response.text();expect(text).toContain(streaming?'response.completed':'"object":"response"');expect(text).toContain('answer');expect(calls).toHaveLength(1);expect(calls[0].url).toEndWith(protocol==='chat_completions'?'/chat/completions':'/messages');expect(calls[0].body.messages[0].role).toBe('user');expect(calls[0].body.model).toBe('m');expect(text).toContain('client-model');const rejected=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'client-model',previous_response_id:'missing',input:'next'})}),config,{logging});expect(rejected.status).toBe(422);expect((await rejected.json() as any).error).toBe('codex_router_history_identity_required');expect(calls).toHaveLength(1);}finally{await registry.destroy();}
});

test('registry refuses a Codex binding without target protocol',async()=>{
  const registry=new ScopedPluginRegistry(import.meta.dir);
  try {
    const result=await registry.initializeFromConfig({routes:[{id:'entry',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{provider:'p',model:'m',target:{type:'route',id:'target'}}]}}],endpoints:[{target:'http://unused'}]}]});
    expect(result.failed).toBe(1);expect(registry.getRoutePluginOwners('/codex',true)).toHaveLength(0);
  } finally {await registry.destroy();}
});

for(const [name,captured,count] of [['base',capturedBase,11],['preferences',capturedPreferences,13]] as const)test(`captured ${name} public HTTP pipeline preserves every tool and model routing`,async()=>{
  const config:any={routes:[{id:'e',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{source:'captured-model',provider:'p',model:'destination',target:{type:'route',id:'t',protocol:'chat_completions'}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'t',path:'/target',path_rewrite:{'^/target':''},endpoints:[{target:'http://upstream.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const calls:any[]=[];globalThis.fetch=Object.assign(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(await new Response(init.body).text())});return Response.json({choices:[{message:{role:'assistant',content:'{"title":"fixture","description":"fixture"}'},finish_reason:'stop'}]});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(captured)}),config,{logging});
    expect(response.status).toBe(200);expect((await response.json() as any).model).toBe('captured-model');
    expect(calls).toHaveLength(1);expect(calls[0].body.tools).toHaveLength(count);expect(calls[0].body.model).toBe('destination');
    expect(calls[0].url).toEndWith('/chat/completions');
    expect(calls[0].body.messages.map((m:any)=>m.role)).toEqual(captured.input.filter(i=>i.type!=='additional_tools').map(i=>i.role));
    expect(calls[0].body).not.toHaveProperty('access_programs');
  }finally{await registry.destroy();}
});

test('codec rejection details survive a separately bundled plugin and reach HTTP without upstream calls',async()=>{
  const config:any={routes:[{id:'e',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{source:'m',provider:'p',model:'destination',target:{type:'route',id:'t',protocol:'chat_completions'}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'t',path:'/target',endpoints:[{target:'http://upstream.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  let calls=0;globalThis.fetch=Object.assign(async()=>{calls++;return Response.json({});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',input:'x',access_programs:{cyber:'daybreak_blue'}})}),config,{logging});
    expect(response.status).toBe(422);expect(await response.json()).toEqual({error:'codex_router_unsupported_access_program',message:'Selected access program cannot be represented by the target protocol',param:'access_programs.cyber'});expect(calls).toBe(0);
  }finally{await registry.destroy();}
});
