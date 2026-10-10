import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {createAsyncMasterStats,migrateAccessDatabaseAsync,resolveObservabilityWorkerUrl} from '../../src/master-runtime/observability-client';
import {handleManagementRequest} from '../../src/management-listener';
import {PluginManifestCatalog} from '../../src/plugin-manifest-catalog';
import {fileURLToPath} from 'node:url';

test('the real token-stats catalog adapter persists attempts in access storage',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bungee-observe-token-'));const path=join(root,'access.db');
  let stats:Awaited<ReturnType<typeof createAsyncMasterStats>>|undefined;
  try {
    const catalog=await PluginManifestCatalog.build({scanDirectories:[fileURLToPath(new URL('../../../../plugins',import.meta.url))]});
    await migrateAccessDatabaseAsync(path);stats=await createAsyncMasterStats(path);
    await stats.registerObservationAdapter!('token-stats',catalog.get('token-stats')!.controlPath!);
    const adapter=stats.observationAdapter!('token-stats')!;
    const now=Date.now();
    await adapter.recordAttempt({attempt_id:'observer-real-attempt',request_id:'observer-real-request',finished_at_ms:now,
      route_id:'route',upstream_id:'upstream',provider:'openai',outcome:'completed',model:'ObserverModel',
      input_tokens:12,output_tokens:3,input_source:'usage',output_source:'usage',cache_read_tokens:null,cache_write_tokens:null,
      cost_usd:null,observation_incomplete:false});
    expect((await adapter.queryWindowSnapshot({asOfMs:now+1,range:'1h',groupBy:'model'})).all.upstreamAttempts).toBe(1);
    expect((await adapter.listClientModels({})).models).toEqual(['ObserverModel']);
    expect(stats.observationStorage).toBeUndefined();
    await stats.close();stats=undefined;
    const database=new Database(path);try {expect(database.query('SELECT input_tokens FROM token_stats_attempts WHERE attempt_id=?').get('observer-real-attempt')).toEqual({input_tokens:12});}finally{database.close();}
  } finally {await stats?.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
},20_000);

