import {expect,test} from 'bun:test';
import Adapter from '../../../../plugins/llm-protocol-adapter/server';
import {conversionService} from '../../../../plugins/llm-protocol-adapter/server/service';
import {ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,CONVERSION_VERSION,type ConversionService} from '../../../../plugins/llm-protocol-adapter/contract';
import {PluginServiceHost} from '../../src/plugin-services';
import {createPluginHooks} from '../../src/hooks';
import {CatalogView,capabilitiesServiceOf} from '../../../../plugins/models-dev/server/local';
import {buildCatalogIndex} from '../../../../plugins/models-dev/server/catalog';
const view=new CatalogView();
view.apply(buildCatalogIndex({version:1,fetchedAt:1,catalog:{zai:{models:{'glm-5.3-flash':{name:'Flash',limit:{context:32000,output:4096},tool_call:true,reasoning:true,reasoning_options:[{type:'effort',values:['low','high','max']}],modalities:{input:['text'],output:['text']}}}}}}));
const catalog=capabilitiesServiceOf(view);
function host(){const h=new PluginServiceHost();h.setDeclarations(new Map([
  [ADAPTER_PLUGIN,{provides:[{id:CONVERSION_SERVICE_ID,version:1,process:'worker',kind:'local'}]}],
  ['consumer',{consumes:[{plugin:ADAPTER_PLUGIN,id:CONVERSION_SERVICE_ID,version:1,process:'worker',kind:'local'}]}],
]) as any);const provider=h.createContext(ADAPTER_PLUGIN);provider.publish(CONVERSION_SERVICE_ID,1,conversionService(catalog,true));h.markReady(ADAPTER_PLUGIN);return h;}
test('real local host enforces version/dependency, own session functions, immutable DTO and provider revocation',async()=>{
  const h=host();const unauthorized=h.createContext('consumer');expect(()=>unauthorized.consume(ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,1)).toThrow('dependency');await h.dispose('consumer');
  const consumer=h.createContext('consumer','global',{[ADAPTER_PLUGIN]:'^1.0.0'});expect(()=>consumer.consume(ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,2)).toThrow();
  const service=consumer.consume<ConversionService>(ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,CONVERSION_VERSION);h.markReady('consumer');
  const profile=service.resolveCapabilities({provider:'zai',model:'glm-5.3-flash',targetProtocol:'chat_completions'})!;
  expect(Object.isFrozen(profile)).toBe(true);expect(profile.supportedEfforts).toEqual(['low','high','max']);expect(profile.defaultEffort).toBe('max');
  const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3-flash',provider:'zai',profile,selectedEffort:'high'});
  for(const name of ['convertRequest','convertResponse','push','finish','dispose','validateAttempt'])expect(Object.hasOwn(session,name)).toBe(true);
  const converted=session.convertRequest({model:'glm-5.3-flash',input:'hello',reasoning:{effort:'high'}});
  expect(Object.isFrozen(converted.body)).toBe(true);const body:any=structuredClone(converted.body);body.model='changed';expect(converted.body.model).toBe('glm-5.3-flash');
  expect(session.validateAttempt({model:'glm-5.3-flash',protocol:'chat_completions',body:converted.body,url:'http://local/v1/chat/completions'})).toMatchObject({effort:'high'});
  const response:any=session.convertResponse({choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}]});expect(Object.isFrozen(response.output)).toBe(true);expect(response.output[0].content[0].text).toBe('answer');
  await expect(h.dispose(ADAPTER_PLUGIN)).rejects.toThrow('referenced');await h.dispose('consumer');expect(()=>session.finish()).toThrow('revoked');expect(()=>service.describe()).toThrow('revoked');await h.dispose(ADAPTER_PLUGIN);
});
test('actual selected effort is fail closed for changed model, wire parameter, protocol URL and unsupported selections',()=>{
  const service=conversionService(catalog,true);const profile=service.resolveCapabilities({provider:'zai',model:'glm-5.3-flash',targetProtocol:'chat_completions'})!;
  expect(()=>service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:profile.model,provider:'zai',profile,selectedEffort:'medium'})).toThrow('Selected reasoning effort');
  const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:profile.model,provider:'zai',profile,selectedEffort:'high'});
  const body=session.convertRequest({model:profile.model,input:'hello',reasoning:{effort:'high'}}).body;
  for(const input of [{model:'other',protocol:'chat_completions',body},{model:profile.model,protocol:'chat_completions',body:{...body,reasoning_effort:'low'}},{model:profile.model,protocol:'anthropic_messages',body},{model:profile.model,protocol:'chat_completions',body,url:'http://local/v1/messages'}])expect(()=>session.validateAttempt(input as any)).toThrow();
  expect(conversionService(catalog,false).describe().matrix).toHaveLength(16);expect(()=>conversionService(catalog,false).createSession({sourceProtocol:'responses',targetProtocol:'responses',model:'m'})).toThrow('requires_worker');
});
const protocols=['responses','chat_completions','anthropic_messages','gemini_generate_content'] as const;
const requests:any={responses:{model:'m',input:'hello',max_output_tokens:32},chat_completions:{model:'m',max_tokens:32,messages:[{role:'user',content:'hello'}]},anthropic_messages:{model:'m',max_tokens:32,messages:[{role:'user',content:'hello'}]},gemini_generate_content:{generationConfig:{maxOutputTokens:32},contents:[{role:'user',parts:[{text:'hello'}]}]}};
const responses:any={responses:{id:'r',object:'response',status:'completed',model:'m',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}]},chat_completions:{choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}]},anthropic_messages:{id:'a',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'answer'}],stop_reason:'end_turn'},gemini_generate_content:{candidates:[{content:{role:'model',parts:[{text:'answer'}]},finishReason:'STOP'}]}};
const streams:any={responses:[{type:'response.completed',response:responses.responses}],chat_completions:[{choices:[{index:0,delta:{content:'answer'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}],anthropic_messages:[{type:'message_start',message:{id:'a',type:'message',role:'assistant',model:'m',content:[],usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}],gemini_generate_content:[{candidates:[{index:0,content:{role:'model',parts:[{text:'answer'}]},finishReason:'STOP'}]}]};
const canonicalJson=conversionService(catalog,true).createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'m'});responses.responses=canonicalJson.convertResponse(responses.chat_completions);
const canonicalStream=conversionService(catalog,true).createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'m'});streams.responses=[...streams.chat_completions.flatMap((e:any)=>canonicalStream.push(e)),...canonicalStream.finish()];
const path=(protocol:string,stream=false)=>protocol==='responses'?'/v1/responses':protocol==='chat_completions'?'/v1/chat/completions':protocol==='anthropic_messages'?'/v1/messages':`/v1/models/m:${stream?'streamGenerateContent':'generateContent'}`;
async function adapter(sourceProtocol:any,targetProtocol:any){const plugin=new Adapter({sourceProtocol,targetProtocol});await plugin.init({scope:{type:'route',routeId:'/v1'},initializationKind:'explicit-application',services:{consume:()=>catalog,onDispose(){}}} as any);const hooks=createPluginHooks();plugin.register(hooks);return {plugin,hooks};}
for(const source of protocols)for(const target of protocols)for(const streaming of [false,true])test(`scoped actual request/shared body/response hooks ${source} → ${target} ${streaming?'SSE':'JSON'}`,async()=>{
  const unsupported=(source==='responses'&&target==='gemini_generate_content')||(source==='gemini_generate_content'&&target==='responses');
  if(unsupported){await expect(adapter(source,target)).rejects.toThrow('invalid_protocol_pair');return;}
  const {hooks}=await adapter(source,target);const raw=structuredClone(requests[source]);if(source!=='gemini_generate_content')raw.stream=streaming;
  const context:any={requestId:crypto.randomUUID(),method:'POST',url:new URL('http://local'+path(source,streaming)),headers:{},body:raw};
  await hooks.onBeforeRequest.promise(context);expect(context.url.pathname).toBe(path(target,streaming));
  if(source===target){expect(context.body).toEqual(raw);return;}
  await hooks.onValidateOutbound.promise({...context,url:context.url.href,model:context.body.model??'m',body:context.body});
  if(!streaming){let reads=0;const response=await hooks.onResponse.promise(Response.json({}),{...context,bodyHandle:{json:async()=>{reads++;return Object.freeze(structuredClone(responses[target]));}}});expect(reads).toBe(1);expect(JSON.stringify(await response.json())).toContain('answer');}
  else {const out:any[]=[];for(const value of streams[target])out.push(...await hooks.onStreamChunk.promise(Object.freeze({data:JSON.stringify(value),json:Object.freeze(value)}),context)??[]);out.push(...await hooks.onFlushStream.promise([],context));expect(JSON.stringify(out)).toContain('answer');const wire=out.map(x=>x.json?.type);if(source==='responses')expect(wire).toContain('response.completed');if(source==='anthropic_messages')expect(wire).toContain('message_stop');}
  await hooks.onFinally.promise(context);
});
test('automatic provider publishes service without request conversion hooks; explicit application requires two protocols',async()=>{
  const p=new Adapter();let published=false;await p.init({scope:{type:'global'},initializationKind:'automatic-provider',services:{consume:()=>catalog,publish(id:string){published=id===CONVERSION_SERVICE_ID;},onDispose(){}}} as any);const h=createPluginHooks();p.register(h);expect(published).toBe(true);expect(p.bodyRequirements({method:'POST',url:new URL('http://local/v1/responses')})).toEqual({request:'none'});const raw:any={method:'POST',url:new URL('http://local/v1/responses'),body:{provider_secret:true}};expect(await h.onBeforeRequest.promise(raw)).toBe(raw);
  await expect(new Adapter().init({scope:{type:'route'},services:{consume:()=>catalog,onDispose(){}}} as any)).rejects.toThrow('invalid_protocol_pair');
});
test('strict scoped conversion rejects unknown inputs/tools/history/structured output before any response or secret leakage',async()=>{
  for(const [field,value,param] of [['secret_field','PRIVATE_REQUEST_BODY','secret_field'],['tools',[{type:'remote_execution',secret:'PRIVATE_REQUEST_BODY'}],'tools[0]'],['previous_response_id','private-id','previous_response_id']] as const){const {hooks}=await adapter('responses','chat_completions');try{await hooks.onBeforeRequest.promise({requestId:crypto.randomUUID(),method:'POST',url:new URL('http://local/v1/responses'),body:{model:'m',input:'hello',[field]:value}} as any);throw new Error('expected refusal');}catch(e:any){expect(e.status).toBe(422);expect(JSON.stringify(e)).not.toContain('PRIVATE_REQUEST_BODY');if(field!=='previous_response_id')expect(e.details?.param??e.param).toBeDefined();}}
  const {hooks}=await adapter('responses','anthropic_messages');await expect(hooks.onBeforeRequest.promise({requestId:'schema',method:'POST',url:new URL('http://local/v1/responses'),body:{model:'m',input:'hello',text:{format:{type:'json_schema',name:'test',schema:{type:'object'}}}}} as any)).rejects.toThrow('llm_adapter_unsupported_request');
});

