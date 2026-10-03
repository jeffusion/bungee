import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../../packages/core/src/plugin-durable-state';
import {createControl,recoverIdentity} from '../server/control';
const oldPassword='previous-owner-password-2026',nextPassword='recovered-owner-password-2026';
function fixture() {
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const durableState=new PluginDurableStateStore(db).forNamespace('local-accounts');
 const host={signal:new AbortController().signal,durableState,secretStore:{} as never,storage:{} as never};
 return {db,durableState,host};
}
async function seedLegacy(durableState:ReturnType<typeof fixture>['durableState'],roles:string[]) {
 const passwordHash=await Bun.password.hash(oldPassword,{algorithm:'argon2id',memoryCost:65536,timeCost:3});
 const members=roles.map((role,i)=>({id:'old-'+i,username:'user'+i,role,disabled:false,temporary:false,passwordHash,generation:1}));
 durableState.execute({commandId:'seed',mutations:[{key:'accounts',expectedVersion:0,value:{schema:1,members,sessions:[{digest:'a'.repeat(64),memberId:'old-0',generation:1,created:Date.now(),touched:Date.now(),transport:'bearer'}],failures:[]}}]});
 return members;
}
test('offline recovery restores only the existing administrator, revokes all sessions and records bounded audit without secrets',async()=>{
 const {db,durableState,host}=fixture();
 try {
  const control=createControl(host);await control.bootstrap({username:'owner',password:oldPassword,passwordConfirmation:oldPassword});
  const login=await control.login(new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username:'owner',password:oldPassword,transport:'bearer'})}));
  const token=(await login.json()).token;
  await expect(recoverIdentity({username:'new',password:nextPassword,reason:'restore access'},{durableState})).rejects.toThrow('existing_administrator');
  const result=await recoverIdentity({username:'owner',password:nextPassword,reason:'restore access'},{durableState});
  expect(result).toMatchObject({username:'owner'});expect(result).not.toHaveProperty('role');
  const restored=durableState.get('accounts')!.value as any;
  expect(restored.schema).toBe(2);expect(restored.members).toBeUndefined();expect(restored.sessions).toEqual([]);
  expect(await Bun.password.verify(nextPassword,restored.administrator.passwordHash)).toBe(true);
  expect(await Bun.password.verify(oldPassword,restored.administrator.passwordHash)).toBe(false);
  expect(await control.authenticate(new Request('https://example.com/self',{headers:{authorization:'Bearer '+token}}))).toBeNull();
  expect(JSON.stringify(durableState.list())).not.toContain(nextPassword);
  expect(durableState.list().filter(x=>x.key.startsWith('recovery:'))).toHaveLength(1);
 }finally{db.close();}
});
test('legacy unique enabled owner becomes the only administrator and other roles never gain access',async()=>{
 const {db,durableState,host}=fixture();
 try {
  await seedLegacy(durableState,['owner','admin','viewer']);
  const control=createControl(host);await control.start();
  const migrated=durableState.get('accounts')!.value as any;
  expect(migrated.schema).toBe(2);expect(migrated.administrator.username).toBe('user0');
  expect(migrated.administrator.role).toBeUndefined();expect(migrated.members).toBeUndefined();expect(migrated.sessions).toEqual([]);
  for(const username of ['user1','user2']) expect((await control.login(new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username,password:oldPassword,transport:'bearer'})}))).status).toBe(401);
  expect(control.hasIdentity()).toBe(true);
 }finally{db.close();}
});
test('multiple legacy owners fail closed until offline recovery explicitly selects an existing owner',async()=>{
 const {db,durableState,host}=fixture();
 try {
  await seedLegacy(durableState,['owner','owner','viewer']);
  await expect(createControl(host).start()).rejects.toThrow('administrator_migration_required');
  await expect(recoverIdentity({username:'user2',password:nextPassword,reason:'select identity'},{durableState})).rejects.toThrow('existing_administrator');
  await recoverIdentity({username:'user1',password:nextPassword,reason:'select original owner'},{durableState});
  const control=createControl(host);await control.start();
  expect((durableState.get('accounts')!.value as any).administrator.username).toBe('user1');expect(control.hasIdentity()).toBe(true);
 }finally{db.close();}
});
test('disabled administrator cannot be replaced by bootstrap and offline recovery re-enables the same identity',async()=>{
 const {db,durableState,host}=fixture();
 try {
  const control=createControl(host);await control.bootstrap({username:'owner',password:oldPassword,passwordConfirmation:oldPassword});
  const previous=durableState.get('accounts')!;const state=previous.value as any;state.administrator.disabled=true;
  durableState.execute({commandId:'disable',mutations:[{key:'accounts',expectedVersion:previous.version,value:state}]});
  expect(control.hasIdentity()).toBe(false);
  await expect(control.bootstrap({username:'owner',password:oldPassword,passwordConfirmation:oldPassword})).rejects.toThrow('invalid_credentials');
  await recoverIdentity({username:'owner',password:nextPassword,reason:'recover disabled identity'},{durableState});
  expect(control.hasIdentity()).toBe(true);
 }finally{db.close();}
});

test('forgotten username can be replaced offline without changing administrator identity',async()=>{
 const {db,durableState,host}=fixture();
 try {
  const {readManagementSetup}=await import('../server/control');
  expect(readManagementSetup(durableState)).toEqual({initialized:false});
  const control=createControl(host);await control.bootstrap({username:'forgotten',password:oldPassword,passwordConfirmation:oldPassword});
  const id=(durableState.get('accounts')!.value as any).administrator.id;
  expect(readManagementSetup(durableState)).toEqual({initialized:true});
  const result=await recoverIdentity({newUsername:'restored',password:nextPassword,reason:'Forgot account name'},{durableState});
  expect(result).toMatchObject({id,username:'restored'});
  const login=await control.login(new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username:'restored',password:nextPassword,transport:'bearer'})}));
  expect(login.status).toBe(200);
 }finally{db.close();}
});
