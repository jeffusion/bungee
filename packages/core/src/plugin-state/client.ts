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
import type { StateResponse, StateCallback, StatePhysical } from './protocol';
import { storageMessageBytes } from './message-size';
import { stateMethodClass, stateCreatedResource, type StateMethodClass } from './operations';

export class PluginStateError extends Error {
  readonly name = 'PluginStateError';
  constructor(readonly code: 'queue_full' | 'request_failed' | 'request_timeout' | 'result_unknown' | 'worker_failed' | 'close_unconfirmed' | 'cleanup_overloaded', readonly operationId: string | null = null) { super(`plugin state failed (${code})`); }
}
export type AtomicReadSet = { readonly keys: readonly string[] } | { readonly list: true };
export type AtomicReadSetResolver = (execution: CommandJournalRequest) => AtomicReadSet;
export interface PluginStateDiagnostic {
  readonly event:string;readonly methodClass:StateMethodClass;readonly requestId:number;readonly operationId:string|null;
  readonly phase:string;readonly count:number;readonly bytes:number;readonly ageMs:number;readonly deadlineAt:number;readonly eventLoopDelayMs:number;
}
interface PendingStateRequest {
  resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>;debt?:ReturnType<typeof setTimeout>;suspect?:ReturnType<typeof setTimeout>;
  bytes:number;cleanup:boolean;sent:boolean;writing:boolean;operationId:string|null;settled:boolean;responded:boolean;physical:boolean;responseError?:boolean;
  createdAt:number;sentAt?:number;deadlineAt:number;methodClass:StateMethodClass;resource:'capability'|'source'|null;token?:string;
}
export interface PluginStateOpenOptions {
  readonly maxPendingRequests?: number;
  readonly maxPendingBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly progressTimeoutMs?:number;
  readonly probeTimeoutMs?:number;
  readonly probeIntervalMs?:number;
  readonly cleanupTimeoutMs?:number;
  readonly onDiagnostic?:(diagnostic:PluginStateDiagnostic)=>void;
  readonly onWorkerFailure?: (error: PluginStateError) => void;
  readonly material?: SecretKeyMaterial;
  readonly limits?: PluginCommunicationLimits;
  /** Only for a fresh library. Existing legacy tables are always refused. */
  readonly initialize?: boolean;
  /** Host-only offline metadata preparation; unavailable on normal runtime clients. */
  readonly offline?: boolean;
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
  readonly #pending=new Map<number,PendingStateRequest>();
  readonly #probes=new Map<number,{resolve:()=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>();
  #probeRunning=false;
  #closeConfirmed=false;
  readonly #runningCallbacks=new Set<number>();
  readonly #idle=new Set<()=>void>();
  #progressTimeout:number;#probeTimeout:number;#probeInterval:number;#cleanupTimeout:number;
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
    this.#progressTimeout=bounded(options.progressTimeoutMs,30000,300000);
    this.#probeTimeout=bounded(options.probeTimeoutMs,5000,300000);
    this.#probeInterval=bounded(options.probeIntervalMs,1000,300000);
    this.#cleanupTimeout=bounded(options.cleanupTimeoutMs,10000,300000);
    this.#ready=new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject;});
    void this.#ready.catch(()=>undefined);
    this.#worker=new Worker(url,{type:'module',name:'bungee-plugin-state'});
    this.#worker.onmessage=event=>{
      if(event.data?.type==='ready'){this.#readyResolve();return;}
      const message=event.data as StateResponse|StateCallback|StatePhysical;
      if(message.type==='physical-settled') {
        const pending=this.#pending.get(message.id);if(!pending)return;
        pending.physical=true;this.#finish(message.id,pending);return;
      }
      if (message.type==='callback') {
        // Re-check ownership in the microtask: close/timeout can precede execution.
        void Promise.resolve().then(()=>{
          const pending=this.#pending.get(message.requestId);
          const handler=this.#callbacks.get(message.token);
          if(!handler||!pending||pending.settled||this.#state==='closing'||this.#state==='closed'||Date.now()>=message.deadlineAt)
            throw new Error('plugin_state_callback_unavailable');
          this.#runningCallbacks.add(message.id);
          return handler(message.method,message.args);
        }).then(value=>{validateDurableJson(value);this.#worker.postMessage({type:'callback-response',id:message.id,value});})
          .catch(()=>{try{this.#worker.postMessage({type:'callback-response',id:message.id,error:'plugin_state_callback_failed'});}catch{/* Worker already terminated. */}}).finally(()=>{this.#runningCallbacks.delete(message.id);});
        return;
      }
      const probe=this.#probes.get(message.id);
      if(probe){this.#probes.delete(message.id);clearTimeout(probe.timer);message.error?probe.reject():probe.resolve();return;}
      const pending=this.#pending.get(message.id);if(!pending||pending.responded)return;
      pending.responded=true;pending.responseError=message.error!==undefined;if(message.physical)pending.physical=true;
      if(!pending.settled&&!pending.cleanup&&pending.methodClass!=='close'&&Date.now()>=pending.deadlineAt) {
        pending.settled=true;clearTimeout(pending.timer);this.#diagnose('request_timeout',message.id,pending,pending.deadlineAt);
        pending.reject(new PluginStateError(pending.sent&&pending.writing?'result_unknown':'request_timeout',pending.operationId));
      }
      if(pending.settled) {
        if(!message.error&&pending.resource&&message.value!=null)this.#reclaim(pending.resource,message.value);
      } else {
        pending.settled=true;clearTimeout(pending.timer);
        if(message.error) {
          const error=message.error.code==='durable_state_conflict'?new DurableStateConflictError()
            :message.error.name==='CommandJournalError'?new CommandJournalError(message.error.code as any,message.error.operationId)
            :Object.assign(new Error(message.error.message),{name:message.error.name,code:message.error.code});
          pending.reject(error);
        } else pending.resolve(message.value);
      }
      this.#finish(message.id,pending);
    };
    this.#worker.onerror=event=>{event.preventDefault?.();if(this.#state!=='closed')this.#fail(new PluginStateError('worker_failed'));};
    this.#worker.addEventListener('close',()=>{if(this.#state!=='closed')this.#fail(new PluginStateError('worker_failed'));});
  }
  static async open(path:string,options:PluginStateOpenOptions={}):Promise<PluginStateClient> {
    const client=new PluginStateClient(options.workerUrl ?? new URL('./worker.ts',import.meta.url),options);
    try { await client.#request('host','open',[path,{material:options.material,limits:options.limits,initialize:options.initialize,offline:options.offline,callbackCapacity:client.#maxPending}]); client.#state='open';return client; }
    catch (error) { client.#worker.terminate(); client.#fail(new PluginStateError('worker_failed')); throw error; }
  }
  #diagnose(event:string,id:number,p:PendingStateRequest,expectedAt=Date.now()):void {
    try{this.options.onDiagnostic?.(Object.freeze({event,requestId:id,operationId:p.operationId,methodClass:p.methodClass,
      phase:p.physical?'physical-settled':p.responded?'response-settled':p.settled?'caller-settled':p.sent?'sent':'unsent',
      count:this.#pending.size,bytes:this.#pendingBytes,ageMs:Date.now()-p.createdAt,deadlineAt:p.deadlineAt,
      eventLoopDelayMs:Math.max(0,Date.now()-expectedAt)}));}catch{/* Diagnostics cannot change ownership. */}
  }
  health() {
    return Object.freeze({state:this.#state,closeConfirmed:this.#closeConfirmed,physicalCallbackCount:this.#runningCallbacks.size,failure:this.#failure?.code??null,pendingCount:this.#pending.size,pendingBytes:this.#pendingBytes,
      cleanupCount:this.#cleanupPending,callbackCount:this.#callbacks.size,probeInFlight:this.#probeRunning,
      requests:Object.freeze([...this.#pending].map(([id,p])=>Object.freeze({requestId:id,operationId:p.operationId,methodClass:p.methodClass,
        phase:p.physical?'physical-settled':p.responded?'response-settled':p.settled?'caller-settled':p.sent?'sent':'unsent',ageMs:Date.now()-p.createdAt,deadlineAt:p.deadlineAt})))});
  }
  #fail(error:PluginStateError):void {
    if(this.#failure)return;
    this.#failure=error;this.#state='closed';this.#readyReject(error);
    for(const [id,p] of this.#pending) {
      this.#diagnose(error.code,id,p);clearTimeout(p.timer);clearTimeout(p.debt);clearTimeout(p.suspect);
      if(!p.settled)p.reject(p.sent&&p.writing?new PluginStateError('result_unknown',p.operationId):error);
    }
    for(const p of this.#probes.values()){clearTimeout(p.timer);p.reject();}this.#probes.clear();
    this.#pending.clear();this.#pendingBytes=0;this.#cleanupPending=0;this.#cleanupBytes=0;this.#callbacks.clear();
    for(const resolve of this.#idle)resolve();
    try{this.options.onWorkerFailure?.(error);}catch{/* Failure notification cannot strand callers. */}
    this.#worker.terminate();
  }
  #take(id:number) {
    const pending=this.#pending.get(id);if(!pending)return;
    this.#pending.delete(id);clearTimeout(pending.timer);clearTimeout(pending.debt);clearTimeout(pending.suspect);this.#pendingBytes-=pending.bytes;
    if(pending.cleanup){this.#cleanupPending--;this.#cleanupBytes-=pending.bytes;}
    if(pending.token)this.#callbacks.delete(pending.token);
    if(this.#pending.size===0)for(const resolve of this.#idle)resolve();
    return pending;
  }
  #finish(id:number,p:PendingStateRequest):void {if(p.responded&&p.physical){if(p.cleanup&&!p.responseError)this.#diagnose('cleanup_ack',id,p);this.#take(id);}}
  #reclaim(resource:'capability'|'source',value:any):void {
    const request=resource==='capability'?this.#request('host','release',[value]):this.#request('source','release',[value.id]);
    void request.catch(()=>{if(!this.#failure)this.#fail(new PluginStateError('worker_failed'));});
  }
  #probe():Promise<void> {
    const id=++this.#sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#probes.delete(id);reject();},this.#probeTimeout);
      this.#probes.set(id,{resolve,reject:()=>reject(),timer});
      try{this.#worker.postMessage({type:'request',id,target:'host',method:'probe',args:[],deadlineAt:Date.now()+this.#probeTimeout});}
      catch{clearTimeout(timer);this.#probes.delete(id);reject();}
    });
  }
  async #checkProgress(id:number,p:PendingStateRequest):Promise<void> {
    if(!this.#pending.has(id)||this.#failure||this.#probeRunning)return;
    this.#probeRunning=true;this.#diagnose('suspect',id,p,(p.sentAt??p.createdAt)+this.#progressTimeout);
    try {
      for(let attempt=0;attempt<2;attempt++) {
        try{await this.#probe();this.#diagnose('probe_healthy',id,p);return;}catch{if(this.#failure)return;}
        if(attempt===0)await new Promise(resolve=>setTimeout(resolve,this.#probeInterval));
      }
      this.#fail(new PluginStateError('worker_failed'));
    } finally {this.#probeRunning=false;}
  }
  #request<T=any>(target:string|Promise<string>,method:string,args:readonly unknown[]=[],deadline?:number,token?:string):Promise<T> {
    const methodClass=stateMethodClass(target,method,args),cleanup=methodClass==='cleanup',writing=methodClass==='write';
    if(this.#state==='closed'||(this.#state==='closing'&&methodClass!=='close'&&!cleanup))return Promise.reject(this.#failure??new PluginStateError('request_failed'));
    const operationId=['execute','reconcile'].includes(method)?(args[0] as CommandJournalRequest)?.operationId??null:null;
    let bytes:number;try{bytes=storageMessageBytes(args);}catch{return Promise.reject(new PluginStateError('request_failed',operationId));}
    if(cleanup) {
      if(this.#cleanupPending>=this.#maxPending||bytes>1024){const error=new PluginStateError('cleanup_overloaded');this.#fail(error);return Promise.reject(error);}
    } else if(methodClass!=='close'&&(this.#pending.size-this.#cleanupPending>=this.#maxPending||bytes>this.#maxBytes-(this.#pendingBytes-this.#cleanupBytes)))return Promise.reject(new PluginStateError('queue_full',operationId));
    let ownedArgs:readonly unknown[];try{ownedArgs=structuredClone(args);}catch{return Promise.reject(new PluginStateError('request_failed',operationId));}
    const id=++this.#sequence,createdAt=Date.now(),deadlineAt=deadline??createdAt+(methodClass==='close'?this.#closeTimeout:cleanup?this.#cleanupTimeout:this.#requestTimeout);
    if(!Number.isFinite(deadlineAt)||deadlineAt<=createdAt)return Promise.reject(new PluginStateError('request_timeout',operationId));
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const p=this.#pending.get(id);if(!p||p.settled)return;
        p.settled=true;this.#diagnose('request_timeout',id,p,p.deadlineAt);
        reject(new PluginStateError(p.sent&&p.writing?'result_unknown':'request_timeout',operationId));
        if(!p.sent){this.#take(id);return;}
        if(methodClass==='close'){this.#fail(new PluginStateError('close_unconfirmed'));return;}
        if(cleanup){this.#fail(new PluginStateError('worker_failed'));return;}
        this.#finish(id,p);
      },Math.max(0,deadlineAt-createdAt));
      const pending:PendingStateRequest={resolve,reject,timer,bytes,cleanup,sent:false,writing,operationId,settled:false,responded:false,physical:false,
        createdAt,deadlineAt,methodClass,resource:stateCreatedResource(target,method),token};
      this.#pending.set(id,pending);this.#pendingBytes+=bytes;if(cleanup){this.#cleanupPending++;this.#cleanupBytes+=bytes;}
      if(!cleanup&&methodClass!=='close') {
        pending.debt=setTimeout(()=>{if(this.#pending.has(id))this.#fail(new PluginStateError('worker_failed'));},Math.max(0,deadlineAt-createdAt)+this.#cleanupTimeout);
      }
      void Promise.all([this.#ready,target]).then(([,resolvedTarget])=>{
        if(!this.#pending.has(id)||pending.settled)return;
        try{this.#worker.postMessage({type:'request',id,target:resolvedTarget,method,args:ownedArgs,deadlineAt});pending.sent=true;pending.sentAt=Date.now();
          if(!cleanup&&methodClass!=='close')pending.suspect=setTimeout(()=>void this.#checkProgress(id,pending),this.#progressTimeout);}
        catch{this.#take(id);reject(new PluginStateError('request_failed',operationId));}
      },error=>{if(!this.#take(id))return;reject(this.#failure??(error instanceof PluginStateError?error:new PluginStateError('request_failed',operationId)));});
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
    const call=<T=any>(method:string,args:readonly unknown[]=[],deadline?:number,operationToken?:string)=>this.#request<T>(ready,method,args,deadline,operationToken);
    let closePromise:Promise<void>|null=null;
    const recovery=async(limit=128)=>{
      const requests=await call<readonly CommandRecoveryRequest[]>('pendingRecoveryRequests',[limit]);
      const proofs:{request:CommandRecoveryRequest;proof:CommandRecoveryEvidence}[]=[];
      for(const request of requests){try{const proof=await authorizeRecovery?.(freeze(request));if(proof)proofs.push({request,proof});}catch{/* Absence of owner proof leaves the pending operation unchanged. */}}
      return call<number>('recoverPending',[proofs,limit]);
    };
    return Object.freeze({
      execute:async(execution:RpcCommandExecution<unknown>)=>{
        const deadlineAt=execution.context.deadlineAt??Date.now()+this.#requestTimeout;
        const {executeBusiness,...original}=execution;
        const identity = {...original, context:{...original.context,signal:undefined,callee:null}} as unknown as CommandJournalRequest;
        validateDurableJson(identity.input);
        let atomic:{plan:CommandAtomicPlan;reads:readonly {key:string;version:number|null}[];list:readonly DurableRecord[]|null}|null=null;
        if(execution.definition.command?.deduplication==='external-contract' && !resolveExternal?.(original)) throw new CommandJournalError('capability_unavailable');
        const prior = await call<CommandJournalInspection>('inspect',[identity.operationId,identity.context.caller],deadlineAt);
        if(execution.definition.command?.deduplication==='local-transaction' && prior.status==='missing') {
          const planner=resolveAtomic?.(original);if(!planner)throw new CommandJournalError('capability_unavailable');
          if(!atomicReadSet)throw new CommandJournalError('capability_unavailable');
          const declared=atomicReadSet(original);
          const records=freeze(await this.#request<readonly DurableRecord[]>('host','atomicView',[options.privateStateNamespace,declared,{rows:options.atomicReadRows??256,bytes:options.atomicReadBytes??1024*1024,queries:options.atomicReadQueries??516}],deadlineAt));
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
        const operationToken=crypto.randomUUID();this.#callbacks.set(operationToken,AsyncResource.bind(()=>{if(execution.context.signal?.aborted)throw new CommandJournalError('unknown',execution.operationId);return executeBusiness();}));
        return call<RpcJson>('execute',[identity,atomic,operationToken],deadlineAt,operationToken).catch(error=>{if(![...this.#pending.values()].some(p=>p.token===operationToken))this.#callbacks.delete(operationToken);throw error;});
      },
      inspect:(id:string,caller:RpcCaller)=>call('inspect',[id,caller]),query:(id:string,caller:RpcCaller)=>call('query',[id,caller]),
      reconcile:async(execution:CommandJournalRequest)=>{
        const operationToken=crypto.randomUUID();
        this.#callbacks.set(operationToken,AsyncResource.bind(async()=>{
          if(execution.context.signal?.aborted)throw new CommandJournalError('unknown',execution.operationId);
          const external=resolveExternal?.(execution);if(!external)throw new CommandJournalError('capability_unavailable');
          return external.reconcile(execution);
        }));
        return call('reconcile',[{...execution,context:{...execution.context,signal:undefined,callee:null}},operationToken],execution.context.deadlineAt??Date.now()+this.#requestTimeout,operationToken).catch(error=>{if(![...this.#pending.values()].some(p=>p.token===operationToken))this.#callbacks.delete(operationToken);throw error;});
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
  retireExecutorProof(id:string,proof:import('../plugin-services/peer-executor-proof').PluginExecutorProof):Promise<void> {return this.#request('host','retireExecutorProof',[id,proof]);}
  prepareExecutorProofPage(after:string):Promise<{scanned:number;converted:number;last_key:string|null}> {
    if(this.options.offline!==true) return Promise.reject(new Error('runtime_upgrade_requires_offline_session'));
    return this.#request('host','prepareExecutorProofPage',[after]);
  }
  executorHasPending(source:CommandSourceIdentity):Promise<boolean> {return this.#request('host','executorHasPending',[source]);}
  journalNamespaces(after:string,limit:number):Promise<readonly string[]> {return this.#request('host','journalNamespaces',[after,limit]);}
  close():Promise<void> {
    if(this.#closePromise)return this.#closePromise;
    if(this.#failure)return Promise.reject(this.#failure);
    if(this.#state==='closed')return Promise.resolve();
    this.#state='closing';
    const deadlineAt=Date.now()+this.#closeTimeout;
    for(const [id,p] of this.#pending)if(!p.sent){p.settled=true;p.reject(new PluginStateError('request_failed',p.operationId));this.#take(id);}
    const drained=this.#pending.size===0?Promise.resolve():new Promise<void>((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);this.#idle.delete(done);resolve();};
      const timer=setTimeout(()=>{this.#idle.delete(done);const error=new PluginStateError('close_unconfirmed');this.#fail(error);reject(error);},this.#closeTimeout);
      this.#idle.add(done);
    });
    this.#closePromise=drained.then(()=>this.#request('host','close',[],deadlineAt)).then(()=>{
      this.#state='closed';this.#closeConfirmed=true;this.#callbacks.clear();this.#worker.terminate();
    },error=>{this.#fail(new PluginStateError('close_unconfirmed'));throw error;});
    return this.#closePromise;
  }
}
