import {resolve,dirname,join} from 'node:path';
import { lstat } from 'node:fs/promises';
import { constants, Database } from 'bun:sqlite';
import {AsyncConfigRepository} from '../config-storage';
import { prepareConfigurationRuntimeCutover } from '../config-storage/config-repository';
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

/** The Docker host operator confirms the old instance is stopped and fenced from restart. */
export async function prepareStoppedDockerCutover(configDbPath: string, stoppedContainerId: string) {
  if (!/^[0-9a-f]{64}$/.test(stoppedContainerId)) throw new Error('invalid_stopped_docker_container_id');
  const path = resolve(configDbPath);
  return withOfflineStorageSession(path, async session => {
    const status = await lstat(path);
    if (!status.isFile() || status.size === 0) throw new Error('invalid_existing_configuration_database');
    const { db } = await session.open(async () => {
      const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
      return { db, async close() { db.close(true); } };
    });
    return prepareConfigurationRuntimeCutover(db, stoppedContainerId, Date.now());
  });
}
