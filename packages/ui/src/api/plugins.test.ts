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
    expect(requests[0]?.url).toBe(`/__ui/api/plugins/${expectedEncoded}/enable`);
    expect(requests[1]?.url).toBe(`/__ui/api/plugins/${expectedEncoded}/disable`);
  });
});
