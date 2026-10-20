import {fileURLToPath} from 'node:url';
import {withRecoveryTerminal, identityRecoveryAnswers} from '../../../../tests/helpers/recovery-terminal';
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {recoverOffline,recoverOfflineAction,readRecoveryInput} from '../../src/master-runtime/offline-recovery';
import {acquireMasterInstanceLock} from '../../src/master-runtime/instance-lock';
import {ConfigRepository} from '../../src/config-storage';
import {PluginStateClient} from '../../src/plugin-state/client';
import {initializeConfigurationDatabase} from '../../src/master-runtime/initialize-configuration';
import {setPolicy,publication,stateRpc,readKey} from '../../../../plugins/token-budget/server/ledger';
import {createIngress} from '../../../../plugins/token-budget/server/policy';
import {createControl} from '../../../../plugins/user-auth/server/control';

test('offline identity recovery shares master lock and uses immutable selected plugin',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-offline-'));const path=join(dir,'config.db');
 try {
  const lock=await acquireMasterInstanceLock(path+'.lock');
  try{await expect(recoverOffline(path,{kind:'identity',plugin:'user-auth',payload:{}})).rejects.toThrow('held');expect(await Bun.file(path).exists()).toBe(false);}finally{await lock.release();}
  await expect(recoverOffline(path,{kind:'management-key'})).rejects.toThrow('invalid_recovery_kind');
  await initializeConfigurationDatabase({configDbPath:path});
  const repository=ConfigRepository.open(path,{offline:true,compileOptions:{pluginSchemas:new Map(),managementProviders:new Set(['user-auth'])}});
  try{
   expect(repository.getDatabase().query("SELECT name FROM sqlite_master WHERE name IN ('api_keys','plugin_durable_records','secret_store_objects')").all()).toEqual([]);
   repository.setManagementProviderOffline('user-auth','select-accounts',Date.now());
  }finally{repository.close();}
  await expect(recoverOffline(path,{kind:'management-key'})).rejects.toThrow('invalid_recovery_kind');
  await expect(recoverOffline(path,{kind:'identity',plugin:'token-budget',payload:{}})).rejects.toThrow('not_selected');
  const result=await resetIdentity(path,'owner','secure-recovery-password-2026','Lost administrator credentials') as {id:string;username:string};
  expect(result.username).toBe('owner');
  const reopened=ConfigRepository.open(path);try{
   expect(reopened.getSnapshot().aggregate.plugin_activations.map(x=>x.plugin_name)).toContain('user-auth');
   expect(reopened.getDatabase().query("SELECT name FROM sqlite_master WHERE name IN ('api_keys','plugin_durable_records','secret_store_objects')").all()).toEqual([]);
   const plugin=await PluginStateClient.open(join(dir,'plugin-state.db'));
   try {
   expect((await plugin.durableState('user-auth').get('recovery-anchor'))?.value).toEqual({schema:3,userId:result.id});
   expect((await plugin.durableState('user-auth').get('user:'+result.id))?.value).toMatchObject({schema:3,user:{id:result.id,username:'owner',disabled:false}});
   expect((await plugin.durableState('user-auth').get('credential:'+result.id))?.value).toMatchObject({schema:3,credential:{passwordHash:expect.stringContaining('$argon2id$')}});
   const state=plugin.durableState('token-budget');
   const target={requestId:'request',attemptId:'attempt',principal:{domain:'data' as const,keyId:'key',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'upstream',url:'https://example.test',model:null,now:Date.UTC(2026,0,31)};
   await setPolicy(state,'key',{mode:'monthly',limit:100});
   const snapshot=createIngress().plan(target,(await publication(state)).value,null).snapshot!;
   await stateRpc('prepare',{snapshot},{state,...target});
   } finally { await plugin.close(); }
  }finally{reopened.close();}
  const recovery={kind:'plugin-state',plugin:'token-budget',payload:{keyId:'key',requestId:'request',attemptId:'attempt',inputTokens:3,outputTokens:4,reason:'Verified upstream usage'}};
  await recoverOffline(path,recovery);await recoverOffline(path,recovery);
  const checked=ConfigRepository.open(path);try{
   const plugin=await PluginStateClient.open(join(dir,'plugin-state.db'));
   try {expect(await readKey(plugin.durableState('token-budget'),'key')).toMatchObject({cumulative:7,monthly:{'2026-01':7},unresolved:{}});}finally{await plugin.close();}
   expect(checked.getSnapshot().aggregate.plugin_activations.map(x=>x.plugin_name)).not.toContain('token-budget');
  }finally{checked.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test('recovery input bounds before parsing and never accepts secret argv fields',async()=>{
 async function* large(){yield 'x'.repeat(8193)}
 await expect(readRecoveryInput(large())).rejects.toThrow('too_large');
 await expect(recoverOffline('/tmp/unused-recovery.db',{kind:'identity',plugin:'user-auth',password:'secret'})).rejects.toThrow('invalid_recovery_input');
});

test('identity JSON is rejected even on a terminal; interactive reset preserves id and protection, revokes sessions and recovers a forgotten account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-interactive-reset-')),path=join(dir,'config.db');
 const password='previous-owner-password-2026',nextPassword='recovered-owner-password-2026';
 try{
  await initializeConfigurationDatabase({configDbPath:path});
  const config=ConfigRepository.open(path,{offline:true,compileOptions:{pluginSchemas:new Map(),managementProviders:new Set(['user-auth'])}});
  try{config.setManagementProviderOffline('user-auth','protect-for-reset',Date.now());}finally{config.close();}
  const original=await resetIdentity(path,'forgotten-owner',password,'Initial account') as {id:string};
  const login=(username:string,p:string,transport:'bearer'|'cookie')=>new Request('https://example.test/login',{method:'POST',headers:{origin:'https://example.test'},body:JSON.stringify({username,password:p,transport})});
  let token:string,cookie:string;
  const first=await PluginStateClient.open(join(dir,'plugin-state.db'));
  const control=createControl({signal:new AbortController().signal,durableState:first.durableState('user-auth'),managementOrigin:'https://example.test',secretStore:{} as never,storage:{} as never});
  try{
   await control.start();
   token=(await (await control.login(login('forgotten-owner',password,'bearer'))).json()).token;
   const response=await control.login(login('forgotten-owner',password,'cookie'));
   cookie=response.headers.get('set-cookie')!.split(';')[0]!;
   expect(await control.authenticate(new Request('https://example.test/self',{headers:{authorization:'Bearer '+token}}))).not.toBeNull();
   expect(await control.authenticate(new Request('https://example.test/self',{headers:{cookie}}))).not.toBeNull();
   await first.durableState('token-budget').transact([{key:'unrelated',expectedVersion:0,value:{marker:'preserve'}}]);
  }finally{await control.dispose();await first.close();}
  const inspect=async()=>{
   const repository=ConfigRepository.open(path),state=await PluginStateClient.open(join(dir,'plugin-state.db'));
   try{return {snapshot:repository.getSnapshot(),protection:repository.getManagementProtection(),identity:await state.durableState('user-auth').list(),other:await state.durableState('token-budget').list()};}
   finally{await state.close();repository.close();}
  };
  const before=await inspect();
  const payload={operation:'reset',username:'replacement',password:nextPassword,passwordConfirmation:nextPassword,reason:'Rejected structured reset'};
  await expect(recoverOffline(path,{kind:'identity',plugin:'user-auth',payload})).rejects.toThrow('requires_interactive_action');
  await expect(withTerminal(()=>recoverOffline(path,{kind:'identity',plugin:'user-auth',payload}))).rejects.toThrow('requires_interactive_action');
  await expect(recoverOffline(path,{kind:'plugin-state',plugin:'user-auth',payload})).rejects.toThrow('not_supported');
  expect(await inspect()).toEqual(before);
  const recovered=await resetIdentity(path,'recovered-owner',nextPassword,'Forgot account and password') as {id:string;username:string};
  expect(recovered).toMatchObject({id:original.id,username:'recovered-owner'});
  const after=await inspect();expect(after.snapshot).toEqual(before.snapshot);expect(after.protection).toEqual(before.protection);expect(after.protection).toMatchObject({required:true,selectedProvider:'user-auth'});expect(after.other).toEqual(before.other);
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  const restored=createControl({signal:new AbortController().signal,durableState:state.durableState('user-auth'),managementOrigin:'https://example.test',secretStore:{} as never,storage:{} as never});
  try{
   await restored.start();
   expect(await restored.authenticate(new Request('https://example.test/self',{headers:{authorization:'Bearer '+token!}}))).toBeNull();
   expect(await restored.authenticate(new Request('https://example.test/self',{headers:{cookie:cookie!}}))).toBeNull();
   expect((await restored.login(login('forgotten-owner',password,'bearer'))).status).toBe(401);
   expect((await restored.login(login('recovered-owner',nextPassword,'bearer'))).status).toBe(200);
  }finally{await restored.dispose();await state.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test.each(['identity','plugin-state'])('live ingress refuses offline %s while master lock is free',async(kind)=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-orphan-ingress-'));const path=join(dir,'config.db');
 const ingress=await acquireMasterInstanceLock(join(dir,'ingress.instance.lock'));
 try {
  await expect(recoverOffline(path,{kind,plugin:kind==='identity'?'user-auth':'token-budget',payload:{}})).rejects.toThrow('held');
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
  await expect(recoverOffline(path,{kind:'identity',plugin:'user-auth',payload:{}})).rejects.toThrow('held');
  expect(await Bun.file(path).exists()).toBe(false);
 }finally{if(prior===undefined)delete process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH;else process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH=prior;await ingress.release();await rm(dir,{recursive:true,force:true});}
});

test('built local recovery reads stdin without logging rejected identity secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-cli-'));
 try{
  const build=await Bun.build({entrypoints:[fileURLToPath(new URL('../../src/main.ts', import.meta.url))],outdir:dir,target:'bun',format:'esm'});expect(build.success).toBe(true);
  for(const [entry,name] of [['config-storage/storage-worker.ts','config-storage-worker.js'],['plugin-state/worker.ts','plugin-state-worker.js']] as const) {
   const worker=await Bun.build({entrypoints:[fileURLToPath(new URL('../../src/'+entry,import.meta.url))],outdir:dir,naming:name,target:'bun'});expect(worker.success).toBe(true);
  }
  const env={...process.env,BUNGEE_ROLE:'master',BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../../../plugins', import.meta.url))};
  const run=(body:string)=>{const child=Bun.spawn([process.execPath,join(dir,'main.js'),'--recover',join(dir,'config.db')],{stdin:new Blob([body]),stdout:'pipe',stderr:'pipe',env});return child;};
  const child=run(JSON.stringify({kind:'management-key'}));const output=await new Response(child.stdout).text();const errors=await new Response(child.stderr).text();expect(await child.exited).toBe(1);expect(output+errors).not.toContain('bng_management_');
  const initialize=Bun.spawn([process.execPath,join(dir,'main.js'),'--initialize-config',join(dir,'config.db')],{stdout:'pipe',stderr:'pipe',env});
  const initialization=await new Response(initialize.stdout).text()+await new Response(initialize.stderr).text();expect(await initialize.exited,initialization).toBe(0);
  const rejected=run(JSON.stringify({kind:'identity',plugin:'user-auth',payload:{operation:'reset',username:'owner',password:'DO-NOT-LOG-THIS-SECRET',passwordConfirmation:'DO-NOT-LOG-THIS-SECRET',reason:'Rejected piped recovery'}}));const text=await new Response(rejected.stdout).text()+await new Response(rejected.stderr).text();expect(await rejected.exited).toBe(1);expect(text).not.toContain('DO-NOT-LOG-THIS-SECRET');
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect(await state.durableState('user-auth').list()).toEqual([]);}finally{await state.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test('offline recovery removes obsolete plugin activations and preserves their business state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-missing-'));const path=join(dir,'config.db');
 try{
  const repository=ConfigRepository.open(path);try{
   const snapshot=repository.getSnapshot();
   expect(repository.commit({mutation_id:'missing-auth',expected_revision:snapshot.revision,aggregate:{...snapshot.aggregate,plugin_activations:[{plugin_name:'missing-provider'}]},kind:'config',created_at:Date.now(),target_worker_slots:[0]}).kind).toBe('committed');
   repository.beginPublication('missing-auth',Date.now());
   repository.beginWorkerAttempt('missing-auth',0,0,'initial',Date.now());
   repository.recordWorkerResult('missing-auth',0,{kind:'converged',attempt_no:1,applied_revision:snapshot.revision+1},Date.now());
   repository.markDraining('missing-auth',Date.now());
   repository.finalizePublication('missing-auth',{outcome:'converged',old_workers_exited:true},Date.now());
  }finally{repository.close();}
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'),{initialize:true});
  try{await state.durableState('missing-provider').transact([{key:'retained',expectedVersion:0,value:{schema:1,example:true}}]);}finally{await state.close();}
  await resetIdentity(path,'owner','Recovery password 123!','Restore management identity');
  const checked=ConfigRepository.open(path);try{
   expect(checked.getSnapshot().aggregate.plugin_activations).toEqual([]);
   expect(checked.getManagementProtection()).toMatchObject({required:false,selectedProvider:null});
   expect(checked.getDatabase().query("SELECT name FROM sqlite_master WHERE name IN ('api_keys','plugin_durable_records','secret_store_objects')").all()).toEqual([]);
  }finally{checked.close();}
  const preserved=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect((await preserved.durableState('missing-provider').get('retained'))?.value).toEqual({schema:1,example:true});}finally{await preserved.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

// A disabled plugin retains its identity. Recovery must allow re-enabling it after a lost password.
test('offline recovery can reset inactive management identity without enabling authentication',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-inactive-'));const path=join(dir,'config.db');
 try {
  await initializeConfigurationDatabase({configDbPath:path});
  const result=await resetIdentity(path,'admin','inactive-recovery-password-2026','Prepare administrator for re-enable') as {username:string};
  expect(result.username).toBe('admin');
  const repository=ConfigRepository.open(path);try{expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([]);expect(repository.getDatabase().query("SELECT name FROM sqlite_master WHERE name IN ('api_keys','plugin_durable_records','secret_store_objects')").all()).toEqual([]);}finally{repository.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

async function withTerminal<T>(operation: () => Promise<T>): Promise<T> {
 return (await withRecoveryTerminal(operation)).result;
}

async function resetIdentity(path: string, username: string, password: string, reason: string): Promise<unknown> {
 const {result,output}=await withRecoveryTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action:'reset'}),identityRecoveryAnswers(username,password,reason));
 expect(output).not.toContain(password);
 return result;
}

test('plugin-declared add-user and reset-password actions preserve protection and release-auth preserves identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-identity-actions-')),path=join(dir,'config.db');
 try{
  await initializeConfigurationDatabase({configDbPath:path});
  const identity=await resetIdentity(path,'owner','Owner password 123!','Initial recovery') as {id:string};
  const checkpoint=ConfigRepository.open(path,{offline:true,compileOptions:{pluginSchemas:new Map(),managementProviders:new Set(['user-auth'])}});
  let before!: {snapshot: ReturnType<ConfigRepository['getSnapshot']>; guard: ReturnType<ConfigRepository['getManagementProtection']>};
  try{checkpoint.setManagementProviderOffline('user-auth','protect-recovery',Date.now());before={snapshot:checkpoint.getSnapshot(),guard:checkpoint.getManagementProtection()};}finally{checkpoint.close();}
  const added=await withRecoveryTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action:'add-user'}),[
   {label:'Username',answer:'second'}, {label:'New password',answer:'Second password 123!'},
   {label:'Confirm password',answer:'Second password 123!'},
  ]);
  expect(added.result).toMatchObject({username:'second'});expect(added.output).not.toContain('Second password 123!');
  const reset=await withRecoveryTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action:'reset-password'}),[
   {label:'Username',answer:'second'}, {label:'New password',answer:'Changed password 123!'},
   {label:'Confirm password',answer:'Changed password 123!'},
  ]);
  expect(reset.result).toMatchObject({username:'second'});expect(reset.output).not.toContain('Changed password 123!');
  const unchanged=ConfigRepository.open(path);try{expect({snapshot:unchanged.getSnapshot(),guard:unchanged.getManagementProtection()}).toEqual(before);}finally{unchanged.close();}
  await withTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action:'release-auth'}));
  const released=ConfigRepository.open(path);try{expect(released.getManagementProtection()).toMatchObject({required:false,selectedProvider:null});expect(released.getSnapshot().aggregate.plugin_activations).toEqual([]);}finally{released.close();}
  const reopened=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect((await reopened.durableState('user-auth').get('recovery-anchor'))?.value).toEqual({schema:3,userId:identity.id});expect((await reopened.durableState('user-auth').get('user:'+identity.id))?.value).toMatchObject({schema:3,user:{id:identity.id,username:'owner'}});}finally{await reopened.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},20000);

