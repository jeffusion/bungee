import {afterEach,expect,test} from 'bun:test';
import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../src/scoped-plugin-registry';
import {runGatewayWebSocket} from '../src/gateway/runtime';
import {createWebSocketBridge,isWebSocketUpgradeRequest} from '../src/websocket';
const path=new URL('./fixtures/codex-dispatch-plugin.ts',import.meta.url).pathname;
const previous=getScopedPluginRegistry();afterEach(()=>setScopedPluginRegistry(previous));
async function waitUntil(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await Bun.sleep(10);}throw new Error('Timeout');}
async function setup(endpoints:any[], bindModels=true){
  const config:any={logging:{enabled:false},routes:[{id:'e',path:'/codex',websocket:{enabled:true},path_rewrite:{'^/codex':''},plugins:[{name:'codex-router',path,options:{models:!bindModels?[]:endpoints.map((endpoint,index)=>({source:`m${index}`,provider:'p',model:endpoint.model ?? `m${index}`,target:{type:'route',id:`t${index}`,protocol:endpoint.protocol}}))}}],endpoints:[{target:endpoints[0].target}]},...endpoints.map((endpoint,index)=>({id:`t${index}`,path:`/target${index}`,path_rewrite:{[`^/target${index}`]:''},websocket:{enabled:endpoint.ws===true},endpoints:[{id:`u${index}`,target:endpoint.target}]}))]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const bridge=createWebSocketBridge({closeTimeoutMs:200});const completions=new Set<Promise<void>>();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:bridge.websocket,async fetch(request,server){if(!isWebSocketUpgradeRequest(request))return new Response('no');const result=await runGatewayWebSocket({request,nativeRequest:request,server,config,bridge,servingRevision:1,retain(promise){completions.add(promise);void promise.finally(()=>completions.delete(promise));}});return result.response;}});
  const client=new WebSocket(`ws://127.0.0.1:${server.port}/codex/responses`);const events:any[]=[];
  client.onmessage=event=>events.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve,reject)=>{client.onopen=()=>resolve();client.onerror=()=>reject(new Error('client connect'));});
  return {client,events,bridge,async terminal(start=0){await waitUntil(()=>events.slice(start).some(e=>['response.completed','response.failed','response.incomplete','error'].includes(e.type)));return events.slice(start);},async close(){client.close();await waitUntil(()=>bridge.stats.connections===0 && completions.size===0);await bridge.stop();server.stop(true);await registry.destroy();}};
}
const chat=(text:string)=>[{choices:[{index:0,delta:{content:text},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:1}}];
const anthropic=(text:string)=>[{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
function sse(events:any[]){return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}
test('real WS binding protocol selects HTTP conversion on WS-enabled targets; prewarm and history switch',async()=>{
  const calls:any[]=[]; let upgradeAttempts = 0;
  const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){if (request.headers.get('upgrade') === 'websocket') upgradeAttempts++; const body=await request.json();calls.push({url:request.url,body});return sse(request.url.endsWith('/messages')?anthropic('second'):chat('first'));}});
  const base=`http://127.0.0.1:${upstream.port}`;const env=await setup([{protocol:'chat_completions',target:base,ws:true},{protocol:'anthropic_messages',target:base,ws:true}]);
  try{
    env.client.send(JSON.stringify({type:'response.create',generate:false,model:'m0',input:[{role:'developer',content:'rules'}]}));const warm=await env.terminal();expect(calls).toHaveLength(0);const warmId=warm.at(-1).response.id;
    let start=env.events.length;env.client.send(JSON.stringify({type:'response.create',model:'m0',previous_response_id:warmId,input:'hello'}));const first=await env.terminal(start);expect(first.at(-1).type).toBe('response.completed');expect(calls).toHaveLength(1);expect(calls[0].body.messages).toHaveLength(2);
    start=env.events.length;env.client.send(JSON.stringify({type:'response.create',model:'m1',previous_response_id:first.at(-1).response.id,input:'next'}));const second=await env.terminal(start);expect(second.at(-1).type).toBe('response.completed');expect(calls).toHaveLength(2);expect(calls[1].url).toEndWith('/messages');expect(calls[1].body.messages.map((m:any)=>m.role)).toEqual(['user','assistant','user']);expect(calls[1].body.system).toContain('rules'); expect(upgradeAttempts).toBe(0);
    start=env.events.length;env.client.send(JSON.stringify({type:'response.create',model:'m0',previous_response_id:'missing',input:'next'}));expect((await env.terminal(start)).at(-1).error.code).toContain('history_missing');expect(calls).toHaveLength(2);
  }finally{await env.close();upstream.stop(true);}
});
test('real WS native Responses target uses WS transport once per generation',async()=>{
  const calls:any[]=[];const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,server){if(server.upgrade(request))return;return new Response('HTTP not supported',{status:400});},websocket:{message(socket,message){const body=JSON.parse(String(message));calls.push(body);const response={id:`resp_${calls.length}`,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'native'}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};socket.send(JSON.stringify({type:'response.created',response:{...response,status:'in_progress',output:[]}}));socket.send(JSON.stringify({type:'response.completed',response}));}}});
  const env=await setup([{protocol:'responses',target:`http://127.0.0.1:${upstream.port}`,ws:true,model:'destination'}]);
  try{for(let i=0;i<2;i++){const start=env.events.length;env.client.send(JSON.stringify({type:'response.create',model:'m0',input:'hello'}));const terminal=(await env.terminal(start)).at(-1);expect(terminal.type).toBe('response.completed');expect(terminal.response.model).toBe('m0');}expect(calls).toHaveLength(2);expect(calls.every(call=>call.type==='response.create' && call.model==='destination')).toBe(true);}finally{await env.close();upstream.stop(true);}
});
test('busy generation refuses overlap and cancel aborts actual pipeline',async()=>{
  const original=globalThis.fetch;let calls=0,aborted=0;
  globalThis.fetch=Object.assign((_url:any,options:any)=>{calls++;return new Promise<Response>((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'));},{once:true}));},{preconnect(){}}) as any;
  const env=await setup([{protocol:'chat_completions',target:'http://unused.test'}]);
  try{env.client.send(JSON.stringify({type:'response.create',model:'m0',input:'hello'}));await waitUntil(()=>calls===1);env.client.send(JSON.stringify({type:'response.create',model:'m0',input:'overlap'}));await waitUntil(()=>env.events.some(e=>e.error?.code==='codex_router_response_busy'));expect(calls).toBe(1);env.client.send(JSON.stringify({type:'response.cancel'}));await waitUntil(()=>aborted===1 && env.events.some(e=>e.error?.code==='codex_router_generation_cancelled'));expect(env.events.some(e=>e.type==='response.completed')).toBe(false);}finally{await env.close();globalThis.fetch=original;}
});
test('disconnect aborts active generation and drains retained connection resources',async()=>{
  const original=globalThis.fetch;let calls=0,aborted=0;
  globalThis.fetch=Object.assign((_url:any,options:any)=>{calls++;return new Promise<Response>((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'));},{once:true}));},{preconnect(){}}) as any;
  const env=await setup([{protocol:'chat_completions',target:'http://unused.test'}]);
  try{env.client.send(JSON.stringify({type:'response.create',model:'m0',input:'hello'}));await waitUntil(()=>calls===1);env.client.close();await waitUntil(()=>aborted===1);expect(env.events.some(e=>e.type==='response.completed')).toBe(false);}finally{await env.close();globalThis.fetch=original;}
});

for (const bindModels of [false, true]) test(`unbound native model retains WS transport with ${bindModels ? 'other bindings' : 'empty bindings'}`, async () => {
  const calls:any[]=[];
  const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,server){if(server.upgrade(request))return;return new Response('WS required',{status:400});},websocket:{message(socket,message){const body=JSON.parse(String(message));calls.push(body);socket.send(JSON.stringify({type:'response.completed',response:{id:'native-unbound',object:'response',status:'completed',model:body.model,output:[]}}));}}});
  const env=await setup([{protocol:'responses',target:`http://127.0.0.1:${upstream.port}`,ws:true}],bindModels);
  try {
    env.client.send(JSON.stringify({type:'response.create',model:'unbound-model',input:'hello'}));
    const terminal=(await env.terminal()).at(-1);
    expect(terminal.type).toBe('response.completed');expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({type:'response.create',model:'unbound-model'});
  } finally {await env.close();upstream.stop(true);}
});
