import {expect,test} from 'bun:test';
import {AgentRelay} from '../../server/relay';
import {RELAY_TOOL} from '../../server/relay-response';
import {historyClient} from '../../contract';
import {HistoryTransport} from '../../server/history';

function fixture(){const transport=new HistoryTransport();return {transport,history:historyClient({get:async(input:any)=>transport.get(input),put:async(input:any)=>transport.put(input)})};}
function request(executeAuxiliary:any,signal=new AbortController().signal):any{return {message:{type:'agent_message',author:'a',recipient:'b',content:[{type:'encrypted_content',encrypted_content:'cipher'}]},contentIndex:0,param:'input[0].content[0].encrypted_content',relay:{target:{type:'route',id:'relay',protocol:'responses'},model:'configured'},entryScope:'entry-revision',scope:'trusted-entry-revision',requestId:'request',signal,executeAuxiliary};}
function executor(options:{account?:string|null; model?:string; status?:number; gate?:Promise<void>}={}){
 const identity={scope:options.account===undefined?'account':options.account,model:options.model??'actual',upstreamId:'upstream'};
 const state={wire:0,requests:[] as any[],signals:[] as AbortSignal[]};
 const execute=async(input:any)=>{state.requests.push(input);const cached=await input.reuse?.(identity);if(cached!==undefined)return {kind:'reused',value:cached,identity};state.wire++;state.signals.push(input.signal);if(options.gate)await Promise.race([options.gate,new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}))]);return {kind:'response',identity,status:options.status??200,requestId:'aux',bodyHandle:{identity:{contentType:'application/json'},json:async()=>({status:'completed',output:[{type:'function_call',name:RELAY_TOOL,status:'completed',arguments:JSON.stringify({payload:'中文完整正文\n\\"🙂'})}]}),maxBytes:1024*1024},completion:Promise.resolve({status:'completed'}),dispose(){}};};
 return {state,execute};
}
test('completed cache crosses workers but isolates account, entry/revision, actual model and ciphertext',async()=>{
 const {history}=fixture(), first=new AgentRelay(history), second=new AgentRelay(history), wire=executor();
 expect(await first.relay(request(wire.execute))).toBe('中文完整正文\n\\"🙂');await second.relay(request(wire.execute));expect(wire.state.wire).toBe(1);
 for(const changed of [request(executor({account:'other'}).execute),{...request(wire.execute),scope:'other-entry'},request(executor({model:'other'}).execute),{...request(wire.execute),message:{type:'agent_message',content:[{type:'encrypted_content',encrypted_content:'other'}]}}])await second.relay(changed);
 expect(wire.state.wire).toBe(3);first.dispose();second.dispose();
});
test('anonymous HTTP or unknown account never share a cache',async()=>{
 const {history}=fixture(), relay=new AgentRelay(history), a=executor(), b=executor({account:null});
 await relay.relay({...request(a.execute),scope:null});await relay.relay({...request(a.execute),scope:null});expect(a.state.wire).toBe(2);
 await relay.relay(request(b.execute));await relay.relay(request(b.execute));expect(b.state.wire).toBe(2);relay.dispose();
});
test('anonymous WebSocket reuses only its host connection and drops payloads on disconnect',async()=>{
 const {history,transport}=fixture(),relay=new AgentRelay(history),wire=executor({account:null}),connection=new AbortController(),other=new AbortController();
 const req={...request(wire.execute),scope:null,webSocketConnection:{id:'host-connection',signal:connection.signal}};
 await relay.relay(req);await relay.relay(req);expect(wire.state.wire).toBe(1);expect(transport.cache.status().entries).toBe(0);
 await relay.relay({...req,webSocketConnection:{id:'other-connection',signal:other.signal}});expect(wire.state.wire).toBe(2);
 connection.abort();await expect(relay.relay(req)).rejects.toBeDefined();
 const resumed=new AbortController();await relay.relay({...req,webSocketConnection:{id:'host-connection',signal:resumed.signal}});expect(wire.state.wire).toBe(3);relay.dispose();
});
test('coalescing keeps one native call and cancelling one waiter preserves the other',async()=>{
 const {history}=fixture(), relay=new AgentRelay(history);let finish!:()=>void;const wire=executor({gate:new Promise<void>(resolve=>finish=resolve)}),a=new AbortController(),b=new AbortController();
 const one=relay.relay(request(wire.execute,a.signal)),two=relay.relay(request(wire.execute,b.signal));
 await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 a.abort(new Error('first cancelled'));expect(a.signal.aborted).toBe(true);expect(wire.state.signals[0]?.aborted).toBe(false);
 finish();await expect(one).rejects.toThrow('first cancelled');expect(await two).toBe('中文完整正文\n\\"🙂');expect(wire.state.wire).toBe(1);relay.dispose();
});
test('last waiter and service disposal cancel owned work without storing success',async()=>{
 for(const dispose of [false,true]){const {history,transport}=fixture(),relay=new AgentRelay(history),wire=executor({gate:new Promise(()=>{})}),controller=new AbortController();const work=relay.relay(request(wire.execute,controller.signal));
  await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  if(dispose)relay.dispose();else controller.abort(new Error('cancelled'));
  await expect(work).rejects.toBeDefined();expect(wire.state.signals[0]?.aborted).toBe(true);expect(transport.cache.status().entries).toBe(0);relay.dispose();
 }
});
test('429 uses a distinct bounded sixty second account and target cooldown across different tasks',async()=>{
 const {history,transport}=fixture();let now=0;const relay=new AgentRelay(history,()=>now),wire=executor({status:429});
 await expect(relay.relay(request(wire.execute))).rejects.toMatchObject({status:429});await expect(relay.relay(request(wire.execute))).rejects.toMatchObject({status:429,code:'llm_adapter_relay_backoff'});expect(wire.state.wire).toBe(1);expect(transport.cache.status().entries).toBe(0);
 const another={...request(wire.execute),message:{type:'agent_message',content:[{type:'encrypted_content',encrypted_content:'different-task'}]}};
 await expect(relay.relay(another)).rejects.toMatchObject({code:'llm_adapter_relay_backoff'});expect(wire.state.wire).toBe(1);
 const otherAccount=executor({account:'other',status:429});await expect(relay.relay(request(otherAccount.execute))).rejects.toMatchObject({status:429,code:'llm_adapter_relay_upstream_failed'});expect(otherAccount.state.wire).toBe(1);
 now=59_000;await expect(relay.relay(request(wire.execute))).rejects.toMatchObject({code:'llm_adapter_relay_backoff'});
 now=60_000;await expect(relay.relay(request(wire.execute))).rejects.toMatchObject({status:429});expect(wire.state.wire).toBe(2);relay.dispose();
});
test('native relay request contains exactly the individual agent message and forced nonexecuting tool',async()=>{
 const relay=new AgentRelay(),wire=executor(),input=request(wire.execute);await relay.relay(input);
 expect(wire.state.requests[0].body).toMatchObject({input:[input.message],model:'configured',stream:true,store:false,tool_choice:{type:'function',name:RELAY_TOOL},tools:[{type:'function',name:RELAY_TOOL,strict:true,parameters:{required:['payload'],additionalProperties:false}}]});expect(wire.state.requests[0].body.tools).toHaveLength(1);relay.dispose();
});
