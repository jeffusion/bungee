import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PluginStateClient } from '../../../src/plugin-state/client';
import { initializePluginStateDatabase } from '../../../src/plugin-state/schema';
import type { RpcCommandExecution } from '../../../src/plugin-services/rpc-runtime';
import type { CommandAtomicPlanner } from '../../../src/plugin-services/command-journal';
const clients:PluginStateClient[]=[];const dirs:string[]=[];
afterEach(async()=>{for(const client of clients.splice(0))await client.close().catch(()=>undefined);for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(file=false) {
  const dir=mkdtempSync(join(tmpdir(),'plugin-state-client-'));dirs.push(dir);
  const path=file?join(dir,'plugin-state.db'):':memory:';
  const client=await PluginStateClient.open(path,{initialize:true,material:{keyId:'test-key',key:new Uint8Array(32).fill(7)}});clients.push(client);
  return {client,path};
}
function execution(operationId:string,kind:'local-transaction'|'external-contract'|'none'='local-transaction',business:()=>Promise<any>=async()=>({ok:true})):RpcCommandExecution<unknown> {
  const definition={kind:'command' as const,input:{type:'json' as const},output:{type:'json' as const},purposes:['background' as const],
    command:{deduplication:kind,maxResultBytes:512,resultRetentionMs:null,quotaBytes:65536}};
  return {contract:{id:'fixture',version:1,methods:{apply:definition}},method:'apply',definition,
    context:{endpoint:{process:'control',instance:'owner',catalog:'catalog',generation:1,service:'fixture',version:1,plugin:'fixture',scope:'global'} as any,
      caller:{subject:'caller',scope:'global'},method:'apply',kind:'command',purpose:'background',operationId,signal:new AbortController().signal,callee:{notCloneable:()=>null}},
    operationId,input:null,executeBusiness:business};
}
async function failure(operation:Promise<unknown>):Promise<unknown> {try {await operation;return null;}catch(error){return error;}}
describe('PluginStateClient storage Worker',()=>{
  test('ordinary CAS creates no history and isolates namespace capabilities',async()=>{
    const {client,path}=await fixture(true);const a=client.durableState('a'),b=client.durableState('b');
    expect(await a.get('value')).toBeNull();
    for(let version=0;version<40;version++)await a.transact([{key:'value',expectedVersion:version,value:{n:version}}]);
    await b.transact([{key:'value',expectedVersion:0,value:'b'}]);
    expect(await failure(a.transact([{key:'value',expectedVersion:0,value:'stale'}]))).toMatchObject({code:'durable_state_conflict'});
    expect(await b.get('value')).toMatchObject({version:1,value:'b'});expect(await a.list()).toHaveLength(1);
    await client.close();const db=new Database(path,{readonly:true});
    expect(db.query("SELECT name FROM sqlite_master WHERE name='plugin_durable_commands'").get()).toBeNull();
    expect(db.query('SELECT count(*) AS n FROM plugin_durable_records').get()).toEqual({n:2});db.close();
  });
  test('SQLite lock contention does not block the controlling event loop',async()=>{
    const {client,path}=await fixture(true),state=client.durableState('slow');
    await state.get('record');const db=new Database(path);db.exec('BEGIN IMMEDIATE');
    let ticks=0;const timer=setInterval(()=>ticks++,5);const started=performance.now();
    const write=state.transact([{key:'record',expectedVersion:0,value:'after-lock'}]);
    await new Promise(resolve=>setTimeout(resolve,90));db.exec('ROLLBACK');
    await write;clearInterval(timer);db.close();
    expect(ticks).toBeGreaterThan(5);expect(performance.now()-started).toBeGreaterThan(70);
  });
  test('state and reliable event are one atomic commit and failed CAS publishes nothing',async()=>{
    const {client}=await fixture();const state=client.durableState('owner');
    const log=client.eventLog('owner','changes',2,1);
    const first=await log.appendWithState!(new Uint8Array([1]),[{key:'state',expectedVersion:0,value:1}]);expect(first.sequence).toBe(1);
    expect(await failure(log.appendWithState!(new Uint8Array([2]),[{key:'state',expectedVersion:0,value:2}]))).toMatchObject({code:'durable_state_conflict'});
    expect(await state.get('state')).toMatchObject({version:1,value:1});expect(await log.latestSequence()).toBe(1);
    await state.transact([{key:'state',expectedVersion:1,value:3}],{outbox:{topic:'changes',major:1,maxEvents:2,payload:new Uint8Array([3])}});
    expect(await log.latestSequence()).toBe(2);expect((await log.list(1,10)).map(item=>item.payload[0])).toEqual([1,3]);
  });
  test('a later CAS conflict rolls back earlier state writes',async()=>{
    const {client}=await fixture(), state=client.durableState('rollback');
    await state.transact([{key:'first',expectedVersion:0,value:1},{key:'second',expectedVersion:0,value:1}]);
    expect(await failure(state.transact([{key:'first',expectedVersion:1,value:2},{key:'second',expectedVersion:0,value:2}]))).toMatchObject({code:'durable_state_conflict'});
    expect(await state.get('first')).toMatchObject({version:1,value:1});
  });
  test('secret ciphertext, version fences and committed KV are preserved',async()=>{
    const {client,path}=await fixture(true);const secret=client.secretStore('secrets'),other=client.secretStore('other'),storage=client.pluginStorage('kv');
    expect(await secret.compareAndSet('token',null,'plaintext-secret')).toBe(1);expect(await other.get('token')).toBeNull();
    expect(await secret.get('token')).toEqual({version:1,value:'plaintext-secret'});
    expect(await failure(secret.compareAndSet('token',null,'overwrite'))).toMatchObject({code:'version_conflict'});
    await storage.set('object',{count:1});expect(await storage.increment('object','count',2)).toBe(3);
    expect(await storage.readStrict!('object')).toEqual({found:true,value:{count:3}});await storage.set('null',null);
    expect(await storage.readStrict!('null')).toEqual({found:true,value:null});
    await client.close();const db=new Database(path,{readonly:true});const row=db.query<{envelope:Uint8Array},[]>('SELECT envelope FROM secret_store_objects').get()!;
    expect(Buffer.from(row.envelope).includes(Buffer.from('plaintext-secret'))).toBe(false);db.close();
  });
  test('journal plans stay on control, replay skips planning, missing read and list phantom conflict',async()=>{
    const {client}=await fixture();let plans=0;
    const planner:CommandAtomicPlanner=reader=>{plans++;const old=reader.get('counter');return {mutations:[{key:'counter',expectedVersion:old?.version??0,value:1}],result:{ok:true}};};
    const journal=client.journal({namespace:'rpc.test',privateStateNamespace:'owner',atomicReadSet:()=>({keys:['counter']}),resolveAtomic:()=>planner});
    expect(await journal.execute(execution('once'))).toEqual({ok:true});expect(await journal.execute(execution('once'))).toEqual({ok:true});expect(plans).toBe(1);
    const state=client.durableState('owner');let concurrent:Promise<unknown>|undefined;
    const phantom=client.journal({namespace:'rpc.phantom',privateStateNamespace:'owner',atomicReadSet:()=>({list:true}),resolveAtomic:()=>reader=>{
      reader.list();concurrent=state.transact([{key:'inserted',expectedVersion:0,value:1}]);return {mutations:[],result:{ok:true}};
    }});
    expect(await failure(phantom.execute(execution('phantom')))).toMatchObject({code:'conflict'});await concurrent;
    const missing=client.journal({namespace:'rpc.missing',privateStateNamespace:'owner',atomicReadSet:()=>({keys:['absent']}),resolveAtomic:()=>reader=>{
      expect(reader.get('absent')).toBeNull();concurrent=state.transact([{key:'absent',expectedVersion:0,value:1}]);return {mutations:[],result:{ok:true}};
    }});
    expect(await failure(missing.execute(execution('missing')))).toMatchObject({code:'conflict'});await concurrent;
  });
  test('business callback runs in control frame after reservation; unknown is never retried',async()=>{
    const {client}=await fixture();const frames=new AsyncLocalStorage<string>();let calls=0;
    const journal=client.journal({namespace:'rpc.external',privateStateNamespace:'owner'});
    const command=execution('lost','none',async()=>{calls++;expect(frames.getStore()).toBe('real-host-frame');
      expect((await journal.inspect('lost',{subject:'caller',scope:'global'})).status).toBe('pending');
      await client.pluginStorage('callback').set('progress',true);throw new Error('lost reply');});
    expect(await failure(frames.run('real-host-frame',()=>journal.execute(command)))).toMatchObject({code:'unknown'});
    expect(await failure(journal.execute(command))).toMatchObject({code:'unknown'});expect(calls).toBe(1);
    expect(await client.pluginStorage('callback').get<boolean>('progress')).toBe(true);
  });
  test('external reconciliation remains in its exact control frame and preserves opaque callee',async()=>{
    const {client}=await fixture();const frames=new AsyncLocalStorage<string>();let reconciliations=0;
    const command=execution('external-lost','external-contract',async()=>{throw new Error('lost response');});
    const journal=client.journal({namespace:'rpc.reconcile',privateStateNamespace:'owner',resolveExternal:request=>{
      expect(typeof (request.context.callee as any).notCloneable).toBe('function');
      return {reconcile:async original=>{reconciliations++;expect(original.context.callee).toBe(command.context.callee);
        expect(frames.getStore()).toBe('reconciliation-frame');return {status:'committed',result:{confirmed:true}};}};
    }});
    expect(await failure(journal.execute(command))).toMatchObject({code:'unknown'});
    const {executeBusiness,...request}=command;
    expect(await frames.run('reconciliation-frame',()=>journal.reconcile(request))).toEqual({confirmed:true});
    expect(await journal.execute(command)).toEqual({confirmed:true});expect(reconciliations).toBe(1);
  });
  test('callback results refuse getters without leaving a pending operation',async()=>{
    const {client}=await fixture();let reads=0;
    const result=Object.defineProperty({},'hostile',{enumerable:true,get(){reads++;return 1;}});
    const journal=client.journal({namespace:'rpc.hostile-result',privateStateNamespace:'owner'});
    expect(await failure(journal.execute(execution('hostile','none',async()=>result)))).toMatchObject({code:'unknown'});
    expect(reads).toBe(0);expect((await journal.inspect('hostile',{subject:'caller',scope:'global'})).status).toBe('unknown');
  });
  test('snapshot family references stay inside Worker across facades and GC',async()=>{
    const {client}=await fixture();const a=client.snapshotStore('owner',{id:'family',schemaVersion:1,maxVersions:1,chunkBytes:3});
    const b=client.snapshotStore('owner',{id:'family',schemaVersion:1,maxVersions:1,chunkBytes:3});
    await a.publish(1,new Uint8Array([1,2,3,4]));const retained=await a.version(1);expect(retained).not.toBeNull();
    await b.publish(2,new Uint8Array([5,6,7]));expect(await retained!.read(0,4)).toEqual(new Uint8Array([1,2,3,4]));
    const also=await b.version(1);expect(also).not.toBeNull();await also!.release?.();await retained!.release?.();
    expect(await b.collect()).toBe(1);expect(await a.version(1)).toBeNull();
    const current=await a.current();expect(current?.descriptor.version).toBe(2);await current?.release?.();
  });
  test('remote KV capabilities bind namespace and revoke immediately',async()=>{
    const {client}=await fixture();
    const {createRemotePluginStorageFactory}=await import('../../../src/plugin-state/storage-rpc');
    const factory=createRemotePluginStorageFactory((namespace,operation,args)=>client.storageOperation(namespace,operation,args));
    const a=factory.create('worker-a'),b=factory.create('worker-b');
    await a.set('shared',{n:1});expect(await b.get('shared')).toBeNull();
    expect(await a.uncached!().compareAndSet('shared','n',1,2)).toBe(true);
    expect(await a.get<{n:number}>('shared')).toEqual({n:2});factory.revoke?.(a);
    expect(await failure(a.get('shared'))).toMatchObject({message:'plugin_storage_capability_revoked'});
    const secret=client.secretStore('revoked');await secret.get('key');secret.revoke();
    expect(await failure(secret.get('key'))).toMatchObject({code:'handle_revoked'});
  });
  test('IPC rejects getters without evaluating them',async()=>{
    const {client}=await fixture();let reads=0;
    const value=Object.defineProperty({},'hostile',{enumerable:true,get(){reads++;return 1;}});
    const state=client.durableState('pure');
    expect(await failure(state.transact([{key:'record',expectedVersion:0,value:value as any}]))).toMatchObject({message:'Durable state must be pure JSON'});
    expect(reads).toBe(0);expect(await state.get('record')).toBeNull();
  });
  test('restarted pending operations require the exact saved owner proof',async()=>{
    const {client,path}=await fixture(true);let started!:()=>void;
    const begun=new Promise<void>(resolve=>{started=resolve;});
    const accepted=client.journal({namespace:'rpc.owner-proof',privateStateNamespace:'owner'});
    void accepted.execute(execution('pending','none',()=>{started();return new Promise(()=>undefined);})).catch(()=>undefined);
    await begun;await client.close();
    const restarted=await PluginStateClient.open(path);clients.push(restarted);
    const absent=restarted.journal({namespace:'rpc.owner-proof',privateStateNamespace:'owner'});
    expect(await absent.recoverPending()).toBe(0);
    const wrong=restarted.journal({namespace:'rpc.owner-proof',privateStateNamespace:'owner',authorizeRecovery:request=>({owner:'other-owner',epoch:request.epoch,issuedAt:Date.now()})});
    expect(await wrong.recoverPending()).toBe(0);expect((await wrong.inspect('pending',{subject:'caller',scope:'global'})).status).toBe('pending');
    const exact=restarted.journal({namespace:'rpc.owner-proof',privateStateNamespace:'owner',authorizeRecovery:async request=>({owner:request.owner,epoch:request.epoch,issuedAt:Date.now()})});
    expect(await exact.recoverPending()).toBe(1);expect((await exact.inspect('pending',{subject:'caller',scope:'global'})).status).toBe('unknown');
    expect(await failure(exact.execute(execution('pending','none')))).toMatchObject({code:'unknown'});
  });
  test('unversioned nonempty databases are rejected without modification',()=>{
    const db=new Database(':memory:');db.exec('CREATE TABLE plugin_durable_commands(id TEXT)');
    expect(()=>initializePluginStateDatabase(db)).toThrow('plugin_state_version_unsupported');expect(db.query("SELECT name FROM sqlite_master WHERE name='plugin_durable_commands'").get()).not.toBeNull();db.close();
  });
});

describe('production PluginStateClient failure and bounded read-set regressions',()=>{
  const faultUrl=new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url);
  const directory=()=>{const dir=mkdtempSync(join(tmpdir(),'state-fault-'));dirs.push(dir);return dir;};
  test('a 257-row namespace permits a one-row lookup and enforces declared rows and bytes',async()=>{
    const {client}=await fixture();const state=client.durableState('wide');
    for(let n=0;n<257;n++)await state.transact([{key:`k${String(n).padStart(3,'0')}`,expectedVersion:0,value:n===0?1:123456}]);
    let invocations=0;
    const journal=client.journal({namespace:'rpc.point',privateStateNamespace:'wide',atomicReadRows:1,atomicReadBytes:1,atomicReadQueries:2,
      atomicReadSet:()=>({keys:['k000']}),resolveAtomic:()=>reader=>{invocations++;expect(reader.get('k000')?.value).toBe(1);return {mutations:[],result:{ok:true}};}});
    expect(await journal.execute(execution('wide-point'))).toEqual({ok:true});expect(invocations).toBe(1);
    const excessive=client.journal({namespace:'rpc.bytes',privateStateNamespace:'wide',atomicReadRows:1,atomicReadBytes:1,
      atomicReadSet:()=>({keys:['k001']}),resolveAtomic:()=>()=>{throw new Error('must not invoke');}});
    expect(await failure(excessive.execute(execution('excess-bytes')))).toMatchObject({code:'overloaded'});
    const undeclared=client.journal({namespace:'rpc.undeclared',privateStateNamespace:'wide',atomicReadSet:()=>({keys:['k000']}),
      resolveAtomic:()=>reader=>{reader.get('k001');return {mutations:[],result:null};}});
    expect(await failure(undeclared.execute(execution('undeclared')))).toMatchObject({code:'capability_unavailable'});
    const absentDeclaration=client.journal({namespace:'rpc.no-declaration',privateStateNamespace:'wide',resolveAtomic:()=>()=>({mutations:[],result:null})});
    expect(await failure(absentDeclaration.execute(execution('no-declaration')))).toMatchObject({code:'capability_unavailable'});
  });
  test('a tail insertion from 256 to 257 rows cannot pass a complete-list read fence',async()=>{
    const {client}=await fixture();const state=client.durableState('phantom');
    for(let n=0;n<256;n++)await state.transact([{key:`k${String(n).padStart(3,'0')}`,expectedVersion:0,value:n}]);
    let concurrent:Promise<unknown>|undefined;
    const journal=client.journal({namespace:'rpc.full-list',privateStateNamespace:'phantom',atomicReadSet:()=>({list:true}),resolveAtomic:()=>reader=>{
      expect(reader.list()).toHaveLength(256);concurrent=state.transact([{key:'zzz',expectedVersion:0,value:1}]);
      return {mutations:[{key:'effect',expectedVersion:0,value:true}],result:{ok:true}};
    }});
    expect(await failure(journal.execute(execution('tail-phantom')))).toMatchObject({code:'conflict'});await concurrent;
    expect(await state.get('effect')).toBeNull();expect(await state.list()).toHaveLength(257);
  });
  test('real silent Worker bounds pending count and bytes, settles reads by deadline and retains close failure',async()=>{
    let failures=0;const client=await PluginStateClient.open(join(directory(),'silent.db'),{initialize:true,workerUrl:faultUrl,
      maxPendingRequests:1,maxPendingBytes:1024,requestTimeoutMs:250,onWorkerFailure:()=>{failures++;}});clients.push(client);
    const state=client.durableState('reader');await new Promise(resolve=>setTimeout(resolve,10));
    const first=state.get('first').catch(error=>error);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(await failure(state.get('second'))).toMatchObject({code:'queue_full'});
    expect(await first).toMatchObject({code:'request_timeout'});expect(failures).toBe(1);
    expect(await failure(client.close())).toMatchObject({code:'request_timeout'});
    expect(await failure(client.close())).toMatchObject({code:'request_timeout'});
    const bytesClient=await PluginStateClient.open(join(directory(),'bytes.db'),{initialize:true,maxPendingBytes:256});clients.push(bytesClient);
    const bytesState=bytesClient.durableState('bytes');await bytesState.get('warm');
    expect(await failure(bytesState.transact([{key:'large',expectedVersion:0,value:'x'.repeat(300)}]))).toMatchObject({code:'queue_full'});
    expect(await bytesState.get('large')).toBeNull();
  });
  test('concurrent close shares one promise and closing refuses new admissions',async()=>{
    const {client}=await fixture();const state=client.durableState('close');await state.get('warm');
    const close=client.close();expect(client.close()).toBe(close);
    expect(await failure(state.transact([{key:'late',expectedVersion:0,value:true}]))).toMatchObject({code:'request_failed'});
    await close;await client.close();
  });
  test('silent close has its own deadline, notifies failure once and never claims release',async()=>{
    let failures=0;const client=await PluginStateClient.open(join(directory(),'silent-close.db'),{initialize:true,workerUrl:faultUrl,
      closeTimeoutMs:60,onWorkerFailure:()=>{failures++;}});clients.push(client);
    const close=client.close();expect(client.close()).toBe(close);
    expect(await failure(close)).toMatchObject({code:'request_timeout'});expect(failures).toBe(1);
    expect(await failure(client.close())).toMatchObject({code:'request_timeout'});
  });
  test('real SQLite lock timeout classifies sent write unknown and sent read as failed, with timers responsive',async()=>{
    const dir=directory(),path=join(dir,'locked.db');
    const client=await PluginStateClient.open(path,{initialize:true,requestTimeoutMs:250});clients.push(client);
    const state=client.durableState('locked');await state.get('warm');
    const blocker=new Database(path);blocker.exec('BEGIN IMMEDIATE');let ticks=0;const timer=setInterval(()=>ticks++,5);
    try {
      const write=state.transact([{key:'blocked',expectedVersion:0,value:true}]).catch(error=>error);
      const read=state.get('blocked').catch(error=>error);
      expect(await write).toMatchObject({code:'result_unknown',operationId:null});
      expect(await read).toMatchObject({code:'request_timeout'});expect(ticks).toBeGreaterThan(5);
      expect(await failure(client.close())).toMatchObject({code:'request_timeout'});
    } finally {clearInterval(timer);blocker.exec('ROLLBACK');blocker.close();}
  });
  test('real production Worker commits then exits before ACK; original journal ID recovers with no replanning',async()=>{
    const path=join(directory(),'lost-ack.db');let calls=0;
    const client=await PluginStateClient.open(path,{initialize:true,workerUrl:faultUrl});clients.push(client);
    const opts={namespace:'rpc.crash',privateStateNamespace:'crash',atomicReadSet:()=>({keys:['counter']}),resolveAtomic:()=> (reader:any)=>{
      calls++;const old=reader.get('counter');return {mutations:[{key:'counter',expectedVersion:old?.version??0,value:1}],result:{ok:true}};
    }};
    expect(await failure(client.journal(opts).execute(execution('original-crash-id')))).toMatchObject({code:'result_unknown',operationId:'original-crash-id'});
    expect(await failure(client.close())).toMatchObject({code:'worker_failed'});
    const restarted=await PluginStateClient.open(path);clients.push(restarted);
    expect(await restarted.durableState('crash').get('counter')).toMatchObject({version:1,value:1});
    const journal=restarted.journal(opts);
    expect((await journal.inspect('original-crash-id',{subject:'caller',scope:'global'})).status).toBe('committed');
    expect(await journal.execute(execution('original-crash-id'))).toEqual({ok:true});expect(calls).toBe(1);
  });
});

test('executor evidence paging reaches beyond 256 proofs and pending lookup uses exact source identity',async()=>{
  const {client}=await fixture();const proofs=client.channelStore('host:rpc:executors');
  for(let n=0;n<257;n++)await proofs.put(`proof${String(n).padStart(3,'0')}`,new Uint8Array([n%256]),{required:true});
  const first=await client.executorProofPage('',256);expect(first).toHaveLength(256);
  expect(await client.executorProofPage(first.at(-1)!.key,8)).toEqual([{key:'proof256'}]);
  const source={process:'control',instance:'owner',catalog:'catalog',generation:1};
  expect(await client.executorHasPending(source)).toBe(false);
  let started!:()=>void,finish!:(value:any)=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  const result=new Promise<any>(resolve=>{finish=resolve;});
  const journal=client.journal({namespace:'rpc.proof-page',privateStateNamespace:'owner'});
  const pending=journal.execute(execution('proof-pending','none',()=>{started();return result;}));
  await begun;expect(await client.executorHasPending(source)).toBe(true);
  expect(await client.executorHasPending({...source,generation:2})).toBe(false);
  finish({ok:true});expect(await pending).toEqual({ok:true});expect(await client.executorHasPending(source)).toBe(false);
});

describe('public admission while production capability creation is silent',()=>{
  test('waiting capability methods occupy request slots immediately, including their deadlines',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-capability-'));dirs.push(dir);
    let notifications=0;
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:8,requestTimeoutMs:400,
      onWorkerFailure:()=>{notifications++;}});clients.push(client);
    const state=client.durableState('waiting');
    // No readiness sleep: creation and ALL public calls begin in the same turn.
    const calls=Array.from({length:1000},(_,n)=>state.get(`key${n}`).then(()=> 'unexpected',error=>error.code));
    const settled=await Promise.all(calls);
    expect(settled.filter(code=>code==='queue_full')).toHaveLength(993);
    expect(settled.filter(code=>code==='request_timeout')).toHaveLength(7);
    expect(notifications).toBe(1);expect(await failure(client.close())).toMatchObject({code:'request_timeout'});
  });
  test('queued write arguments consume bytes while their capability is unready and remain definitely unsent',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-cap-bytes-'));dirs.push(dir);
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:128,maxPendingBytes:300,requestTimeoutMs:400});clients.push(client);
    const state=client.durableState('waiting');
    const calls=Array.from({length:20},(_,n)=>state.transact([{key:`key${n}`,expectedVersion:0,value:'x'.repeat(100)}]).then(()=> 'unexpected',error=>error.code));
    const settled=await Promise.all(calls);
    expect(settled.filter(code=>code==='queue_full').length).toBeGreaterThanOrEqual(18);
    expect(settled).not.toContain('result_unknown');expect(settled).toContain('request_timeout');
  });
  test('journal methods and release waiting for creation share the same bounded admission',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-journal-cap-'));dirs.push(dir);
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:4,requestTimeoutMs:400});clients.push(client);
    const journal=client.journal({namespace:'rpc.waiting-cap',privateStateNamespace:'owner'});
    const calls=Array.from({length:100},(_,n)=>journal.inspect(`waiting-${n}`,{subject:'caller'}).then(()=> 'unexpected',error=>error.code));
    const close=journal.close().catch(error=>error.code);const same=journal.close();
    expect(journal.close()).toBe(same);expect(await close).toBe('request_timeout');await same.catch(()=>undefined);
    const settled=await Promise.all(calls);
    expect(settled.filter(code=>code==='queue_full')).toHaveLength(97);
    expect(settled.filter(code=>code==='request_timeout')).toHaveLength(3);
  });
});

