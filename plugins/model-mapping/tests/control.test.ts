import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { ControlHostContext, PluginControl } from '../../../packages/core/src/plugin-control/contracts';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { PluginServiceHost } from '../../../packages/core/src/plugin-services';
import { createControl } from '../server/control';
import { MODELS_DEV_CATALOG_SERVICE_ID } from '../../models-dev/contract';
import { buildCatalogIndex } from '../../models-dev/server/catalog';
import { CatalogView, catalogServiceOf } from '../../models-dev/server/local';

class MemoryStorage implements PluginStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async set(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async keys(prefix?: string): Promise<string[]> { return [...this.values.keys()].filter((key) => !prefix || key.startsWith(prefix)); }
  async clear(): Promise<void> { this.values.clear(); }
}

function catalogService(catalog: unknown) {
  const view = new CatalogView();
  view.apply(buildCatalogIndex({ version: 1, fetchedAt: 123, catalog }));
  return catalogServiceOf(view);
}

function host(storage: PluginStorage, catalog?: unknown, signal = new AbortController().signal): ControlHostContext {
  const services = new PluginServiceHost();
  if (catalog !== undefined) {
    const provider = services.createContext('models-dev');
    provider.publish(MODELS_DEV_CATALOG_SERVICE_ID, 1, catalogService(catalog));
    services.markReady('models-dev');
  }
  return {
    signal, secretStore: {} as ControlHostContext['secretStore'], storage,
    services: services.createContext('model-mapping', 'global', catalog === undefined ? {} : { 'models-dev': '^1.0.0' }),
  };
}

function handler(control: PluginControl, name: string) {
  return control.api.find((entry) => entry.handler === name)!;
}

function request(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method });
}

const sampleCatalog = {
  openai: { id: 'openai', name: 'OpenAI', models: { 'gpt-test': { id: 'gpt-test', name: 'GPT Test', cost: { input: 1, output: 2 } } } },
  deepseek: { id: 'deepseek', name: 'DeepSeek', models: {
    'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'Flash', cost: { input: 1, output: 2 } },
    'no-price': { id: 'no-price', name: 'No Price' },
  } },
};

