import {expect,test} from 'bun:test';
import {relayServiceHost} from '../../../../tests/helpers/llm-protocol-adapter-service-host';
import {RELAY_TOOL} from '../../server/relay-response';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
const payload='中文原始任务\n"完整"\\🙂';
const identity={scope:'account',model:'native',upstreamId:'upstream'};
function input(executeAuxiliary:any,signal:AbortSignal):any{return {message:{type:'agent_message',author:'a',recipient:'b',content:[{type:'encrypted_content',encrypted_content:'cipher'}]},contentIndex:0,param:'input[0].content[0].encrypted_content',relay:{target:{type:'route',id:'relay',protocol:'responses'},model:'configured'},scope:'trusted',entryScope:'entry:revision',requestId:'generation',signal,executeAuxiliary};}
function response(signal:AbortSignal,actual=identity):any{return {kind:'response',status:200,identity:actual,requestId:'aux',bodyHandle:{identity:{contentType:'application/json'},maxBytes:1024*1024,json:async()=>{signal.throwIfAborted();return {status:'completed',output:[{type:'function_call',name:RELAY_TOOL,status:'completed',arguments:JSON.stringify({payload})}]};}},completion:Promise.resolve({status:'completed'}),dispose(){}};}
function wire(){const finish=deferred<void>(),started=deferred<void>(),second=deferred<void>();let calls=0,entered=0,aggregate!:AbortSignal;
 const execute=async(request:any)=>{if(++entered===2)second.resolve();const reused=await request.reuse(identity);if(reused!==undefined)return {kind:'reused',identity,value:reused};calls++;aggregate=request.signal;started.resolve();await Promise.race([finish.promise,new Promise((_,reject)=>aggregate.addEventListener('abort',()=>reject(aggregate.reason),{once:true}))]);return response(aggregate);};
 return {execute,finish,started,second,calls:()=>calls,signal:()=>aggregate};
}
async function nextTurn(){await new Promise<void>(resolve=>setTimeout(resolve,0));}
test.each(['http','websocket'])('real facade and self-history RPC retain the shared owner after first %s client cancellation',async transport=>{
 const host=relayServiceHost(),upstream=wire(),a=new AbortController(),b=new AbortController(),connection=new AbortController();
 const request=(signal:AbortSignal)=>({...input(upstream.execute,signal),...(transport==='websocket'?{webSocketConnection:{id:'host-connection',signal:connection.signal}}:{})});
 const one=host.call(request(a.signal));const outcome=one.catch(error=>error);await upstream.started.promise;
 const two=host.call(request(b.signal));await upstream.second.promise;await nextTurn();
 try{
  a.abort(new Error('client_cancelled'));expect(a.signal.aborted).toBe(true);expect(upstream.signal().aborted).toBe(false);
  expect(host.worker.currentInvocation()).toBeNull();
  upstream.finish.resolve();expect(await two).toBe(payload);expect(await outcome).toMatchObject({message:'client_cancelled'});expect(upstream.calls()).toBe(1);
  expect(host.transport.cache.status().entries).toBe(1);expect(host.purposes.every(purpose=>purpose==='background')).toBe(true);
  expect(await host.call(request(new AbortController().signal))).toBe(payload);expect(upstream.calls()).toBe(1);
 }finally{upstream.finish.resolve();await Promise.allSettled([one,two]);await host.dispose();}
});
test('real facade aborts the aggregate when all waiters cancel and writes no successful history',async()=>{
 const host=relayServiceHost(),upstream=wire(),a=new AbortController(),b=new AbortController();
 const one=host.call(input(upstream.execute,a.signal));const first=one.catch(error=>error);await upstream.started.promise;
 const two=host.call(input(upstream.execute,b.signal));const second=two.catch(error=>error);await upstream.second.promise;await nextTurn();
 try{a.abort(new Error('a cancelled'));b.abort(new Error('b cancelled'));expect(upstream.signal().aborted).toBe(true);await first;await second;expect(host.transport.cache.status().entries).toBe(0);}
 finally{upstream.finish.resolve();await Promise.allSettled([one,two]);await host.dispose();}
});
test('provider relay disposal aborts owned native work and invalidates its service after host drain',async()=>{
 const host=relayServiceHost(),upstream=wire(),controller=new AbortController();const pending=host.call(input(upstream.execute,controller.signal));const outcome=pending.catch(error=>error);await upstream.started.promise;
 host.service.dispose();expect(upstream.signal().aborted).toBe(true);await outcome;expect(host.transport.cache.status().entries).toBe(0);await host.dispose();
 expect(()=>host.facade.relayAgentMessage(input(upstream.execute,new AbortController().signal))).toThrow('revoked');
});
test('the same native identity may resolve reuse again on retry without joining its own flight',async()=>{
 const host=relayServiceHost();let attempts=0;
 const execute=async(request:any)=>{for(let retry=0;retry<2;retry++){expect(await request.reuse(identity)).toBeUndefined();attempts++;}return response(request.signal);};
 try{expect(await host.call(input(execute,new AbortController().signal))).toBe(payload);expect(attempts).toBe(2);expect(host.transport.cache.status().entries).toBe(1);}
 finally{await host.dispose();}
});
test('failover moves the existing flight, retains waiters and caches only the final account/upstream',async()=>{
 const host=relayServiceHost(),allowRetry=deferred<void>(),started=deferred<void>(),second=deferred<void>();
 const finalIdentity={...identity,scope:'final-account',model:'final-native',upstreamId:'final-upstream'};
 let entered=0,attempts=0;const a=new AbortController(),b=new AbortController();
 const execute=async(request:any)=>{
  const number=++entered;if(number===2)second.resolve();
  const reused=await request.reuse(identity);if(reused!==undefined)return {kind:'reused',identity,value:reused};
  attempts++;started.resolve();await allowRetry.promise;
  expect(await request.reuse(finalIdentity)).toBeUndefined();attempts++;return response(request.signal,finalIdentity);
 };
 const one=host.call(input(execute,a.signal));const outcome=one.catch(error=>error);await started.promise;
 const two=host.call(input(execute,b.signal));await second.promise;await nextTurn();
 try{
  a.abort(new Error('first cancelled during failover'));allowRetry.resolve();expect(await two).toBe(payload);expect(await outcome).toMatchObject({message:'first cancelled during failover'});expect(attempts).toBe(2);expect(host.transport.cache.status().entries).toBe(1);
  let wires=0;
  const native=(actual:typeof identity)=>async(request:any)=>{const reused=await request.reuse(actual);if(reused!==undefined)return {kind:'reused',identity:actual,value:reused};wires++;return response(request.signal,actual);};
  expect(await host.call(input(native(finalIdentity),new AbortController().signal))).toBe(payload);expect(wires).toBe(0);
  expect(await host.call(input(native(identity),new AbortController().signal))).toBe(payload);expect(wires).toBe(1);expect(host.transport.cache.status().entries).toBe(2);
 }finally{allowRetry.resolve();await Promise.allSettled([one,two]);await host.dispose();}
});
test.each([false,true])('a deferred retry failure or cancellation settles every waiter and removes the flight (%s)',async cancel=>{
 const host=relayServiceHost(),continueRetry=deferred<void>(),started=deferred<void>(),joined=deferred<void>(),a=new AbortController(),b=new AbortController();let entries=0,aggregate!:AbortSignal;
 const execute=async(request:any)=>{
  if(++entries===2)joined.resolve();const reused=await request.reuse(identity);if(reused!==undefined)return {kind:'reused',identity,value:reused};
  aggregate=request.signal;started.resolve();await Promise.race([continueRetry.promise,new Promise((_,reject)=>aggregate.addEventListener('abort',()=>reject(new Error('native cancelled')),{once:true}))]);
  expect(await request.reuse(identity)).toBeUndefined();throw new Error('native retry failed');
 };
 const one=host.call(input(execute,a.signal));const first=one.catch(error=>error);await started.promise;
 const two=host.call(input(execute,b.signal));const second=two.catch(error=>error);await joined.promise;await nextTurn();
 try{
  if(cancel){a.abort();b.abort();expect(aggregate.aborted).toBe(true);}else continueRetry.resolve();
  expect(await first).toBeInstanceOf(Error);expect(await second).toBeInstanceOf(Error);expect(host.transport.cache.status().entries).toBe(0);
  let wires=0;const fresh=async(request:any)=>{expect(await request.reuse(identity)).toBeUndefined();wires++;return response(request.signal);};
  expect(await host.call(input(fresh,new AbortController().signal))).toBe(payload);expect(wires).toBe(1);
 }finally{continueRetry.resolve();await Promise.allSettled([one,two]);await host.dispose();}
});
test('a later waiter starts independent work while an aborted flight is still settling',async()=>{
 const host=relayServiceHost(),finishOld=deferred<void>(),startedOld=deferred<void>(),startedNew=deferred<void>(),a=new AbortController();let calls=0;
 const execute=async(request:any)=>{
  const reused=await request.reuse(identity);if(reused!==undefined)return {kind:'reused',identity,value:reused};
  if(++calls===1){startedOld.resolve();await finishOld.promise;}else startedNew.resolve();
  return response(request.signal);
 };
 const one=host.call(input(execute,a.signal));const outcome=one.catch(error=>error);await startedOld.promise;a.abort(new Error('old cancelled'));
 const two=host.call(input(execute,new AbortController().signal));
 try{await startedNew.promise;expect(await two).toBe(payload);expect(calls).toBe(2);finishOld.resolve();expect(await outcome).toBeDefined();expect(host.transport.cache.status().entries).toBe(1);}
 finally{finishOld.resolve();await Promise.allSettled([one,two]);await host.dispose();}
});
