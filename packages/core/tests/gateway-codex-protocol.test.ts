import {afterEach,expect,test} from 'bun:test';
import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../src/scoped-plugin-registry';
import {handleRequest} from '../src/worker/request/handler';
const originalFetch=globalThis.fetch,previous=getScopedPluginRegistry();afterEach(()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);});
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
const path=new URL('./fixtures/codex-dispatch-plugin.ts',import.meta.url).pathname;
for(const protocol of ['chat_completions','anthropic_messages'] as const)for(const streaming of [false,true])test(`actual pipeline ${protocol} ${streaming?'SSE':'JSON'}`,async()=>{
  const config:any={routes:[{id:'e',path:'/codex',plugins:[{name:'codex-router',path,options:{models:[{provider:'p',model:'m',target:{type:'route',id:'t'}}]}}],endpoints:[{target:'http://unused'}]},
    {id:'t',path:'/target',llm_protocol:protocol,path_rewrite:{'^/target':''},endpoints:[{id:'u',target:'http://upstream.test'}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);const calls:any[]=[];
  globalThis.fetch=Object.assign(async(url:any,init:any)=>{
    calls.push({url:String(url),body:JSON.parse(await new Response(init.body).text())});
    if(!streaming)return Response.json(protocol==='chat_completions'?{choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}:{content:[{type:'text',text:'answer'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:1}});
    const events=protocol==='chat_completions'?[{choices:[{index:0,delta:{content:'answer'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:1}}]:[{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
    return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+(protocol==='chat_completions'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
  },{preconnect(){}}) as any;
  try{const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',input:'hello',stream:streaming})}),config,{logging});expect(response.status).toBe(200);const text=await response.text();expect(text).toContain(streaming?'response.completed':'"object":"response"');expect(text).toContain('answer');expect(calls).toHaveLength(1);expect(calls[0].url).toEndWith(protocol==='chat_completions'?'/chat/completions':'/messages');expect(calls[0].body.messages[0].role).toBe('user');}finally{await registry.destroy();}
});
