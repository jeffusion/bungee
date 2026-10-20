import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { PluginStateClient, type PluginStateOpenOptions } from '../../../src/plugin-state/client';
import { deferred, waitForState } from '../../helpers/plugin-state-progress';
import { initializePluginStateDatabase } from '../../../src/plugin-state/schema';
import type { RpcCommandExecution } from '../../../src/plugin-services/rpc-runtime';
import type { CommandAtomicPlanner } from '../../../src/plugin-services/command-journal';
const clients:PluginStateClient[]=[];const dirs:string[]=[];
afterEach(async()=>{for(const client of clients.splice(0))await client.close().catch(()=>undefined);for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(file=false,options:PluginStateOpenOptions={}) {
  const dir=mkdtempSync(join(tmpdir(),'plugin-state-client-'));dirs.push(dir);
  const path=file?join(dir,'plugin-state.db'):':memory:';
  const client=await PluginStateClient.open(path,{initialize:true,material:{keyId:'test-key',key:new Uint8Array(32).fill(7)},...options});clients.push(client);
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
    const {client,path}=await fixture(true,{closeTimeoutMs:60});let started!:()=>void;
    const begun=new Promise<void>(resolve=>{started=resolve;});
    const accepted=client.journal({namespace:'rpc.owner-proof',privateStateNamespace:'owner'});
    void accepted.execute(execution('pending','none',()=>{started();return new Promise(()=>undefined);})).catch(()=>undefined);
    await begun;expect(await failure(client.close())).toMatchObject({code:'close_unconfirmed'});
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
      maxPendingRequests:1,maxPendingBytes:1024,requestTimeoutMs:250,closeTimeoutMs:100,onWorkerFailure:()=>{failures++;}});clients.push(client);
    const state=client.durableState('reader');await new Promise(resolve=>setTimeout(resolve,10));
    const first=state.get('first').catch(error=>error);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(await failure(state.get('second'))).toMatchObject({code:'queue_full'});
    expect(await first).toMatchObject({code:'request_timeout'});expect(failures).toBe(0);
    expect(await failure(client.close())).toMatchObject({code:'close_unconfirmed'});
    expect(await failure(client.close())).toMatchObject({code:'close_unconfirmed'});expect(failures).toBe(1);
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
    // Include Worker startup in the request budget while still expiring well
    // before SQLite's 5-second busy timeout during the locked operations.
    const client=await PluginStateClient.open(path,{initialize:true,requestTimeoutMs:1000});clients.push(client);
    const state=client.durableState('locked');await state.get('warm');
    const blocker=new Database(path);blocker.exec('BEGIN IMMEDIATE');let ticks=0;const timer=setInterval(()=>ticks++,5);
    try {
      const write=state.transact([{key:'blocked',expectedVersion:0,value:true}]).catch(error=>error);
      const read=state.get('blocked').catch(error=>error);
      expect(await write).toMatchObject({code:'result_unknown',operationId:null});
      expect(await read).toMatchObject({code:'request_timeout'});expect(ticks).toBeGreaterThan(5);
      blocker.exec('ROLLBACK');await client.close();
    } finally {clearInterval(timer);if(blocker.inTransaction)blocker.exec('ROLLBACK');blocker.close();}
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

describe('explicit offline executor proof preparation',()=>{
  const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
  function proof(instance='owner') {
    const source={process:'control' as const,instance,catalog:'catalog',generation:1};
    const key=createHash('sha256').update(JSON.stringify(['control',instance,'catalog',1])).digest('hex');
    const value={source,physical:{pid:123,startToken:'fixture-start',executable:'/fixture/control',
      processInstanceId:'00000000-0000-4000-8000-000000000001'},boot:'linux:00000000-0000-4000-8000-000000000002'};
    return {key,value};
  }
  function businessRows(path:string) {
    const db=new Database(path,{readonly:true});
    try {return {
      durable:db.query('SELECT * FROM plugin_durable_records ORDER BY namespace,key').all(),
      kv:db.query('SELECT * FROM plugin_storage ORDER BY plugin_name,key').all(),
      records:db.query("SELECT * FROM plugin_communication_records WHERE namespace!='host:rpc:executors' ORDER BY namespace,key").all(),
      reservations:db.query('SELECT * FROM plugin_communication_reservations ORDER BY namespace,reservation_id').all(),
      receipts:db.query('SELECT * FROM plugin_communication_receipts ORDER BY namespace,reservation_id').all(),
      tombstones:db.query('SELECT * FROM plugin_communication_tombstones ORDER BY namespace,reservation_id').all(),
      retention:db.query('SELECT * FROM plugin_command_journal_retention ORDER BY namespace,key').all(),
    };}finally{db.close();}
  }
  test('ordinary sessions refuse preparation and keep the original proof untouched',async()=>{
    const {client}=await fixture(true),saved=proof(),store=client.channelStore('host:rpc:executors');
    await store.put(saved.key,encode(saved.value),{required:true});const before=await store.get(saved.key);
    expect(await failure(client.prepareExecutorProofPage(''))).toMatchObject({message:'runtime_upgrade_requires_offline_session'});
    expect(await store.get(saved.key)).toEqual(before);
  });
  test('offline preparation preserves business and pending commands, never invents retirement, and survives reopen',async()=>{
    const {client,path}=await fixture(true,{closeTimeoutMs:60}),saved=proof(),current=proof('current');
    const store=client.channelStore('host:rpc:executors');
    await store.put(saved.key,encode(saved.value),{required:true});
    // Deliberate whitespace and property order reveal any rewrite of a current proof.
    await store.put(current.key,new TextEncoder().encode(JSON.stringify({retired:true,guard:null,...current.value},null,2)),{required:true});
    const currentBefore=await store.get(current.key);
    await client.durableState('owner').transact([{key:'business',expectedVersion:0,value:{counter:7}}]);
    await client.pluginStorage('owner').set('setting',{enabled:true});
    const journalOptions={namespace:'rpc.offline-proof',privateStateNamespace:'owner'};
    const journal=client.journal(journalOptions);
    expect(await journal.execute(execution('committed','none'))).toEqual({ok:true});
    const started=deferred<void>(),finish=deferred<unknown>();
    const pending=journal.execute(execution('pending','none',()=>{started.resolve();return finish.promise;})).catch(error=>error);
    await started.promise;
    expect((await journal.inspect('pending',{subject:'caller',scope:'global'})).status).toBe('pending');
    // An interrupted real Worker leaves its durable pending record for the offline session.
    expect(await failure(client.close())).toMatchObject({code:'close_unconfirmed'});
    finish.resolve({ok:true});await pending;
    const before=businessRows(path);
    const offline=await PluginStateClient.open(path,{offline:true});clients.push(offline);
    const result={scanned:2,converted:1,last_key:[saved.key,current.key].sort().at(-1)!};
    expect(await offline.prepareExecutorProofPage('')).toEqual(result);
    const prepared=await offline.channelStore('host:rpc:executors').get(saved.key);
    expect(JSON.parse(new TextDecoder().decode(prepared!.payload))).toEqual({
      source:saved.value.source,physical:saved.value.physical,boot:saved.value.boot,guard:null,retired:false,
    });
    expect(await offline.channelStore('host:rpc:executors').get(current.key)).toEqual(currentBefore);
    expect(businessRows(path)).toEqual(before);
    expect((await offline.journal(journalOptions).inspect('pending',{subject:'caller',scope:'global'})).status).toBe('pending');
    expect(await offline.executorHasPending(saved.value.source)).toBe(true);
    expect(await offline.prepareExecutorProofPage('')).toEqual({...result,converted:0});
    expect(await offline.channelStore('host:rpc:executors').get(saved.key)).toEqual(prepared);
    await offline.close();
    const reopened=await PluginStateClient.open(path,{offline:true});clients.push(reopened);
    expect(await reopened.prepareExecutorProofPage('')).toEqual({...result,converted:0});
    expect(await reopened.channelStore('host:rpc:executors').get(saved.key)).toEqual(prepared);
    expect(await reopened.channelStore('host:rpc:executors').get(current.key)).toEqual(currentBefore);
    expect(businessRows(path)).toEqual(before);
    const reopenedJournal=reopened.journal(journalOptions);
    expect((await reopenedJournal.inspect('pending',{subject:'caller',scope:'global'})).status).toBe('pending');
    expect(await reopenedJournal.execute(execution('committed','none',async()=>{throw new Error('must replay committed result');}))).toEqual({ok:true});
  });
  test.each([
    {name:'identity mismatch',payload:encode(proof('wrong-owner').value),message:'runtime_upgrade_identity_mismatch'},
    {name:'extra proof field',payload:encode({...proof().value,extra:true}),message:'runtime_upgrade_proof_invalid'},
    {name:'invalid JSON',payload:new TextEncoder().encode('{'),message:'JSON'},
  ])('a later $name rolls the whole page back, including after reopen',async({payload,message})=>{
    const {client,path}=await fixture(true),saved=proof(),store=client.channelStore('host:rpc:executors');
    // This key sorts after the valid row, so a conversion has happened before rejection.
    const badKey='f'.repeat(64);expect(saved.key<badKey).toBe(true);
    await store.put(saved.key,encode(saved.value),{required:true});await store.put(badKey,payload,{required:true});
    const goodBefore=await store.get(saved.key),badBefore=await store.get(badKey);
    await client.close();
    const offline=await PluginStateClient.open(path,{offline:true});clients.push(offline);
    for(let attempt=0;attempt<2;attempt++) {
      expect(await failure(offline.prepareExecutorProofPage(''))).toMatchObject({message:expect.stringContaining(message)});
      expect(await offline.channelStore('host:rpc:executors').get(saved.key)).toEqual(goodBefore);
      expect(await offline.channelStore('host:rpc:executors').get(badKey)).toEqual(badBefore);
    }
    await offline.close();
    const reopened=await PluginStateClient.open(path,{offline:true});clients.push(reopened);
    expect(await failure(reopened.prepareExecutorProofPage(''))).toMatchObject({message:expect.stringContaining(message)});
    expect(await reopened.channelStore('host:rpc:executors').get(saved.key)).toEqual(goodBefore);
    expect(await reopened.channelStore('host:rpc:executors').get(badKey)).toEqual(badBefore);
    await reopened.channelStore('host:rpc:executors').ack(badKey);
    expect(await reopened.prepareExecutorProofPage('')).toEqual({scanned:1,converted:1,last_key:saved.key});
  });
});

describe('public admission while production capability creation is silent',()=>{
  test('waiting capability methods occupy request slots immediately, including their deadlines',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-capability-'));dirs.push(dir);
    let notifications=0;
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:8,requestTimeoutMs:400,closeTimeoutMs:60,
      onWorkerFailure:()=>{notifications++;}});clients.push(client);
    const state=client.durableState('waiting');
    // No readiness sleep: creation and ALL public calls begin in the same turn.
    const calls=Array.from({length:1000},(_,n)=>state.get(`key${n}`).then(()=> 'unexpected',error=>error.code));
    const settled=await Promise.all(calls);
    expect(settled.filter(code=>code==='queue_full')).toHaveLength(993);
    expect(settled.filter(code=>code==='request_timeout')).toHaveLength(7);
    expect(notifications).toBe(0);expect(await failure(client.close())).toMatchObject({code:'close_unconfirmed'});expect(notifications).toBe(1);
  });
  test('queued write arguments consume bytes while their capability is unready and remain definitely unsent',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-cap-bytes-'));dirs.push(dir);
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:128,maxPendingBytes:300,requestTimeoutMs:400,closeTimeoutMs:60});clients.push(client);
    const state=client.durableState('waiting');
    const calls=Array.from({length:20},(_,n)=>state.transact([{key:`key${n}`,expectedVersion:0,value:'x'.repeat(100)}]).then(()=> 'unexpected',error=>error.code));
    const settled=await Promise.all(calls);
    expect(settled.filter(code=>code==='queue_full').length).toBeGreaterThanOrEqual(18);
    expect(settled).not.toContain('result_unknown');expect(settled).toContain('request_timeout');
  });
  test('journal methods and release waiting for creation share the same bounded admission',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'silent-journal-cap-'));dirs.push(dir);
    const client=await PluginStateClient.open(join(dir,'silent-cap.db'),{initialize:true,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),maxPendingRequests:4,requestTimeoutMs:400,closeTimeoutMs:60});clients.push(client);
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

