import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore, type DurableJson} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, readManagementSetup, recoverIdentity, addUserOffline, resetUserPasswordOffline} from '../../server/control';
const password='Unicode 空格 密码 123456789';
const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
 const db=new Database(':memory:');databases.push(db);db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const durableState=new PluginDurableStateStore(db).forNamespace('user-auth');let now=1_000_000;
 const host={signal:new AbortController().signal,durableState,storage:{} as never,secretStore:{} as never};
 return {db,durableState,host,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
const input=(extra:Record<string,unknown>={})=>({username:'owner',password,passwordConfirmation:password,...extra});
function initialize(extra:Record<string,unknown>={},origin='https://example.com'){
 return new Request('https://example.com/setup',{method:'POST',headers:{origin},body:JSON.stringify(input(extra))});
}
const login=(p=password)=>new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username:'owner',password:p,transport:'bearer'})});
async function pendingCode(f:ReturnType<typeof fixture>){
 await f.durableState.transact([
  {key:'setup',expectedVersion:0,value:{schema:3,setup:{phase:'uninitialized',code:{digest:'a'.repeat(64),expiresAt:2_800_000}}}},
  {key:'clock',expectedVersion:0,value:{schema:3,observedThrough:1_000_000}},
 ]);
}
test.each([' 😀 甲 ', '😀'.repeat(32)])('initialization accepts 5–32 Unicode characters without trimming (%j)',async value=>{
 const f=fixture(),control=createControl(f.host,{now:f.now});await control.start();
 for(const invalid of ['x'.repeat(4),'😀'.repeat(4),'x'.repeat(33),'😀'.repeat(33)]){
  const response=await control.initialize(initialize({password:invalid,passwordConfirmation:invalid}));
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid_password'});
  expect(await control.setupStatus()).toBe('uninitialized');
 }
 expect((await control.initialize(initialize({password:value,passwordConfirmation:value}))).status).toBe(200);
 expect((await control.login(login(value))).status).toBe(200);
});
test('setup reader is read-only; real start creates only pending setup and clock with CAS',async()=>{
 const f=fixture();expect(await readManagementSetup(f.durableState)).toEqual({initialized:false});
 expect(await f.durableState.list()).toEqual([]);
 const a=createControl(f.host,{now:f.now}),b=createControl(f.host,{now:f.now});await Promise.all([a.start(),b.start()]);
 expect((await f.durableState.list()).map(r=>r.key).sort()).toEqual(['clock','setup']);
 expect(await f.durableState.get('setup')).toMatchObject({version:1,value:{schema:3,setup:{phase:'uninitialized'}}});
 const before=await f.durableState.list();expect(await readManagementSetup(f.durableState)).toEqual({initialized:false});expect(await f.durableState.list()).toEqual(before);
 await expect(a.bootstrap({operation:'verify',username:'owner',password})).rejects.toThrow('initialization_required');
 expect((await a.initialize(initialize({},'https://evil.example'))).status).toBe(403);
 const result=await a.initialize(initialize());expect(result.status).toBe(200);expect(await result.json()).toEqual({initialized:true});
 expect(result.headers.has('set-cookie')).toBe(false);expect((await f.durableState.list()).filter(r=>r.key.startsWith('session:'))).toHaveLength(0);
 expect(await a.setupStatus()).toBe('ready');expect((await a.login(login())).status).toBe(200);
});
test('bootstrap initialize and public initialize compete for exactly one account',async()=>{
 const f=fixture(),a=createControl(f.host,{now:f.now}),b=createControl(f.host,{now:f.now});await a.start();await b.start();
 const results=await Promise.allSettled([a.bootstrap({operation:'initialize',...input()}),b.initialize(initialize({username:'second'}))]);
 const publicResult=results[1];expect(publicResult.status).toBe('fulfilled');
 if(publicResult.status!=='fulfilled')throw new Error('missing response');
 expect(publicResult.value.status).toBe(results[0]!.status==='fulfilled'?409:200);
 if(results[0]!.status==='rejected')expect(results[0]!.reason.code).toBe('already_initialized');
 expect((await f.durableState.list()).filter(r=>r.key.startsWith('user:'))).toHaveLength(1);
 const before=await f.durableState.list();
 await expect(a.bootstrap({operation:'initialize',...input()})).rejects.toMatchObject({code:'already_initialized',status:409});
 expect((await b.initialize(initialize())).status).toBe(409);expect(await f.durableState.list()).toEqual(before);
});
test('bootstrap validates explicit operations and input errors without creating accounts; verify never writes identity',async()=>{
 const f=fixture(),c=createControl(f.host,{now:f.now});await c.start();const before=await f.durableState.list();
 for(const value of [input(),{operation:'unknown',...input()},{operation:'initialize',...input({passwordConfirmation:'mismatch'})},{operation:'initialize',...input({password:'tiny'})},{operation:'initialize',...input({setupCode:'retired'})},{operation:'verify',username:'owner',password,passwordConfirmation:password}]){
  await expect(c.bootstrap(value)).rejects.toMatchObject({code:'invalid_input',status:400});expect(await f.durableState.list()).toEqual(before);
 }
 expect((await c.initialize(initialize({setupCode:'retired'}))).status).toBe(400);
 await c.bootstrap({operation:'initialize',...input()});const ready=await f.durableState.list();
 await c.bootstrap({operation:'verify',username:'OWNER',password});
 await expect(c.bootstrap({operation:'verify',username:'missing',password})).rejects.toThrow('invalid_credentials');
 expect(await f.durableState.list()).toEqual(ready);
});
test('pending schema-3 code can be queried without writes; start removes it once before current validation',async()=>{
 const f=fixture();await pendingCode(f);const before=await f.durableState.list();
 expect(await readManagementSetup(f.durableState)).toEqual({initialized:false});expect(await f.durableState.list()).toEqual(before);
 const c=createControl(f.host,{now:f.now});await c.start();
 expect(await f.durableState.get('setup')).toMatchObject({version:2,value:{schema:3,setup:{phase:'uninitialized'}}});
 const cleaned=await f.durableState.list();await createControl(f.host,{now:f.now}).start();expect(await f.durableState.list()).toEqual(cleaned);
 expect((await c.initialize(initialize())).status).toBe(200);
});
test.each(['add-user','reset-password','reset'])('offline %s removes retired code before validating current state',async operation=>{
 const f=fixture();await pendingCode(f);
 const value={operation,...input()};
 if(operation==='add-user')await addUserOffline(value,f);
 else if(operation==='reset')await recoverIdentity({...value,reason:'recover pending setup'},f);
 else await expect(resetUserPasswordOffline(value,f)).rejects.toThrow('not_found');
 expect(JSON.stringify((await f.durableState.get('setup'))!.value)).not.toContain('code');
});
test.each([1,2,4])('unsupported setup schema %s does not get converted',async schema=>{
 const f=fixture();await f.durableState.transact([{key:'setup',expectedVersion:0,value:{schema,setup:{phase:'uninitialized',code:{digest:'a'.repeat(64),expiresAt:1}}}}]);
 const before=await f.durableState.list();await expect(readManagementSetup(f.durableState)).rejects.toThrow('corrupt_state');await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');expect(await f.durableState.list()).toEqual(before);
});
test('ready setup with every user lost stays closed and cannot be initialized again',async()=>{
 const f=fixture(),c=createControl(f.host,{now:f.now});await c.start();await c.bootstrap({operation:'initialize',...input()});
 f.db.query("DELETE FROM plugin_durable_records WHERE namespace = ? AND (key LIKE 'user:%' OR key LIKE 'credential:%')").run('user-auth');
 const before=await f.durableState.list();await expect(readManagementSetup(f.durableState)).rejects.toThrow('corrupt_state');await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');
 expect((await c.initialize(initialize())).status).toBe(503);expect(await f.durableState.list()).toEqual(before);
});

test.each([
 {phase:'ready',code:{digest:'a'.repeat(64),expiresAt:1}},
 {phase:'uninitialized',code:{digest:'invalid',expiresAt:1}},
 {phase:'uninitialized',code:{digest:'a'.repeat(64),expiresAt:1,unexpected:true}},
])('malformed setup code records fail closed without cleanup (%j)',async setup=>{
 const f=fixture();await f.durableState.transact([{key:'setup',expectedVersion:0,value:{schema:3,setup:setup as DurableJson}},{key:'clock',expectedVersion:0,value:{schema:3,observedThrough:1}}]);
 const before=await f.durableState.list();
 await expect(readManagementSetup(f.durableState)).rejects.toThrow('corrupt_state');await expect(createControl(f.host,{now:f.now}).start()).rejects.toThrow('corrupt_state');
 expect(await f.durableState.list()).toEqual(before);
});
