import { randomUUID } from 'node:crypto';
import { AsyncConfigRepository } from '../../packages/core/src/config-storage';
import { buildPluginManifestCatalog } from '../../packages/core/src/plugin-manifest-catalog';

/** Prepare only while the fixture master is stopped; accounts are created by HTTP setup. */
export async function prepareManagementInitialization(configDbPath: string, pluginsPath: string) {
  const catalog = await buildPluginManifestCatalog({ scanDirectories: [pluginsPath] });
  const repository = await AsyncConfigRepository.open(configDbPath, { offline: true, compileOptions: catalog.toCompileOptions() });
  try {
    const projection = await repository.setManagementProviderOffline('user-auth', randomUUID(), Date.now());
    return { revision: projection.snapshot.revision };
  } finally { await repository.close(); }
}

export async function initializeManagementAccount(base: string, username: string, password: string) {
  const response = await fetch(base + '/api/auth/setup', {
    method: 'POST', headers: { origin: base, 'x-bungee-auth-provider': 'user-auth', 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, passwordConfirmation: password }),
  });
  if (!response.ok) throw new Error(`Management setup failed (${response.status})`);
  await response.body?.cancel();
}
