/// <reference lib="webworker" />
import { Database } from 'bun:sqlite';
import { createMasterStats, type MasterStatsApi } from './master-stats';
import { initializeAccessDatabaseForMaster } from '../access-database';
import { MigrationManager } from '../migrations';

function headerEntries(headers:Headers):[string,string][] {const values:[string,string][]=[];headers.forEach((value,key)=>values.push([key,value]));return values;}
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
let stats: MasterStatsApi | null = null;
let database: Database | null = null;
const adapters = new Map<string, Readonly<Record<string, (...args: any[]) => unknown>>>();
const bodies = new Map<number, {reader:ReadableStreamDefaultReader<Uint8Array>;lifetime:AbortController}>();
let sequence = 0;
let closing = false;
let creatingResponses = 0;
const operations = new Set<Promise<void>>();
async function execute(method: string, args: readonly any[]): Promise<unknown> {
  if (method === 'migrate') {
    const settings = initializeAccessDatabaseForMaster(args[0]);
    const result = await new MigrationManager(args[0]).migrate();
    if (!result.success) throw new Error('access_database_migration_failed');
    return settings;
  }
  if (method === 'open') {
    if (stats) throw new Error('observability_already_open');
    database = new Database(args[0]);
    try { stats = createMasterStats({accessDbPath:args[0],database}); }
    catch (error) { database = null; throw error; }
    return null;
  }
  if (!stats || !database) throw new Error('observability_unavailable');
  if (method === 'register') {
    const [namespace, modulePath] = args;
    const module = await import(modulePath);
    if (typeof module.createObservationAdapter !== 'function') return [];
    const adapter = await module.createObservationAdapter(Object.freeze({withDatabase:<T>(operation:(db:Database)=>T):T=>operation(database!)}));
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw new Error('invalid_observation_adapter');
    const entries = Object.entries(adapter);
    if (entries.length > 32 || entries.some(([name, method])=> !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(name) || typeof method !== 'function')) throw new Error('invalid_observation_adapter');
    adapters.set(namespace,Object.freeze(adapter));
    return entries.map(([name])=>name);
  }
  if (method === 'observe') {
    const [namespace, operation, values] = args;
    const adapter = adapters.get(namespace);
    if (!adapter || !Object.hasOwn(adapter,operation) || !Array.isArray(values)) throw new Error('observation_capability_unavailable');
    return await adapter[operation]!(...values) ?? null;
  }
  if (method === 'configure') {stats.configureLogging?.(args[0]);return null;}
  if (method === 'cleanup') {stats.startCleanup?.();return null;}
  if (method === 'request') {
    if (bodies.size + creatingResponses >= 128) throw new Error('observability_response_capacity');
    creatingResponses++;
    try {
    const [wire] = args;
    const lifetime = new AbortController();
    const response = await stats.handle(new Request(wire.url,{method:wire.method,headers:wire.headers,
      ...(wire.body?.byteLength ? {body:wire.body} : {}),signal:lifetime.signal}));
    const id = response.body ? ++sequence : null;
    if (id !== null) bodies.set(id,{reader:response.body!.getReader(),lifetime});
    return {status:response.status,statusText:response.statusText,headers:headerEntries(response.headers),bodyId:id};
    } finally { creatingResponses--; }
  }
  if (method === 'pull') {
    const body = bodies.get(args[0]);
    if (!body) return {done:true};
    const part = await body.reader.read();
    if (part.done) {bodies.delete(args[0]);body.reader.releaseLock();}
    return part;
  }
  if (method === 'cancel') {
    const body = bodies.get(args[0]);
    if (body) {bodies.delete(args[0]);body.lifetime.abort();await body.reader.cancel();body.reader.releaseLock();}
    return null;
  }
  if (method === 'close') {
    await Promise.all([...bodies.values()].map(async body=>{body.lifetime.abort();await body.reader.cancel();body.reader.releaseLock();}));
    bodies.clear();adapters.clear();await stats.close();stats=null;database=null;return null;
  }
  throw new Error('unknown_observability_operation');
}
scope.onmessage = event => {
  const {id,method,args} = event.data;
  const reply = (work: Promise<unknown>) => work.then(value=>scope.postMessage({id,value}),error=>scope.postMessage({id,error:{code:'observability_storage_failure',message:error instanceof Error ? error.message : 'storage failure',resourceUnreleased:(error as any)?.resourceUnreleased===true}}));
  if (closing) {void reply(Promise.reject(new Error('observability_closing')));return;}
  if (method === 'close') {
    closing = true;
    void reply((async()=>{
      // End stream pulls before draining adapter tasks and acknowledging database close.
      await Promise.all([...bodies.values()].map(async body=>{body.lifetime.abort();await body.reader.cancel();}));
      await Promise.allSettled([...operations]);
      return execute(method,args);
    })());
    return;
  }
  const task = reply(execute(method,args)); operations.add(task);
  void task.finally(()=>operations.delete(task));
};
scope.postMessage({type:'ready'});
