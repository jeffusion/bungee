import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigRepository} from '../../packages/core/src/config-storage';
import {PluginStateClient} from '../../packages/core/src/plugin-state/client';
import {initializePluginStateFixture, pluginStateFixturePath} from './plugin-state-fixture';

test('offline fixture initialization isolates durable plugin data from the configuration library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-plugin-state-fixture-'));
  const configPath = join(root, 'bungee.db');
  try {
    ConfigRepository.open(configPath).close();
    await initializePluginStateFixture(configPath);
    const state = await PluginStateClient.open(pluginStateFixturePath(configPath));
    try {
      await state.durableState('fixture').transact([{key: 'record', expectedVersion: 0, value: {persisted: true}}]);
    } finally {await state.close();}
    const config = new Database(configPath, {readonly: true});
    const plugin = new Database(pluginStateFixturePath(configPath), {readonly: true});
    try {
      expect(config.query("SELECT name FROM sqlite_master WHERE name IN ('plugin_durable_records', 'plugin_storage', 'plugin_communication_records', 'secret_store_objects')").all()).toEqual([]);
      expect(plugin.query('PRAGMA user_version').get()).toEqual({user_version: 1});
      expect(plugin.query("SELECT version,value_json FROM plugin_durable_records WHERE namespace='fixture' AND key='record'").get())
        .toEqual({version: 1, value_json: '{"persisted":true}'});
    } finally {config.close(); plugin.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});
