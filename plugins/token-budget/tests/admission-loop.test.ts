import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {DataAdmissionHost} from '../../../packages/core/src/data-admission/host';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../packages/core/src/plugin-durable-state';
import {createControl} from '../server/control';
import {createIngress} from '../server/policy';
import {createIngress as accessIngress} from '../../key-access/server/policy';
import {setPolicy,publication,keyRecord,recoverPending,stateRpc} from '../server/ledger';

test('SQLite durable prepare/cancel preserve preview CAS; settlement and recovery publish new admission version',async()=>{
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 try{
  const state=new PluginDurableStateStore(db).forNamespace('token-budget');(await setPolicy(state,'k',{mode:'monthly',limit:100}));
  const principal={domain:'data' as const,keyId:'k',credentialVersion:1};
  const worker={role:'worker' as const,master_generation:'master',process_instance_id:'worker',boot_nonce:'nonce',worker_slot:0};
  const host=new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> 'catalog',loadPlugin:async entry=>({createIngress:entry==='access'?accessIngress:createIngress})});
  let hostVersion=0;let publications=0;
  const publishPolicy=async (policy:any)=>{
   publications++;await host.publish({version:++hostVersion,plugins:[{name:'key-access',entry:'access',catalogHash:'catalog',policy:{protectedRouteIds:['route'],byKey:{},credentials:[{id:'k',domain:'data',digest:'a'.repeat(64),credentialVersion:1,expiresAt:null,revokedAt:null}]}},{name:'token-budget',entry:'budget',catalogHash:'catalog',policy:policy.value}]});
  };
  const execute=async(method:string,payload:unknown,ctx:any)=>{const before=(await publication(state)).version;const result=(await stateRpc(method,payload,ctx));if((await publication(state)).version!==before||method==='settle')await publishPolicy((await publication(state)));return result;};
  const control=createControl({signal:new AbortController().signal,durableState:state,publishPolicy:async (policy:any)=>{
   publications++;await host.publish({version:++hostVersion,plugins:[{name:'key-access',entry:'access',catalogHash:'catalog',policy:{protectedRouteIds:['route'],byKey:{},credentials:[{id:'k',domain:'data',digest:'a'.repeat(64),credentialVersion:1,expiresAt:null,revokedAt:null}]}},{name:'token-budget',entry:'budget',catalogHash:'catalog',policy:policy.value}]});
  }} as any);
  await control.start();const initial=(await publication(state)).version;
  for(let index=0;index<3;index++){
   const target={requestId:'r'+index,attemptId:'a'+index,principal,routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now:Date.now()};
   const preview=host.admit(target,worker,true);const ledgerCas=(await state.get(keyRecord('k')))!.version;
   await execute('prepare',{snapshot:preview.snapshots['token-budget']},{state,...target});
   expect((await state.get(keyRecord('k')))!.version).toBeGreaterThan(ledgerCas);
   expect((await publication(state)).version).toBe(initial);expect(publications).toBe(1);
   expect(host.admit(target,worker,false,preview.version).requestId).toBe(target.requestId);
   await execute('cancel',{sent:false},{state,...target});
   expect((await publication(state)).version).toBe(initial);expect(publications).toBe(1);
  }
  const target={requestId:'sent',attemptId:'sent-a',principal,routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now:Date.now()};
  const preview=host.admit(target,worker,true);
  await execute('prepare',{snapshot:preview.snapshots['token-budget']},{state,...target});
  host.admit(target,worker,false,preview.version);
  const result={requestId:'sent',attemptId:'sent-a',routeId:'route',upstreamId:'u',provider:'test',inputTokens:3,outputTokens:4,inputSource:'official',outputSource:'official',inputAuthority:'official',outputAuthority:'official',complete:true,observationIncomplete:false,outcome:'completed',finishedAtMs:Date.now(),settlementVersion:1};
  await execute('settle',{result},{state,...target});expect((await publication(state)).version).toBe(initial+1);expect(publications).toBe(2);
  await execute('settle',{result},{state,...target});expect((await publication(state)).version).toBe(initial+1);expect(((await publication(state)).value.byKey as any).k.cumulative).toBe(7);
  const pending={...target,requestId:'lost',attemptId:'lost-a'};const next=host.admit(pending,worker,true);
  await execute('prepare',{snapshot:next.snapshots['token-budget']},{state,...pending});
  const versionBeforeRecovery=(await publication(state)).version;(await recoverPending(state));expect((await publication(state)).version).toBe(versionBeforeRecovery+1);
  expect(createIngress().plan({...pending,now:Date.UTC(2027,0,1)},(await publication(state)).value,null).denial?.status).toBe(503);
 }finally{db.close();}
});
