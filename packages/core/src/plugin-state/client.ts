import { AsyncResource } from 'node:async_hooks';
import type { PluginDurableState, DurableMutation, DurableRecord, DurableTransactionOptions } from '../plugin-durable-state';
import type { PluginStorage } from '../plugin.types';
import type { SecretStore } from '../plugin-control/contracts';
import type { SecretStoreFactory, PluginStorageFactory } from '../plugin-control/host';
import type { SecretKeyMaterial } from '../plugin-control/secret-crypto';
import type { PluginCommunicationLimits, CommunicationNamespaceStore } from '../plugin-services/persistence';
import { DurableStateConflictError, validateDurableJson } from '../plugin-durable-state';
import { CommandJournalError, type CommandJournalOptions, type CommandJournalRequest, type CommandAtomicPlan,
  type CommandRecoveryEvidence, type CommandRecoveryRequest, type CommandSourceIdentity,
  type CommandJournalInspection } from '../plugin-services/command-journal';
import type { RpcCaller, RpcCommandExecution, RpcCommandExecutor } from '../plugin-services/rpc-runtime';
import type { RpcJson } from '../plugin-services/wire-contract';
import type { HostSnapshotStoreOptions } from '../plugin-services/snapshot-store';
import type { PluginChannelSnapshotSource, PluginChannelReliableEventLog } from '../plugin-services/peer-channel-hub';
import type { ChannelSnapshotDescriptor } from '../plugin-services/peer-channel-protocol';
import {PLUGIN_STORAGE_OPERATIONS,type PluginStorageOperation} from './storage-rpc';
import type { StateResponse, StateCallback } from './protocol';
import { storageMessageBytes } from './message-size';

export class PluginStateError extends Error {
  readonly name = 'PluginStateError';
  constructor(readonly code: 'queue_full' | 'request_failed' | 'request_timeout' | 'result_unknown' | 'worker_failed' | 'close_unconfirmed' | 'cleanup_overloaded', readonly operationId: string | null = null) { super(`plugin state failed (${code})`); }
}
export type AtomicReadSet = { readonly keys: readonly string[] } | { readonly list: true };
export type AtomicReadSetResolver = (execution: CommandJournalRequest) => AtomicReadSet;
export interface PluginStateOpenOptions {
  readonly maxPendingRequests?: number;
  readonly maxPendingBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerFailure?: (error: PluginStateError) => void;
  readonly material?: SecretKeyMaterial;
  readonly limits?: PluginCommunicationLimits;
  /** Only for a fresh library. Existing legacy tables are always refused. */
  readonly initialize?: boolean;
  /** Bundled entry URL supplied by the host build. */
  readonly workerUrl?: string | URL;
}
export type AsyncCommunicationNamespaceStore = {
  readonly namespace:string;
} & { [K in Exclude<keyof CommunicationNamespaceStore,'namespace'|'mutator'|'transact'>]:
  CommunicationNamespaceStore[K] extends (...args:infer A)=>infer R ? (...args:A)=>Promise<Awaited<R>> : never };
