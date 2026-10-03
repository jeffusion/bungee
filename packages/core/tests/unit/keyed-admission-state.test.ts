import {expect,test} from 'bun:test';
import {KeyedAdmissionState} from '../../src/data-admission/keyed-state';
import {DataAdmissionHost} from '../../src/data-admission/host';
import {createIngress,validatePolicy} from '../../../../plugins/key-rate-limit/server/policy';
import type {AdmissionTarget} from '../../src/plugin-extensions';
import type {RateLimitWorkerIdentity} from '../../src/rate-limit';
const worker = {role:'worker',master_generation:'m',process_instance_id:'p',boot_nonce:'b',worker_slot:0} as RateLimitWorkerIdentity;
const target = (key='k'):AdmissionTarget => ({requestId:crypto.randomUUID(),attemptId:'a',principal:{domain:'data',keyId:key,credentialVersion:1},routeId:'r',serviceId:null,upstreamId:'u',url:'http://localhost',model:null,now:0});
function fixture(capacity=10000) {
  let now=0, reject=false, version=0;
  const host = new DataAdmissionHost({clock:()=>now,authorizeWorker:()=> 'active',catalogHash:()=> 'hash',loadPlugin:async entry=>({createIngress:()=> {
    if(entry==='identity')return {resolveIdentity:(t:AdmissionTarget)=>t.principal,plan:()=>({snapshot:null})};
    if(entry==='gate')return {plan:()=>reject?{denial:{status:403 as const,error:'gate'}}:{snapshot:null}};
    const rate=createIngress();rate.keyedState={...rate.keyedState!,capacity};return rate;
  }})});
  const publish = (byKey:any)=>host.publish({version:++version,plugins:[{name:'identity',entry:'identity',catalogHash:'hash',policy:null},{name:'rate',entry:'rate',catalogHash:'hash',policy:{byKey}},{name:'gate',entry:'gate',catalogHash:'hash',policy:null}]});
  return {host,publish,clock:(n:number)=>now=n,reject:(v:boolean)=>reject=v,store:()=> (host as any).plugins[1].keyed as KeyedAdmissionState};
}
test('indexed expiry heap stays bounded through updates and matches expiry order',()=>{
 const store=new KeyedAdmissionState(200);const due=new Map<string,number>();
 for(let i=0;i<5000;i++){const k=String((i*37)%200),at=(i*79)%3000;store.set(k,i,at);due.set(k,at);}
 expect(store.size).toBe(200);expect((store as any).heap.length).toBe(200);
 for(let now=0;now<=3000;now+=13){const expired=[...due].filter(([,at])=>at<=now);expect(store.sweep(now,200)).toBe(expired.length);for(const [k]of expired)due.delete(k);expect(store.size).toBe(due.size);}
 expect(store.size).toBe(0);
});
test('bucket cleanup waits for full refill, capacity rejects debt eviction, and timed cleanup needs no traffic',async()=>{
 const f=fixture(2);const p={rps:1,burst:2};await f.publish({k:p,b:p,c:p});
 try {
  f.host.admit(target(),worker);f.host.admit(target(),worker);f.host.admit(target('b'),worker);
  expect(()=>f.host.admit(target('c'),worker)).toThrow('admission_key_capacity');
  f.clock(999);f.host.sweepKeyedState();expect(f.store().size).toBe(2);
  f.clock(1000);f.host.sweepKeyedState();expect(f.store().size).toBe(1); // only b is full
  expect(f.store().get('k')).not.toBeNull();f.host.admit(target('c'),worker);
  f.clock(2000);await Bun.sleep(1100);expect(f.store().size).toBe(0);
  f.host.admit(target(),worker);f.host.admit(target(),worker);expect(()=>f.host.admit(target(),worker)).toThrow('exhausted');
 }finally{f.host.dispose();}
});
test('preview and later denial never debit; delayed commit refills against current time; grants do not retain bucket tables',async()=>{
 const f=fixture();await f.publish({k:{rps:1,burst:1}});
 try {
  f.reject(true);expect(()=>f.host.admit(target(),worker)).toThrow('gate');expect(f.store().size).toBe(0);f.reject(false);
  const t=target(),preview=f.host.admit(t,worker,true);expect(f.store().size).toBe(0);
  f.clock(2000);f.host.admit(t,worker,false,preview.version);expect((f.store().get('k') as any).at).toBe(2000);
  expect((f.host as any).grants.get(t.requestId).plugins[1].keyed).toBeUndefined();
  expect(()=>f.host.admit(target(),worker)).toThrow('exhausted');f.host.beforeAttempt(t,worker);expect(()=>f.host.admit(target(),worker)).toThrow('exhausted');
 }finally{f.host.dispose();}
});
test('publication accrues old rate before new rate and recomputes expiry without granting capacity',async()=>{
 const f=fixture();await f.publish({k:{rps:1,burst:2}});
 try {
  f.host.admit(target(),worker);f.host.admit(target(),worker);f.clock(500);
  await f.publish({k:{rps:2,burst:4,unit:'minute'}});
  expect(f.store().get('k')).toEqual({tokens:0.5,at:500,rps:2,burst:4});
  f.clock(2000);f.host.sweepKeyedState();expect(f.store().size).toBe(1);
  f.clock(2250);f.host.sweepKeyedState();expect(f.store().size).toBe(0);
  f.host.admit(target(),worker);await f.publish({});expect(f.store().size).toBe(1);
  f.clock(2750);f.host.sweepKeyedState();expect(f.store().size).toBe(0);
 }finally{f.host.dispose();}
});
test('unit metadata remains compatible and unrepresentable expiry is rejected',()=>{
 expect(validatePolicy({rps:1,burst:2})).toEqual({rps:1,burst:2});
 expect(validatePolicy({rps:1,burst:2,unit:'minute'})).toEqual({rps:1,burst:2,unit:'minute'});
 expect(()=>validatePolicy({rps:Number.MIN_VALUE,burst:1})).toThrow();
});


test('disposing during asynchronous plugin load prevents publication and timer resurrection',async()=>{
 let resume!:()=>void;const gate=new Promise<void>(resolve=>resume=resolve);
 const host=new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> 'hash',loadPlugin:async()=>{await gate;return {createIngress};}});
 const pending=host.publish({version:1,plugins:[{name:'rate',entry:'rate',catalogHash:'hash',policy:{byKey:{}}}]});
 host.dispose();resume();await expect(pending).rejects.toThrow('disposed');
 expect((host as any).cleanupTimer).toBeNull();expect((host as any).plugins).toEqual([]);
 await expect(host.publish({version:2,plugins:[]})).rejects.toThrow('disposed');
 expect(()=>host.admit(target(),worker)).toThrow('admission_state_unavailable');
});


test('a fully refilled bucket behaves identically on policy change before or after cleanup',async()=>{
 for(const sweep of [false,true]) {
  const f=fixture();await f.publish({k:{rps:1,burst:1}});
  try {
   f.host.admit(target(),worker);f.clock(1000);if(sweep)f.host.sweepKeyedState();
   await f.publish({k:{rps:1,burst:2}});expect(f.store().size).toBe(0);
   f.host.admit(target(),worker);f.host.admit(target(),worker);expect(()=>f.host.admit(target(),worker)).toThrow('exhausted');
  }finally{f.host.dispose();}
 }
});
