import {PluginServiceHost} from '../../packages/core/src/plugin-services';
import type {RpcEndpointHandle} from '../../packages/core/src/plugin-services/rpc-runtime';
import {CONVERSION_SERVICE_ID,CONVERSION_VERSION,historyClient,historyRpc,type ConversionService} from '../../plugins/llm-protocol-adapter/contract';
import {conversionService} from '../../plugins/llm-protocol-adapter/server/service';
import {HistoryTransport} from '../../plugins/llm-protocol-adapter/server/history';

/** Real worker service facade and self-history RPC over a host-owned in-memory transport. */
export function relayServiceHost(catalog:any={model:()=>null}){
 const plugin='llm-protocol-adapter',transport=new HistoryTransport(),purposes:string[]=[];
 const declarations=new Map([
  ['models-dev',{provides:[{id:'models-dev.capabilities.v1',version:1,process:'worker',kind:'local'}]}],
  [plugin,{provides:[{id:CONVERSION_SERVICE_ID,version:1,process:'worker',kind:'local'},{id:historyRpc.id,version:1,process:'control',kind:'rpc'}],consumes:[{plugin,id:historyRpc.id,version:1,process:'worker',kind:'rpc'},{plugin:'models-dev',id:'models-dev.capabilities.v1',version:1,process:'worker',kind:'local'}]}],
  ['router',{consumes:[{plugin,id:CONVERSION_SERVICE_ID,version:1,process:'worker',kind:'local'}]}]
 ]) as any;
 const identity=(process:string)=>(subject:string,scope:string)=>({endpoint:`${process}:${subject}:${scope}`,instance:process,generation:1,catalog:'fixture',subject});
 const control:PluginServiceHost=new PluginServiceHost('control',{identity:identity('control'),resolvePlacement:()=>null,resolveCallee:()=>control.currentInvocation()?.callee??null,resolveJournal:()=>null});
 control.setDeclarations(declarations);const controlProvider=control.createContext(plugin);
 controlProvider.rpc!.publish(historyRpc,{get:input=>transport.get(input),put:input=>transport.put(input)});control.markReady(plugin);
 let endpoint!:RpcEndpointHandle;
 const worker:PluginServiceHost=new PluginServiceHost('worker',{identity:identity('worker'),resolvePlacement:()=>({kind:'endpoint',endpoint}),resolveCallee:()=>worker.currentInvocation()?.callee??null,resolveJournal:()=>null});
 worker.setDeclarations(declarations);
 const modelProvider=worker.createContext('models-dev');modelProvider.publish('models-dev.capabilities.v1',1,catalog);worker.markReady('models-dev');
 const provider=worker.createContext(plugin,'global',{'models-dev':'*'});
 const remote=control.rpc!.createRemoteCaller({token:{},plugin,scope:'global',declarations:declarations.get(plugin),dependencies:{},process:'worker',lifecycle:identity('worker')(plugin,'global'),getLifecycleState:()=>({ready:worker.isReady(plugin),retiring:false,revoked:false}),acquireLease:()=>({release:worker.acquireLease(plugin)}),resolveInvocationContext:()=>null,authorizeIncoming:()=>true});
 endpoint=worker.rpc!.runtime.registerProxy({provider:plugin,contract:historyRpc,binding:{...identity('control')(plugin,'global'),process:'control',scope:'global'},execute:request=>{
  purposes.push(request.context.purpose);
  return remote.invokeTracked({target:{provider:plugin,service:historyRpc.id,major:1,method:request.method},input:request.input,purpose:request.context.purpose,signal:request.context.signal,...(request.context.operationId?{operationId:request.context.operationId}:{}),...(request.commandAction?{commandAction:request.commandAction}:{})});
 }});worker.rpc!.runtime.markReady(endpoint);
 const service=conversionService(provider.consume<any>('models-dev','models-dev.capabilities.v1',1),true,historyClient(provider.rpc!.consume(plugin,historyRpc)),provider.runBackground!.bind(provider));
 provider.publish(CONVERSION_SERVICE_ID,CONVERSION_VERSION,service);provider.onDispose(()=>service.dispose());worker.markReady(plugin);
 const router=worker.createContext('router','route:entry',{[plugin]:'*'});worker.markReady('router','route:entry');
 const facade=router.consume<ConversionService>(plugin,CONVERSION_SERVICE_ID,CONVERSION_VERSION);
 const call=(input:any)=>{const release=worker.acquireLease('router','route:entry');return worker.runInInvocation(router,{purpose:'request',callee:{},signal:input.signal,lease:release},()=>facade.relayAgentMessage(input)).finally(release);};
 return {worker,provider,facade,service,transport,purposes,call,async dispose(){service.dispose();await worker.dispose('router','route:entry');await worker.dispose(plugin);await worker.dispose('models-dev');await remote.dispose();await worker.rpc!.dispose();await control.dispose(plugin);await control.rpc!.dispose();transport.clear();}};
}
