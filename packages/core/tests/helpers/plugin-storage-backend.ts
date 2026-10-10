/** Explicit SQLite leaf fixtures. Production hosts use PluginStateClient factories. */
import type {Database} from 'bun:sqlite';
import type {SecretStoreFactory,PluginStorageFactory} from '../../src/plugin-control/host';
import {createSecretStore,revokeSecretStore,clearSecretStore,type SecretKeyMaterial} from '../../src/plugin-control/secret-store';
import {createPluginStorageCapability} from '../../src/plugin-storage';
import type {PluginStorage} from '../../src/plugin.types';
export function createDatabaseSecretStoreFactory(db:Database,material:SecretKeyMaterial|undefined):SecretStoreFactory {
 return {create:namespace=>createSecretStore(db,namespace,material),revoke:revokeSecretStore,clear:clearSecretStore};
}
export function createDatabasePluginStorageFactory(db:Database):PluginStorageFactory {
 const revokes=new WeakMap<PluginStorage,()=>void>();
 return {create:namespace=>{const c=createPluginStorageCapability(db,namespace);revokes.set(c.storage,c.revoke);return c.storage;},revoke:storage=>revokes.get(storage)?.()};
}
