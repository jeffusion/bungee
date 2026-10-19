import { randomUUID } from 'node:crypto';
import { AsyncConfigRepository } from '../../packages/core/src/config-storage';
import { buildPluginManifestCatalog } from '../../packages/core/src/plugin-manifest-catalog';
import { PluginStateClient } from '../../packages/core/src/plugin-state/client';
import { prepareInitialization } from '../../plugins/user-auth/server/control';
import { pluginStateFixturePath } from './plugin-state-fixture';

/** Prepare only while the fixture master is stopped; accounts are created by HTTP setup. */
export async function prepareManagementInitialization(configDbPath: string, pluginsPath: string) {
  const state = await PluginStateClient.open(pluginStateFixturePath(configDbPath));
  let prepared: Awaited<ReturnType<typeof prepareInitialization>>;
  try { prepared = await prepareInitialization({ durableState: state.durableState('user-auth') }); }
  finally { await state.close(); }
  const catalog = await buildPluginManifestCatalog({ scanDirectories: [pluginsPath] });
  const repository = await AsyncConfigRepository.open(configDbPath, { offline: true, compileOptions: catalog.toCompileOptions() });
  try {
    const projection = await repository.setManagementProviderOffline('user-auth', randomUUID(), Date.now());
    return { ...prepared, revision: projection.snapshot.revision };
  } finally { await repository.close(); }
}

export async function initializeManagementAccount(base: string, code: string, username: string, password: string) {
  const response = await fetch(base + '/api/auth/setup', {
    method: 'POST', headers: { origin: base, 'x-bungee-auth-provider': 'user-auth', 'content-type': 'application/json' },
    body: JSON.stringify({ setupCode: code, username, password, passwordConfirmation: password }),
  });
  if (!response.ok) throw new Error(`Management setup failed (${response.status})`);
  await response.body?.cancel();
}
