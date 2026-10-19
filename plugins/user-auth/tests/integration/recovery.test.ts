import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, recoverIdentity, readManagementSetup, prepareInitialization} from '../../server/control';
const password = 'previous-owner-password-2026', nextPassword = 'recovered-owner-password-2026';
function fixture() {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const durableState = new PluginDurableStateStore(db).forNamespace('user-auth');
  const host = {signal: new AbortController().signal, durableState, secretStore: {} as never, storage: {} as never};
  return {db, durableState, host, now:()=>1_000_000};
}
const request = (username = 'owner', p = password) => new Request('https://example.com/login', {method:'POST', body:JSON.stringify({username,password:p,transport:'bearer'})});
const reset = (username='owner', p=password, reason='restore access') => ({operation:'reset',username,password:p,passwordConfirmation:p,reason});

test.each([' 😀 甲 ', '😀'.repeat(32)])('offline reset enforces 5–32 Unicode characters without altering state on invalid input (%j)',async value=>{
 const f=fixture();
 try{
  await recoverIdentity(reset(),f);const before=await f.durableState.list();
  for(const invalid of ['x'.repeat(4),'😀'.repeat(4),'x'.repeat(33),'😀'.repeat(33)]){
   await expect(recoverIdentity(reset('owner',invalid),f)).rejects.toThrow('invalid_password');
   expect(await f.durableState.list()).toEqual(before);
  }
  await recoverIdentity(reset('owner',value),f);const control=createControl(f.host,{now:f.now});await control.start();
  expect((await control.login(request('owner',value))).status).toBe(200);
 }finally{f.db.close();}
});

test('offline reset preserves valid identity, changes forgotten username, revokes sessions and throttles, records only a redacted reason', async () => {
  const f=fixture();
  try {
    await recoverIdentity(reset(),f); const control=createControl(f.host,{now:f.now}); await control.start();
    const token=(await (await control.login(request())).json()).token;
    for(let i=0;i<10;i++) expect((await control.login(request('owner','incorrect'))).status).toBe(401);
    expect((await control.login(request())).status).toBe(429);
    const before=((await f.durableState.list()).find(r=>r.key.startsWith('user:')))!.value as any;
    const result=await recoverIdentity(reset('renamed',nextPassword),f);
    expect(result).toMatchObject({id:before.user.id,username:'renamed',requiresPasswordChange:false});
    expect(await control.authenticate(new Request('https://example.com/self',{headers:{authorization:'Bearer '+token}}))).toBeNull();
    expect((await control.login(request('renamed',nextPassword))).status).toBe(200);
    await recoverIdentity(reset('renamed',nextPassword,'second reset'),f);
    const summary=(await f.durableState.get('recovery-summary'))!;
    expect(summary.version).toBe(3); expect(summary.value).toMatchObject({reason:'second reset',at:1_000_000});
    const text=JSON.stringify(await f.durableState.list());
    for(const secret of [password,nextPassword,token]) expect(text).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toMatch(/passwordHash|digest/);
    expect(await readManagementSetup(f.durableState)).toEqual({initialized:true});
  } finally {f.db.close();}
});

test('runtime rejects missing/damaged state; only explicit local reset rebuilds it, never imports old namespace', async () => {
  const f=fixture();
  try {
    await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');
    await expect(readManagementSetup(f.durableState)).rejects.toThrow('corrupt_state');
    const old=new PluginDurableStateStore(f.db).forNamespace('local-accounts');
    await old.transact([{key:'administrator',expectedVersion:0,value:{schema:3,administrator:{id:'old-secret-identity'}}}]);
    await recoverIdentity(reset(),f);
    const identity=((await f.durableState.list()).find(r=>r.key.startsWith('user:')))!;
    expect(JSON.stringify(identity)).not.toContain('old-secret-identity');
    await f.durableState.transact([{key:identity.key,expectedVersion:identity.version,value:{schema: 3,user:{id:'damaged'}}}]);
    await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');
    await expect(prepareInitialization(f)).rejects.toThrow('corrupt_state');
    await expect(recoverIdentity({...reset(),passwordConfirmation:'mismatch'},f)).rejects.toThrow('password_confirmation');
    await recoverIdentity(reset('rebuilt'),f);
    const control=createControl(f.host,{now:f.now}); await control.start(); expect(await control.hasIdentity()).toBe(true);
    expect((await control.login(request('rebuilt'))).status).toBe(200);
    expect(await old.get('administrator')).toMatchObject({version:1});
  } finally {f.db.close();}
});

test('reset consumes outstanding setup code and disabled identity keeps its id',async()=>{
  const f=fixture();
  try{
    const {code}=await prepareInitialization(f); await recoverIdentity(reset(),f);
    const control=createControl(f.host,{now:f.now}); await control.start();
    expect((await control.initialize(new Request('https://example.com/setup',{method:'POST',headers:{origin:'https://example.com'},body:JSON.stringify({setupCode:code,username:'attacker',password,passwordConfirmation:password})}))).status).toBe(409);
    const account=((await f.durableState.list()).find(r=>r.key.startsWith('user:')))!,value=account.value as any; value.user.disabled=true;
    await f.durableState.transact([{key:account.key,expectedVersion:account.version,value}]);
    expect(await control.hasIdentity()).toBe(false);
    await expect(control.bootstrap({username:'owner',password})).rejects.toThrow('invalid_credentials');
    const result=await recoverIdentity(reset(),f); expect(result.id).toBe(value.user.id);
    await expect(prepareInitialization(f)).rejects.toThrow('already_initialized');
  } finally{f.db.close();}
});
