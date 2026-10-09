import { afterEach, expect, test } from 'bun:test';
import { WorkerRequestAdmission, setWorkerAdmissionSession } from '../../src/data-admission/worker';
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