describe('bounded capability cleanup reserve',()=>{
  test('a healthy Worker releases the journal after full business slots drain and keeps the database open',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'healthy-cleanup-slots-'));dirs.push(dir);const path=join(dir,'state.db');
    const client=await PluginStateClient.open(path,{initialize:true,maxPendingRequests:2});clients.push(client);
    const journal=client.journal({namespace:'rpc.cleanup-slots',privateStateNamespace:'owner'});await journal.status();
    const state=client.durableState('owner');await state.get('warm');
    const blocker=new Database(path);blocker.exec('BEGIN IMMEDIATE');
    let releaseSettled=false;
    try{
      const write=state.transact([{key:'record',expectedVersion:0,value:1}]);
      const read=state.get('record');
      expect(await failure(state.get('overflow'))).toMatchObject({code:'queue_full'});
      const release=journal.close();expect(journal.close()).toBe(release);void release.then(()=>{releaseSettled=true;});
      await new Promise(resolve=>setTimeout(resolve,30));expect(releaseSettled).toBe(false);
      blocker.exec('ROLLBACK');await write;await read;await release;
      expect(await failure(journal.status())).toMatchObject({message:'plugin_state_capability_revoked'});
      // A capability-release ACK proves only handle reclamation, not database release.
      expect(await state.get('record')).toMatchObject({version:1,value:1});
      await client.close();expect(await failure(state.get('record'))).toMatchObject({code:'request_failed'});
    }finally{if(blocker.inTransaction)blocker.exec('ROLLBACK');blocker.close();}
  });
  test('release also has admission when business bytes are exactly full',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'healthy-cleanup-bytes-'));dirs.push(dir);const path=join(dir,'state.db');
    const byteLimit=256,client=await PluginStateClient.open(path,{initialize:true,maxPendingRequests:2,maxPendingBytes:byteLimit});clients.push(client);
    const journal=client.journal({namespace:'rpc.cleanup-bytes',privateStateNamespace:'owner'});await journal.status();
    const state=client.durableState('owner');await state.get('warm');
    const empty=[{key:'record',expectedVersion:0,value:''}];
    const value='x'.repeat(byteLimit-Buffer.byteLength(JSON.stringify([empty,undefined])));
    const blocker=new Database(path);blocker.exec('BEGIN IMMEDIATE');
    try{
      const write=state.transact([{key:'record',expectedVersion:0,value}]);
      expect(await failure(state.get('record'))).toMatchObject({code:'queue_full'});
      const release=journal.close();
      await new Promise(resolve=>setTimeout(resolve,30));blocker.exec('ROLLBACK');
      await write;await release;
      expect(await failure(journal.status())).toMatchObject({message:'plugin_state_capability_revoked'});
      expect(await state.get('record')).toMatchObject({value});
    }finally{if(blocker.inTransaction)blocker.exec('ROLLBACK');blocker.close();}
  });
  test('exhausting the finite cleanup reserve reports a resource failure and never claims database release',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'cleanup-reserve-bound-'));dirs.push(dir);const failures:string[]=[];
    const client=await PluginStateClient.open(join(dir,'silent-release.db'),{initialize:true,maxPendingRequests:2,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),onWorkerFailure:error=>{failures.push(error.code);}});clients.push(client);
    const journals=[];
    for(let n=0;n<3;n++){const journal=client.journal({namespace:`rpc.cleanup-${n}`,privateStateNamespace:'owner'});await journal.status();journals.push(journal);}
    const releases=journals.map(journal=>journal.close().then(()=> 'unexpected',error=>error.code));
    expect(await Promise.all(releases)).toEqual(['cleanup_overloaded','cleanup_overloaded','cleanup_overloaded']);
    expect(failures).toEqual(['cleanup_overloaded']);
    expect(await failure(client.close())).toMatchObject({code:'cleanup_overloaded'});
  });
});
