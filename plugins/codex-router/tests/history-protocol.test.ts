import {expect,test} from 'bun:test';
import {conversionService} from '../../llm-protocol-adapter/server/service';
import {CodexRouterPlugin} from '../server/index';
import {HistoryCache,HistoryTransport} from '../../llm-protocol-adapter/server/history';
import {createPluginHooks} from '../../../packages/core/src/hooks';
const cache=new HistoryCache();const transport=new HistoryTransport(cache);
const caps={status:()=>({version:1}),model:()=>({provider:'p',model:'m',name:'m',contextWindow:32000,outputLimit:4096,toolCall:true,reasoning:false,inputModalities:['text']})};
async function router(protocol:string,alias='m',principal:any={domain:'data',keyId:'k',credentialVersion:1}){
  const binding={provider:'p',model:'m',alias,target:{type:'route',id:protocol,protocol}};
  const handler=new CodexRouterPlugin({models:[binding]});await handler.init( {scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(caps as any,true):caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);
  const hooks=createPluginHooks();handler.register(hooks);
  const dispatch=(body:any)=>hooks.onDispatchRequest.promise({context:{method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'},targets:[{type:'route',id:protocol}],signal:new AbortController().signal,principal,servingRevision:1});
  return {dispatch};
}
test('Chat and Anthropic JSON results return Responses and retain ordinary history across consumers',async()=>{
  cache.clear();const first=await router('chat_completions');
  const decision=await first.dispatch({model:'m',input:'hello'});const hooks=createPluginHooks();decision!.adapter!.register(hooks);
  const result=await hooks.onResponse.promise(Response.json({}),{method:'POST',bodyHandle:{json:async()=>({choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})}} as any);
  const body:any=await result.json();expect(body.object).toBe('response');expect(body.output[0].content[0].text).toBe('answer');expect(cache.status().entries).toBe(1);
  // Same configuration/identity, independently initialized consumer reads the control cache.
  const second=await router('chat_completions');const follow=await second.dispatch({model:'m',previous_response_id:body.id,input:'next'});expect(follow).toBeDefined();
  const anthropic=await router('anthropic_messages');const other=await anthropic.dispatch({model:'m',input:[{role:'user',content:'hello'},{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]},{role:'user',content:'next'}]});expect(other).toBeDefined();
});
test('missing and anonymous references fail closed; encrypted conversion requests a new conversation',async()=>{
  const r=await router('chat_completions');await expect(r.dispatch({model:'m',previous_response_id:'missing',input:'delta'})).rejects.toThrow('history_missing');
  const anon=await router('chat_completions','m',{domain:'anonymous',keyId:'',credentialVersion:0});await expect(anon.dispatch({model:'m',previous_response_id:'private',input:'delta'})).rejects.toThrow('identity_required');
  await expect(r.dispatch({model:'m',input:[{type:'reasoning',encrypted_content:'opaque'}]})).rejects.toThrow('unrestorable_history');
});
test('bounded cache isolates scopes, evicts, expires, clones and clears',()=>{
  let now=0;const local=new HistoryCache({maxEntries:1,maxBytes:1024,maxEntryBytes:512,ttlMs:10},()=>now);const value={items:[{text:'secret'}]};local.put('a','r',value);value.items[0].text='changed';expect(local.get('a','r').items[0].text).toBe('secret');expect(local.get('b','r')).toBeNull();local.put('a','s',{});expect(local.get('a','r')).toBeNull();now=10;expect(local.get('a','s')).toBeNull();expect(()=>local.put('a','big',{text:'x'.repeat(600)})).toThrow('history_limit');local.clear();expect(local.status().bytes).toBe(0);
});

test('large history uses canonical bounded chunks without any durable storage',async()=>{
  const {historyClient}=await import('../../llm-protocol-adapter/contract');const transport=new HistoryTransport();const calls:number[]=[];
  const client=historyClient({get:async(input:any)=>transport.get(input),put:async(input:any)=>{calls.push(Buffer.byteLength(JSON.stringify(input)));return transport.put(input);}});
  const value={items:[{text:'中文🙂'.repeat(50000)}]};await client.put({scope:'key',id:'r',value},{operationId:crypto.randomUUID()});expect(calls.length).toBeGreaterThan(10);expect(Math.max(...calls)).toBeLessThan(65536);expect(await client.get({scope:'key',id:'r'})).toEqual(value);transport.clear();expect(await client.get({scope:'key',id:'r'})).toBeNull();
});

test('history contract runs through the canonical RPC host',async()=>{
  const {PluginServiceHost}=await import('../../../packages/core/src/plugin-services');const {historyRpc,historyClient}=await import('../../llm-protocol-adapter/contract');
  const host=new PluginServiceHost('control',{identity:(plugin,scope)=>({endpoint:`history:${plugin}:${scope}`,instance:'unit',generation:1,catalog:'unit',subject:plugin}),resolvePlacement:()=>null,resolveCallee:()=>null,resolveJournal:()=>null});
  host.setDeclarations(new Map([['llm-protocol-adapter',{provides:[{id:historyRpc.id,version:1,kind:'rpc',process:'control'}]}],['history-test',{consumes:[{plugin:'llm-protocol-adapter',id:historyRpc.id,version:1,kind:'rpc',process:'control'}]}]]) as any);
  const context=host.createContext('llm-protocol-adapter');const transport=new HistoryTransport();context.rpc!.publish(historyRpc,{get:input=>transport.get(input),put:input=>transport.put(input)});host.markReady('llm-protocol-adapter');
  const consumer=host.createContext('history-test','global',{'llm-protocol-adapter':'^1.0.0'});host.markReady('history-test');const client=historyClient(consumer.rpc!.consume('llm-protocol-adapter',historyRpc));try{await client.put({scope:'k',id:'r',value:{items:['hello']}},{operationId:crypto.randomUUID()});expect(await client.get({scope:'k',id:'r'})).toEqual({items:['hello']});expect(await client.get({scope:'other',id:'r'})).toBeNull();}finally{await host.dispose('history-test');await host.dispose('llm-protocol-adapter');await host.rpc!.dispose();}
});

test('cross-model namespace tool continuation re-encodes the cached logical history',async()=>{
  cache.clear();const models=[{provider:'p',model:'chat',target:{type:'route',id:'chat',protocol:'chat_completions'}},{provider:'p',model:'anthropic',target:{type:'route',id:'anthropic',protocol:'anthropic_messages'}}];
  const create=async()=>{const plugin=new CodexRouterPlugin({models});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(caps as any,true):caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);const hooks=createPluginHooks();plugin.register(hooks);return hooks;};
  const targets:any=[{type:'route',id:'chat'},{type:'route',id:'anthropic'}];const principal={domain:'data',keyId:'cross',credentialVersion:1};
  const context=(body:any)=>({method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'});
  const tools=[{type:'namespace',name:'mcp',tools:[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}]}];const one=context({model:'chat',input:'lookup',tools});
  const decision=await (await create()).onDispatchRequest.promise({context:one,targets,signal:new AbortController().signal,principal,servingRevision:7});const resultHooks=createPluginHooks();decision!.adapter!.register(resultHooks);
  const result=await resultHooks.onResponse.promise(Response.json({}),{method:'POST',bodyHandle:{json:async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'bungee_tool_0',arguments:'{}'}}]},finish_reason:'tool_calls'}]})}} as any);const response:any=await result.json();expect(response.output[0].namespace).toBe('mcp');
  const two=context({model:'anthropic',tools,previous_response_id:response.id,input:[{type:'function_call_output',call_id:'call',output:'found'}]});await (await create()).onDispatchRequest.promise({context:two,targets,signal:new AbortController().signal,principal,servingRevision:7});
  expect(two.body.messages[1].content[0]).toMatchObject({type:'tool_use',id:'call',name:'bungee_tool_0'});expect(two.body.messages[2].content[0]).toMatchObject({type:'tool_result',tool_use_id:'call',content:'found'});
  await expect((await create()).onDispatchRequest.promise({context:context({model:'anthropic',previous_response_id:response.id,input:'next'}),targets,signal:new AbortController().signal,principal:{...principal,keyId:'other'},servingRevision:7})).rejects.toThrow('history_missing');
});