import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../../src/scoped-plugin-registry';
import {handleRequest} from '../../src/worker/request/handler';
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
for(const source of protocols)for(const target of protocols)for(const streaming of [false,true])test(`Gateway scoped adapter ${source} → ${target} ${streaming?'SSE':'JSON'} final wire`,async()=>{
  if((source==='responses'&&target==='gemini_generate_content')||(source==='gemini_generate_content'&&target==='responses'))return;
  const previous=getScopedPluginRegistry(),fetch=globalThis.fetch;const h=new PluginServiceHost();const provider=h.createContext('models-dev');provider.publish('models-dev.capabilities.v1',1,catalog);h.markReady('models-dev');
  const registry=new ScopedPluginRegistry(import.meta.dir,h);registry.setServiceDependencies(new Map([[ADAPTER_PLUGIN,{'models-dev':'^1.0.0'}]]));
  const config:any={routes:[{id:'adapter',path:'/v1',path_rewrite:{'^/v1':''},plugins:[{name:ADAPTER_PLUGIN,path:new URL('../../../../plugins/llm-protocol-adapter/server/index.ts',import.meta.url).pathname,options:{sourceProtocol:source,targetProtocol:target}}],endpoints:[{id:'mock',target:'http://upstream.test/v1'}]}]};
  let calls=0,wire:any,url='';globalThis.fetch=Object.assign(async(input:any,init:any)=>{calls++;url=String(input);wire=JSON.parse(await new Response(init.body).text());return streaming?new Response(streams[target].map((e:any)=>`data: ${JSON.stringify(e)}\n\n`).join('')+(target==='chat_completions'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}}):Response.json(responses[target]);},{preconnect(){}}) as any;
  try{expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);const body=structuredClone(requests[source]);if(source!=='gemini_generate_content')body.stream=streaming;
    const response=await handleRequest(new Request('http://local'+path(source,streaming),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),config,{logging});expect(response.status).toBe(200);const text=await response.text();expect(text).toContain('answer');expect(calls).toBe(1);expect(new URL(url).pathname).toBe(path(target,streaming));if(source===target)expect(wire).toEqual(body);
    if(streaming&&source==='responses')expect(text).toContain('response.completed');if(streaming&&source==='anthropic_messages')expect(text).toContain('message_stop');if(streaming&&source==='chat_completions')expect(text).toContain('[DONE]');
  }finally{globalThis.fetch=fetch;setScopedPluginRegistry(previous);await registry.destroy();await h.dispose('models-dev');}
});

