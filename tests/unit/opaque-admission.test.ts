import { test, expect, afterEach } from 'bun:test';
import { DataAdmissionHost } from '../../packages/core/src/data-admission/host';
import { WorkerRequestAdmission, setWorkerAdmissionSession } from '../../packages/core/src/data-admission/worker';
import { ANONYMOUS_PRINCIPAL } from '../../packages/core/src/plugin-extensions';
const worker={role:'worker' as const,master_generation:'g',process_instance_id:'p',boot_nonce:'b',worker_slot:0};
const target={requestId:'r',attemptId:'a',principal:ANONYMOUS_PRINCIPAL,routeId:'route',serviceId:null,upstreamId:'up',url:'http://provider/v1/chat/completions',model:null,now:Date.now()};
afterEach(()=>setWorkerAdmissionSession(null));
test('admission inspection authenticates and reports body demand without quota planning',async()=>{
  let plans=0;const host=new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> 'hash',loadPlugin:async()=>({createIngress:()=>({bodyRequirements:()=>({request:'json-read' as const}),plan(){plans++;return {snapshot:null};}})})});
  try {await host.publish({version:1,plugins:[{name:'budget',entry:'test',catalogHash:'hash',policy:null}]});for(let i=0;i<3;i++)expect(host.inspect(target,worker).requirements.budget.request).toBe('json-read');expect(plans).toBe(0);host.admit(target,worker);expect(plans).toBe(1);}finally{host.dispose();}
});
test('admission inspection fails closed for an unbound protected route',async()=>{
  const host=new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> 'hash'});try{await host.publish({version:1,plugins:[],routeRequirements:[{plugin:'access',routeIds:['route']}]});expect(()=>host.inspect(target,worker)).toThrow('route_protection_unavailable');}finally{host.dispose();}
});
test('no policy demand does not read the body; final target is admitted after inspection',async()=>{
  const operations:string[]=[];let reads=0;const grant={requestId:'r',principal:ANONYMOUS_PRINCIPAL,version:1,snapshots:{}};
  setWorkerAdmissionSession({admission:async(operation)=>{operations.push(operation);return operation==='inspect'?{policyVersion:1,requirements:{budget:{request:'none'}}}:grant;}});
  const admission=new WorkerRequestAdmission([],{requestId:'r',principal:ANONYMOUS_PRINCIPAL,routeId:'route',serviceId:null},async()=>{throw new Error('unexpected budget invocation');});
  await admission.prepare({attemptId:'a',upstreamId:'up',url:target.url,model:null,body:undefined},new AbortController().signal,async()=>{reads++;return {};});expect(reads).toBe(0);expect(operations).toEqual(['inspect','preview','admit']);
});
test('necessary budget view is read once and publication churn stops after three inspections',async()=>{
  let reads=0;let probes=0;setWorkerAdmissionSession({admission:async(operation)=>operation==='inspect'?{policyVersion:++probes,requirements:{budget:{request:'json-read'}}}:{requestId:'r',principal:ANONYMOUS_PRINCIPAL,version:probes+1,snapshots:{}}});
  const admission=new WorkerRequestAdmission([],{requestId:'r',principal:ANONYMOUS_PRINCIPAL,routeId:'route',serviceId:null},async()=>{throw new Error('unexpected budget invocation');});
  await expect(admission.prepare({attemptId:'a',upstreamId:'up',url:target.url,model:null,body:undefined},new AbortController().signal,async()=>{reads++;return {model:'test'};})).rejects.toMatchObject({code:'admission_publication_busy'});expect(reads).toBe(1);expect(probes).toBe(3);
});
