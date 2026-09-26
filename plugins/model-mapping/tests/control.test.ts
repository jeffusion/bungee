import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { ControlHostContext, PluginControl } from '../../../packages/core/src/plugin-control/contracts';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { createControl } from '../server/control';
import { getModelMappingCatalogStatus } from '../server/catalog';

class MemoryStorage implements PluginStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async set(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async keys(prefix?: string): Promise<string[]> { return [...this.values.keys()].filter((key) => !prefix || key.startsWith(prefix)); }
  async clear(): Promise<void> { this.values.clear(); }
  async increment(): Promise<number> { throw new Error('not used'); }
  async compareAndSet(): Promise<boolean> { throw new Error('not used'); }
}

function host(storage: PluginStorage, signal = new AbortController().signal): ControlHostContext {
  return { signal, secretStore: {} as ControlHostContext['secretStore'], storage };
}

function handler(control: PluginControl, name: string) {
  return control.api.find((entry) => entry.handler === name)!;
}

function request(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe('model-mapping control', () => {
  test('lists static catalog and reads a persisted catalog', async () => {
    const storage = new MemoryStorage();
    const control = createControl(host(storage));
    const context = { ...host(storage), request: request('/catalog'), requestSignal: new AbortController().signal };
    const initial = await handler(control, 'getCatalog').invoke(context);
    expect(initial.status).toBe(200);
    expect((await initial.json()).source).toBe('static');
    await storage.set('catalog:v1:data', {
      fetchedAt: 123,
      models: [{ value: 'gpt-test', label: 'GPT Test', description: 'openai', provider: 'openai' }],
    });
    const persisted = await handler(control, 'getCatalog').invoke(context);
    expect(await persisted.json()).toMatchObject({ source: 'stored', fetchedAt: 123, modelCount: 1, providers: ['openai'] });
    await control.dispose();
  });

  test('malformed storage falls back to static data', async () => {
    const storage = new MemoryStorage();
    await storage.set('catalog:v1:data', { fetchedAt: 'bad', models: [{}] });
    const status = await getModelMappingCatalogStatus(storage);
    expect(status.source).toBe('static');
    expect(status.fetchedAt).toBeNull();
  });

  test('serializes concurrent refreshes and persists the result', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ openai: { models: { 'gpt-test': { id: 'gpt-test', name: 'GPT Test' } } } }));
    }) as unknown as typeof fetch;
    try {
      const storage = new MemoryStorage();
      const control = createControl(host(storage));
      const context = { ...host(storage), request: request('/catalog/refresh', 'POST'), requestSignal: new AbortController().signal };
      const [first, second] = await Promise.all([
        handler(control, 'refreshCatalog').invoke(context),
        handler(control, 'refreshCatalog').invoke(context),
      ]);
      expect(calls).toBe(1);
      expect((await first.json()).models).toHaveLength(1);
      expect((await second.json()).source).toBe('stored');
      const persisted = await handler(control, 'getCatalog').invoke({ ...context, request: request('/catalog') });
      expect((await persisted.json()).fetchedAt).toBeNumber();
      await control.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refreshes and pages through a full models.dev-sized catalog without truncation', async () => {
    const originalFetch = globalThis.fetch;
    const models: Record<string, { id: string; name: string }> = {};
    for (let index = 0; index < 8173; index++) {
      const uniqueIndex = index < 8155 ? index : index - 8155;
      const id = `model-${uniqueIndex}`;
      models[`entry-${index}`] = { id, name: `Test model ${uniqueIndex} ${'x'.repeat(64)}` };
    }
    const body = JSON.stringify({ testprovider: { models } });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(512 * 1024);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(16 * 1024 * 1024);
    globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch;
    try {
      const storage = new MemoryStorage();
      const control = createControl(host(storage));
      const refresh = await handler(control, 'refreshCatalog').invoke({
        ...host(storage), request: request('/catalog/refresh', 'POST'), requestSignal: new AbortController().signal,
      });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({ source: 'stored', modelCount: 8155, providerCount: 1, matchedCount: 8155, page: 1, pageSize: 50 });
      const persisted = await storage.get<{ models: unknown[] }>('catalog:v1:data');
      expect(persisted?.models).toHaveLength(8155);

      const getCatalog = handler(control, 'getCatalog');
      const secondPage = await getCatalog.invoke({
        ...host(storage), request: request('/catalog?page=2'), requestSignal: new AbortController().signal,
      });
      const secondPageStatus = await secondPage.json();
      expect(secondPageStatus).toMatchObject({ matchedCount: 8155, page: 2, pageSize: 50, providers: ['testprovider'] });
      expect(secondPageStatus.models).toHaveLength(50);

      const filtered = await getCatalog.invoke({
        ...host(storage), request: request('/catalog?provider=testprovider&search=MODEL%208154'), requestSignal: new AbortController().signal,
      });
      const filteredStatus = await filtered.json();
      expect(filteredStatus).toMatchObject({ modelCount: 8155, providerCount: 1, matchedCount: 1, page: 1 });
      expect(filteredStatus.models[0].label).toContain('Test model 8154');
      const lastPage = await getCatalog.invoke({
        ...host(storage), request: request('/catalog?page=164'), requestSignal: new AbortController().signal,
      });
      expect((await lastPage.json()).models).toHaveLength(5);
      await control.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('clamps a stale page after catalog shrink and resets empty results to page one', async () => {
    const storage = new MemoryStorage();
    const control = createControl(host(storage));
    const getCatalog = handler(control, 'getCatalog');
    const options = (count: number) => Array.from({ length: count }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
      description: 'testprovider',
      provider: 'testprovider',
    }));
    await storage.set('catalog:v1:data', { fetchedAt: 1, models: options(120) });
    const initialLastPage = await getCatalog.invoke({
      ...host(storage), request: request('/catalog?page=3'), requestSignal: new AbortController().signal,
    });
    expect((await initialLastPage.json()).page).toBe(3);

    await storage.set('catalog:v1:data', { fetchedAt: 2, models: options(65) });
    const shrunkLastPage = await getCatalog.invoke({
      ...host(storage), request: request('/catalog?page=3'), requestSignal: new AbortController().signal,
    });
    const shrunkStatus = await shrunkLastPage.json();
    expect(shrunkStatus).toMatchObject({ modelCount: 65, matchedCount: 65, page: 2, pageSize: 50 });
    expect(shrunkStatus.models).toHaveLength(15);
    expect(shrunkStatus.models[0].value).toBe('model-50');
    expect(shrunkStatus.models[14].value).toBe('model-64');

    const emptyFilteredPage = await getCatalog.invoke({
      ...host(storage), request: request('/catalog?search=no-match&page=3'), requestSignal: new AbortController().signal,
    });
    expect(await emptyFilteredPage.json()).toMatchObject({ matchedCount: 0, page: 1, models: [] });
    await control.dispose();
  });

  test('redacts remote catalog errors and rejects body, item, and string bounds', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const cases = [
        new Response(`{"error":"secret upstream details ${'x'.repeat(16 * 1024 * 1024)}"}`),
        new Response(JSON.stringify({ openai: { models: Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`m${i}`, { id: `m${i}` }])) } })),
        new Response(JSON.stringify({ openai: { models: { test: { id: 'test', name: 'x'.repeat(513) } } } })),
      ];
      for (const responseBody of cases) {
        globalThis.fetch = (async () => responseBody) as unknown as typeof fetch;
        const storage = new MemoryStorage();
        const control = createControl(host(storage));
        const response = await handler(control, 'refreshCatalog').invoke({
          ...host(storage), request: request('/catalog/refresh', 'POST'), requestSignal: new AbortController().signal,
        });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'catalog_failed' });
        control.dispose();
      }

      const storage = new MemoryStorage();
      const control = createControl(host(storage));
      for (const path of ['/catalog?page=0', '/catalog?page=401', '/catalog?page=1&page=2', `/catalog?search=${'x'.repeat(513)}`]) {
        const response = await handler(control, 'getCatalog').invoke({
          ...host(storage), request: request(path), requestSignal: new AbortController().signal,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_query' });
      }
      await control.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('dispose waits for an in-flight refresh to reach a terminal state', async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
    try {
      const storage = new MemoryStorage();
      const control = createControl(host(storage));
      const context = { ...host(storage), request: request('/catalog/refresh', 'POST'), requestSignal: new AbortController().signal };
      const refresh = handler(control, 'refreshCatalog').invoke(context);
      await Promise.resolve();
      let disposed = false;
      const disposing = Promise.resolve(control.dispose()).then(() => { disposed = true; });
      await Promise.resolve();
      expect(disposed).toBe(false);
      resolveFetch(new Response(JSON.stringify({ openai: { models: { test: { id: 'test' } } } })));
      await disposing;
      await refresh;
      expect(disposed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
        { path: '/catalog', methods: ['GET'], handler: 'getCatalog' },
        { path: '/catalog/refresh', methods: ['POST'], handler: 'refreshCatalog' },
      ]);

    const storage = new MemoryStorage();
    const control = createControl(host(storage));
    await control.dispose();
    const response = await handler(control, 'getCatalog').invoke({ ...host(storage), request: request('/catalog'), requestSignal: new AbortController().signal });
    expect(response.status).toBe(503);
  });

  test('control artifact does not import the runtime entry', () => {
    const source = readFileSync(new URL('../server/control.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './index'");
  });

  test('control has no legacy aliases', () => {
    const source = readFileSync(new URL('../server/control.ts', import.meta.url), 'utf8');
    for (const symbol of ['export const api', 'export const controlApi', 'export const rpc', 'export const controlRpc', 'getModels']) {
      expect(source).not.toContain(symbol);
    }
  });

  test('runtime entry has no worker catalog compatibility symbols', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    for (const symbol of ['getEditorModels', 'getModels', 'legacyStorage', 'resetModelMappingCatalogCache', 'getModelCatalogResponse']) {
      expect(source).not.toContain(symbol);
    }
  });
});
