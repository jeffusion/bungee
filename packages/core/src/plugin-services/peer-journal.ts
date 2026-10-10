import { CommandJournalError } from './command-journal';
import { PluginStateError } from '../plugin-state/client';
/** Production resolver: all journal storage and maintenance runs in plugin-state Worker. */
import type { HostRpcJournalRequest } from './host-rpc';
import type { PluginStateClient, AsyncCommandJournal, StateRecoveryAuthorizer } from '../plugin-state/client';
import { createHash } from 'node:crypto';
export interface PluginPeerJournalOptions {
  readonly client:PluginStateClient;
  readonly authorizeRecovery?:StateRecoveryAuthorizer;
}
export interface PluginPeerJournalMaintenance {
  readonly namespaces:number;readonly recovered:number;readonly collected:number;
  readonly failures:readonly {readonly namespace:string;readonly code:string}[];
}
export interface PluginPeerJournalResolver {
  resolve(request:HostRpcJournalRequest):AsyncCommandJournal|null;
  maintain(options?:{readonly namespaceLimit?:number;readonly recordLimit?:number}):Promise<PluginPeerJournalMaintenance>;
  close():Promise<void>;
}
function limit(value:number|undefined,fallback:number,max:number):number {
  if(value!==undefined&&(!Number.isSafeInteger(value)||value<1))throw new Error('invalid journal maintenance limit');
  return Math.min(value??fallback,max);
}
export function createPluginPeerJournalResolver(options:PluginPeerJournalOptions):PluginPeerJournalResolver {
  let closed=false,cursor='';let active:{namespace:string;journal:AsyncCommandJournal}|null=null;
  return Object.freeze({
    resolve(request:HostRpcJournalRequest) {
      if(closed)return null;
      const namespace=`rpc.${createHash('sha256').update(JSON.stringify([request.provider,request.service,request.major,request.method,request.scope,request.bindingScope??null])).digest('hex')}`;
      const journal=options.client.journal({namespace,privateStateNamespace:request.provider,quotaBytes:request.policy.quotaBytes,
        resolveAtomic:()=>request.atomic??null,atomicReadSet:request.atomicReadSet,resolveExternal:()=>request.external??null,authorizeRecovery:options.authorizeRecovery});
      const outcome=async<T>(work:Promise<T>):Promise<T>=>{try{return await work;}catch(error){
        // The host RPC vocabulary already names an ambiguous delivered command "unknown".
        if(error instanceof PluginStateError&&error.code==='result_unknown')throw new CommandJournalError('unknown',error.operationId);
        throw error;
      }};
      return Object.freeze({...journal,execute:(execution:Parameters<AsyncCommandJournal['execute']>[0])=>outcome(journal.execute(execution)),reconcile:(execution:Parameters<AsyncCommandJournal['reconcile']>[0])=>outcome(journal.reconcile(execution))});
    },
    async maintain(limits:{readonly namespaceLimit?:number;readonly recordLimit?:number}={}) {
      const count=limit(limits.namespaceLimit,8,32),records=limit(limits.recordLimit,128,256);
      let namespaces=0,recovered=0,collected=0;const failures:{namespace:string;code:string}[]=[];
      if(!closed)for(let index=0;index<count;index++) {
        if(!active){const next=await options.client.journalNamespaces(cursor,1);if(!next.length){cursor='';break;}
          cursor=next[0]!;active={namespace:cursor,journal:options.client.journal({namespace:cursor,privateStateNamespace:'maintenance',maintenance:true,authorizeRecovery:options.authorizeRecovery})};}
        const current=active;namespaces++;
        try {collected+=await current.journal.collect(records);recovered+=await current.journal.recoverPending(records);
          if(await current.journal.recoveryScanComplete()){await current.journal.close();active=null;}}
        catch(error){failures.push({namespace:current.namespace,code:String((error as any)?.code??'storage_failure')});await current.journal.close().catch(()=>undefined);active=null;}
      }
      return Object.freeze({namespaces,recovered,collected,failures:Object.freeze(failures)});
    },
    async close(){closed=true;if(active)await active.journal.close();active=null;},
  });
}
