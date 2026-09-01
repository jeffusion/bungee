import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAPIRequest } from '../../src/api/router';
import { setServingConfig } from '../../src/api/serving-config';
import { cleanupPluginRegistry, initializePluginRuntime } from '../../src/worker/state/plugin-manager';
import { getScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { resetModelMappingCatalogCache } from '../../../../plugins/model-mapping/server/index';

let configDir: string;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'bungee-plugin-editor-models-'));
  setServingConfig({ routes: [] }, []);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetModelMappingCatalogCache();
  await cleanupPluginRegistry();
  db?.close();
  db = null;
});

process.on('exit', () => {
  if (configDir) {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  }
});

const originalFetch = globalThis.fetch;
let db: Database | null = null;

function createPluginStorageTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, key)
    );
  `);
}

describe('plugin editor model catalog API', () => {
  test('serves offline model catalog for upstream-scoped model-mapping without requiring a global runtime instance', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          openai: {
            id: 'openai',
            models: {
              'gpt-4o': {
                id: 'gpt-4o',
                name: 'GPT-4o',
                limit: { context: 128000 },
                last_updated: '2026-04-10'
              }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof globalThis.fetch;

    await initializePluginRuntime({
      plugins: [],
      routes: [{
        path: '/chat',
        endpoints: [{
          id: 'u1',
          target: 'http://mock-openai.com',
          plugins: [{ name: 'model-mapping', enabled: true }]
        }]
      }],
    }, { basePath: process.cwd() });

    const scopedRegistry = getScopedPluginRegistry();
    expect(scopedRegistry?.getGlobalInstances().find((instance) => instance.handler.pluginName === 'model-mapping')).toBeUndefined();

    const response = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/models'),
      '/api/plugins/model-mapping/models'
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { source: 'stored' | 'static'; models: Array<{ value: string; provider?: string }> };
    expect(payload.source).toBe('static');
    expect(payload.models.length).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  test('refreshes model-mapping catalog into plugin storage through the management endpoint', async () => {
    db = new Database(':memory:');
    createPluginStorageTable(db);

    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          openai: {
            id: 'openai',
            models: {
              'gpt-4o': {
                id: 'gpt-4o',
                name: 'GPT-4o',
                limit: { context: 128000 },
                last_updated: '2026-04-10'
              }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof globalThis.fetch;

    await initializePluginRuntime({
      plugins: [],
      routes: [{
        path: '/chat',
        endpoints: [{
          id: 'u1',
          target: 'http://mock-openai.com',
          plugins: [{ name: 'model-mapping', enabled: true }]
        }]
      }],
    }, { basePath: process.cwd(), db });

    const refreshResponse = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/catalog/refresh', { method: 'POST' }),
      '/api/plugins/model-mapping/catalog/refresh'
    );
    expect(refreshResponse.status).toBe(200);
    const refreshPayload = await refreshResponse.json() as { source: 'stored' | 'static'; modelCount: number; fetchedAt: number | null };
    expect(refreshPayload.source).toBe('stored');
    expect(refreshPayload.modelCount).toBe(1);
    expect(typeof refreshPayload.fetchedAt).toBe('number');
    expect(calls).toBe(1);

    const statusResponse = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/catalog'),
      '/api/plugins/model-mapping/catalog'
    );
    expect(statusResponse.status).toBe(200);
    const statusPayload = await statusResponse.json() as { source: 'stored' | 'static'; modelCount: number };
    expect(statusPayload.source).toBe('stored');
    expect(statusPayload.modelCount).toBe(1);

    const modelsResponse = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/models'),
      '/api/plugins/model-mapping/models'
    );
    expect(modelsResponse.status).toBe(200);
    const modelsPayload = await modelsResponse.json() as { source: 'stored' | 'static'; models: Array<{ value: string; provider?: string }> };
    expect(modelsPayload.source).toBe('stored');
    expect(modelsPayload.models.some((model) => model.value === 'gpt-4o' && model.provider === 'openai')).toBe(true);
  });
});
