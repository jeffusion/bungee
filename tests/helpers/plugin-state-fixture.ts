import {dirname, join} from 'node:path';
import {PluginStateClient} from '../../packages/core/src/plugin-state/client';

/** Offline fixture initialization; runtime never creates or migrates plugin state. */
export function pluginStateFixturePath(configDbPath: string): string {
  return join(dirname(configDbPath), 'plugin-state.db');
}
export async function initializePluginStateFixture(configDbPath: string): Promise<void> {
  const client = await PluginStateClient.open(pluginStateFixturePath(configDbPath), {initialize: true});
  await client.close();
}
