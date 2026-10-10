import type {PluginStorage} from '../plugin.types';
import type {PluginStorageFactory} from '../plugin-control/host';
export const PLUGIN_STORAGE_OPERATIONS = ['get','readStrict','set','delete','keys','clear','increment','compareAndSet','flush'] as const;
export type PluginStorageOperation = typeof PLUGIN_STORAGE_OPERATIONS[number];
export type PluginStorageTransport = (namespace:string,operation:PluginStorageOperation,args:readonly unknown[])=>Promise<unknown>;
/** Host-side bridge over the existing authenticated master control transport.
 * Plugins receive only one namespace closure, never the transport or a database. */
export function createRemotePluginStorageFactory(send:PluginStorageTransport):PluginStorageFactory {
  const revocations=new WeakMap<PluginStorage,()=>void>();
  return {
    create(namespace) {
      let revoked=false;
      const active=()=>{if(revoked)throw new Error('plugin_storage_capability_revoked');};
      const capability:any={uncached:()=>{active();return capability;}};
      for(const operation of PLUGIN_STORAGE_OPERATIONS) capability[operation]=async(...args:unknown[])=>{active();return send(namespace,operation,args);};
      revocations.set(capability,()=>{revoked=true;});return Object.freeze(capability);
    },
    revoke(storage){revocations.get(storage)?.();},
  };
}
