import {randomUUID} from 'node:crypto';
import {createGatewayHooks,runGatewayRequest} from '../../src/gateway/runtime';
import {getScopedPluginRegistry,setScopedPluginRegistry} from '../../src/scoped-plugin-registry';
import {setWorkerAdmissionSession} from '../../src/data-admission/worker';
import {generateWorkerTransportSecret,restoreWorkerTransportRequest} from '../../src/config-worker/private-transport';
import {privateRequestHeaders} from '../../src/public-listener/headers';
import {DataAdmissionError} from '../../src/data-admission/errors';
import type {RequestLoggerDependencies} from '../../src/logger/request-logger';
import type {DispatchRequestPreparationInput,DispatchRequestPreparationResult} from '../../src/gateway/contracts';

/** A real Gateway/HTTP fixture; admission RPC is deterministic and records all debits and settlements. */
export function gatewayPreparationFixture(options:{prepare:(input:DispatchRequestPreparationInput)=>Promise<DispatchRequestPreparationResult>;deniedRoute?:string;wsBudget?:boolean;upstream?:(request:Request)=>Promise<Response>|Response;credential?:string;logging?:RequestLoggerDependencies;bodyLogging?:boolean;admissionHost?:import('../../src/data-admission/host').DataAdmissionHost;dispatchModel?:string;onInspection?:(target:import('../../src/plugin-extensions').AdmissionTarget)=>Promise<void>}) {
  const previous=getScopedPluginRegistry();const hooks=createGatewayHooks();
  const calls:{path:string;body:any}[]=[];const operations:{operation:string;target:any}[]=[];
  const budgets:{requestId:string;attemptId:string}[]=[];const settlements:{requestId:string;sent:boolean;outcome:string}[]=[];
  let prepares=0;let dispatches=0;
  const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){calls.push({path:new URL(request.url).pathname,body:await request.clone().json()});return options.upstream?.(request)??Response.json({output:'auxiliary value',usage:{input_tokens:2,output_tokens:3}});}});
  const config:any={logging:options.bodyLogging?{body:{enabled:true,max_size:1024*1024,retention_days:1}}:{enabled:false},routes:[{id:'entry',path:'/entry',endpoints:[{id:'entry-up',target:`http://127.0.0.1:${upstream.port}`}]},
    ...['final','aux'].map(id=>({id,path:`/${id}`,path_rewrite:{[`^/${id}`]:''},endpoints:[{id:`${id}-up`,target:`http://127.0.0.1:${upstream.port}`}]}))]};
  const principal={domain:'data',keyId:'key',credentialVersion:1};
  const worker={role:'worker' as const,master_generation:randomUUID(),process_instance_id:randomUUID(),boot_nonce:randomUUID(),worker_slot:0};
  setWorkerAdmissionSession({admission:async(operation,payload:any)=>{operations.push({operation,target:payload});if(options.admissionHost){
    const host=options.admissionHost;
    if(operation==='inspect'){const result=host.inspect(payload,worker);await options.onInspection?.(payload);return result;}
    if(operation==='authorize')return host.authorize(payload.target,worker,payload.version);
    if(operation==='preview')return host.admit(payload,worker,true);
    if(operation==='admit')return host.admit(payload.target,worker,false,payload.version);
    if(operation==='attempt')return host.beforeAttempt(payload,worker);
    host.release(payload.requestId,worker);return null;
  }if(operation==='inspect'){
    if(payload.routeId===options.deniedRoute)throw new DataAdmissionError(403,'scope_denied');
    return {policyVersion:1,requirements:options.wsBudget?{fixture:{request:'json-read'}}:{}};
  }if(operation==='authorize')return {policyVersion:1};return {version:1,principal,snapshots:{fixture:{}}};}});
  const registry:any={getGatewayHooks:()=>hooks,getRoutePrecompiledHooks:()=>({hooks:{onDispatchRequest:{hasCallbacks:()=>true}}}),
    getDeclaredDispatchTargets:()=>[{type:'route',id:'final'},{type:'route',id:'aux'}],getRoutePluginOwners:()=>[],getPrecompiledHooks:()=>null,
    getGlobalAdmissionHandlers:()=>[{pluginName:'fixture',resolveAdmissionModel:({body}:any)=>body?.model??null,prepareAdmissionAttempt:async({target}:any)=>{
      budgets.push({requestId:target.requestId,attemptId:target.attemptId});return {onResult:async(result:any)=>{settlements.push({...result,requestId:target.requestId});}};
    }}],invokeAdmissionRpc:async()=>undefined,runWithRequestLeases:(_leases:any,run:any)=>run(),dispatchRequest:async(_route:any,input:any)=>{
      dispatches++;if(options.dispatchModel)input.context.body={...input.context.body,model:options.dispatchModel};return {target:{type:'route',id:'final'},prepareRequest:async(preparation:DispatchRequestPreparationInput)=>{prepares++;return options.prepare(preparation);}};
    }};
  setScopedPluginRegistry(registry);
  const secret=generateWorkerTransportSecret();
  const request=(signal?:AbortSignal)=>{
    const source=new Request('http://client/entry/responses',{method:'POST',headers:{'content-type':'application/json',...(options.credential?{authorization:options.credential}:{})},body:JSON.stringify({model:'main-model',input:'hello'}),signal});
    const transport=new Request(source.url,{method:'POST',headers:privateRequestHeaders(source,secret,'127.0.0.1',{requestId:randomUUID(),principal}),body:source.body,signal});
    const restored=restoreWorkerTransportRequest(transport,secret);if(!restored.ok)throw Error('trusted fixture request rejected');return restored.request;
  };
  return {calls,operations,budgets,settlements,get prepares(){return prepares;},get dispatches(){return dispatches;},
    send:(transport?:'websocket',signal?:AbortSignal)=>runGatewayRequest(request(signal),config,{servingRevision:1,transport,logging:options.logging}),
    config,request,async close(){setWorkerAdmissionSession(null);setScopedPluginRegistry(previous);upstream.stop(true);}};
}

/** Isolated worker module instances validate projection independence from process-local state. */
export async function credentialIdentityFromWorker(input:{headers:Record<string,string>;model:string;upstreamId:string;managedCredentials?:string[]}):Promise<import('../../src/gateway/contracts').GatewayAuxiliaryIdentity> {
  const worker=new Worker(new URL('../fixtures/auxiliary-identity-worker.ts',import.meta.url).href);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{return await new Promise((resolve,reject)=>{
    timeout=setTimeout(()=>reject(new Error('Credential identity worker timed out')),5000);
    worker.onmessage=event=>resolve(event.data);
    worker.onerror=event=>reject(new Error(event.message));
    worker.postMessage(input);
  });}finally{if(timeout)clearTimeout(timeout);await worker.terminate();}
}
