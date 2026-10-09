import {expect,test} from 'bun:test';
import {CodexRouterPlugin} from '../server/index';
import {HistoryCache,HistoryTransport} from '../server/history';
import {createPluginHooks} from '../../../packages/core/src/hooks';
const cache=new HistoryCache();const transport=new HistoryTransport(cache);
const caps={status:()=>({version:1}),model:()=>({provider:'p',model:'m',name:'m',contextWindow:32000,outputLimit:4096,toolCall:true,reasoning:false,inputModalities:['text']})};
async function router(protocol:string,alias='m',principal:any={domain:'data',keyId:'k',credentialVersion:1}){
  const binding={provider:'p',model:'m',alias,target:{type:'route',id:protocol}};
  const handler=new CodexRouterPlugin({models:[binding]});await handler.init( {scope:{type:'route',routeId:'/codex'},services:{consume:()=>caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);
  const hooks=createPluginHooks();handler.register(hooks);
  const dispatch=(body:any)=>hooks.onDispatchRequest.promise({context:{method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'},targets:[{type:'route',id:protocol,protocol:protocol as any}],signal:new AbortController().signal,principal,servingRevision:1});
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
  const {historyClient}=await import('../server/history-rpc');const transport=new HistoryTransport();const calls:number[]=[];
  const client=historyClient({get:async(input:any)=>transport.get(input),put:async(input:any)=>{calls.push(Buffer.byteLength(JSON.stringify(input)));return transport.put(input);}});
  const value={items:[{text:'中文🙂'.repeat(50000)}]};await client.put({scope:'key',id:'r',value},{operationId:crypto.randomUUID()});expect(calls.length).toBeGreaterThan(10);expect(Math.max(...calls)).toBeLessThan(65536);expect(await client.get({scope:'key',id:'r'})).toEqual(value);transport.clear();expect(await client.get({scope:'key',id:'r'})).toBeNull();
});

test('history contract runs through the canonical RPC host',async()=>{
  const {PluginServiceHost}=await import('../../../packages/core/src/plugin-services');const {historyRpc,historyClient}=await import('../server/history-rpc');
  const host=new PluginServiceHost('control',{identity:(plugin,scope)=>({endpoint:`history:${plugin}:${scope}`,instance:'unit',generation:1,catalog:'unit',subject:plugin}),resolvePlacement:()=>null,resolveCallee:()=>null,resolveJournal:()=>null});
  host.setDeclarations(new Map([['codex-router',{provides:[{id:historyRpc.id,version:1,kind:'rpc',process:'control'}]}],['history-test',{consumes:[{plugin:'codex-router',id:historyRpc.id,version:1,kind:'rpc',process:'control'}]}]]) as any);
  const context=host.createContext('codex-router');const transport=new HistoryTransport();context.rpc!.publish(historyRpc,{get:input=>transport.get(input),put:input=>transport.put(input)});host.markReady('codex-router');
  const consumer=host.createContext('history-test','global',{'codex-router':'^1.0.0'});host.markReady('history-test');const client=historyClient(consumer.rpc!.consume('codex-router',historyRpc));try{await client.put({scope:'k',id:'r',value:{items:['hello']}},{operationId:crypto.randomUUID()});expect(await client.get({scope:'k',id:'r'})).toEqual({items:['hello']});expect(await client.get({scope:'other',id:'r'})).toBeNull();}finally{await host.dispose('history-test');await host.dispose('codex-router');await host.rpc!.dispose();}
});

test('cross-model namespace tool continuation re-encodes the cached logical history',async()=>{
  cache.clear();const models=[{provider:'p',model:'chat',target:{type:'route',id:'chat'}},{provider:'p',model:'anthropic',target:{type:'route',id:'anthropic'}}];
  const create=async()=>{const plugin=new CodexRouterPlugin({models});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:()=>caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);const hooks=createPluginHooks();plugin.register(hooks);return hooks;};
  const targets:any=[{type:'route',id:'chat',protocol:'chat_completions'},{type:'route',id:'anthropic',protocol:'anthropic_messages'}];const principal={domain:'data',keyId:'cross',credentialVersion:1};
  const context=(body:any)=>({method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'});
  const tools=[{type:'namespace',name:'mcp',tools:[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}]}];const one=context({model:'chat',input:'lookup',tools});
  const decision=await (await create()).onDispatchRequest.promise({context:one,targets,signal:new AbortController().signal,principal,servingRevision:7});const resultHooks=createPluginHooks();decision!.adapter!.register(resultHooks);
  const result=await resultHooks.onResponse.promise(Response.json({}),{method:'POST',bodyHandle:{json:async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'bungee_tool_0',arguments:'{}'}}]},finish_reason:'tool_calls'}]})}} as any);const response:any=await result.json();expect(response.output[0].namespace).toBe('mcp');
  const two=context({model:'anthropic',tools,previous_response_id:response.id,input:[{type:'function_call_output',call_id:'call',output:'found'}]});await (await create()).onDispatchRequest.promise({context:two,targets,signal:new AbortController().signal,principal,servingRevision:7});
  expect(two.body.messages[1].content[0]).toMatchObject({type:'tool_use',id:'call',name:'bungee_tool_0'});expect(two.body.messages[2].content[0]).toMatchObject({type:'tool_result',tool_use_id:'call',content:'found'});
  await expect((await create()).onDispatchRequest.promise({context:context({model:'anthropic',previous_response_id:response.id,input:'next'}),targets,signal:new AbortController().signal,principal:{...principal,keyId:'other'},servingRevision:7})).rejects.toThrow('history_missing');
});

