import {afterEach,beforeEach,expect,test} from 'bun:test';
import {handleRequest} from '../src/worker/request/handler';
import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../src/scoped-plugin-registry';
import {PluginServiceHost} from '../src/plugin-services';
import {CatalogView,capabilitiesServiceOf} from '../../../plugins/models-dev/server/local';

let host:PluginServiceHost,registry:ScopedPluginRegistry,previous:ReturnType<typeof getScopedPluginRegistry>;
const originalFetch=globalThis.fetch;
const calls:{url:string;body:any}[]=[];
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
beforeEach(()=>{
  calls.length=0;previous=getScopedPluginRegistry();host=new PluginServiceHost();
  host.createContext('models-dev').publish('models-dev.capabilities.v1',1,capabilitiesServiceOf(new CatalogView()));host.markReady('models-dev');
  registry=new ScopedPluginRegistry(import.meta.dir,host);registry.setServiceDependencies(new Map([['llm-protocol-adapter',{'models-dev':'^1.0.0'}]]));
  globalThis.fetch=Object.assign(async(input:any,init:any)=>{calls.push({url:String(input),body:init.body?JSON.parse(await new Response(init.body).text()):null});return Response.json({choices:[{message:{content:'answer'},finish_reason:'stop'}]});},{preconnect(){}}) as any;
});
afterEach(async()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);await registry.destroy();await host.dispose('models-dev');});
async function setup(rewrite:Record<string,string>,plugins:any[]=[]){const config:any={routes:[{id:'route',path:'/api',path_rewrite:rewrite,plugins,endpoints:[{id:'mock',target:'http://mock.test'}]}]};expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);return config;}
test('path rewrite chooses the first matching rule before proxy forwarding',async()=>{
  const config=await setup({'^/api/v1':'/v1-internal','^/api':''});
  for(const path of ['/api/v1/users','/api/health'])expect((await handleRequest(new Request('http://local'+path),config,{logging})).status).toBe(200);
  expect(calls.map(call=>call.url)).toEqual(['http://mock.test/v1-internal/users','http://mock.test/health']);
});
test('route rewrite precedes the adapter source-path validation and target-path rewrite',async()=>{
  const config=await setup({'^/api':''},[{name:'llm-protocol-adapter',path:new URL('../../../plugins/llm-protocol-adapter/server/index.ts',import.meta.url).pathname,options:{sourceProtocol:'anthropic_messages',targetProtocol:'chat_completions'}}]);
  const response=await handleRequest(new Request('http://local/api/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',max_tokens:1024,messages:[{role:'user',content:'hello'}]})}),config,{logging});
  expect(response.status).toBe(200);expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({url:'http://mock.test/v1/chat/completions',body:{model:'m',max_completion_tokens:1024,messages:[{role:'user',content:[{type:'text',text:'hello'}]}]}});
  expect(await response.json()).toMatchObject({type:'message',content:[{type:'text',text:'answer'}]});
});
test('a rewritten request in a different source protocol fails before the mock connection',async()=>{
  const config=await setup({'^/api':''},[{name:'llm-protocol-adapter',path:new URL('../../../plugins/llm-protocol-adapter/server/index.ts',import.meta.url).pathname,options:{sourceProtocol:'anthropic_messages',targetProtocol:'chat_completions'}}]);
  const response=await handleRequest(new Request('http://local/api/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',input:'hello'})}),config,{logging});expect(response.status).toBe(422);expect(calls).toHaveLength(0);
});
