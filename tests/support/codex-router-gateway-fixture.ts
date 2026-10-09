/** Actual daemon/worker plugins; only the external catalog data is a fixed fixture. */
import {Database} from 'bun:sqlite';
import {cp, mkdir, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {ConfigRepository} from '../../packages/core/src/config-storage';
import {SQLitePluginStorage} from '../../packages/core/src/plugin-storage';
import {HostSnapshotStore} from '../../packages/core/src/plugin-services/snapshot-store';
import {PluginCommunicationStore} from '../../packages/core/src/plugin-services/persistence';
import {MODELS_DEV_SETTINGS_KEY} from '../../plugins/models-dev/server/store';
import {makeCanonicalTempDir} from './canonical-temp';
import type {GatewayFixture} from './token-stats-gateway';

export const CODEX_PROCESS_PROBE = 'codex-router-process-probe';
export const CODEX_MODELS = ['org/native', 'org/chat', 'org/anthropic', 'org/native-ws'];

export async function createCodexRouterGatewayFixture(): Promise<GatewayFixture> {
  const root = makeCanonicalTempDir('codex-router-gateway', {daemonSafe: true});
  try {
    const pluginsPath = join(root, 'data', 'plugins');
    for (const path of [pluginsPath, join(root, 'logs'), join(root, '.bungee', 'run')]) await mkdir(path, {recursive: true});
    for (const name of ['codex-router', 'models-dev', 'key-access', 'token-metering', 'token-stats']) {
      await cp(resolve(import.meta.dir, '../../packages/core/dist/plugins', name), join(pluginsPath, name), {recursive: true, errorOnExist: true});
    }
    const probePath = join(pluginsPath, CODEX_PROCESS_PROBE);
    await mkdir(join(probePath, 'server'), {recursive: true});
    await cp(join(import.meta.dir, 'codex-router-process-probe.ts'), join(probePath, 'server', 'index.ts'));
    await writeFile(join(probePath, 'manifest.json'), JSON.stringify({
      name: CODEX_PROCESS_PROBE, version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
      capabilities: ['hooks', 'dynamicRuntimeLoad'], runtimeScope: 'scoped', main: 'server/index.ts',
      uiExtensionMode: 'none', engines: {bungee: '^5.0.0'}, configSchema: [
        {name: 'priority', type: 'number', label: 'Observer priority', default: -1000},
      ],
    }));
    await writeFile(join(root, 'config.json'), '{invalid json');
    const configDbPath = join(root, 'data', 'bungee.db');
    ConfigRepository.open(configDbPath).close();
    const accessDbPath = join(root, 'logs', 'access.db');
    return {root, configDbPath, accessDbPath, pluginsPath, pluginSecretsKey: randomBytes(32).toString('base64')};
  } catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
}

/** Seed after master creates observation tables, before activating any catalog consumer. */
export async function seedCodexRouterCatalog(fixture: GatewayFixture): Promise<void> {
    const accessDb = new Database(fixture.accessDbPath);
    const configDb = new Database(fixture.configDbPath);
    try {
      await new SQLitePluginStorage(accessDb, 'models-dev').set(MODELS_DEV_SETTINGS_KEY,
        {autoRefresh: false, intervalHours: 24, timeoutSeconds: 15});
      const store = new HostSnapshotStore(new PluginCommunicationStore(configDb, undefined, {setup: false}).forNamespace('models-dev'),
        {owner: 'models-dev', id: 'models-dev.catalog.v1', schemaVersion: 1, maxVersions: 3});
      store.publish(1, {version: 1, fetchedAt: Date.now(), catalog: {lab: {id: 'lab', name: 'Local protocol fixture', models:
        Object.fromEntries(CODEX_MODELS.map(id => [id, {id, name: id, limit: {context: 200000, output: 4096}, tool_call: true,
          reasoning: id===CODEX_MODELS[1], modalities: {input: ['text'], output: ['text']}, cost: {input: 1, output: 2}}]))}}});
    } finally {accessDb.close(); configDb.close();}
}
