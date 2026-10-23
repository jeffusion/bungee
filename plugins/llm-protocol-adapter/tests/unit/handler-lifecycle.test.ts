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
