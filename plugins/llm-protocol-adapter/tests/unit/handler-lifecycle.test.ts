import {expect,test} from 'bun:test';
import {createPluginHooks} from '@jeffusion/bungee-core/plugin';
import {responseHandler} from '../../server/handler';
import type {AdapterSession} from '../../contract';

test.each([false,true])('finally releases a prepared conversion session even without a response (%p validation only)',async validationOnly=>{
  let disposals=0;
  const controller=new AbortController();
  const session={dispose(){disposals++;}} as AdapterSession;
  const hooks=createPluginHooks();
  responseHandler({session,sourceProtocol:'responses',targetProtocol:'chat_completions',model:'model',signal:controller.signal,validationOnly}).register(hooks);
  const context={requestId:'request',method:'POST',originalUrl:new URL('http://client/responses'),clientIP:'unknown',success:false,latencyMs:1};
  if(!validationOnly)await hooks.onError.promise({...context,headers:{},body:undefined,error:new Error('failed')});
  await hooks.onFinally.promise(context);controller.abort();expect(disposals).toBe(1);
});

test('response conversion failures are 502 while outbound request validation remains 422',async()=>{
 const failure=()=>{throw Object.assign(new Error('Cannot convert field'),{code:'unsupported_content',param:'audio'});};
 const session={validateAttempt:failure,convertResponse:failure,push:failure,finish:failure,dispose(){}} as unknown as AdapterSession;
 const hooks=createPluginHooks();
 responseHandler({session,sourceProtocol:'responses',targetProtocol:'chat_completions',model:'model'}).register(hooks);
 await expect(hooks.onValidateOutbound.promise({body:{model:'model'},url:new URL('http://upstream/v1/chat/completions')} as any)).rejects.toMatchObject({status:422,code:'llm_adapter_unsupported_content'});
 await expect(hooks.onResponse.promise(Response.json({}),{bodyHandle:{json:async()=>({})}} as any)).rejects.toMatchObject({status:502,code:'llm_adapter_unsupported_content',details:{param:'audio'}});
 await expect(hooks.onStreamChunk.promise({json:{}} as any,{strict:true} as any)).rejects.toMatchObject({status:502,code:'llm_adapter_unsupported_content'});
 await expect(hooks.onFlushStream.promise([],{} as any)).rejects.toMatchObject({status:502,code:'llm_adapter_unsupported_content'});
});