export interface AsyncHostSnapshotStore {
  publish(version:number,body:unknown|Uint8Array):Promise<ChannelSnapshotDescriptor>;
  current():Promise<PluginChannelSnapshotSource|null>;
  version(version:number):Promise<PluginChannelSnapshotSource|null>;
  collect():Promise<number>;
  maintain():Promise<{readonly removed:number;readonly error:string|null}>;
  maintenanceStatus():Promise<{readonly pending:boolean;readonly error:string|null}>;
}
export interface AsyncCommandJournal extends RpcCommandExecutor<unknown> {
  inspect(operationId:string,caller:RpcCaller):Promise<CommandJournalInspection>;
  query(operationId:string,caller:RpcCaller):Promise<RpcJson>;
  reconcile(execution:CommandJournalRequest):Promise<RpcJson>;
  collect(limit?:number):Promise<number>;
  recoverPending(limit?:number):Promise<number>;
  recoveryScanComplete():Promise<boolean>;
  status():Promise<{readonly usedBytes:number;readonly reservedBytes:number;readonly recordCount:number;readonly namespaceQuotaBytes:number}>;
  close():Promise<void>;
}
export type StateRecoveryAuthorizer=(request:CommandRecoveryRequest)=>CommandRecoveryEvidence|null|Promise<CommandRecoveryEvidence|null>;
export type StateJournalOptions = Omit<CommandJournalOptions,'db'|'setup'|'now'|'authorizeRecovery'> & {readonly maintenance?:boolean;readonly authorizeRecovery?:StateRecoveryAuthorizer;readonly atomicReadSet?:AtomicReadSetResolver};
function freeze<T>(value:T):T {
  if (value && typeof value==='object' && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  }
  return value;
}
/** Async IPC facade. The controlling thread never opens a database or runs SQLite. */
export class PluginStateClient {
  readonly #worker:Worker;
  readonly #pending=new Map<number,{resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>;bytes:number;cleanup:boolean;sent:boolean;writing:boolean;operationId:string|null}>();
  readonly #callbacks=new Map<string,(method:string,args:readonly any[])=>unknown|Promise<unknown>>();
  readonly #ready:Promise<void>;
  #readyResolve!:()=>void;
  #readyReject!:(error:unknown)=>void;
  #sequence=0;
  #state:'opening'|'open'|'closing'|'closed'='opening';
  #failure:PluginStateError|null=null;
  #closePromise:Promise<void>|null=null;
  #pendingBytes=0;
  #cleanupPending=0;
  #cleanupBytes=0;
  #maxPending:number;
  #maxBytes:number;
  #requestTimeout:number;
  #closeTimeout:number;
  private constructor(url:string|URL,private readonly options:PluginStateOpenOptions) {
    const bounded=(value:number|undefined,fallback:number,max:number)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('plugin_state_limit_invalid');return n;};
    this.#maxPending=bounded(options.maxPendingRequests,128,4096);
    this.#maxBytes=bounded(options.maxPendingBytes,8*1024*1024,64*1024*1024);
    this.#requestTimeout=bounded(options.requestTimeoutMs,30000,300000);
    this.#closeTimeout=bounded(options.closeTimeoutMs,10000,300000);
    this.#ready=new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject;});
    void this.#ready.catch(()=>undefined);
    this.#worker=new Worker(url,{type:'module',name:'bungee-plugin-state'});
    this.#worker.onmessage=event=>{
      if(event.data?.type==='ready'){this.#readyResolve();return;}
      const message=event.data as StateResponse|StateCallback;
      if (message.type==='callback') {
        const handler=this.#callbacks.get(message.token);
        void Promise.resolve().then(()=>{
          if (!handler) throw new Error('plugin_state_callback_unavailable');
          return handler(message.method,message.args);
        }).then(value=>{validateDurableJson(value);this.#worker.postMessage({type:'callback-response',id:message.id,value});})
          .catch(()=>{try{this.#worker.postMessage({type:'callback-response',id:message.id,error:'plugin_state_callback_failed'});}catch{/* Worker already terminated. */}});
        return;
      }
      const pending=this.#take(message.id); if (!pending) return;
      if (message.error) {
        const error=message.error.code==='durable_state_conflict' ? new DurableStateConflictError()
          : message.error.name==='CommandJournalError' ? new CommandJournalError(message.error.code as any,message.error.operationId)
          : Object.assign(new Error(message.error.message),{name:message.error.name,code:message.error.code});
        pending.reject(error);
      } else pending.resolve(message.value);
    };
    this.#worker.onerror=event=>{event.preventDefault?.();if(this.#state!=='closed')this.#fail(new PluginStateError('worker_failed'));};
    this.#worker.addEventListener('close',()=>{if(this.#state!=='closed')this.#fail(new PluginStateError('worker_failed'));});
  }
  static async open(path:string,options:PluginStateOpenOptions={}):Promise<PluginStateClient> {
    const client=new PluginStateClient(options.workerUrl ?? new URL('./worker.ts',import.meta.url),options);
    try { await client.#request('host','open',[path,{material:options.material,limits:options.limits,initialize:options.initialize,callbackCapacity:client.#maxPending}]); client.#state='open';return client; }
    catch (error) { client.#worker.terminate(); client.#fail(new PluginStateError('worker_failed')); throw error; }
  }
  #fail(error:PluginStateError):void {
    if(this.#failure)return;
    this.#failure=error;this.#state='closed';this.#readyReject(error);
    for(const p of this.#pending.values()) {clearTimeout(p.timer);p.reject(p.sent&&p.writing?new PluginStateError('result_unknown',p.operationId):error);}
    this.#pending.clear();this.#pendingBytes=0;this.#cleanupPending=0;this.#cleanupBytes=0;this.#callbacks.clear();
    try{this.options.onWorkerFailure?.(error);}catch{/* Failure notification cannot strand callers. */}
    this.#worker.terminate();
  }
  #take(id:number) {
    const pending=this.#pending.get(id);if(!pending)return;
    this.#pending.delete(id);clearTimeout(pending.timer);this.#pendingBytes-=pending.bytes;
    if(pending.cleanup){this.#cleanupPending--;this.#cleanupBytes-=pending.bytes;}
    return pending;
  }
  #request<T=any>(target:string|Promise<string>,method:string,args:readonly unknown[]=[]):Promise<T> {
    if(this.#state==='closed'||(this.#state==='closing'&&method!=='close'))return Promise.reject(this.#failure??new PluginStateError('request_failed'));
    const reading=new Set(['get','readStrict','keys','list','receipt','releaseCapability','status','inspect','query','current','version','read','oldestSequence','latestSequence','prunedThrough','checkpoint','maintenanceStatus','pendingRecoveryRequests','recoveryScanComplete','journalNamespaces','atomicView','executorProofPage','executorHasPending']);
    const writing=method!=='open'&&method!=='close'&&!reading.has(method)&&!(target==='host'&&method==='storageOperation'&&['get','readStrict','keys'].includes(args[1] as string))&&!(target==='host'&&['durable','storage','secret','communication','event','snapshot','journal','release'].includes(method));
    const operationId=['execute','reconcile'].includes(method)?(args[0] as CommandJournalRequest)?.operationId??null:null;
    let bytes:number;try{bytes=storageMessageBytes(args);}catch{return Promise.reject(new PluginStateError('request_failed',operationId));}
    const cleanup=method==='releaseCapability'||method==='secretRevoke'||(target==='source'&&method==='release');
    if(cleanup) {
      // A separate, finite reserve guarantees release admission when business work is full.
      // Exhausting it is a resource failure, never a silently abandoned healthy handle.
      if(this.#cleanupPending>=this.#maxPending||bytes>1024){
        const error=new PluginStateError('cleanup_overloaded');this.#fail(error);return Promise.reject(error);
      }
    } else if(method!=='close'&&(this.#pending.size-this.#cleanupPending>=this.#maxPending||bytes>this.#maxBytes-(this.#pendingBytes-this.#cleanupBytes)))return Promise.reject(new PluginStateError('queue_full',operationId));
    let ownedArgs:readonly unknown[];try{ownedArgs=structuredClone(args);}catch{return Promise.reject(new PluginStateError('request_failed',operationId));}
    const id=++this.#sequence;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>this.#fail(new PluginStateError('request_timeout',operationId)),method==='close'?this.#closeTimeout:this.#requestTimeout);
      const pending={resolve,reject,timer,bytes,cleanup,sent:false,writing,operationId};
      this.#pending.set(id,pending);this.#pendingBytes+=bytes;if(cleanup){this.#cleanupPending++;this.#cleanupBytes+=bytes;}
      // Reserve count, bytes and deadline BEFORE subscribing to capability readiness.
      void Promise.all([this.#ready,target]).then(([,resolvedTarget])=>{
        if(!this.#pending.has(id))return;
        try{this.#worker.postMessage({type:'request',id,target:resolvedTarget,method,args:ownedArgs});pending.sent=true;}
        catch{this.#take(id);reject(new PluginStateError('request_failed',operationId));}
      },()=>{
        if(!this.#take(id))return;
        reject(this.#failure??new PluginStateError('request_failed',operationId));
      });
    });
  }
  #capability(kind:string,args:readonly unknown[]) {
    const ready=this.#request<string>('host',kind,args);
    // Lazy factory callers can be disposed before their first method; avoid an unhandled rejection.
    void ready.catch(()=>undefined);
    return <T=any>(method:string,values:readonly unknown[]=[])=>this.#request<T>(ready,method,values);
  }
  durableState(namespace:string):PluginDurableState {
    const call=this.#capability('durable',[namespace]);
    return Object.freeze({
      get:async(key:string)=>freeze(await call<DurableRecord|null>('get',[key])),
      list:async()=>freeze(await call<readonly DurableRecord[]>('list')),
      transact:async(mutations:readonly DurableMutation[],options?:DurableTransactionOptions)=>{validateDurableJson(mutations);return freeze(await call<readonly DurableRecord[]>('transact',[mutations,options]));},
    });
  }
  readonly durable: {forNamespace(namespace:string):PluginDurableState} = {forNamespace:(namespace:string)=>this.durableState(namespace)};
  secretStore(namespace:string):SecretStore & {revoke():void;clear():Promise<void>} {
    const call=this.#capability('secret',[namespace]); let revoked=false;
    const active=()=>{if(revoked) throw Object.assign(new Error('Secret store handle has been revoked'),{name:'SecretStoreError',code:'handle_revoked'});};
    return Object.freeze({namespace,
      get:async(key:string)=>{active();return call('get',[key]);},
      compareAndSet:async(key:string,expectedVersion:number|null,value:string)=>{active();return call('compareAndSet',[key,expectedVersion,value]);},
      delete:async(key:string,expectedVersion:number)=>{active();await call('delete',[key,expectedVersion]);},
      revoke:()=>{if(revoked)return;revoked=true;void call('secretRevoke').catch(()=>undefined);},
      clear:async()=>{active();await call('secretClear');revoked=true;},
    });
  }
  readonly secretStores:SecretStoreFactory = {
    create:namespace=>this.secretStore(namespace),
    revoke:store=>(store as ReturnType<PluginStateClient['secretStore']>).revoke(),
    clear:store=>(store as ReturnType<PluginStateClient['secretStore']>).clear(),
  };
  pluginStorage(namespace:string):PluginStorage & {revoke():void} {
    const call=this.#capability('storage',[namespace]);let revoked=false;
    const active=()=>{if(revoked)throw new Error('plugin_storage_capability_revoked');};
    const storage:any={uncached:()=>{active();return storage;},revoke:()=>{if(revoked)return;revoked=true;void call('releaseCapability').catch(()=>undefined);}};
    for(const method of ['get','readStrict','set','delete','keys','clear','increment','compareAndSet','flush'])
      storage[method]=async(...args:unknown[])=>{active();return call(method,args);};
    return Object.freeze(storage);
  }
  readonly storage:PluginStorageFactory = {create:namespace=>this.pluginStorage(namespace),
    revoke:store=>(store as ReturnType<PluginStateClient['pluginStorage']>).revoke()};
  channelStore(namespace:string):AsyncCommunicationNamespaceStore {
    const call=this.#capability('communication',[namespace]);const capability:any={namespace};
    for (const method of ['get','reserve','commit','receipt','cancel','put','delete','ack','forceRelease','collect','list','status'])
      capability[method]=(...args:unknown[])=>call(method,args);
    return Object.freeze(capability);
  }
  eventLog(plugin:string,topic:string,maxEvents=128,major=1):PluginChannelReliableEventLog {
    const call=this.#capability('event',[`channel.${plugin}`,topic,maxEvents,major,plugin]);const log:any={};
    for(const method of ['oldestSequence','latestSequence','prunedThrough','list','checkpoint','ack','append'])
      log[method]=(...args:unknown[])=>call(method,args);
    log.appendWithState=async(payload:Uint8Array,mutations:readonly DurableMutation[])=>{validateDurableJson(mutations);return call('appendWithState',[payload,mutations]);};
    return Object.freeze(log);
  }
  readonly eventLogFactory = (input:{plugin:string;topic:string;major:number;maxEvents:number})=>this.eventLog(input.plugin,input.topic,input.maxEvents,input.major);
  snapshotStore(plugin:string,options:Omit<HostSnapshotStoreOptions,'owner'>):AsyncHostSnapshotStore {
    const call=this.#capability('snapshot',[`channel.${plugin}`,{...options,owner:plugin}]);
    const wrap=async(method:string,args:readonly unknown[]):Promise<PluginChannelSnapshotSource|null>=>{
      const saved=await call<{id:string;descriptor:ChannelSnapshotDescriptor}|null>(method,args); if(!saved)return null;
      let released=false;
      return Object.freeze({descriptor:freeze(saved.descriptor),
        retain:()=>{if(released)throw new Error('snapshot_source_released');},
        release:async()=>{if(released)return;released=true;await this.#request('source','release',[saved.id]);},
        read:async(offset:number,length:number)=>{if(released)throw new Error('snapshot_source_released');return this.#request<Uint8Array>('source','read',[saved.id,offset,length]);},
      });
    };
    return Object.freeze({publish:(v:number,b:unknown)=>call('publish',[v,b]),current:()=>wrap('current',[]),version:(v:number)=>wrap('version',[v]),
      collect:()=>call('collect'),maintain:()=>call('maintain'),maintenanceStatus:()=>call('maintenanceStatus')});
  }
  journal(options:StateJournalOptions):AsyncCommandJournal {
    const token=crypto.randomUUID();
    if(this.#callbacks.size>=8192)throw new PluginStateError('queue_full');
    this.#callbacks.set(token,async(method,args)=>{
      if(method==='reconcile') {
        const external=options.resolveExternal?.(args[0]); if(!external)throw new CommandJournalError('capability_unavailable');
        return external.reconcile(args[0]);
      }
      throw new CommandJournalError('capability_unavailable');
    });
    const {resolveAtomic,resolveExternal,authorizeRecovery,atomicReadSet,...data}=options;
    const ready=this.#request<string>('host','journal',[{...data,external:resolveExternal!==undefined},token]);
    void ready.catch(()=>{this.#callbacks.delete(token);});
    const call=<T=any>(method:string,args:readonly unknown[]=[])=>this.#request<T>(ready,method,args);
    let closePromise:Promise<void>|null=null;
    const recovery=async(limit=128)=>{
      const requests=await call<readonly CommandRecoveryRequest[]>('pendingRecoveryRequests',[limit]);
      const proofs:{request:CommandRecoveryRequest;proof:CommandRecoveryEvidence}[]=[];
      for(const request of requests){try{const proof=await authorizeRecovery?.(freeze(request));if(proof)proofs.push({request,proof});}catch{/* Absence of owner proof leaves the pending operation unchanged. */}}
      return call<number>('recoverPending',[proofs,limit]);
    };
    return Object.freeze({
      execute:async(execution:RpcCommandExecution<unknown>)=>{
        const {executeBusiness,...original}=execution;
        const identity = {...original, context:{...original.context,signal:undefined,callee:null}} as unknown as CommandJournalRequest;
        validateDurableJson(identity.input);
        let atomic:{plan:CommandAtomicPlan;reads:readonly {key:string;version:number|null}[];list:readonly DurableRecord[]|null}|null=null;
        if(execution.definition.command?.deduplication==='external-contract' && !resolveExternal?.(original)) throw new CommandJournalError('capability_unavailable');
        const prior = await call<CommandJournalInspection>('inspect',[identity.operationId,identity.context.caller]);
        if(execution.definition.command?.deduplication==='local-transaction' && prior.status==='missing') {
          const planner=resolveAtomic?.(original);if(!planner)throw new CommandJournalError('capability_unavailable');
          if(!atomicReadSet)throw new CommandJournalError('capability_unavailable');
          const declared=atomicReadSet(original);
          const records=freeze(await this.#request<readonly DurableRecord[]>('host','atomicView',[options.privateStateNamespace,declared,{rows:options.atomicReadRows??256,bytes:options.atomicReadBytes??1024*1024,queries:options.atomicReadQueries??516}]));
          const byKey=new Map(records.map(record=>[record.key,record]));const reads=new Map<string,number|null>();let list:readonly DurableRecord[]|null=null;
          let active=true;let queries=0;
          const check=()=>{if(!active)throw new CommandJournalError('capability_unavailable');if(++queries>(options.atomicReadQueries ?? 516))throw new CommandJournalError('overloaded');};
          let plan:CommandAtomicPlan;
          try { plan=planner(Object.freeze({get:(key:string)=>{check();if(!('list' in declared)&&!declared.keys.includes(key))throw new CommandJournalError('capability_unavailable');const record=byKey.get(key) ?? null;reads.set(key,record?.version ?? null);return record;},
            list:()=>{check();if(!('list' in declared))throw new CommandJournalError('capability_unavailable');list=records;return records;}}),original); }
          finally {active=false;}
          // postMessage refuses captured behavior; the leaf additionally validates the pure JSON plan and result.
          validateDurableJson(plan);
          atomic={plan,reads:[...reads].map(([key,version])=>({key,version})),list};
        }
        const operationToken=crypto.randomUUID();this.#callbacks.set(operationToken,AsyncResource.bind(()=>executeBusiness()));
        try{return await call<RpcJson>('execute',[identity,atomic,operationToken]);}
        finally{this.#callbacks.delete(operationToken);}
      },
      inspect:(id:string,caller:RpcCaller)=>call('inspect',[id,caller]),query:(id:string,caller:RpcCaller)=>call('query',[id,caller]),
      reconcile:async(execution:CommandJournalRequest)=>{
        const operationToken=crypto.randomUUID();
        this.#callbacks.set(operationToken,AsyncResource.bind(async()=>{
          const external=resolveExternal?.(execution);if(!external)throw new CommandJournalError('capability_unavailable');
          return external.reconcile(execution);
        }));
        try {return await call('reconcile',[{...execution,context:{...execution.context,signal:undefined,callee:null}},operationToken]);}
        finally {this.#callbacks.delete(operationToken);}
      },collect:(limit?:number)=>call('collect',[limit]),
      recoverPending:recovery,recoveryScanComplete:()=>call('recoveryScanComplete'),status:()=>call('status'),
      /** Releases this journal capability; it is not a database-close acknowledgement. */
      close:()=>{this.#callbacks.delete(token);return closePromise??=this.#request<void>(ready,'releaseCapability');},
    });
  }
  storageOperation(namespace:string,operation:PluginStorageOperation,args:readonly unknown[]):Promise<unknown> {
    if(!(PLUGIN_STORAGE_OPERATIONS as readonly string[]).includes(operation))return Promise.reject(new Error('plugin_storage_method_invalid'));
    return this.#request('host','storageOperation',[namespace,operation,args]);
  }
  executorProofPage(after:string,limit=8):Promise<readonly {readonly key:string}[]> {return this.#request('host','executorProofPage',[after,limit]);}
  executorHasPending(source:CommandSourceIdentity):Promise<boolean> {return this.#request('host','executorHasPending',[source]);}
  journalNamespaces(after:string,limit:number):Promise<readonly string[]> {return this.#request('host','journalNamespaces',[after,limit]);}
  close():Promise<void> {
    if(this.#closePromise)return this.#closePromise;
    if(this.#failure)return Promise.reject(this.#failure);
    if(this.#state==='closed')return Promise.resolve();
    this.#state='closing';
    this.#closePromise=this.#request('host','close').then(()=>{
      this.#state='closed';
      for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(p.sent&&p.writing?new PluginStateError('result_unknown',p.operationId):new PluginStateError('request_failed'));}
      this.#pending.clear();this.#pendingBytes=0;this.#cleanupPending=0;this.#cleanupBytes=0;this.#callbacks.clear();this.#worker.terminate();
    },error=>{this.#fail(new PluginStateError('close_unconfirmed'));throw error;});
    return this.#closePromise;
  }
}