test('migrated Messages tool history converts losslessly and restores frozen declared tool responses',async()=>{
  const {hooks}=await adapter('anthropic_messages','chat_completions');const raw:any={requestId:'message-tools',method:'POST',url:new URL('http://local/v1/messages'),body:{model:'m',max_tokens:32,tools:[{name:'lookup',input_schema:{type:'object',properties:{q:{type:'string'}}}}],messages:[{role:'assistant',content:[{type:'tool_use',id:'call',name:'lookup',input:{q:'中文'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'found'}]}]}};await hooks.onBeforeRequest.promise(raw);expect(raw.body.messages[0].tool_calls[0]).toMatchObject({id:'call',function:{name:'bungee_tool_0',arguments:'{"q":"中文"}'}});expect(raw.body.messages[1]).toMatchObject({role:'tool',tool_call_id:'call',content:'found'});
  const result=await hooks.onResponse.promise(Response.json({}),{...raw,bodyHandle:{json:async()=>Object.freeze({choices:[{message:{content:null,tool_calls:[{id:'next',type:'function',function:{name:'bungee_tool_0',arguments:'{"q":"next"}'}}]},finish_reason:'tool_calls'}]})}});expect(await result.json()).toMatchObject({type:'message',stop_reason:'tool_use',content:[{type:'tool_use',id:'next',name:'lookup',input:{q:'next'}}]});await hooks.onFinally.promise(raw);
});
test('migrated terminal/transport contracts reject missing terminal and preserve provider errors',async()=>{
  const {hooks}=await adapter('anthropic_messages','chat_completions');const ctx:any={requestId:'missing-terminal',method:'POST',url:new URL('http://local/v1/messages'),body:requests.anthropic_messages};await hooks.onBeforeRequest.promise(ctx);await hooks.onStreamChunk.promise({data:'{"choices":[]}',json:{choices:[]}},ctx);await expect(hooks.onFlushStream.promise([],ctx)).rejects.toThrow('llm_adapter_missing_terminal');await hooks.onError.promise(ctx);
  const errorAdapter=await adapter('responses','chat_completions');const errorCtx:any={requestId:'provider-error',method:'POST',url:new URL('http://local/v1/responses'),body:requests.responses};await errorAdapter.hooks.onBeforeRequest.promise(errorCtx);const denied=Response.json({error:{code:'rate_limit'}},{status:429});expect(await errorAdapter.hooks.onResponse.promise(denied,errorCtx)).toBe(denied);await errorAdapter.hooks.onFinally.promise(errorCtx);
});
