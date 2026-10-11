import { resolve, dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AsyncConfigRepository } from '../config-storage/async-config-repository';
import { PluginStateClient } from '../plugin-state/client';
import { parsePluginSecretsKey } from '../plugin-control/host';
import { withOfflineStorageSession } from './offline-storage-session';
import { resolveStorageWorkerUrls } from './process-options';

/** Initialize separate configuration and plugin libraries. Identity belongs to the selected provider. */
export async function initializeConfigurationDatabase(input: {readonly configDbPath:string}):Promise<void> {
  const path=resolve(input.configDbPath),pluginPath=join(dirname(path),'plugin-state.db');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await withOfflineStorageSession(path, async session => {
    const urls=resolveStorageWorkerUrls(import.meta.url);
    const material=parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY);
    await session.open(() => AsyncConfigRepository.open(path,{workerUrl:urls.configuration}));
    await session.open(() => PluginStateClient.open(pluginPath,{workerUrl:urls.pluginState,initialize:!existsSync(pluginPath),material}));
  });
}
