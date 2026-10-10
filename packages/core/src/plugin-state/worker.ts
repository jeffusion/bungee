/** Sole production owner of plugin-state.db. No Database crosses this thread boundary. */
import { Database } from 'bun:sqlite';
import { PluginDurableStateStore, DurableStateConflictError } from '../plugin-durable-state';
import { SQLitePluginStorage } from '../plugin-storage';
import { createSecretStore, clearSecretStore, revokeSecretStore } from '../plugin-control/secret-store';
import { PluginCommunicationStore } from '../plugin-services/persistence';
import { StoreBackedReliableEventLog } from '../plugin-services/channels';
import { HostSnapshotStore } from '../plugin-services/snapshot-store';
import { CommandJournal, CommandJournalError } from '../plugin-services/command-journal';
import type { CommandAtomicPlan, CommandRecoveryEvidence, CommandRecoveryRequest } from '../plugin-services/command-journal';
import type { DurableRecord } from '../plugin-durable-state';
import type { SecretKeyMaterial } from '../plugin-control/secret-crypto';
import type { PluginCommunicationLimits } from '../plugin-services/persistence';
import type { PluginChannelSnapshotSource } from '../plugin-services/peer-channel-hub';
import { PLUGIN_STORAGE_OPERATIONS } from './storage-rpc';
import { initializePluginStateDatabase } from './schema';
import type { StateRequest, StateCallbackResponse, StateResponse } from './protocol';

