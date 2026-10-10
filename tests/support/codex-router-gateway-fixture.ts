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
export const CODEX_CHAT_MODEL = 'glm-5.3-flash';
export const CODEX_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const CODEX_MODELS = ['org/native', 'org/chat', 'org/anthropic', 'org/native-ws'];

// Only this process's freshly created fixtures may launch a Codex probe.
const probeTargets = new Map<string, Set<string>>();
export function registerCodexProbeTargets(fixture: GatewayFixture, urls: readonly string[]): void {
  const targets=probeTargets.get(fixture.root);if(!targets)throw new Error('unowned Codex fixture');
  for(const value of urls){const url=new URL(value);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password)throw new Error('Codex fixture requires an explicit loopback port');
    targets.add(url.origin);
  }
}
export function assertCodexProbeTargets(root: string, urls: readonly string[]=[]): void {
  const targets=probeTargets.get(root);if(!targets)throw new Error('unowned Codex fixture');
  if(urls.some(value=>!targets.has(new URL(value).origin)))throw new Error('unregistered Codex fixture target');
}

export async function createCodexRouterGatewayFixture(): Promise<GatewayFixture> {
  const root = makeCanonicalTempDir('codex-router-gateway', {daemonSafe: true});
  try {
    const pluginsPath = join(root, 'data', 'plugins');
    for (const path of [pluginsPath, join(root, 'logs'), join(root, '.bungee', 'run')]) await mkdir(path, {recursive: true});
    for (const name of ['codex-router', 'llm-protocol-adapter', 'models-dev', 'key-access', 'token-metering', 'token-stats']) {
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
    probeTargets.set(root,new Set());
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
          reasoning: id===CODEX_MODELS[1], modalities: {input: ['text'], output: ['text']}, cost: {input: 1, output: 2}}]))},
        zai: {models: {[CODEX_CHAT_MODEL]: {name: 'Flash', reasoning: true, reasoning_options: [{type: 'effort', values: ['low','high','max']}], tool_call: true, limit: {context: 200000, output: 4096}, modalities: {input: ['text'], output: ['text']}}}},
        anthropic: {models: {[CODEX_ANTHROPIC_MODEL]: {name: 'Sonnet', reasoning: true, reasoning_options: [{type: 'effort', values: ['low','medium','high','max']}], tool_call: true, limit: {context: 200000, output: 4096}, modalities: {input: ['text'], output: ['text']}}}},
      }});
    } finally {accessDb.close(); configDb.close();}
}