test.each(['add-user','reset-password','reset','release-auth'] as const)('terminal %s rejects before creating storage',async action=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-nontty-')),path=join(dir,'config.db');
 const prior=Object.getOwnPropertyDescriptor(process.stdin,'isTTY');
 try{Object.defineProperty(process.stdin,'isTTY',{value:false,configurable:true});await expect(recoverOfflineAction(path,{plugin:'user-auth',action})).rejects.toThrow('requires_terminal');expect(await Bun.file(path).exists()).toBe(false);}
 finally{if(prior)Object.defineProperty(process.stdin,'isTTY',prior);else delete (process.stdin as any).isTTY;await rm(dir,{recursive:true,force:true});}
});

test.each(['add-user','reset-password','reset','release-auth'] as const)('terminal %s holds the actual stopped-instance lock',async action=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-action-lock-')),path=join(dir,'config.db');const lock=await acquireMasterInstanceLock(path+'.lock');
 try{await expect(withTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action}))).rejects.toThrow('held');expect(await Bun.file(path).exists()).toBe(false);}
 finally{await lock.release();await rm(dir,{recursive:true,force:true});}
});


test('unregistered and dangerous actions fail without touching identity state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-unknown-action-')),path=join(dir,'config.db');
 try{
  await initializeConfigurationDatabase({configDbPath:path});
  for(const action of ['unknown-action','toString','issue-setup-code']) await expect(withTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action}))).rejects.toThrow('offline_recovery_action_not_supported');
  for(const action of ['constructor','__proto__','../reset','x'.repeat(65)]) await expect(withTerminal(()=>recoverOfflineAction(path,{plugin:'user-auth',action}))).rejects.toThrow('invalid_recovery_arguments');
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect(await state.durableState('user-auth').list()).toEqual([]);}finally{await state.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('offline reset repairs a ready namespace with a missing recovery user without starting the provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-ready-missing-user-')),path=join(dir,'config.db');
 try{
  await initializeConfigurationDatabase({configDbPath:path});
  const initial=await resetIdentity(path,'lost-owner','Owner password 123!','Initial recovery') as {id:string};
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{
   const own=state.durableState('user-auth'),user=(await own.get('user:'+initial.id))!;
   await own.transact([{key:user.key,expectedVersion:user.version,value:null}]);
   const control=createControl({signal:new AbortController().signal,durableState:own,secretStore:{} as never,storage:{} as never});
   try{const failure=await control.start().catch(error=>error);expect(failure).toHaveProperty('message','corrupt_state');}finally{await control.dispose();}
  }finally{await state.close();}
  const repaired=await resetIdentity(path,'restored-owner','Restored password 123!','Restore missing recovery user');
  expect(repaired).toMatchObject({id:initial.id,username:'restored-owner'});
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);