test('access Worker serves persisted stats and arbitrary catalog adapters without exposing a connection', async()=>{
  const root=await mkdtemp(join(tmpdir(),'bungee-observe-worker-'));const path=join(root,'access.db');
  let stats:Awaited<ReturnType<typeof createAsyncMasterStats>>|undefined;
  try {
     await migrateAccessDatabaseAsync(path);
    const db=new Database(path);
    db.query("INSERT INTO access_logs(request_id,timestamp,method,path,status,duration,success,created_at,request_type) VALUES ('control',1000,'GET','/positive',200,1,1,1,'final')").run();db.close();
    stats=await createAsyncMasterStats(path);
    const response=await stats.handle(new Request('http://localhost/api/stats'));
    expect(response.status).toBe(200);expect((await response.json()).totalRequests).toBe(1);
    expect('getDatabase' in stats).toBe(false);expect(stats.observationStorage).toBeUndefined();
    const adapter=join(root,'arbitrary.ts');
    await writeFile(adapter,'export function createObservationAdapter(observation){return { count: async()=>observation.withDatabase(db=>db.query("SELECT COUNT(*) AS count FROM access_logs").get().count) };}');
    await stats.registerObservationAdapter!('arbitrary-name',adapter);
    expect(await stats.observationAdapter!('arbitrary-name')!.count()).toBe(1);
    expect(stats.observationAdapter!('undeclared')).toBeUndefined();
    const denied = await stats.observe!('undeclared','count',[]).catch(error=>error);expect(String(denied)).toContain('observation_capability_unavailable');
    await stats.close();
    const closed = await stats.observe!('arbitrary-name','count',[]).catch(error=>error);expect(closed).toBeInstanceOf(Error);
  } finally {await stats?.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
},20_000);

test('a locked access database leaves heartbeat and management health responsive',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bungee-observe-lock-'));const path=join(root,'access.db');
  let stats:Awaited<ReturnType<typeof createAsyncMasterStats>>|undefined, lock:Database|undefined;
  try {
    await migrateAccessDatabaseAsync(path);stats=await createAsyncMasterStats(path);
    const adapter=join(root,'locked-write.ts');
    await writeFile(adapter,'export function createObservationAdapter(observation){return { write:()=>observation.withDatabase(db=>db.query("INSERT INTO access_logs(request_id,timestamp,method,path,status,duration,success,created_at,request_type) VALUES (\'lock-control\',1000,\'GET\',\'/locked\',200,1,1,1,\'final\')").run().changes) };}');
    await stats.registerObservationAdapter!('fixture-lock',adapter);
    lock=new Database(path);lock.run('BEGIN IMMEDIATE');
    let beats=0;const timer=setInterval(()=>beats++,10);
    const started=performance.now();const query=stats.observationAdapter!('fixture-lock')!.write();
    let settled=false;void query.finally(()=>{settled=true;});
    await new Promise(resolve=>setTimeout(resolve,120));
    const health=await handleManagementRequest(new Request('http://localhost/health/management'),{profile:'management',controlApi:{handle:async()=>null},health:()=>({live:true,management:true,data:false,degraded:true})});
    expect(health.status).toBe(200);expect(await health.json()).toMatchObject({data:false,degraded:true});
    expect(beats).toBeGreaterThanOrEqual(5);expect(performance.now()-started).toBeLessThan(1000);
    expect(settled).toBe(false);
    lock.run('ROLLBACK');lock.close();lock=undefined;
    expect(await query).toBe(1);clearInterval(timer);
    expect((await stats.handle(new Request('http://localhost/api/stats'))).status).toBe(200);
  } finally {lock?.close();await stats?.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
},20_000);

test('SQL maintenance scans in an arbitrary observation adapter do not block supervision timers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bungee-observe-scan-'));const path=join(root,'access.db');
  let stats:Awaited<ReturnType<typeof createAsyncMasterStats>>|undefined;
  try {
    await migrateAccessDatabaseAsync(path);stats=await createAsyncMasterStats(path);
    const adapter=join(root,'maintenance.ts');
    await writeFile(adapter,'export function createObservationAdapter(observation){return { scan:()=>observation.withDatabase(db=>db.query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT SUM(x) AS total FROM n").get().total) };}');
    await stats.registerObservationAdapter!('fixture-maintenance',adapter);
    let beats=0;const timer=setInterval(()=>beats++,10);
    try {expect(await stats.observationAdapter!('fixture-maintenance')!.scan()).toBe(2_000_001_000_000);expect(beats).toBeGreaterThanOrEqual(5);}
    finally {clearInterval(timer);}
  } finally {await stats?.close();await rm(root,{recursive:true,force:true});}
},20_000);

test('health data endpoint rejects empty admission while management remains ready',async()=>{
  const options={profile:'management' as const,controlApi:{handle:async()=>null},health:()=>({live:true,management:true,data:false,degraded:true})};
  expect((await handleManagementRequest(new Request('http://localhost/health'),options)).status).toBe(200);
  expect((await handleManagementRequest(new Request('http://localhost/health/live'),options)).status).toBe(200);
  expect((await handleManagementRequest(new Request('http://localhost/health/data'),options)).status).toBe(503);
});
test('observability source and distributable URLs are explicit',()=>{
  expect(resolveObservabilityWorkerUrl('file:///repo/src/master.ts').pathname).toBe('/repo/src/master-runtime/observability-worker.ts');
  expect(resolveObservabilityWorkerUrl('file:///repo/dist/main.js').pathname).toBe('/repo/dist/observability-worker.js');
  expect(resolveObservabilityWorkerUrl('file:///$bunfs/root/main.js').pathname).toBe('/$bunfs/root/observability-worker.js');
});

test('an observation Worker without a close acknowledgement stays unhealthy and close keeps rejecting',async()=>{
  const stats=await createAsyncMasterStats('/unused',{
    workerUrl:new URL('../fixtures/observability-silent-close-worker.ts',import.meta.url),requestTimeoutMs:150,
  });
  expect(stats.healthy!()).toBe(true);
  const failure=await stats.close().catch(error=>error);
  expect(failure.resourceUnreleased).toBe(true);expect(stats.healthy!()).toBe(false);
  expect(await stats.close().catch(error=>error)).toBe(failure);
},5000);