test('opaque native references pin provider/model and actual upstream',async()=>{
  cache.clear();const models=[{provider:'a',model:'one',target:{type:'route',id:'native',protocol:'responses'}},{provider:'b',model:'two',target:{type:'route',id:'native',protocol:'responses'}}];
  const plugin=new CodexRouterPlugin({models});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(caps as any,true):caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  const run=(body:any)=>hooks.onDispatchRequest.promise({context:{method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'},targets:[{type:'route',id:'native'}],signal:new AbortController().signal,principal:{domain:'data',keyId:'opaque',credentialVersion:1},servingRevision:9});
  const decision=await run({model:'one',input:'hello'});const resultHooks=createPluginHooks();decision!.adapter!.register(resultHooks);
  const response=await resultHooks.onResponse.promise(Response.json({}),{upstreamId:'actual-endpoint',bodyHandle:{json:async()=>({id:'opaque-id',status:'completed',output:[{type:'reasoning',encrypted_content:'private'}]})}} as any);expect((await response.json() as any).id).toBe('opaque-id');
  expect((await run({model:'one',previous_response_id:'opaque-id',input:'next'}))!.requiredUpstreamId).toBe('actual-endpoint');
  await expect(run({model:'two',previous_response_id:'opaque-id',input:'next'})).rejects.toThrow('unrestorable_history');
  await expect(run({model:'one',input:[{type:'reasoning',encrypted_content:'private'}]})).rejects.toThrow('unrestorable_history');
});
test('removed Anthropic budget override fails binding admission',()=>{expect(()=>new CodexRouterPlugin({models:[{provider:'p',model:'m',target:{type:'route',id:'a',protocol:'anthropic_messages'},capabilityOverrides:{anthropicThinkingBudget:1024}}]})).toThrow('invalid_capabilities');});

test('converted shared history removes carriers and next request can change its declarations',async()=>{
  cache.clear();const models=[{source:'client',provider:'p',model:'m',target:{type:'route',id:'t',protocol:'chat_completions'}}];
  const plugin=new CodexRouterPlugin({models});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(caps as any,true):caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  const makeContext=(body:any)=>({method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'});
  const dispatch=(context:any)=>hooks.onDispatchRequest.promise({context,targets:[{type:'route',id:'t'}],signal:new AbortController().signal,principal:{domain:'data',keyId:'carriers',credentialVersion:1},servingRevision:1});
  const declaration=(description:string)=>({type:'additional_tools',tools:[{type:'namespace',name:'files',tools:[{type:'custom',name:'patch',description,format:{type:'text'}}]}]});
  const one=makeContext({model:'client',input:[declaration('old'),{role:'user',content:'patch'}],text:{verbosity:'low'}});
  const decision=await dispatch(one);const resultHooks=createPluginHooks();decision!.adapter!.register(resultHooks);
  const response=await resultHooks.onResponse.promise(Response.json({}),{bodyHandle:{json:async()=>({choices:[{message:{tool_calls:[{id:'p',function:{name:'bungee_tool_0',arguments:'{"input":"original patch"}'}}]},finish_reason:'tool_calls'}]})}} as any);
  const result:any=await response.json();expect(result.output[0]).toMatchObject({namespace:'files',type:'custom_tool_call'});
  expect(decision!.diagnostics).toMatchObject([{param:'text.verbosity',action:'omitted'}]);
  const two=makeContext({model:'client',previous_response_id:result.id,input:[declaration('new'),{type:'custom_tool_call_output',call_id:'p',output:'patched'}]});
  await dispatch(two);expect(two.body.tools).toHaveLength(1);expect(two.body.tools[0].function.description).toContain('new');
  expect(two.body.messages.map((m:any)=>m.role)).toEqual(['user','assistant','tool']);
  expect(two.body.messages[2]).toMatchObject({tool_call_id:'p',content:'patched'});
});

test('additional tools cannot bypass target tool capability limits',async()=>{
  const plugin=new CodexRouterPlugin({models:[{source:'client',provider:'p',model:'m',capabilityOverrides:{tools:false},target:{type:'route',id:'t',protocol:'chat_completions'}}]});
  await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(caps as any,true):caps,rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  const context:any={method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},requestId:'capability',clientIP:'local',body:{model:'client',input:[{type:'additional_tools',tools:[{type:'function',name:'f',parameters:{type:'object'}}]}]}};
  await expect(hooks.onDispatchRequest.promise({context,targets:[{type:'route',id:'t'}],signal:new AbortController().signal})).rejects.toThrow('codex_router_tools_unsupported');
});

test('reasoning-capable Chat route restores nullable plain reasoning independently of effort override',async()=>{
  const plugin=new CodexRouterPlugin({models:[{source:'client',provider:'p',model:'m',target:{type:'route',id:'t',protocol:'chat_completions'}}]});
  await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService({...caps,model:()=>({...caps.model(),reasoning:true})} as any,true):caps,rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  const context:any={method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},requestId:'plain-reasoning',clientIP:'local',body:{model:'client',input:[{role:'user',content:'hello'},{type:'reasoning',summary:[{type:'summary_text',text:'plain'}],content:null,encrypted_content:null},{role:'assistant',content:'answer'}]}};
  await hooks.onDispatchRequest.promise({context,targets:[{type:'route',id:'t'}],signal:new AbortController().signal});
  expect(context.body.messages[1]).toMatchObject({reasoning_content:'plain',content:'answer'});expect(context.body).not.toHaveProperty('reasoning_effort');
});