test('opaque native references pin provider/model and actual upstream',async()=>{
  cache.clear();const models=[{provider:'a',model:'one',target:{type:'route',id:'native'}},{provider:'b',model:'two',target:{type:'route',id:'native'}}];
  const plugin=new CodexRouterPlugin({models});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:()=>caps,rpc:{consume:()=>({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  const run=(body:any)=>hooks.onDispatchRequest.promise({context:{method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body,requestId:crypto.randomUUID(),clientIP:'local'},targets:[{type:'route',id:'native',protocol:'responses'}],signal:new AbortController().signal,principal:{domain:'data',keyId:'opaque',credentialVersion:1},servingRevision:9});
  const decision=await run({model:'one',input:'hello'});const resultHooks=createPluginHooks();decision!.adapter!.register(resultHooks);
  const response=await resultHooks.onResponse.promise(Response.json({}),{upstreamId:'actual-endpoint',bodyHandle:{json:async()=>({id:'opaque-id',status:'completed',output:[{type:'reasoning',encrypted_content:'private'}]})}} as any);expect((await response.json() as any).id).toBe('opaque-id');
  expect((await run({model:'one',previous_response_id:'opaque-id',input:'next'}))!.requiredUpstreamId).toBe('actual-endpoint');
  await expect(run({model:'two',previous_response_id:'opaque-id',input:'next'})).rejects.toThrow('unrestorable_history');
  await expect(run({model:'one',input:[{type:'reasoning',encrypted_content:'private'}]})).rejects.toThrow('unrestorable_history');
});
test('Anthropic thinking overrides cannot enable a capability without restorable history',async()=>{
  const plugin=new CodexRouterPlugin({models:[{provider:'p',model:'m',target:{type:'route',id:'a'},capabilityOverrides:{anthropicThinkingBudget:1024}}]});await plugin.init({scope:{type:'route',routeId:'/codex'},services:{consume:()=>({...caps,model:()=>({...caps.model(),reasoning:true})}),rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}} as any);
  const hooks=createPluginHooks();plugin.register(hooks);
  await expect(hooks.onDispatchRequest.promise({context:{method:'POST',originalUrl:new URL('http://local/codex/responses'),url:new URL('http://local/codex/responses'),routeId:'/codex',headers:{},body:{model:'m',input:'hello',reasoning:{effort:'high'}},requestId:crypto.randomUUID(),clientIP:'local'},targets:[{type:'route',id:'a',protocol:'anthropic_messages'}],signal:new AbortController().signal})).rejects.toThrow('unsupported_reasoning');
});
