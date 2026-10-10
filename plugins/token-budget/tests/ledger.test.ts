async function expectRejected(operation:Promise<unknown>,message?:string){let error:unknown;try{await operation;}catch(value){error=value;}expect(error).toBeInstanceOf(Error);if(message)expect((error as Error).message).toContain(message);}
import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../packages/core/src/plugin-durable-state';
import {setPolicy,publication,readKey,readUsage,stateRpc,recoverPending} from '../server/ledger';
import {createIngress} from '../server/policy';
const dbs:Database[]=[];const dirs:string[]=[];afterEach(()=>{for(const db of dbs.splice(0))try{db.close()}catch{};for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(path=':memory:'){const db=new Database(path);dbs.push(db);db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);return {db,state:new PluginDurableStateStore(db).forNamespace('token-budget')};}
const principal={domain:'data' as const,keyId:'k',credentialVersion:1};
const target={requestId:'r',attemptId:'a',principal,routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now:Date.UTC(2026,0,31,23,59)};
function result(input=5,output=7,source='estimated',version=1){return {requestId:'r',attemptId:'a',routeId:'route',upstreamId:'u',provider:'test',inputTokens:input,outputTokens:output,inputSource:source,outputSource:source,inputAuthority:source==='official'?'official':'local',outputAuthority:source==='official'?'official':'local',complete:true,observationIncomplete:false,outcome:'completed',finishedAtMs:1,settlementVersion:version};}
test('UTC fixed month, both ledgers, official delta, replay and policy changes preserve accounting',async ()=>{
 const {state}=setup();(await setPolicy(state,'k',{mode:'monthly',limit:10}));const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;const ctx={state,...target};
 (await stateRpc('prepare',{snapshot},ctx));(await stateRpc('settle',{result:result()},ctx));expect((await readKey(state,'k'))).toMatchObject({cumulative:12,monthly:{'2026-01':12}});
 (await stateRpc('settle',{result:result()},ctx));expect((await readKey(state,'k')).cumulative).toBe(12);
 (await stateRpc('settle',{result:result(3,4,'official',2)},ctx));expect((await readKey(state,'k')).cumulative).toBe(7);
 expect((await readUsage(state,'k')).attempts).toEqual([{requestId:'r',attemptId:'a',month:'2026-01',day:'2026-01-31',week:'2026-01-26',costNanoUsd:null,costStatus:'unknown',status:'settled',inputTokens:3,outputTokens:4,inputSource:'official',outputSource:'official',partial:false}]);
 expect((await readUsage(state,'other-key')).attempts).toEqual([]);
 await expectRejected(stateRpc('settle',{result:result(3,8,'official',2)},ctx), 'id_conflict');
 (await setPolicy(state,'k',null));expect(createIngress().plan(target,(await publication(state)).value,null).snapshot).toBeNull();
 (await setPolicy(state,'k',{mode:'cumulative',limit:7}));expect(createIngress().plan({...target,now:Date.UTC(2026,1,1)},(await publication(state)).value,null).denial?.status).toBe(429);
 expect((await readKey(state,'k')).monthly['2026-01']).toBe(7);
});
test('unsent cancel, trusted principal and immutable grant identity',async ()=>{
 const {state}=setup();(await setPolicy(state,'k',{mode:'monthly',limit:10}));const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;const ctx={state,...target};
 await expectRejected(stateRpc('prepare',{snapshot:{...snapshot as any,keyId:'other'}},ctx), 'invalid_grant');
 (await stateRpc('prepare',{snapshot,keyId:'forged'},ctx));await expectRejected(stateRpc('prepare',{snapshot:{...snapshot as any,month:'2026-02',day:'2026-02-01',week:'2026-01-26'}},ctx), 'id_conflict');
 await expectRejected(stateRpc('cancel',{sent:true},ctx));(await stateRpc('cancel',{sent:false},ctx));(await stateRpc('cancel',{sent:false},ctx));expect((await readKey(state,'k')).cumulative).toBe(0);expect((await readKey(state,'k')).unresolved).toEqual({});
});
test('unknown blocks across new month and disable/reenable; complete official usage resolves',async ()=>{
 const {state}=setup();(await setPolicy(state,'k',{mode:'monthly',limit:10}));const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;const ctx={state,...target};(await stateRpc('prepare',{snapshot},ctx));
 (await stateRpc('settle',{result:{...result(),inputTokens:undefined,outputTokens:undefined,inputSource:'none',outputSource:'none',observationIncomplete:true,complete:false}},ctx));
 expect((await readUsage(state,'k')).attempts[0]).toMatchObject({requestId:'r',attemptId:'a',inputTokens:null,outputTokens:null,status:'unknown',partial:true});
 const later={...target,now:Date.UTC(2026,1,1)};expect(createIngress().plan(later,(await publication(state)).value,null).denial?.status).toBe(503);
 (await setPolicy(state,'k',null));expect(createIngress().plan(later,(await publication(state)).value,null).denial).toBeUndefined();(await setPolicy(state,'k',{mode:'monthly',limit:10}));expect(createIngress().plan(later,(await publication(state)).value,null).denial?.status).toBe(503);
 (await stateRpc('settle',{result:{...result(3,4,'official',2),observationIncomplete:true}},ctx));expect(createIngress().plan(later,(await publication(state)).value,null).denial).toBeUndefined();expect((await readKey(state,'k')).cumulative).toBe(7);
});
test('actual SQLite reopen retains pending/history and blocks until recovery settles',async ()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-'));dirs.push(dir);const path=join(dir,'state.db');const {db,state}=setup(path);(await setPolicy(state,'k',{mode:'monthly',limit:10}));const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;(await stateRpc('prepare',{snapshot},{state,...target}));db.close();
 const reopened=new Database(path);dbs.push(reopened);const recovered=new PluginDurableStateStore(reopened).forNamespace('token-budget');(await recoverPending(recovered));expect(createIngress().plan({...target,now:Date.UTC(2026,1,1)},(await publication(recovered)).value,null).denial?.status).toBe(503);
 (await stateRpc('settle',{result:result(1,2,'official')},{state:recovered,...target}));expect((await readKey(recovered,'k')).cumulative).toBe(3);expect((await readKey(recovered,'k')).unresolved).toEqual({});
});
