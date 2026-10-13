import {resolve,dirname,join} from 'node:path';
import {AsyncConfigRepository} from '../config-storage';
import {PluginStateClient} from '../plugin-state/client';
import {parsePluginSecretsKey} from '../plugin-control';
import {resolveStorageWorkerUrls} from './process-options';
import {withOfflineStorageSession} from './offline-storage-session';

/** The caller must stop the whole instance and archive unsupported runtime descriptors first. */
export async function prepareRuntimeUpgrade(configDbPath:string):Promise<{converted_executor_proofs:number}> {
  const path=resolve(configDbPath);
  return withOfflineStorageSession(path,async session=>{
    const urls=resolveStorageWorkerUrls(import.meta.url);
    const repository=await session.open(()=>AsyncConfigRepository.open(path,{workerUrl:urls.configuration}));
    await repository.verify();
    const state=await session.open(()=>PluginStateClient.open(join(dirname(path),'plugin-state.db'),{offline:true,
      workerUrl:urls.pluginState,material:parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY)}));
    let cursor='';let converted=0;
    while(true) {
      const result=await state.prepareExecutorProofPage(cursor);converted+=result.converted;
      if(result.scanned<128) break;
      cursor=result.last_key!;
    }
    return {converted_executor_proofs:converted};
  });
}
