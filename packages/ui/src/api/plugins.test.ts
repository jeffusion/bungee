import { afterEach, describe, expect, test } from 'bun:test';
import { PluginsAPI } from './plugins';

const originalFetch = globalThis.fetch;

type MockResponse = Response | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

function setResponses(
  requests: Array<{ readonly url: string; readonly init?: RequestInit }>,
  responses: MockResponse[],
): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected HTTP request');
      return typeof response === 'function' ? await response(input, init) : response;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
});

describe('PluginsAPI enable/disable encoding', () => {
  test('encodes plugin names with reserved, percent, space, and Unicode characters exactly once', async () => {
    // Given
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    setResponses(requests, [
      Response.json({ success: true }),
      Response.json({ success: true }),
    ]);

    const complexName = 'foo/bar% 20测试';
    // Expected encoded segment:
    // 'foo' -> 'foo'
    // '/' -> '%2F'
    // 'bar' -> 'bar'
    // '%' -> '%25'
    // ' ' -> '%20'
    // '20' -> '20'
    // '测试' -> '%E6%B5%8B%E8%AF%95'
    // Combined: 'foo%2Fbar%25%2020%E6%B5%8B%E8%AF%95'
    const expectedEncoded = 'foo%2Fbar%25%2020%E6%B5%8B%E8%AF%95';

    // When
    await PluginsAPI.enable(complexName);
    await PluginsAPI.disable(complexName);

    // Then
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`/api/plugins/${expectedEncoded}/enable`);
    expect(requests[1]?.url).toBe(`/api/plugins/${expectedEncoded}/disable`);
  });

  test('model catalog APIs use the plugin control namespace', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    setResponses(requests, [
      Response.json({ provider: 'model-mapping', models: [] }),
      Response.json({ source: 'static', fetchedAt: null, modelCount: 0, providerCount: 0, matchedCount: 0, page: 1, pageSize: 50, models: [], providers: [] }),
      Response.json({ source: 'stored', fetchedAt: 1, modelCount: 1, providerCount: 1, matchedCount: 1, page: 1, pageSize: 50, models: [], providers: ['openai'] }),
    ]);

    await PluginsAPI.getPluginModels('model-mapping', 'openai');
    await PluginsAPI.getModelMappingCatalogStatus();
    await PluginsAPI.refreshModelMappingCatalog();

    expect(requests.map((request) => [request.url, request.init?.method])).toEqual([
      ['/api/plugins/model-mapping/control/models?provider=openai', 'GET'],
      ['/api/plugins/model-mapping/control/catalog', 'GET'],
      ['/api/plugins/model-mapping/control/catalog/refresh', 'POST'],
    ]);
  });

  test('catalog query preserves exact provider and search, page, and abort signal', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    setResponses(requests, [Response.json({ source: 'static', fetchedAt: null, modelCount: 90, providerCount: 2, providers: ['Foo & Bar', 'other'], matchedCount: 52, page: 2, pageSize: 50, models: [] })]);
    const controller = new AbortController();
    const result = await PluginsAPI.getModelMappingCatalogStatus({ provider: 'Foo & Bar', search: 'A/B 中文', page: 2 }, controller.signal);
    expect(requests[0]?.url).toBe('/api/plugins/model-mapping/control/catalog?provider=Foo+%26+Bar&search=A%2FB+%E4%B8%AD%E6%96%87&page=2');
    expect(requests[0]?.init?.signal).toBe(controller.signal);
    expect(result.matchedCount).toBe(52);
    expect(result.models).toHaveLength(0);
  });
});
