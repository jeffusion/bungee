async function expectRejected(operation:Promise<unknown>,message?:string){let error:unknown;try{await operation;}catch(value){error=value;}expect(error).toBeInstanceOf(Error);if(message)expect((error as Error).message).toContain(message);}
import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../packages/core/src/plugin-durable-state';
import {setPolicy,readKey,stateRpc,recoverUsage,publication} from '../server/ledger';
import {createIngress} from '../server/policy';

test('offline unresolved recovery applies original-month delta once, preserves evidence and rejects conflicts',async ()=>{
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 try {
  const state=new PluginDurableStateStore(db).forNamespace('token-budget');
  const target={requestId:'r',attemptId:'a',principal:{domain:'data' as const,keyId:'k',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now:Date.UTC(2026,0,31)};
  (await setPolicy(state,'k',{mode:'monthly',limit:100}));const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;
  (await stateRpc('prepare',{snapshot},{state,...target}));
  const result={requestId:'r',attemptId:'a',inputTokens:5,inputSource:'estimated',outputSource:'none',settlementVersion:1,complete:false,observationIncomplete:true};
  (await stateRpc('settle',{result},{state,...target}));expect((await readKey(state,'k')).cumulative).toBe(5);
  const input={keyId:'k',requestId:'r',attemptId:'a',inputTokens:7,outputTokens:9,reason:'Confirmed provider invoice'};
  await expectRejected(recoverUsage({...input,keyId:'wrong'},{durableState:state}), 'id_conflict');
  (await recoverUsage(input,{durableState:state}));expect((await readKey(state,'k'))).toMatchObject({cumulative:16,monthly:{'2026-01':16},unresolved:{}});
  expect((await recoverUsage(input,{durableState:state}))).toEqual({recovered:true,alreadyApplied:true});
  await expectRejected(recoverUsage({...input,outputTokens:10},{durableState:state}), 'recovery_conflict');
  const audit=(await state.list()).find(r=>r.key.startsWith('recovery:'))!.value as any;
  expect(audit).toMatchObject({reason:input.reason,delta:11,month:'2026-01',previous:{status:'unknown',input:5,output:0}});
  await expectRejected(stateRpc('settle',{result:{...result,settlementVersion:2}},{state,...target}), 'recovered_attempt');
  await expectRejected(recoverUsage({...input,inputTokens:-1},{durableState:state}));
  await expectRejected(recoverUsage({...input,unexpected:true},{durableState:state}));
 }finally{db.close();}
});
