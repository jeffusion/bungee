import { afterEach, expect, test } from 'bun:test';
import { WorkerRequestAdmission, setWorkerAdmissionSession } from '../../../src/data-admission/worker';
const base={requestId:'req',principal:{domain:'data',keyId:'key',credentialVersion:1},routeId:'route',serviceId:null};
const input={attemptId:'attempt',upstreamId:'up',url:'https://api.openai.com/v1/responses',model:null,body:undefined,transport:'websocket' as const};
afterEach(()=>setWorkerAdmissionSession(null));
test('WebSocket with effective Token budget fails before preview, debit or upstream connection',async()=>{
  const calls:string[]=[];
  setWorkerAdmissionSession({admission:async operation=>{calls.push(operation);return {policyVersion:1,requirements:{'token-budget':{request:'json-read'}}};}});
  const admission=new WorkerRequestAdmission([],base,async()=>{throw Error('unexpected budget call');});
  await expect(admission.prepare(input,new AbortController().signal)).rejects.toMatchObject({status:422,code:'websocket_budget_unsupported'});
  expect(calls).toEqual(['inspect']);
});
test('unbudgeted WebSocket uses signed admission and releases the original grant',async()=>{
  const calls:string[]=[];
  setWorkerAdmissionSession({admission:async operation=>{calls.push(operation);return operation==='inspect'?{policyVersion:1,requirements:{}}:{version:1,principal:base.principal,snapshots:{}};}});
  const admission=new WorkerRequestAdmission([],base,async()=>undefined);
  await admission.prepare(input,new AbortController().signal);await admission.release();
  expect(calls).toEqual(['inspect','preview','admit','release']);
});
test('WS generation cannot enable unsupported hard budgets by supplying JSON',async()=>{
  const calls:string[]=[];
  setWorkerAdmissionSession({admission:async operation=>{calls.push(operation);return {policyVersion:1,requirements:{'token-budget':{request:'json-read'}}};}});
  const admission=new WorkerRequestAdmission([],base,async()=>{throw Error('unexpected budget call');});
  await expect(admission.prepare({...input,model:'external',body:{model:'external',input:'hello'}},new AbortController().signal)).rejects.toMatchObject({status:422,code:'websocket_budget_unsupported'});
  expect(calls).toEqual(['inspect']);
});
test('preparation inspection checks effective WS budget without creating grant or invoking budget hooks',async()=>{
  const calls:string[]=[];
  setWorkerAdmissionSession({admission:async operation=>{calls.push(operation);return {policyVersion:1,requirements:{budget:{request:'json-read'}}};}});
  const admission=new WorkerRequestAdmission([{pluginName:'budget',prepareAdmissionAttempt:async()=>{throw Error('must not reserve');}}],base,async()=>{throw Error('must not debit');});
  await expect(admission.inspect({...input,body:{model:'m'}},new AbortController().signal)).rejects.toMatchObject({status:422,code:'websocket_budget_unsupported'});
  await admission.release();expect(calls).toEqual(['inspect']);
});
test('inspection propagates access denial without planning or granting',async()=>{
  const {DataAdmissionError}=await import('../../../src/data-admission/errors');
  const calls:string[]=[];
  setWorkerAdmissionSession({admission:async operation=>{calls.push(operation);throw new DataAdmissionError(403,'scope_denied');}});
  const admission=new WorkerRequestAdmission([],base,async()=>undefined);
  await expect(admission.inspect(input,new AbortController().signal)).rejects.toMatchObject({status:403,code:'scope_denied'});
  await admission.release();expect(calls).toEqual(['inspect']);
});
test('access-only inspection authorizes the resolved model at the inspected version without budget or grant',async()=>{
  const calls:{operation:string;payload:any}[]=[];
  setWorkerAdmissionSession({admission:async(operation,payload)=>{
    calls.push({operation,payload});return operation==='inspect'?{policyVersion:7,requirements:{}}:{policyVersion:7};
  }});
  const admission=new WorkerRequestAdmission([{pluginName:'model',resolveAdmissionModel:()=> 'mapped-model',prepareAdmissionAttempt:async()=>{throw Error('budget must not run');}}],base,async()=>{throw Error('budget RPC must not run');});
  await admission.inspect({...input,model:'client-model'},new AbortController().signal);
  await admission.release();
  expect(calls.map(call=>call.operation)).toEqual(['inspect','authorize']);
  expect(calls[0].payload.model).toBe('mapped-model');
  expect(calls[1].payload).toMatchObject({version:7,target:{model:'mapped-model',routeId:base.routeId}});
});