describe('IPC physical progress and orphan resources',()=>{
  async function fault(mode:string,options:PluginStateOpenOptions={}) {
    const dir=mkdtempSync(join(tmpdir(),'plugin-state-progress-'));dirs.push(dir);
    const client=await PluginStateClient.open(join(dir,`${mode}.db`),{initialize:true,requestTimeoutMs:300,cleanupTimeoutMs:300,closeTimeoutMs:500,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),...options});clients.push(client);return client;
  }
  test('a sent read deadline leaves healthy clients usable and retains the physical slot',async()=>{
    const requestTimeoutMs=30_000,cleanupTimeoutMs=300;
    const client=await fault('silent',{requestTimeoutMs,cleanupTimeoutMs});const state=client.durableState('read');
    // The creator must physically settle before isolating the silent get.
    await waitForState(()=>client.health().pendingCount===0);
    const schedule=globalThis.setTimeout;
    let expire:(()=>void)|undefined;
    let expireCleanup:(()=>void)|undefined;
    let pending:Promise<unknown>;
    try {
      // Isolate the target read's deadlines from real worker startup time.
      globalThis.setTimeout=((callback:(...args:any[])=>void,delay?:number,...args:any[])=>{
        const timer=schedule(callback,delay,...args);
        if(delay===requestTimeoutMs)expire=()=>{clearTimeout(timer);callback(...args);};
        if(delay===requestTimeoutMs+cleanupTimeoutMs)expireCleanup=()=>{clearTimeout(timer);callback(...args);};
        return timer;
      }) as typeof setTimeout;
      pending=failure(state.get('silent'));
    } finally { globalThis.setTimeout=schedule; }
    await waitForState(()=>client.health().requests.some(request=>request.phase==='sent'));
    expect(expire).toBeFunction();expire!();
    expect(await pending).toMatchObject({code:'request_timeout'});
    expect(client.health()).toMatchObject({failure:null,pendingCount:1});
    expect(await client.executorHasPending({process:'control',instance:'i',catalog:'c',generation:1})).toBe(false);
    const closing=failure(client.close());
    await waitForState(()=>client.health().state==='closing');
    expect(expireCleanup).toBeFunction();expireCleanup!();
    expect(await closing).toMatchObject({code:'worker_failed'});
    expect(client.health().closeConfirmed).toBe(false);
  });
  test('late capability ACK is reclaimed once during close, and waiting business remains unsent',async()=>{
    let cleanups=0;const client=await fault('late-cap',{requestTimeoutMs:300,onDiagnostic:event=>{if(event.event==='cleanup_ack')cleanups++;}});const state=client.durableState('late');
    expect(await failure(state.transact([{key:'must-not-write',expectedVersion:0,value:true}]))).toMatchObject({code:'request_timeout'});
    expect(client.health().failure).toBeNull();await client.close();expect(client.health().closeConfirmed).toBe(true);expect(cleanups).toBe(1);
  });
  test('late source ACK is reclaimed and no orphan pin blocks collection',async()=>{
    const requestTimeoutMs=30_000;
    let cleanups=0;const client=await fault('late-source',{requestTimeoutMs,onDiagnostic:event=>{if(event.event==='cleanup_ack')cleanups++;}});
    const path=join(dirs.at(-1)!,'late-source.db');
    const snapshots=client.snapshotStore('owner',{id:'late',schemaVersion:1,maxVersions:1,chunkBytes:3});
    async function timeoutCurrent(sequence:number) {
      const schedule=globalThis.setTimeout;
      let expire:(()=>void)|undefined;
      let pending:Promise<unknown>;
      try {
        // Drive only this request's caller timer, after the real worker owns its source.
        globalThis.setTimeout=((callback:(...args:any[])=>void,delay?:number,...args:any[])=>{
          const timer=schedule(callback,delay,...args);
          if(delay===requestTimeoutMs)expire=()=>{clearTimeout(timer);callback(...args);};
          return timer;
        }) as typeof setTimeout;
        pending=failure(snapshots.current());
      } finally { globalThis.setTimeout=schedule; }
      await waitForState(()=>existsSync(`${path}.source-${sequence}.ready`));
      expect(expire).toBeFunction();expire!();
      expect(await pending).toMatchObject({code:'request_timeout'});
    }
    try {
      await snapshots.publish(1,new Uint8Array([1,2,3]));
      await timeoutCurrent(1);writeFileSync(`${path}.source-1.release`,'');
      await waitForState(()=>client.health().pendingCount===0);
      await snapshots.publish(2,new Uint8Array([4,5,6]));
      expect(await snapshots.version(1)).toBeNull();expect(cleanups).toBe(1);
      await timeoutCurrent(2);const closing=client.close();writeFileSync(`${path}.source-2.release`,'');
      await closing;expect(cleanups).toBe(2);
    } finally {
      for(const sequence of [1,2])writeFileSync(`${path}.source-${sequence}.release`,'');
      await client.close();
    }
  });
  test('SQL probes prove long business progress without imposing the ordinary request deadline',async()=>{
    const healthy=deferred<void>(),finish=deferred<any>(),started=deferred<void>();let failures=0;
    const client=await fault('normal',{requestTimeoutMs:250,progressTimeoutMs:30,probeTimeoutMs:50,probeIntervalMs:10,
      onDiagnostic:event=>{if(event.event==='probe_healthy')healthy.resolve();},onWorkerFailure:()=>{failures++;}});
    const journal=client.journal({namespace:'rpc.long',privateStateNamespace:'owner'});await journal.status();
    const command=execution('long','none',()=>{started.resolve();return finish.promise;});
    const pending=journal.execute({...command,context:{...command.context,deadlineAt:Date.now()+1000}});
    await started.promise;await healthy.promise;
    await new Promise(resolve=>setTimeout(resolve,280));expect(failures).toBe(0);
    expect(client.health().physicalCallbackCount).toBe(1);finish.resolve({ok:true});expect(await pending).toEqual({ok:true});
  });
  test('reconciliation inherits the real business deadline and retains its callback frame',async()=>{
    const finish=deferred<any>(),started=deferred<void>();let failures=0;
    const client=await fault('normal',{requestTimeoutMs:250,progressTimeoutMs:30,onWorkerFailure:()=>{failures++;}});
    const journal=client.journal({namespace:'rpc.long-reconcile',privateStateNamespace:'owner',resolveExternal:()=>({reconcile:()=>{started.resolve();return finish.promise;}})});
    await journal.status();const command=execution('long-reconcile','external-contract',async()=>{throw new Error('unconfirmed');});
    expect(await failure(journal.execute(command))).toMatchObject({code:'unknown'});
    const {executeBusiness,...request}=command;
    const pending=journal.reconcile({...request,context:{...request.context,deadlineAt:Date.now()+1000}});
    await started.promise;await new Promise(resolve=>setTimeout(resolve,280));expect(failures).toBe(0);
    finish.resolve({status:'committed',result:{confirmed:true}});expect(await pending).toEqual({confirmed:true});
  });
  test('journal response does not free late physical callback capacity or its token',async()=>{
    const finish=deferred<any>(),started=deferred<void>();const client=await fault('normal',{maxPendingRequests:2});
    const journal=client.journal({namespace:'rpc.physical',privateStateNamespace:'owner'});await journal.status();
    const command=execution('late-finish','none',()=>{started.resolve();return finish.promise;});
    const pending=journal.execute({...command,context:{...command.context,deadlineAt:Date.now()+100}});await started.promise;
    expect(await failure(pending)).toMatchObject({code:'result_unknown',operationId:'late-finish'});
    expect(client.health()).toMatchObject({pendingCount:1,physicalCallbackCount:1,failure:null});
    const secondStarted=deferred<void>(),secondFinish=deferred<any>();
    const second=execution('second-physical','none',()=>{secondStarted.resolve();return secondFinish.promise;});
    const secondPending=journal.execute({...second,context:{...second.context,deadlineAt:Date.now()+500}});
    await secondStarted.promise;expect(client.health()).toMatchObject({pendingCount:2,physicalCallbackCount:2});
    expect(await failure(journal.execute(execution('over-capacity','none')))).toMatchObject({code:'queue_full'});
    const closing=client.close();let closed=false;void closing.then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,25));expect(closed).toBe(false);
    finish.resolve({ok:true});secondFinish.resolve({ok:true});expect(await secondPending).toEqual({ok:true});await closing;expect(client.health().closeConfirmed).toBe(true);
  });
  test('healthy SQL does not hide a never finishing callback past deadline and cleanup debt',async()=>{
    const failed=deferred<void>(),started=deferred<void>();let failures=0,probes=0;
    const client=await fault('normal',{cleanupTimeoutMs:100,progressTimeoutMs:30,probeTimeoutMs:50,probeIntervalMs:10,
      onWorkerFailure:()=>{failures++;failed.resolve();},onDiagnostic:event=>{if(event.event==='probe_healthy')probes++;}});
    const journal=client.journal({namespace:'rpc.never',privateStateNamespace:'owner'});await journal.status();
    const command=execution('never','none',()=>{started.resolve();return new Promise(()=>undefined);});
    const pending=journal.execute({...command,context:{...command.context,deadlineAt:Date.now()+100}});await started.promise;
    expect(await failure(pending)).toMatchObject({code:'result_unknown',operationId:'never'});await failed.promise;
    expect(probes).toBeGreaterThan(0);expect(failures).toBe(1);expect(client.health().closeConfirmed).toBe(false);
    expect(await failure(client.close())).toMatchObject({code:'worker_failed'});
  });
  test('late callback after its owner deadline is refused and close can confirm drain',async()=>{
    const client=await fault('late-callback');const journal=client.journal({namespace:'rpc.late-callback',privateStateNamespace:'owner'});await journal.status();let calls=0;
    const command=execution('unowned','none',async()=>{calls++;return {ok:true};});
    expect(await failure(journal.execute({...command,context:{...command.context,deadlineAt:Date.now()+80}}))).toMatchObject({code:'result_unknown'});
    await client.close();expect(calls).toBe(0);expect(client.health().closeConfirmed).toBe(true);
  });
  test('close cancels a not started callback even before its business deadline',async()=>{
    const client=await fault('late-callback');const journal=client.journal({namespace:'rpc.close-callback',privateStateNamespace:'owner'});await journal.status();let calls=0;
    const command=execution('closing-owner','none',async()=>{calls++;return {ok:true};});
    const pending=journal.execute({...command,context:{...command.context,deadlineAt:Date.now()+1000}}).catch(error=>error);
    await waitForState(()=>client.health().requests.some(request=>request.methodClass==='write'));
    await client.close();expect(await pending).toMatchObject({code:'unknown'});expect(calls).toBe(0);expect(client.health().closeConfirmed).toBe(true);
  });
  test('lost committed ACK preserves operation ID, journal proof and no reexecution',async()=>{
    const client=await fault('drop-write-ack',{requestTimeoutMs:300});let plans=0;
    const journal=client.journal({namespace:'rpc.ack',privateStateNamespace:'owner',atomicReadSet:()=>({keys:['counter']}),
      resolveAtomic:()=>()=>{plans++;return {mutations:[{key:'counter',expectedVersion:0,value:1}],result:{ok:true}};}});
    expect(await failure(journal.execute(execution('original-ack-id')))).toMatchObject({code:'result_unknown',operationId:'original-ack-id'});
    expect((await journal.inspect('original-ack-id',{subject:'caller',scope:'global'})).status).toBe('committed');expect(plans).toBe(1);
    expect(await client.durableState('owner').get('counter')).toMatchObject({version:1,value:1});
  });
  test('lost cleanup ACK has a finite independent deadline and one failure notification',async()=>{
    const failed=deferred<void>();let failures=0;const client=await fault('drop-release-ack',{cleanupTimeoutMs:80,onWorkerFailure:()=>{failures++;failed.resolve();}});
    const journal=client.journal({namespace:'rpc.cleanup-ack',privateStateNamespace:'owner'});await journal.status();
    expect(await failure(journal.close())).toMatchObject({code:'request_timeout'});await failed.promise;
    expect(failures).toBe(1);expect(client.health().closeConfirmed).toBe(false);
  });
  test('two reserved DB probe failures end suspect work without consuming business capacity',async()=>{
    const failed=deferred<void>();let suspect=0,failures=0;
    const client=await fault('drop-probe',{requestTimeoutMs:1000,maxPendingRequests:1,progressTimeoutMs:25,probeTimeoutMs:30,probeIntervalMs:10,
      onWorkerFailure:()=>{failures++;failed.resolve();},onDiagnostic:event=>{if(event.event==='suspect')suspect++;}});
    const state=client.durableState('suspect');await waitForState(()=>client.health().pendingCount===0);
    expect(client.health().failure).toBeNull();suspect=0;
    const result=state.get('missing').catch(error=>error);await failed.promise;
    expect(await result).toMatchObject({code:'worker_failed'});expect(suspect).toBe(1);expect(failures).toBe(1);
  });
});
