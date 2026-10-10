async function expectRejected(operation:Promise<unknown>,message?:string){let error:unknown;try{await operation;}catch(value){error=value;}expect(error).toBeInstanceOf(Error);if(message)expect((error as Error).message).toContain(message);}
import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../../packages/core/src/plugin-durable-state';
import {readKey,readUsage,keyRecord,setPolicy,stateRpc,publication,recoverPending,recoverUsage} from '../../server/ledger';
import {createIngress,utcDay,utcWeek,validatePolicy,usdToNanoUsd} from '../../server/policy';
const dbs:Database[]=[],dirs:string[]=[];afterEach(()=>{for(const db of dbs.splice(0))try{db.close()}catch{};for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(path=':memory:'){const db=new Database(path);dbs.push(db);db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);return {db,state:new PluginDurableStateStore(db).forNamespace('token-budget')};}
function target(requestId='r',now=Date.UTC(2026,1,1,23,59,59)){return {requestId,attemptId:requestId+'a',principal:{domain:'data' as const,keyId:'k',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now};}
function result(t:ReturnType<typeof target>,input=1,output=2,version=1){return {requestId:t.requestId,attemptId:t.attemptId,inputTokens:input,outputTokens:output,inputSource:'official',outputSource:'official',settlementVersion:version,complete:true,observationIncomplete:false};}
async function prepare(state:any,t=target()){const snapshot=createIngress().plan(t,(await publication(state)).value,null).snapshot!;(await stateRpc('prepare',{snapshot},{state,...t}));return snapshot;}
test('UTC day/month/year and Monday week boundary, fixed snapshot survives late settlement and policy/unit changes',async ()=>{
 expect(utcDay(Date.UTC(2026,0,1)-1)).toBe('2025-12-31');expect(utcWeek(Date.UTC(2026,0,1))).toBe('2025-12-29');expect(utcWeek(Date.UTC(2026,1,1,23,59))).toBe('2026-01-26');expect(utcWeek(Date.UTC(2026,1,2))).toBe('2026-02-02');
 const {state}=setup(),t=target();(await setPolicy(state,'k',{mode:'weekly',limit:3}));const snapshot=(await prepare(state,t));
 (await setPolicy(state,'k',{mode:'daily',unit:'usd',limit:1}));(await stateRpc('settle',{result:{...result(t),finishedAtMs:Date.UTC(2026,1,2)},costNanoUsd:1000},{state,...t}));
 expect(snapshot).toMatchObject({day:'2026-02-01',week:'2026-01-26',month:'2026-02'});
 expect((await readKey(state,'k'))).toMatchObject({cumulative:3,daily:{'2026-02-01':3},weekly:{'2026-01-26':3},monthly:{'2026-02':3},money:{cumulativeNanoUsd:1000,dailyNanoUsd:{'2026-02-01':1000},weeklyNanoUsd:{'2026-01-26':1000},monthlyNanoUsd:{'2026-02':1000}}});
 (await setPolicy(state,'k',{mode:'weekly',limit:3}));expect(createIngress().plan(t,(await publication(state)).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('next',Date.UTC(2026,1,2)),(await publication(state)).value,null).denial).toBeUndefined();
 (await setPolicy(state,'k',{mode:'daily',limit:3}));expect(createIngress().plan(t,(await publication(state)).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('next',Date.UTC(2026,1,2)),(await publication(state)).value,null).denial).toBeUndefined();
});
test('USD accepts six decimals, rejects invalid amounts, integer additions and revised settlements are exact and idempotent',async ()=>{
 expect(validatePolicy({mode:'daily',unit:'usd',limit:0.000001})).toEqual({mode:'daily',unit:'usd',limit:0.000001});expect(usdToNanoUsd(0.1)).toBe(100000000);
 for(const limit of [0,-1,NaN,Infinity,0.0000001,1.1234567,1e12])expect(()=>validatePolicy({mode:'weekly',unit:'usd',limit})).toThrow();
 expect(validatePolicy({mode:'monthly',limit:3})).toEqual({mode:'monthly',limit:3});expect(()=>validatePolicy({mode:'monthly',unit:'eur',limit:1})).toThrow();
 const {state}=setup();(await setPolicy(state,'k',{mode:'cumulative',unit:'usd',limit:0.3}));
 for(let i=0;i<3;i++){const t=target('r'+i);(await prepare(state,t));(await stateRpc('settle',{result:result(t),costNanoUsd:100000000},{state,...t}));}
 expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(300000000);expect(createIngress().plan(target('next'),(await publication(state)).value,null).denial?.status).toBe(429);
 const t=target('r0'),ctx={state,...t},revision={result:result(t,1,1,2),costNanoUsd:50000000};(await stateRpc('settle',revision,ctx));(await stateRpc('settle',revision,ctx));
 expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(250000000);expect((await readKey(state,'k')).cumulative).toBe(8);
 await expectRejected(stateRpc('settle',{...revision,costNanoUsd:2},ctx), 'id_conflict');
 await expectRejected(stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:1.2},ctx), 'invalid_cost');
 await expectRejected(stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:-1},ctx), 'invalid_cost');
 (await stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:null},ctx));expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(250000000);expect(createIngress().plan(target('next'),(await publication(state)).value,null).denial?.error).toBe('token-budget.cost_unknown');
 (await stateRpc('settle',{result:result(t,1,1,4),costNanoUsd:40000000},ctx));expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(240000000);
});
test('price unknown never disables Token, unit switch blocks USD and unsent cancellation bills neither unit',async ()=>{
 const {state}=setup(),t=target();(await setPolicy(state,'k',{mode:'daily',limit:100}));(await prepare(state,t));(await stateRpc('settle',{result:result(t),costNanoUsd:null},{state,...t}));
 expect(createIngress().plan(target('next'),(await publication(state)).value,null).denial).toBeUndefined();expect((await readUsage(state,'k')).attempts[0]).toMatchObject({costStatus:'unknown',costNanoUsd:null,status:'settled'});
 (await setPolicy(state,'k',{mode:'cumulative',unit:'usd',limit:1}));expect(createIngress().plan(target('next'),(await publication(state)).value,null).denial?.status).toBe(503);
 (await recoverUsage({keyId:'k',requestId:t.requestId,attemptId:t.attemptId,costUsd:0.123456,reason:'Provider invoice'},{durableState:state}));expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(123456000);expect((await readKey(state,'k')).cumulative).toBe(3);
 const cancel=target('cancel');(await prepare(state,cancel));(await stateRpc('cancel',{sent:false},{state,...cancel}));expect((await readKey(state,'k')).money.cumulativeNanoUsd).toBe(123456000);expect((await readKey(state,'k')).money.unresolved).toEqual({});
 const audit=(await state.list()).find(r=>r.key.startsWith('recovery-cost:'))!.value as any;expect(audit).toMatchObject({deltaNanoUsd:123456000,reason:'Provider invoice',previous:{costStatus:'unknown'}});
});
test('cold SQLite reopen preserves balances and unknown axes; Token-only recovery cannot clear money unknown',async ()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-money-'));dirs.push(dir);const path=join(dir,'state.db'),{db,state}=setup(path),t=target();(await setPolicy(state,'k',{mode:'monthly',limit:100}));(await prepare(state,t));db.close();
 const reopenedDb=new Database(path);dbs.push(reopenedDb);const reopened=new PluginDurableStateStore(reopenedDb).forNamespace('token-budget');(await recoverPending(reopened));expect((await readUsage(reopened,'k')).attempts[0]).toMatchObject({status:'unknown',costStatus:'unknown'});
 (await recoverUsage({keyId:'k',requestId:t.requestId,attemptId:t.attemptId,inputTokens:4,outputTokens:5,reason:'usage invoice'},{durableState:reopened}));expect((await readKey(reopened,'k')).cumulative).toBe(9);expect((await readKey(reopened,'k')).unresolved).toEqual({});expect(Object.values((await readKey(reopened,'k')).money.unresolved)).toEqual(['unknown']);
 (await setPolicy(reopened,'k',{mode:'monthly',unit:'usd',limit:1}));expect(createIngress().plan(target('next'),(await publication(reopened)).value,null).denial?.status).toBe(503);
 const input={keyId:'k',requestId:t.requestId,attemptId:t.attemptId,costUsd:0.01,reason:'price invoice'};(await recoverUsage(input,{durableState:reopened}));expect((await recoverUsage(input,{durableState:reopened}))).toEqual({recovered:true,alreadyApplied:true});expect((await readKey(reopened,'k')).money.cumulativeNanoUsd).toBe(10000000);
 await expectRejected(recoverUsage({...input,costUsd:0.02},{durableState:reopened}), 'recovery_conflict');
});
test('legacy month/cumulative records and in-flight grants remain compatible without invented daily, weekly or monetary history',async ()=>{
 const {state}=setup();(await state.transact([{key:keyRecord('k'),expectedVersion:0,value:{keyId:'k',ledger:{policy:{mode:'monthly',limit:100},cumulative:40,monthly:{'2026-01':40},unresolved:{}}}}]));
 const prior=(await readKey(state,'k'));expect(prior).toMatchObject({cumulative:40,daily:{},weekly:{},money:{cumulativeNanoUsd:0},collection:{dailyWeeklyStartedAtMs:null,moneyStartedAtMs:null,legacyTokensExcluded:true}});
 const t=target(),snapshot={keyId:'k',requestId:t.requestId,month:'2026-02',policy:{mode:'monthly',limit:100},version:0};(await stateRpc('prepare',{snapshot},{state,...t}));(await stateRpc('settle',{result:result(t),costNanoUsd:1000},{state,...t}));
 expect((await readKey(state,'k'))).toMatchObject({cumulative:43,monthly:{'2026-01':40,'2026-02':3},daily:{},weekly:{},money:{cumulativeNanoUsd:1000,monthlyNanoUsd:{'2026-02':1000},dailyNanoUsd:{},weeklyNanoUsd:{}}});
 (await setPolicy(state,'k',{mode:'daily',limit:100}));const next=target('new');(await prepare(state,next));(await stateRpc('settle',{result:result(next),costNanoUsd:2000},{state,...next}));expect((await readKey(state,'k')).daily).toEqual({'2026-02-01':3});expect((await readKey(state,'k')).collection.dailyWeeklyStartedAtMs).toBeNumber();
});
test('late monthly USD settlement and revision debit the original month after next-month admission',async ()=>{
 const {state}=setup(),t=target('month-end',Date.UTC(2026,0,31,23,59,59));(await setPolicy(state,'k',{mode:'monthly',unit:'usd',limit:0.000001}));(await prepare(state,t));
 (await stateRpc('settle',{result:{...result(t),finishedAtMs:Date.UTC(2026,1,1)},costNanoUsd:1000},{state,...t}));expect((await readKey(state,'k')).money.monthlyNanoUsd).toEqual({'2026-01':1000});
 expect(createIngress().plan(t,(await publication(state)).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('feb',Date.UTC(2026,1,1)),(await publication(state)).value,null).denial).toBeUndefined();
 (await stateRpc('settle',{result:{...result(t,1,1,2),finishedAtMs:Date.UTC(2026,2,1)},costNanoUsd:500},{state,...t}));expect((await readKey(state,'k')).money.monthlyNanoUsd).toEqual({'2026-01':500});expect((await readKey(state,'k')).monthly).toEqual({'2026-01':2});
});
test('actual legacy attempt records replay without price fields and accept higher settlement versions without rebuilding history',async()=>{
 const {createHash}=await import('node:crypto'),{state}=setup(),t=target('old'),snapshot={keyId:'k',requestId:t.requestId,month:'2026-02',policy:{mode:'monthly',limit:100},version:0};
 const recordId=(kind:string,attemptId='')=>kind+':'+createHash('sha256').update(JSON.stringify([t.requestId,attemptId])).digest('hex'),oldResult=result(t);
 (await state.transact([
  {key:keyRecord('k'),expectedVersion:0,value:{keyId:'k',ledger:{policy:snapshot.policy,cumulative:43,monthly:{'2026-01':40,'2026-02':3},unresolved:{}}}},
  {key:recordId('request'),expectedVersion:0,value:snapshot},
  {key:recordId('attempt',t.attemptId),expectedVersion:0,value:{keyId:'k',requestId:t.requestId,attemptId:t.attemptId,snapshot,status:'settled',input:1,output:2,inputSource:'official',outputSource:'official',settlementVersion:1,resultFingerprint:createHash('sha256').update(JSON.stringify(oldResult)).digest('hex'),partial:false}},
 ]));
 expect((await readUsage(state,'k')).attempts[0]).toMatchObject({costStatus:'untracked',day:null,week:null});(await stateRpc('prepare',{snapshot},{state,...t}));(await stateRpc('settle',{result:oldResult},{state,...t}));expect((await readKey(state,'k')).cumulative).toBe(43);
 (await stateRpc('settle',{result:result(t,1,1,2),costNanoUsd:1000},{state,...t}));expect((await readKey(state,'k'))).toMatchObject({cumulative:42,daily:{},weekly:{},monthly:{'2026-01':40,'2026-02':2},money:{cumulativeNanoUsd:1000,dailyNanoUsd:{},weeklyNanoUsd:{},monthlyNanoUsd:{'2026-02':1000}}});
});
