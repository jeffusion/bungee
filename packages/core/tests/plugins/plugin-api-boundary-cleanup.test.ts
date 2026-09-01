import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializePluginRuntime, cleanupPluginRegistry } from '../../src/worker/state/plugin-manager';
import { getScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { handlePluginApiRequest } from '../../src/api/handlers/plugins';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-api-boundary-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await cleanupPluginRegistry();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Plugin API boundary cleanup', () => {
  test('does not lazily create runtime instances from API requests', async () => {
    const root = createTempRoot();
    const pluginDir = join(root, 'plugins', 'boundary-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });

    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'boundary-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['api'],
      uiExtensionMode: 'none',
      engines: { bungee: '*' },
      contributes: {
        api: [{ path: '/status', methods: ['GET'], handler: 'getStatus' }]
      }
    }, null, 2));

    writeFileSync(join(pluginDir, 'dist', 'index.js'), `
      export default class Plugin {
        static name = 'boundary-plugin';
        static version = '1.0.0';
        static async createHandler() {
          return {
            pluginName: 'boundary-plugin',
            register() {},
            async getStatus() {
              return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
            }
          };
        }
      }
    `);

    await initializePluginRuntime({
      plugins: [{
        name: 'boundary-plugin',
        enabled: false,
        path: 'plugins/boundary-plugin/dist/index.js',
      }],
      routes: [],
    }, { basePath: root });

    const scopedRegistry = getScopedPluginRegistry();
    expect(scopedRegistry?.getGlobalInstances()).toHaveLength(0);

    const response = await handlePluginApiRequest(
      new Request('http://localhost/api/plugins/boundary-plugin/status'),
      'boundary-plugin',
      '/status',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Plugin "boundary-plugin" has no active global runtime instance',
      hint: 'Reconcile plugin runtime before calling plugin APIs'
    });
    expect(scopedRegistry?.getGlobalInstances()).toHaveLength(0);
  });

  test('rejects removed legacy static API declarations even when activated', async () => {
    const root = createTempRoot();
    const pluginFile = join(root, 'legacy-api-plugin.ts');

    writeFileSync(pluginFile, `
      export default class LegacyApiPlugin {
        static name = 'legacy-api-plugin';
        static version = '1.0.0';
        static metadata = {
          contributes: {
            api: [{ path: '/summary', methods: ['GET'], handler: 'getSummary' }]
          }
        };

        static async createHandler() {
          return {
            pluginName: 'legacy-api-plugin',
            register() {},
            async getSummary() {
              return new Response(JSON.stringify({ source: 'legacy-metadata' }), {
                headers: { 'Content-Type': 'application/json' }
              });
            }
          };
        }
      }
    `);

    await initializePluginRuntime({
      plugins: [{
        name: 'legacy-api-plugin',
        enabled: true,
        path: 'legacy-api-plugin.ts',
      }],
      routes: [],
    }, { basePath: root, activatedPluginNames: ['legacy-api-plugin'] });

    const response = await handlePluginApiRequest(
      new Request('http://localhost/api/plugins/legacy-api-plugin/summary'),
      'legacy-api-plugin',
      '/summary',
    );

    expect(response.status).toBe(404);
  });
});
