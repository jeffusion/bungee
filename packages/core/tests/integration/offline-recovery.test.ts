import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {recoverOffline,readRecoveryInput} from '../../src/master-runtime/offline-recovery';
import {acquireMasterInstanceLock} from '../../src/master-runtime/instance-lock';
import {ConfigRepository} from '../../src/config-storage';
import {PluginDurableStateStore} from '../../src/plugin-durable-state';
import {setPolicy,publication,stateRpc,readKey} from '../../../../plugins/token-budget/server/ledger';
import {createIngress} from '../../../../plugins/token-budget/server/policy';

test('offline identity recovery shares master lock and uses immutable selected plugin',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-offline-'));const path=join(dir,'config.db');
 try {
  const lock=await acquireMasterInstanceLock(path+'.lock');
  try{await expect(recoverOffline(path,{kind:'identity',plugin:'local-accounts',payload:{}})).rejects.toThrow('held');expect(await Bun.file(path).exists()).toBe(false);}finally{await lock.release();}
  await expect(recoverOffline(path,{kind:'management-key'})).rejects.toThrow('invalid_recovery_kind');
  const repository=ConfigRepository.open(path);
  try{
   expect(repository.getDatabase().query('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({count:0});
   const snapshot=repository.getSnapshot();
   expect(repository.commit({mutation_id:'select-accounts',expected_revision:snapshot.revision,aggregate:{...snapshot.aggregate,plugin_activations:[{plugin_name:'local-accounts'}]},kind:'config',created_at:Date.now(),target_worker_slots:[0]}).kind).toBe('committed');
  }finally{repository.close();}
  await expect(recoverOffline(path,{kind:'management-key'})).rejects.toThrow('invalid_recovery_kind');
  await expect(recoverOffline(path,{kind:'identity',plugin:'token-budget',payload:{}})).rejects.toThrow('not_selected');
  const result=await recoverOffline(path,{kind:'identity',plugin:'local-accounts',payload:{username:'owner',password:'secure-recovery-password-2026',reason:'Lost administrator credentials'}}) as any;
  expect(result.username).toBe('owner');
  const reopened=ConfigRepository.open(path);try{
   expect(reopened.getSnapshot().aggregate.plugin_activations.map(x=>x.plugin_name)).toContain('local-accounts');
   expect(reopened.getDatabase().query('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({count:0});
   expect(new PluginDurableStateStore(reopened.getDatabase()).forNamespace('local-accounts').get('accounts')).not.toBeNull();
   const state=new PluginDurableStateStore(reopened.getDatabase()).forNamespace('token-budget');
   const target={requestId:'request',attemptId:'attempt',principal:{domain:'data' as const,keyId:'key',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'upstream',url:'https://example.test',model:null,now:Date.UTC(2026,0,31)};
   setPolicy(state,'key',{mode:'monthly',limit:100});
   const snapshot=createIngress().plan(target,publication(state).value,null).snapshot!;
   stateRpc('prepare',{snapshot},{state,...target});
  }finally{reopened.close();}
  const recovery={kind:'plugin-state',plugin:'token-budget',payload:{keyId:'key',requestId:'request',attemptId:'attempt',inputTokens:3,outputTokens:4,reason:'Verified upstream usage'}};
  await recoverOffline(path,recovery);await recoverOffline(path,recovery);
  const checked=ConfigRepository.open(path);try{
   expect(readKey(new PluginDurableStateStore(checked.getDatabase()).forNamespace('token-budget'),'key')).toMatchObject({cumulative:7,monthly:{'2026-01':7},unresolved:{}});
   expect(checked.getSnapshot().aggregate.plugin_activations.map(x=>x.plugin_name)).not.toContain('token-budget');
  }finally{checked.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test('recovery input bounds before parsing and never accepts secret argv fields',async()=>{
 async function* large(){yield 'x'.repeat(8193)}
 await expect(readRecoveryInput(large())).rejects.toThrow('too_large');
 await expect(recoverOffline('/tmp/unused-recovery.db',{kind:'identity',plugin:'local-accounts',password:'secret'})).rejects.toThrow('invalid_recovery_input');
});

test.each(['identity','plugin-state'])('live ingress refuses offline %s while master lock is free',async(kind)=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-orphan-ingress-'));const path=join(dir,'config.db');
 const ingress=await acquireMasterInstanceLock(join(dir,'ingress.instance.lock'));
 try {
  await expect(recoverOffline(path,{kind,plugin:kind==='identity'?'local-accounts':'token-budget',payload:{}})).rejects.toThrow('held');
  expect(await Bun.file(path).exists()).toBe(false);
  const master=await acquireMasterInstanceLock(path+'.lock');await master.release();
 }finally{await ingress.release();await rm(dir,{recursive:true,force:true});}
});

test('offline recovery honors the same configured ingress lock path as startup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-ingress-override-'));const path=join(dir,'config.db');
 const prior=process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH;
 const ingress=await acquireMasterInstanceLock(join(dir,'custom.lock'));
 try {
  process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH=join(dir,'custom.lock');
  await expect(recoverOffline(path,{kind:'identity',plugin:'local-accounts',payload:{}})).rejects.toThrow('held');
  expect(await Bun.file(path).exists()).toBe(false);
 }finally{if(prior===undefined)delete process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH;else process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH=prior;await ingress.release();await rm(dir,{recursive:true,force:true});}
});

test('built local recovery reads stdin without logging rejected identity secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-cli-'));
 try{
  const build=await Bun.build({entrypoints:[new URL('../../src/main.ts',import.meta.url).pathname],outdir:dir,target:'bun',format:'esm'});expect(build.success).toBe(true);
  const env={...process.env,BUNGEE_ROLE:'master',BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:new URL('../../../../plugins',import.meta.url).pathname};
  const run=(body:string)=>{const child=Bun.spawn([process.execPath,join(dir,'main.js'),'--recover',join(dir,'config.db')],{stdin:new Blob([body]),stdout:'pipe',stderr:'pipe',env});return child;};
  const child=run(JSON.stringify({kind:'management-key'}));const output=await new Response(child.stdout).text();const errors=await new Response(child.stderr).text();expect(await child.exited).toBe(1);expect(output+errors).not.toContain('bng_management_');
  const rejected=run(JSON.stringify({kind:'identity',plugin:'local-accounts',payload:{password:'DO-NOT-LOG-THIS-SECRET'}}));const text=await new Response(rejected.stdout).text()+await new Response(rejected.stderr).text();expect(await rejected.exited).toBe(1);expect(text).not.toContain('DO-NOT-LOG-THIS-SECRET');
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test('missing selected plugin cannot silently bypass identity recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-missing-'));const path=join(dir,'config.db');
 try{
  const repository=ConfigRepository.open(path);try{
   const snapshot=repository.getSnapshot();
   expect(repository.commit({mutation_id:'missing-auth',expected_revision:snapshot.revision,aggregate:{...snapshot.aggregate,plugin_activations:[{plugin_name:'missing-provider'}]},kind:'config',created_at:Date.now(),target_worker_slots:[0]}).kind).toBe('committed');
  }finally{repository.close();}
  await expect(recoverOffline(path,{kind:'identity',plugin:'local-accounts',payload:{}})).rejects.toThrow('not_installed');
  const checked=ConfigRepository.open(path);try{expect(checked.getDatabase().query('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({count:0});}finally{checked.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

// A disabled plugin retains its identity. Recovery must allow re-enabling it after a lost password.
test('offline recovery can reset inactive management identity without enabling authentication',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-inactive-'));const path=join(dir,'config.db');
 try {
  const result=await recoverOffline(path,{kind:'identity',plugin:'local-accounts',payload:{username:'admin',password:'inactive-recovery-password-2026',reason:'Prepare administrator for re-enable'}}) as any;
  expect(result.username).toBe('admin');
  const repository=ConfigRepository.open(path);try{expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([]);expect(repository.getDatabase().query('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({count:0});}finally{repository.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
