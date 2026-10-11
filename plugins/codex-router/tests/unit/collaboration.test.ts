import {expect,test} from 'bun:test';
import {createPluginHooks} from '@jeffusion/bungee-core/plugin';
import {conversionService} from '../../../llm-protocol-adapter/server/service';
import {CodexRouterPlugin} from '../../server/index';
import {parseCollaborationRelay} from '../../server/config';

const relay={target:{type:'route',id:'relay',protocol:'responses'},model:'native-model'} as const;
const caps={status:()=>({version:1}),model:()=>({provider:'p',model:'m',name:'m',contextWindow:32000,outputLimit:4096,toolCall:true,reasoning:false,inputModalities:['text']})};
const agent={type:'agent_message',author:'/root/a',recipient:'/root',content:[{type:'input_text',text:'header'},{type:'encrypted_content',encrypted_content:'secret-cipher'},{type:'input_text',text:'tail'}]};
async function setup(protocol='chat_completions',configured:any=relay){
 const service=conversionService(caps as any,true),calls:any[]=[];
 service.relayAgentMessage=async input=>{calls.push(input);return ' 完整中文任务\n"内容"\\🙂 ';};
 const plugin=new CodexRouterPlugin({models:[{source:'source',provider:'p',model:'m',target:{type:'route',id:'target',protocol}}],...(configured===null?{}:{collaborationRelay:configured})});
 await plugin.init({scope:{type:'route',routeId:'entry'},services:{consume:(name:string)=>name==='llm-protocol-adapter'?service:caps,rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}} as any);
 const hooks=createPluginHooks();plugin.register(hooks);
 const input=(body:any):any=>({context:{method:'POST',originalUrl:new URL('http://local/responses'),url:new URL('http://local/responses'),body,routeId:'entry',headers:{},requestId:'r',clientIP:'local'},targets:[{type:'route',id:'target'},{type:'route',id:'relay'}],signal:new AbortController().signal,principal:{domain:'data',keyId:'k',credentialVersion:1},servingRevision:1,executeAuxiliary:async()=>{throw new Error('service owns executor');}});
 return {hooks,calls,input};
}
test('dispatch only selects model; preparation relays just its message and preserves canonical order',async()=>{
 for(const protocol of ['chat_completions','anthropic_messages']){
  const {hooks,calls,input}=await setup(protocol);const req=input({model:'source',input:[{role:'user',content:'before'},agent,{role:'user',content:'after'}]});
  const decision=await hooks.onDispatchRequest.promise(req);expect(calls).toHaveLength(0);expect(req.context.body.model).toBe('m');expect(req.context.body.input[1]).toEqual(agent);
  const prepared=await decision!.prepareRequest!(req);expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({message:agent,contentIndex:1,param:'input[1].content[1].encrypted_content',relay});
  expect(prepared.canonicalInput?.[1]).toEqual({...agent,content:[agent.content[0],{type:'input_text',text:' 完整中文任务\n"内容"\\🙂 '},agent.content[2]]});
  expect(prepared.diagnostics).toEqual([{param:'input[1].content[1].encrypted_content',action:'mapped',reason:'agent_message_plaintext_replacement'},{param:'input[1]',action:'mapped',reason:'agent_message_plaintext_delivery'}]);expect(JSON.stringify(prepared.diagnostics)).not.toContain('secret-cipher');
 }
});
test('missing relay rejects the exact encrypted param without sharing ciphertext in errors',async()=>{
 const {hooks,input}=await setup('chat_completions',null);const req=input({model:'source',input:[agent]});const decision=await hooks.onDispatchRequest.promise(req);
 await expect(decision!.prepareRequest!(req)).rejects.toMatchObject({status:422,code:'llm_adapter_agent_message_relay_required',details:{param:'input[0].content[1].encrypted_content'}});
});
test('multiple opaque blocks fail at the second block before any relay',async()=>{
 const {hooks,calls,input}=await setup();const req=input({model:'source',input:[{...agent,content:[agent.content[1],agent.content[1]]}]});const decision=await hooks.onDispatchRequest.promise(req);
 await expect(decision!.prepareRequest!(req)).rejects.toMatchObject({status:422,code:'llm_adapter_agent_message_multiple_encrypted_blocks',details:{param:'input[0].content[1].encrypted_content'}});expect(calls).toHaveLength(0);
});
test('ordinary, plaintext and native Responses generate no relay traffic; unbound requests remain untouched',async()=>{
 for(const [protocol,message] of [['responses',agent],['chat_completions',{...agent,content:[{type:'input_text',text:'plain'}]}]] as const){
  const {hooks,calls,input}=await setup(protocol);for(const items of [[message],[{role:'user',content:'ordinary'}]]){const req=input({model:'source',input:items});const decision=await hooks.onDispatchRequest.promise(req);await decision!.prepareRequest!(req);}expect(calls).toHaveLength(0);
  const unbound=input({model:'unbound',input:[agent]});const original=structuredClone(unbound.context.body);expect(await hooks.onDispatchRequest.promise(unbound)).toBeUndefined();expect(unbound.context.body).toEqual(original);
 }
});
test('relay is strictly optional with complete explicit Responses target and model',()=>{
 expect(parseCollaborationRelay(undefined)).toBeUndefined();expect(parseCollaborationRelay(relay)).toEqual(relay);
 for(const bad of [{}, {...relay,model:''},{...relay,model:' bad '},{...relay,model:'x'.repeat(513)},{...relay,target:{...relay.target,protocol:'chat_completions'}},{...relay,target:{...relay.target,id:''}},{...relay,extra:true}])expect(()=>parseCollaborationRelay(bad)).toThrow('invalid_collaboration_relay');
});
