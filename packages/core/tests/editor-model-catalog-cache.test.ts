import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildEditorModelCatalogCacheKey,
  EditorModelCatalogCache,
} from '../src/editor-model-catalog-cache';

function createPluginStorageTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, key)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_storage_ttl ON plugin_storage(ttl) WHERE ttl IS NOT NULL;
  `);
}

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('editor model catalog cache', () => {
  test('shares cached catalog payloads across separate database connections', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'bungee-editor-model-cache-'));
    const dbPath = path.join(tempDir, 'editor-model-cache.sqlite');

    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    createPluginStorageTable(dbA);

    const cacheA = new EditorModelCatalogCache(dbA);
    const cacheB = new EditorModelCatalogCache(dbB);

    let workerAFetches = 0;
    let workerBFetches = 0;
    const cacheKey = buildEditorModelCatalogCacheKey('model-mapping', '1.0.0', '/api/plugins/model-mapping/models?');

    const first = await cacheA.getOrLoad(cacheKey, async () => {
      workerAFetches += 1;
      return new Response(JSON.stringify({ provider: '', source: 'fresh', models: [{ value: 'gpt-4o', provider: 'openai' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const firstPayload = await first.json() as { models: Array<{ value: string }> };
    expect(firstPayload.models[0]?.value).toBe('gpt-4o');
    expect(workerAFetches).toBe(1);

    const second = await cacheB.getOrLoad(cacheKey, async () => {
      workerBFetches += 1;
      return new Response(JSON.stringify({ provider: '', source: 'fresh', models: [{ value: 'claude-3-5-sonnet' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const secondPayload = await second.json() as { models: Array<{ value: string }> };
    expect(secondPayload.models[0]?.value).toBe('gpt-4o');
    expect(workerBFetches).toBe(0);

    dbA.close();
    dbB.close();
  });
});
