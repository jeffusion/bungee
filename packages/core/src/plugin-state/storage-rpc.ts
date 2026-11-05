import type {PluginStorage} from '../plugin.types';
import type {PluginStorageFactory} from '../plugin-control/host';
export const PLUGIN_STORAGE_OPERATIONS = ['get','readStrict','set','delete','keys','clear','increment','compareAndSet','flush'] as const;
export type PluginStorageOperation = typeof PLUGIN_STORAGE_OPERATIONS[number];
export type PluginStorageTransport = (namespace:string,operation:PluginStorageOperation,args:readonly unknown[])=>Promise<unknown>;
const WRITE_OPERATIONS:ReadonlySet<PluginStorageOperation>=new Set(['set','delete','clear','increment','compareAndSet']);
/** Host-side bridge over the existing authenticated master control transport.
 * Plugins receive only one namespace closure, never the transport or a database. */
export function createRemotePluginStorageFactory(send:PluginStorageTransport, observe?: (namespace:string,operation:string,args:readonly unknown[])=>Promise<unknown>):PluginStorageFactory {
  const revocations=new WeakMap<PluginStorage,()=>void>();
  return {
    create(namespace) {
      let revoked=false;
      const pendingWrites=new Set<Promise<unknown>>();
      let firstWriteFailure:{error:unknown}|null=null;
      const active=()=>{if(revoked)throw new Error('plugin_storage_capability_revoked');};
      const capability:any={uncached:()=>{active();return capability;}};
      for(const operation of PLUGIN_STORAGE_OPERATIONS){
        if(operation==='flush')continue;
        capability[operation]=async(...args:unknown[])=>{
          active();
          const accepted=(async()=>send(namespace,operation,args))();
          if(!WRITE_OPERATIONS.has(operation))return accepted;
          const tracked=accepted.then(
            (value)=>{pendingWrites.delete(tracked);return value;},
            (error)=>{pendingWrites.delete(tracked);firstWriteFailure??={error};throw error;},
          );
          pendingWrites.add(tracked);return tracked;
        };
      }
      // The master-backed store has no cache: flush has no transport. It still
      // waits for writes accepted before the call, and keeps their failure.
      capability.flush=async()=>{
        active();
        if(pendingWrites.size>0)await Promise.allSettled([...pendingWrites]);
        active();
        if(firstWriteFailure!==null)throw firstWriteFailure.error;
      };
      if(observe)capability.invokeObservation=async(operation:string,args:readonly unknown[])=>{active();return observe(namespace,operation,args);};
      revocations.set(capability,()=>{revoked=true;});return Object.freeze(capability);
    },
    revoke(storage){revocations.get(storage)?.();},
  };
}
