import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, prepareInitialization, readManagementSetup, recoverIdentity} from '../../server/control';
import type {PluginDurableState} from '../../../../packages/core/src/plugin-durable-state';
const password='Unicode 空格 密码 123456789';
const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
 const db=new Database(':memory:');databases.push(db);db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const durableState=new PluginDurableStateStore(db).forNamespace('user-auth');let now=1_000_000;
 const host={signal:new AbortController().signal,durableState,storage:{} as never,secretStore:{} as never};
 return {durableState,host,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
function initialize(code:string,extra:Record<string,unknown>={},origin='https://example.com'){
 return new Request('https://example.com/setup',{method:'POST',headers:{origin},body:JSON.stringify({setupCode:code,username:'owner',password,passwordConfirmation:password,...extra})});
}
const login=()=>new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username:'owner',password,transport:'bearer'})});
test.each([' 😀 甲 ', '😀'.repeat(32)])('initialization accepts 5–32 Unicode characters and rejects values outside the bounds (%j)',async value=>{
 const f=fixture(),issued=await prepareInitialization(f),control=createControl(f.host,{now:f.now});await control.start();
 for(const invalid of ['x'.repeat(4),'😀'.repeat(4),'x'.repeat(33),'😀'.repeat(33)]){
  const response=await control.initialize(initialize(issued.code,{password:invalid,passwordConfirmation:invalid}));
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid_password'});
  expect(await control.setupStatus()).toBe('uninitialized');expect((await f.durableState.list()).filter(r=>r.key.startsWith('user:'))).toHaveLength(0);
 }
 const response=await control.initialize(initialize(issued.code,{password:value,passwordConfirmation:value}));
 expect(response.status).toBe(200);expect(response.headers.has('set-cookie')).toBe(false);
 expect((await control.login(new Request('https://example.com/login',{method:'POST',body:JSON.stringify({username:'owner',password:value,transport:'bearer'})}))).status).toBe(200);
});
test('only offline preparation creates explicit uninitialized state; one-time code is hashed and initialization issues no session',async()=>{
 const f=fixture();expect(await readManagementSetup(f.durableState)).toEqual({initialized:false});
 expect(await f.durableState.list()).toEqual([]);
 await expect(createControl(f.host,{now:f.now}).start()).rejects.toThrow('corrupt_state');
 const issued=await prepareInitialization(f);expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(issued.expiresAt).toBe(f.now()+30*60_000);
 expect(JSON.stringify(await f.durableState.list())).not.toContain(issued.code);
 expect(await readManagementSetup(f.durableState)).toEqual({initialized:false});
 const control=createControl(f.host,{now:f.now});await control.start();expect(await control.setupStatus()).toBe('uninitialized');expect(await control.hasIdentity()).toBe(false);
 await expect(control.bootstrap({username:'owner',password})).rejects.toThrow('initialization_required');
 expect((await control.initialize(initialize(issued.code,{},'https://evil.example'))).status).toBe(403);
 const result=await control.initialize(initialize(issued.code));expect(result.status).toBe(200);expect(await result.json()).toEqual({initialized:true});expect(result.headers.has('set-cookie')).toBe(false);
 expect((await f.durableState.list()).filter(r=>r.key.startsWith('session:'))).toHaveLength(0);
 expect(await control.setupStatus()).toBe('ready');expect(await control.hasIdentity()).toBe(true);
 expect((await control.initialize(initialize(issued.code))).status).toBe(409);
 await expect(prepareInitialization(f)).rejects.toThrow('already_initialized');
 expect((await control.login(login())).status).toBe(200);
});
test('rotation consumes old codes; expiry persists across clock rollback and restart',async()=>{
 const f=fixture(),first=await prepareInitialization(f),second=await prepareInitialization(f);expect(second.code).not.toBe(first.code);
 let control=createControl(f.host,{now:f.now});await control.start();expect((await control.initialize(initialize(first.code))).status).toBe(401);
 f.advance(30*60_000);expect((await control.initialize(initialize(second.code))).status).toBe(401);
 f.advance(-30*60_000);control.dispose();control=createControl(f.host,{now:f.now});await control.start();expect((await control.initialize(initialize(second.code))).status).toBe(401);
 const next=await prepareInitialization(f);expect(next.expiresAt).toBe(4_600_000);expect((await control.initialize(initialize(next.code))).status).toBe(200);
});
test('concurrent initialization consumes the code exactly once',async()=>{
 const f=fixture(),issued=await prepareInitialization(f);const a=createControl(f.host,{now:f.now}),b=createControl(f.host,{now:f.now});await a.start();await b.start();
 const results=await Promise.all([a.initialize(initialize(issued.code)),b.initialize(initialize(issued.code))]);expect(results.map(x=>x.status).sort()).toEqual([200,409]);
 expect(((await f.durableState.list()).find(r=>r.key.startsWith('user:')))!.version).toBe(1);
});
test('source limits run before code hashing and cannot be bypassed by spoofed forwarded headers',async()=>{
 const f=fixture(),issued=await prepareInitialization(f),control=createControl(f.host,{now:f.now});await control.start();
 for(let i=0;i<10;i++)expect((await control.initialize(initialize('bad-code'))).status).toBe(401);
 expect((await control.initialize(initialize(issued.code))).status).toBe(429);
 f.advance(15*60_000);expect((await control.initialize(initialize(issued.code))).status).toBe(200);
});
test('code rotation, expiry or local reset during password hashing cannot initialize',async()=>{
 for(const mode of ['rotate','expire','reset']){
  const f=fixture(),issued=await prepareInitialization(f);let checking=false,reads=0;
  const state:PluginDurableState={get:key=>f.durableState.get(key),list:async()=>{
   if(checking&&++reads===3){
    if(mode==='rotate')await prepareInitialization(f);
    if(mode==='expire')f.advance(30*60_000);
    if(mode==='reset')await recoverIdentity({operation:'reset',username:'reset-owner',password,passwordConfirmation:password,reason:'reset while initializing'},f);
   }
   return f.durableState.list();
  },transact:mutations=>f.durableState.transact(mutations)};
  const control=createControl({...f.host,durableState:state},{now:f.now});await control.start();checking=true;const response=await control.initialize(initialize(issued.code));expect(response.status).toBe(mode==='reset'?409:401);
 }
});
test('a failed CAS cannot erase observed expiration time',async()=>{
 const f=fixture(),issued=await prepareInitialization(f);let reject=false;
 const state:PluginDurableState={get:key=>f.durableState.get(key),list:()=>f.durableState.list(),transact:async mutations=>{
  if(reject&&mutations.some(m=>m.key.startsWith('failure:'))){reject=false;throw Object.assign(new Error('conflict'),{code:'durable_state_conflict'});}return f.durableState.transact(mutations);
 }};
 const control=createControl({...f.host,durableState:state},{now:f.now});await control.start();f.advance(30*60_000);reject=true;expect((await control.initialize(initialize(issued.code))).status).toBe(401);
 f.advance(-30*60_000);expect((await control.initialize(initialize(issued.code))).status).toBe(401);
 expect((await f.durableState.get('clock'))!.value).toMatchObject({observedThrough:2_800_000});
});
