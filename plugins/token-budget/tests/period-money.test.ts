import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../packages/core/src/plugin-durable-state';
import {readKey,readUsage,keyRecord,setPolicy,stateRpc,publication,recoverPending,recoverUsage} from '../server/ledger';
import {createIngress,utcDay,utcWeek,validatePolicy,usdToNanoUsd} from '../server/policy';
const dbs:Database[]=[],dirs:string[]=[];afterEach(()=>{for(const db of dbs.splice(0))try{db.close()}catch{};for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(path=':memory:'){const db=new Database(path);dbs.push(db);db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);return {db,state:new PluginDurableStateStore(db).forNamespace('token-budget')};}
function target(requestId='r',now=Date.UTC(2026,1,1,23,59,59)){return {requestId,attemptId:requestId+'a',principal:{domain:'data' as const,keyId:'k',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now};}
function result(t:ReturnType<typeof target>,input=1,output=2,version=1){return {requestId:t.requestId,attemptId:t.attemptId,inputTokens:input,outputTokens:output,inputSource:'official',outputSource:'official',settlementVersion:version,complete:true,observationIncomplete:false};}
function prepare(state:any,t=target()){const snapshot=createIngress().plan(t,publication(state).value,null).snapshot!;stateRpc('prepare',{snapshot},{state,...t});return snapshot;}
test('UTC day/month/year and Monday week boundary, fixed snapshot survives late settlement and policy/unit changes',()=>{
 expect(utcDay(Date.UTC(2026,0,1)-1)).toBe('2025-12-31');expect(utcWeek(Date.UTC(2026,0,1))).toBe('2025-12-29');expect(utcWeek(Date.UTC(2026,1,1,23,59))).toBe('2026-01-26');expect(utcWeek(Date.UTC(2026,1,2))).toBe('2026-02-02');
 const {state}=setup(),t=target();setPolicy(state,'k',{mode:'weekly',limit:3});const snapshot=prepare(state,t);
 setPolicy(state,'k',{mode:'daily',unit:'usd',limit:1});stateRpc('settle',{result:{...result(t),finishedAtMs:Date.UTC(2026,1,2)},costNanoUsd:1000},{state,...t});
 expect(snapshot).toMatchObject({day:'2026-02-01',week:'2026-01-26',month:'2026-02'});
 expect(readKey(state,'k')).toMatchObject({cumulative:3,daily:{'2026-02-01':3},weekly:{'2026-01-26':3},monthly:{'2026-02':3},money:{cumulativeNanoUsd:1000,dailyNanoUsd:{'2026-02-01':1000},weeklyNanoUsd:{'2026-01-26':1000},monthlyNanoUsd:{'2026-02':1000}}});
 setPolicy(state,'k',{mode:'weekly',limit:3});expect(createIngress().plan(t,publication(state).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('next',Date.UTC(2026,1,2)),publication(state).value,null).denial).toBeUndefined();
 setPolicy(state,'k',{mode:'daily',limit:3});expect(createIngress().plan(t,publication(state).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('next',Date.UTC(2026,1,2)),publication(state).value,null).denial).toBeUndefined();
});
test('USD accepts six decimals, rejects invalid amounts, integer additions and revised settlements are exact and idempotent',()=>{
 expect(validatePolicy({mode:'daily',unit:'usd',limit:0.000001})).toEqual({mode:'daily',unit:'usd',limit:0.000001});expect(usdToNanoUsd(0.1)).toBe(100000000);
 for(const limit of [0,-1,NaN,Infinity,0.0000001,1.1234567,1e12])expect(()=>validatePolicy({mode:'weekly',unit:'usd',limit})).toThrow();
 expect(validatePolicy({mode:'monthly',limit:3})).toEqual({mode:'monthly',limit:3});expect(()=>validatePolicy({mode:'monthly',unit:'eur',limit:1})).toThrow();
 const {state}=setup();setPolicy(state,'k',{mode:'cumulative',unit:'usd',limit:0.3});
 for(let i=0;i<3;i++){const t=target('r'+i);prepare(state,t);stateRpc('settle',{result:result(t),costNanoUsd:100000000},{state,...t});}
 expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(300000000);expect(createIngress().plan(target('next'),publication(state).value,null).denial?.status).toBe(429);
 const t=target('r0'),ctx={state,...t},revision={result:result(t,1,1,2),costNanoUsd:50000000};stateRpc('settle',revision,ctx);stateRpc('settle',revision,ctx);
 expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(250000000);expect(readKey(state,'k').cumulative).toBe(8);
 expect(()=>stateRpc('settle',{...revision,costNanoUsd:2},ctx)).toThrow('id_conflict');
 expect(()=>stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:1.2},ctx)).toThrow('invalid_cost');
 expect(()=>stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:-1},ctx)).toThrow('invalid_cost');
 stateRpc('settle',{result:result(t,1,1,3),costNanoUsd:null},ctx);expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(250000000);expect(createIngress().plan(target('next'),publication(state).value,null).denial?.error).toBe('token-budget.cost_unknown');
 stateRpc('settle',{result:result(t,1,1,4),costNanoUsd:40000000},ctx);expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(240000000);
});
test('price unknown never disables Token, unit switch blocks USD and unsent cancellation bills neither unit',()=>{
 const {state}=setup(),t=target();setPolicy(state,'k',{mode:'daily',limit:100});prepare(state,t);stateRpc('settle',{result:result(t),costNanoUsd:null},{state,...t});
 expect(createIngress().plan(target('next'),publication(state).value,null).denial).toBeUndefined();expect(readUsage(state,'k').attempts[0]).toMatchObject({costStatus:'unknown',costNanoUsd:null,status:'settled'});
 setPolicy(state,'k',{mode:'cumulative',unit:'usd',limit:1});expect(createIngress().plan(target('next'),publication(state).value,null).denial?.status).toBe(503);
 recoverUsage({keyId:'k',requestId:t.requestId,attemptId:t.attemptId,costUsd:0.123456,reason:'Provider invoice'},{durableState:state});expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(123456000);expect(readKey(state,'k').cumulative).toBe(3);
 const cancel=target('cancel');prepare(state,cancel);stateRpc('cancel',{sent:false},{state,...cancel});expect(readKey(state,'k').money.cumulativeNanoUsd).toBe(123456000);expect(readKey(state,'k').money.unresolved).toEqual({});
 const audit=state.list().find(r=>r.key.startsWith('recovery-cost:'))!.value as any;expect(audit).toMatchObject({deltaNanoUsd:123456000,reason:'Provider invoice',previous:{costStatus:'unknown'}});
});
test('cold SQLite reopen preserves balances and unknown axes; Token-only recovery cannot clear money unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-money-'));dirs.push(dir);const path=join(dir,'state.db'),{db,state}=setup(path),t=target();setPolicy(state,'k',{mode:'monthly',limit:100});prepare(state,t);db.close();
 const reopenedDb=new Database(path);dbs.push(reopenedDb);const reopened=new PluginDurableStateStore(reopenedDb).forNamespace('token-budget');recoverPending(reopened);expect(readUsage(reopened,'k').attempts[0]).toMatchObject({status:'unknown',costStatus:'unknown'});
 recoverUsage({keyId:'k',requestId:t.requestId,attemptId:t.attemptId,inputTokens:4,outputTokens:5,reason:'usage invoice'},{durableState:reopened});expect(readKey(reopened,'k').cumulative).toBe(9);expect(readKey(reopened,'k').unresolved).toEqual({});expect(Object.values(readKey(reopened,'k').money.unresolved)).toEqual(['unknown']);
 setPolicy(reopened,'k',{mode:'monthly',unit:'usd',limit:1});expect(createIngress().plan(target('next'),publication(reopened).value,null).denial?.status).toBe(503);
 const input={keyId:'k',requestId:t.requestId,attemptId:t.attemptId,costUsd:0.01,reason:'price invoice'};recoverUsage(input,{durableState:reopened});expect(recoverUsage(input,{durableState:reopened})).toEqual({recovered:true,alreadyApplied:true});expect(readKey(reopened,'k').money.cumulativeNanoUsd).toBe(10000000);
 expect(()=>recoverUsage({...input,costUsd:0.02},{durableState:reopened})).toThrow('recovery_conflict');
});
test('legacy month/cumulative records and in-flight grants remain compatible without invented daily, weekly or monetary history',()=>{
 const {state}=setup();state.execute({commandId:'legacy',mutations:[{key:keyRecord('k'),expectedVersion:0,value:{keyId:'k',ledger:{policy:{mode:'monthly',limit:100},cumulative:40,monthly:{'2026-01':40},unresolved:{}}}}]});
 const prior=readKey(state,'k');expect(prior).toMatchObject({cumulative:40,daily:{},weekly:{},money:{cumulativeNanoUsd:0},collection:{dailyWeeklyStartedAtMs:null,moneyStartedAtMs:null,legacyTokensExcluded:true}});
 const t=target(),snapshot={keyId:'k',requestId:t.requestId,month:'2026-02',policy:{mode:'monthly',limit:100},version:0};stateRpc('prepare',{snapshot},{state,...t});stateRpc('settle',{result:result(t),costNanoUsd:1000},{state,...t});
 expect(readKey(state,'k')).toMatchObject({cumulative:43,monthly:{'2026-01':40,'2026-02':3},daily:{},weekly:{},money:{cumulativeNanoUsd:1000,monthlyNanoUsd:{'2026-02':1000},dailyNanoUsd:{},weeklyNanoUsd:{}}});
 setPolicy(state,'k',{mode:'daily',limit:100});const next=target('new');prepare(state,next);stateRpc('settle',{result:result(next),costNanoUsd:2000},{state,...next});expect(readKey(state,'k').daily).toEqual({'2026-02-01':3});expect(readKey(state,'k').collection.dailyWeeklyStartedAtMs).toBeNumber();
});
test('late monthly USD settlement and revision debit the original month after next-month admission',()=>{
 const {state}=setup(),t=target('month-end',Date.UTC(2026,0,31,23,59,59));setPolicy(state,'k',{mode:'monthly',unit:'usd',limit:0.000001});prepare(state,t);
 stateRpc('settle',{result:{...result(t),finishedAtMs:Date.UTC(2026,1,1)},costNanoUsd:1000},{state,...t});expect(readKey(state,'k').money.monthlyNanoUsd).toEqual({'2026-01':1000});
 expect(createIngress().plan(t,publication(state).value,null).denial?.status).toBe(429);expect(createIngress().plan(target('feb',Date.UTC(2026,1,1)),publication(state).value,null).denial).toBeUndefined();
 stateRpc('settle',{result:{...result(t,1,1,2),finishedAtMs:Date.UTC(2026,2,1)},costNanoUsd:500},{state,...t});expect(readKey(state,'k').money.monthlyNanoUsd).toEqual({'2026-01':500});expect(readKey(state,'k').monthly).toEqual({'2026-01':2});
});
test('actual legacy attempt records replay without price fields and accept higher settlement versions without rebuilding history',async()=>{
 const {createHash}=await import('node:crypto'),{state}=setup(),t=target('old'),snapshot={keyId:'k',requestId:t.requestId,month:'2026-02',policy:{mode:'monthly',limit:100},version:0};
 const recordId=(kind:string,attemptId='')=>kind+':'+createHash('sha256').update(JSON.stringify([t.requestId,attemptId])).digest('hex'),oldResult=result(t);
 state.execute({commandId:'old-attempt',mutations:[
  {key:keyRecord('k'),expectedVersion:0,value:{keyId:'k',ledger:{policy:snapshot.policy,cumulative:43,monthly:{'2026-01':40,'2026-02':3},unresolved:{}}}},
  {key:recordId('request'),expectedVersion:0,value:snapshot},
  {key:recordId('attempt',t.attemptId),expectedVersion:0,value:{keyId:'k',requestId:t.requestId,attemptId:t.attemptId,snapshot,status:'settled',input:1,output:2,inputSource:'official',outputSource:'official',settlementVersion:1,resultFingerprint:createHash('sha256').update(JSON.stringify(oldResult)).digest('hex'),partial:false}},
 ]});
 expect(readUsage(state,'k').attempts[0]).toMatchObject({costStatus:'untracked',day:null,week:null});stateRpc('prepare',{snapshot},{state,...t});stateRpc('settle',{result:oldResult},{state,...t});expect(readKey(state,'k').cumulative).toBe(43);
 stateRpc('settle',{result:result(t,1,1,2),costNanoUsd:1000},{state,...t});expect(readKey(state,'k')).toMatchObject({cumulative:42,daily:{},weekly:{},monthly:{'2026-01':40,'2026-02':2},money:{cumulativeNanoUsd:1000,dailyNanoUsd:{},weeklyNanoUsd:{},monthlyNanoUsd:{'2026-02':1000}}});
});
