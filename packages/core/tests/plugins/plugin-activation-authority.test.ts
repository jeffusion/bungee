import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { handleGetPlugins, handleGetPluginSchemas } from '../../src/api/handlers/plugins';
import { clearServingConfig, setServingConfig } from '../../src/api/serving-config';
import type { MutableRequestContext } from '../../src/hooks';
import {
  cleanupPluginRegistry,
  getPluginRuntimeOrchestrator,
  initializePluginRuntime,
} from '../../src/worker/state/plugin-manager';

const pluginName = 'activation-authority-plugin';
const roots: string[] = [];

function fixture(legacyEnabled: boolean): { root: string; db: Database; pluginPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-activation-authority-'));
  const pluginsDir = join(root, 'plugins');
  const pluginPath = join(pluginsDir, `${pluginName}.ts`);
  roots.push(root);
  mkdirSync(pluginsDir);
  writeFileSync(pluginPath, `export default class ActivationAuthorityPlugin {
    static name = '${pluginName}';
    static version = '1.0.0';
    static async createHandler() { return {
      pluginName: '${pluginName}',
      register(hooks) {
        hooks.onBeforeRequest.tapPromise({ name: '${pluginName}' }, async (context) => {
          context.headers['x-activation-authority'] = 'executed';
          return context;
        });
      },
    }; }
  }`);
  const db = new Database(':memory:');
  db.run(`CREATE TABLE plugin_registry (
    name TEXT PRIMARY KEY, version TEXT NOT NULL, description TEXT NOT NULL,
    path TEXT, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare(`INSERT INTO plugin_registry
    (name, version, description, path, enabled, created_at, updated_at)
    VALUES (?, '0.9.0', '', ?, ?, 1, 1)`)
    .run(pluginName, pluginPath, legacyEnabled ? 1 : 0);
  return { root, db, pluginPath };
}

async function listedPlugin(): Promise<Record<string, unknown>> {
  const response = await handleGetPlugins(new Request('http://localhost/api/plugins'));
  const plugins = await response.json() as Array<Record<string, unknown>>;
  const plugin = plugins.find(({ name }) => name === pluginName);
  if (!plugin) throw new Error('fixture plugin was not listed');
  return plugin;
}

function runtimePlugin() {
  const plugin = getPluginRuntimeOrchestrator()?.getStatusReport().plugins
    .find(({ pluginName: name }) => name === pluginName);
  if (!plugin) throw new Error('fixture plugin runtime state was not listed');
  return plugin;
}

function requestContext(): MutableRequestContext {
  return {
    method: 'GET',
    originalUrl: new URL('http://localhost/eligibility'),
    clientIP: '127.0.0.1',
    requestId: crypto.randomUUID(),
    routeId: '/eligibility',
    url: new URL('http://example.test'),
    headers: {},
    body: null,
  };
}

async function enabledSchemas(): Promise<Record<string, unknown>> {
  const response = await handleGetPluginSchemas(
    new Request('http://localhost/api/plugins/schemas?enabledOnly=true'),
  );
  return await response.json() as Record<string, unknown>;
}

afterEach(async () => {
  clearServingConfig();
  await cleanupPluginRegistry();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('revisioned plugin activation authority', () => {
  for (const [activated, bindingEnabled] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const) {
    test(`runtime eligibility requires activated=${activated} and binding enabled=${bindingEnabled}`, async () => {
      const { root, db, pluginPath } = fixture(true);
      const config: AppConfig = {
        routes: [],
        plugins: [{ name: pluginName, path: pluginPath, enabled: bindingEnabled }],
      };
      const activatedPluginNames = activated ? [pluginName] : [];
      setServingConfig(config, activatedPluginNames);

      try {
        const result = await initializePluginRuntime(config, { basePath: root, db, activatedPluginNames });
        const shouldServe = activated && bindingEnabled;
        const runtime = runtimePlugin();
        const hooks = getPluginRuntimeOrchestrator()?.getScopedRegistry()?.getPrecompiledHooks('/eligibility').routePhase;
        if (!hooks) throw new Error('fixture plugin hooks were unavailable');

        const transformed = await hooks.hooks.onBeforeRequest.promise(requestContext());

        expect(result.runtime.success).toBe(shouldServe ? 1 : 0);
        expect(runtime.state.states.persistedEnabled).toBe(activated ? 'enabled' : 'disabled');
        expect(runtime.state.states.runtimeLoaded).toBe(shouldServe ? 'loaded' : 'not-loaded');
        expect(runtime.state.runtime.servingScopes).toEqual(shouldServe ? [{ type: 'global' }] : []);
        expect(hooks.handlers).toHaveLength(shouldServe ? 1 : 0);
        if (shouldServe) {
          expect(transformed.headers['x-activation-authority']).toBe('executed');
        } else {
          expect(transformed.headers['x-activation-authority']).toBeUndefined();
        }
      } finally {
        db.close();
      }
    });
  }

  test('active config overrides legacy access.db disabled', async () => {
    const { root, db, pluginPath } = fixture(false);
    const config: AppConfig = {
      routes: [],
      plugins: [{ name: pluginName, path: pluginPath, enabled: true }],
    };
    setServingConfig(config, [pluginName]);
    await initializePluginRuntime(config, { basePath: root, db, activatedPluginNames: [pluginName] });

    expect((await listedPlugin()).enabled).toBe(true);
    expect(runtimePlugin().state.states.persistedEnabled).toBe('enabled');
    expect(runtimePlugin().state.authorities.persistedEnabled).toBe('configuration');
    expect(await enabledSchemas()).toHaveProperty(pluginName);
    expect((db.query('SELECT enabled FROM plugin_registry WHERE name = ?').get(pluginName) as { enabled: number }).enabled).toBe(0);
    db.close();
  });

  test('inactive config overrides legacy access.db enabled', async () => {
    const { root, db, pluginPath } = fixture(true);
    const config: AppConfig = {
      routes: [],
      plugins: [{ name: pluginName, path: pluginPath, enabled: false }],
    };
    setServingConfig(config, []);
    await initializePluginRuntime(config, { basePath: root, db, activatedPluginNames: [] });

    expect((await listedPlugin()).enabled).toBe(false);
    expect(runtimePlugin().state.states.persistedEnabled).toBe('disabled');
    expect(await enabledSchemas()).not.toHaveProperty(pluginName);
    expect((db.query('SELECT enabled FROM plugin_registry WHERE name = ?').get(pluginName) as { enabled: number }).enabled).toBe(1);
    db.close();
  });

  test('active plugin with no binding remains enabled in the API', async () => {
    const { root, db } = fixture(false);
    const config: AppConfig = { routes: [] };
    setServingConfig(config, [pluginName]);
    await initializePluginRuntime(config, { basePath: root, db, activatedPluginNames: [pluginName] });

    const plugin = await listedPlugin();
    expect(plugin.enabled).toBe(true);
    expect((plugin.instances as Record<string, number>).global).toBe(0);
    expect(runtimePlugin().state.lifecycle).toBe('enabled');
    expect(runtimePlugin().state.runtime.servingScopes).toEqual([]);
    expect(await enabledSchemas()).toHaveProperty(pluginName);
    db.close();
  });
});