declare const self: Worker;
let db: Database | undefined;
let durable: PluginDurableStateStore;
let communication: PluginCommunicationStore;
let material: SecretKeyMaterial | undefined;
let communicationLimits:PluginCommunicationLimits|undefined;
const kvStores=new Map<string,SQLitePluginStorage>();
const handles = new Map<string, any>();
const durableNamespaces = new Map<string,string>();
const sources = new Map<string, PluginChannelSnapshotSource>();
const callbacks = new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void}>();
let nextCallback = 0;
let callbackCapacity=128;
function callback(token:string, method:string, args:readonly unknown[]):Promise<any> {
  if(callbacks.size>=callbackCapacity)return Promise.reject(new CommandJournalError('overloaded'));
  const id = ++nextCallback;
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{callbacks.delete(id);reject(new CommandJournalError('unknown'));},30000);
    callbacks.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    self.postMessage({type:'callback',id,token,method,args});
  });
}
function bind(value:unknown):string { if(handles.size>=8192)throw new Error('plugin_state_capability_capacity_exceeded');const id = crypto.randomUUID(); handles.set(id,value); return id; }
function source(value:PluginChannelSnapshotSource|null):unknown {
  if (!value) return null;
  // Pin BEFORE returning the descriptor. Publication/GC and this retain are serialized on this thread.
  if(sources.size>=256)throw new Error('snapshot_source_capacity_exceeded');
  value.retain?.();
  const id = crypto.randomUUID(); sources.set(id,value);
  return {id,descriptor:value.descriptor};
}
function openJournal(options:any, token:string) {
  let atomic: {plan:CommandAtomicPlan; reads:readonly {key:string;version:number|null}[]; list:readonly DurableRecord[]|null}|null = null;
  let reconciliationToken=token;
  let evidence = new Map<string,{request:CommandRecoveryRequest;proof:CommandRecoveryEvidence}>();
  const journal = options.maintenance ? CommandJournal.forMaintenance({db:db!,namespace:options.namespace,limits:communicationLimits,
    authorizeRecovery: request => {
      const saved=evidence.get(request.key);
      return saved && JSON.stringify(saved.request)===JSON.stringify(request) ? saved.proof : null;
    }}) : new CommandJournal({db:db!,...options,limits:communicationLimits,setup:false,
    resolveAtomic: () => atomic ? (reader:any) => {
      if (atomic!.list !== null) {
        let current:readonly DurableRecord[];
        try{current=reader.list();}catch(error){if(error instanceof CommandJournalError&&error.code==='capability_unavailable')throw new CommandJournalError('conflict');throw error;}
        if(JSON.stringify(current)!==JSON.stringify(atomic!.list))throw new CommandJournalError('conflict');
      } else for (const read of atomic!.reads) if ((reader.get(read.key)?.version ?? null)!==read.version) throw new CommandJournalError('conflict');
      return atomic!.plan;
    } : null,
    resolveExternal: () => {const activeToken=reconciliationToken;return options.external ? {reconcile:(execution:any)=>callback(activeToken,'reconcile',[execution])}:null;},
    authorizeRecovery: request => {
      const saved=evidence.get(request.key);
      return saved && JSON.stringify(saved.request)===JSON.stringify(request) ? saved.proof : null;
    },
  });
  return {
    async execute(execution:any, plan:any, operationToken:string) {
      atomic = plan;
      // The leaf executes local-transaction synchronously before its first await; immutable plan captured by resolver.
      try { return await journal.execute({...execution,executeBusiness:()=>callback(operationToken,'business',[])}); }
      finally { atomic=null; }
    },
    inspect: journal.inspect.bind(journal), query:journal.query.bind(journal),
    async reconcile(execution:any,operationToken:string){reconciliationToken=operationToken;
      try{return await journal.reconcile(execution);}finally{reconciliationToken=token;}
    },
    collect:journal.collect.bind(journal), status:journal.status.bind(journal),
    pendingRecoveryRequests:journal.pendingRecoveryRequests.bind(journal),
    recoverPending(proofs:readonly {request:CommandRecoveryRequest;proof:CommandRecoveryEvidence}[], limit?:number) {
      evidence=new Map(proofs.map(item=>[item.request.key,item]));
      try { return journal.recoverPending(limit); } finally { evidence.clear(); }
    },
    recoveryScanComplete:journal.recoveryScanComplete.bind(journal),
  };
}
async function dispatch(request:StateRequest):Promise<unknown> {
  const {target,method,args}=request;
  if (target==='host' && method==='open') {
    if (db) throw new Error('plugin_state_already_open');
    const [path,options] = args as [string,{material?:SecretKeyMaterial;limits?:PluginCommunicationLimits;initialize?:boolean;callbackCapacity?:number}];
    db=new Database(path,{create:options.initialize === true,strict:true});
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (options.initialize !== true && db.query<{user_version:number},[]>('PRAGMA user_version').get()!.user_version === 0)
      throw new Error('plugin_state_version_unsupported');
    initializePluginStateDatabase(db);
    if(options.callbackCapacity!==undefined){if(!Number.isSafeInteger(options.callbackCapacity)||options.callbackCapacity<1||options.callbackCapacity>4096)throw new Error('callback_capacity_invalid');callbackCapacity=options.callbackCapacity;}
    communicationLimits=options.limits;
    material=options.material; durable=new PluginDurableStateStore(db); communication=new PluginCommunicationStore(db,options.limits,{setup:false});
    return true;
  }
  if (!db) throw new Error('plugin_state_not_open');
  if (target==='host') {
    if (method==='durable') { const id=bind(durable.forStorageNamespace(args[0] as string)); durableNamespaces.set(id,args[0] as string); return id; }
    if (method==='storageOperation') {
      const [namespace,operation,values]=args as [string,string,unknown[]];
      if(typeof namespace!=='string'||!namespace.length||namespace.length>256||!(PLUGIN_STORAGE_OPERATIONS as readonly string[]).includes(operation)||!Array.isArray(values))throw new Error('plugin_storage_method_invalid');
      let storage=kvStores.get(namespace);
      if(!storage){if(kvStores.size>=1024)throw new Error('plugin_storage_capacity_exceeded');storage=new SQLitePluginStorage(db,namespace);kvStores.set(namespace,storage);}
      return (storage as any)[operation](...values);
    }
    if (method==='storage') return bind(new SQLitePluginStorage(db,args[0] as string));
    if (method==='secret') return bind(createSecretStore(db,args[0] as string,material));
    if (method==='communication') return bind(communication.forNamespace(args[0] as string));
    if (method==='event') {
      const log=new StoreBackedReliableEventLog(communication.forNamespace(args[0] as string),args[1] as string,args[2] as number,args[3] as number);
      const wrapper:any={};
      for(const name of ['oldestSequence','latestSequence','prunedThrough','list','checkpoint','ack','append','receipt']) wrapper[name]=(log as any)[name].bind(log);
      wrapper.appendWithState=(payload:Uint8Array,mutations:any)=>{
        let result:unknown;
        durable.forStorageNamespace(args[4] as string).transact(mutations,()=>{result=log.appendWithinTransaction(payload);});
        return result;
      };
      return bind(wrapper);
    }
    if (method==='snapshot') return bind(new HostSnapshotStore(communication.forNamespace(args[0] as string),args[1] as any));
    if (method==='journal') return bind(openJournal(args[0],args[1] as string));
    if(method==='executorProofPage') {
      const [after,limit]=args as [string,number];
      if(typeof after!=='string'||after.length>128||!Number.isSafeInteger(limit)||limit<1||limit>256)throw new Error('executor_proof_page_invalid');
      return db.query<{key:string},[string,number]>("SELECT key FROM plugin_communication_records WHERE namespace='host:rpc:executors' AND key>? ORDER BY key LIMIT ?").all(after,limit);
    }
    if(method==='executorHasPending') {
      const [source]=args as [{process:string;instance:string;catalog:string;generation:number}];
      if(!source||[source.process,source.instance,source.catalog].some(v=>typeof v!=='string'||!v.length)||!Number.isSafeInteger(source.generation))throw new Error('executor_source_invalid');
      return db.query<{key:string},[string,string,string,number]>(
        `SELECT key FROM plugin_communication_records WHERE namespace LIKE 'rpc.%' AND key LIKE 'j.%'
         AND json_valid(CAST(payload AS TEXT)) AND json_extract(CAST(payload AS TEXT), '$.state')='pending'
         AND json_extract(CAST(payload AS TEXT), '$.source.process')=? AND json_extract(CAST(payload AS TEXT), '$.source.instance')=?
         AND json_extract(CAST(payload AS TEXT), '$.source.catalog')=? AND json_extract(CAST(payload AS TEXT), '$.source.generation')=? LIMIT 1`
      ).get(source.process,source.instance,source.catalog,source.generation)!==null;
    }
    if (method==='journalNamespaces') return db.query<{namespace:string},[string,number]>("SELECT namespace FROM plugin_communication_records WHERE key='journal-policy-binding' AND namespace LIKE 'rpc.%' AND namespace>? ORDER BY namespace LIMIT ?").all(args[0] as string,args[1] as number).map(row=>row.namespace);
    if (method==='atomicView') {
      return db.transaction(()=>{
        const [namespace,declared,budget]=args as [string,{keys:readonly string[]}|{list:true},{rows:number;bytes:number;queries:number}];
        for(const n of [budget?.rows,budget?.bytes,budget?.queries])if(!Number.isSafeInteger(n)||n<1)throw new CommandJournalError('invalid_input');
        const listing='list' in declared&&declared.list===true;
        if(!listing&&(!('keys' in declared)||!Array.isArray(declared.keys)||declared.keys.some(key=>typeof key!=='string'||!key.length||key.length>128)))throw new CommandJournalError('invalid_input');
        const keys=listing?null:[...new Set((declared as {keys:readonly string[]}).keys)];
        if(keys&&(keys.length>budget.rows||keys.length*2>budget.queries))throw new CommandJournalError('overloaded');
        const metas=listing?db!.query<{key:string;version:number;bytes:number},[string,number]>("SELECT key,version,length(CAST(value_json AS BLOB)) AS bytes FROM plugin_durable_records WHERE namespace=? ORDER BY key LIMIT ?").all(namespace,budget.rows+1)
          :keys!.flatMap(key=>{const row=db!.query<{key:string;version:number;bytes:number},[string,string]>("SELECT key,version,length(CAST(value_json AS BLOB)) AS bytes FROM plugin_durable_records WHERE namespace=? AND key=?").get(namespace,key);return row?[row]:[];});
        if(metas.length>budget.rows||metas.reduce((n,r)=>n+r.bytes,0)>budget.bytes||(listing&&1+metas.length>budget.queries))throw new CommandJournalError('overloaded');
        return metas.map(row=>{
          const body=db!.query<{value_json:string},[string,string]>("SELECT value_json FROM plugin_durable_records WHERE namespace=? AND key=?").get(namespace,row.key)!;
          return {key:row.key,version:row.version,value:JSON.parse(body.value_json)};
        });
      }).deferred();
    }
    if (method==='close') { for (const s of sources.values()) s.release?.(); sources.clear(); handles.clear(); kvStores.clear(); db.close(); db=undefined; return; }
    if (method==='release') { handles.delete(args[0] as string);durableNamespaces.delete(args[0] as string); return; }
    throw new Error('plugin_state_method_invalid');
  }
  if (target==='source') {
    const value=sources.get(args[0] as string);
    if (!value) throw new Error('snapshot_source_released');
    if (method==='read') return value.read(args[1] as number,args[2] as number);
    if (method==='release') { value.release?.(); sources.delete(args[0] as string); return; }
    throw new Error('plugin_state_method_invalid');
  }
  const handle=handles.get(target);
  if (!handle) throw new Error('plugin_state_capability_revoked');
  if (method==='secretClear') {clearSecretStore(handle);handles.delete(target);return;}
  if (method==='secretRevoke') {revokeSecretStore(handle);handles.delete(target);return;}
  if (method==='releaseCapability') {handles.delete(target);durableNamespaces.delete(target);return;}
  if (method==='current' || method==='version') return source(handle[method](...args));
  if (method==='transact') {
    const [mutations,options]=args as [any,any];
    // Both leaf writes share this connection and this immediate transaction.
    return handle.transact(mutations,options ? () => {
      if (!options.outbox || Object.keys(options).some(key=>key!=='outbox')) throw new Error('invalid_outbox_request');
      const outbox=options.outbox;
      const log=new StoreBackedReliableEventLog(communication.forNamespace(`channel.${durableNamespaces.get(target)}`),outbox.topic,outbox.maxEvents,outbox.major);
      log.appendWithinTransaction(outbox.payload);
    } : undefined);
  }
  if (typeof handle[method]!=='function' || ['mutator','database','uncached','appendWithinTransaction'].includes(method)) throw new Error('plugin_state_method_invalid');
  return handle[method](...args);
}
self.onmessage = event => {
  const message=event.data as StateRequest|StateCallbackResponse;
  if (message.type==='callback-response') {
    const pending=callbacks.get(message.id); if (!pending) return; callbacks.delete(message.id);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value); return;
  }
  if (message.type!=='request') return;
  void dispatch(message).then(value=>self.postMessage({type:'response',id:message.id,value} satisfies StateResponse),error=>{
    self.postMessage({type:'response',id:message.id,error:{name:error?.name ?? 'Error',message:error?.message ?? 'plugin_state_failure',code:error?.code,operationId:error?.operationId}} satisfies StateResponse);
  });
};

self.postMessage({type:'ready'});