describe('model-mapping control', () => {
  test('reads the catalog from the models-dev service and pages it', async () => {
    const storage = new MemoryStorage();
    const control = createControl(host(storage, sampleCatalog));
    const context = { ...host(storage, sampleCatalog), request: request('/catalog'), requestSignal: new AbortController().signal };
    const response = await handler(control, 'getCatalog').invoke(context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: 'catalog', fetchedAt: 123, modelCount: 3, providerCount: 2, matchedCount: 3, page: 1, pageSize: 50,
    });
    await control.dispose();
  });

  test('reports an unavailable catalog instead of fabricating one', async () => {
    const storage = new MemoryStorage();
    const control = createControl(host(storage));
    const response = await handler(control, 'getCatalog').invoke({
      ...host(storage), request: request('/catalog'), requestSignal: new AbortController().signal,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'catalog_unavailable' });
    await control.dispose();
  });

  test('pages and filters a full models.dev-sized catalog without truncation', async () => {
    const models: Record<string, { id: string; name: string }> = {};
    for (let index = 0; index < 8173; index++) {
      models[`entry-${index}`] = { id: `model-${index}`, name: `Test model ${index} ${'x'.repeat(32)}` };
    }
    const catalog = { testprovider: { id: 'testprovider', name: 'Test', models } };
    const storage = new MemoryStorage();
    const control = createControl(host(storage, catalog));
    const invoke = (path: string) => handler(control, 'getCatalog').invoke({
      ...host(storage, catalog), request: request(path), requestSignal: new AbortController().signal,
    });
    const first = await (await invoke('/catalog')).json();
    expect(first).toMatchObject({ modelCount: 8173, providerCount: 1, matchedCount: 8173, page: 1, pageSize: 50 });
    expect(first.models).toHaveLength(50);
    const second = await (await invoke('/catalog?page=2')).json();
    expect(second).toMatchObject({ page: 2 });
    expect(second.models).toHaveLength(50);
    const filtered = await (await invoke('/catalog?provider=testprovider&search=MODEL%208172')).json();
    expect(filtered).toMatchObject({ matchedCount: 1, page: 1 });
    expect(filtered.models[0].label).toContain('Test model 8172');
    const lastPage = await (await invoke('/catalog?page=164')).json();
    expect(lastPage.models).toHaveLength(23);
    await control.dispose();
  });

  test('clamps a stale page after catalog shrink and resets empty results to page one', async () => {
    const many = (count: number) => ({ testprovider: { id: 'testprovider', models: Object.fromEntries(Array.from({ length: count }, (_, index) => [`model-${index}`, { id: `model-${index}`, name: `Model ${index}` }])) } });
    const storage = new MemoryStorage();
    const invoke = (catalog: unknown, path: string) => {
      const control = createControl(host(storage, catalog));
      return handler(control, 'getCatalog').invoke({
        ...host(storage, catalog), request: request(path), requestSignal: new AbortController().signal,
      }).finally(() => control.dispose());
    };
    const initialLastPage = await (await invoke(many(120), '/catalog?page=3')).json();
    expect(initialLastPage.page).toBe(3);
    const shrunk = await (await invoke(many(65), '/catalog?page=3')).json();
    expect(shrunk).toMatchObject({ modelCount: 65, matchedCount: 65, page: 2, pageSize: 50 });
    expect(shrunk.models).toHaveLength(15);
    expect(shrunk.models[0].value).toBe('model-50');
    expect(shrunk.models[14].value).toBe('model-64');
    const emptyFilteredPage = await (await invoke(many(65), '/catalog?search=no-match&page=3')).json();
    expect(emptyFilteredPage).toMatchObject({ matchedCount: 0, page: 1, models: [] });
  });

  test('rejects query bounds and duplicate parameters', async () => {
    const storage = new MemoryStorage();
    const control = createControl(host(storage, sampleCatalog));
    for (const path of ['/catalog?page=0', '/catalog?page=401', '/catalog?page=1&page=2', `/catalog?search=${'x'.repeat(513)}`]) {
      const response = await handler(control, 'getCatalog').invoke({
        ...host(storage, sampleCatalog), request: request(path), requestSignal: new AbortController().signal,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_query' });
    }
    await control.dispose();
  });

  test('control route table matches manifest and is inactive after dispose', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      control?: { entry?: string };
      capabilities?: string[];
      contributes?: { api?: readonly { path: string; methods: readonly string[]; handler: string; execution: 'control' }[] };
    };
    expect(manifest.control?.entry).toBe('server/control.ts');
    expect(manifest.capabilities).toContain('controlPlane');
    expect(Array.from(manifest.contributes?.api?.filter((entry) => entry.execution === 'control') ?? [])
      .map(({ execution: _execution, ...entry }) => entry)).toEqual([
        { path: '/catalog', methods: ['GET'], handler: 'getCatalog', capability: 'config.read' },
      ]);

    const storage = new MemoryStorage();
    const control = createControl(host(storage, sampleCatalog));
    await control.dispose();
    const response = await handler(control, 'getCatalog').invoke({
      ...host(storage, sampleCatalog), request: request('/catalog'), requestSignal: new AbortController().signal,
    });
    expect(response.status).toBe(503);
  });

  test('control artifact does not import the runtime entry', () => {
    const source = readFileSync(new URL('../server/control.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './index'");
  });

  test('control has no legacy aliases or second refresh entry', () => {
    const source = readFileSync(new URL('../server/control.ts', import.meta.url), 'utf8');
    for (const symbol of ['export const api', 'export const controlApi', 'export const rpc', 'export const controlRpc', 'getModels', 'refreshCatalog', 'refreshStoredModelMappingCatalog']) {
      expect(source).not.toContain(symbol);
    }
  });

  test('runtime entry has no worker catalog compatibility symbols', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    for (const symbol of ['getEditorModels', 'getModels', 'legacyStorage', 'resetModelMappingCatalogCache', 'getModelCatalogResponse', 'fetchModels', 'tokenlens']) {
      expect(source).not.toContain(symbol);
    }
  });
});
