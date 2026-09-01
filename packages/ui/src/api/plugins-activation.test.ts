import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigurationOperationDegradedError } from './config';
import { setPluginEnabled } from './plugins';

const originalFetch = globalThis.fetch;
type RequestRecord = { readonly url: string; readonly init?: RequestInit };
type MockResponse = Response | ((init?: RequestInit) => Response);

function install(requests: RequestRecord[], responses: MockResponse[]): void {
  Object.defineProperty(globalThis, 'fetch', { configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected HTTP request');
      return typeof response === 'function' ? response(init) : response;
    } });
}

function accepted(operationId: string, state: 'committed' | 'converged' | 'degraded'): MockResponse {
  return () => Response.json({
    operation_id: operationId,
    revision: 8,
    operation: {
      mutation_id: operationId,
      state,
      result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null,
      error_code: state === 'degraded' ? 'replacement_convergence_failed' : null,
      error_detail: state === 'degraded' ? 'worker rejected configuration' : null,
    },
    workers: [],
  }, { status: 202 });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('Expected promise to reject');
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
});

describe('plugin activation', () => {
  test('returns unchanged for an already-active plugin without polling', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [Response.json({ revision: 7, unchanged: true }, { status: 200 })]);

    // When
    const result = await setPluginEnabled('demo', true);

    // Then
    expect(result).toBe('unchanged');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/__ui/api/plugins/demo/enable');
  });

  test('polls the accepted operation to its converged terminal before resolving', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [
      accepted('op-9', 'committed'),
      Response.json({ operation: { mutation_id: 'op-9', state: 'converged', result_status: 200 }, workers: [] }),
    ]);

    // When
    const result = await setPluginEnabled('demo', false);

    // Then
    expect(result).toBe('converged');
    expect(requests[0]?.url).toBe('/__ui/api/plugins/demo/disable');
    expect(requests[1]?.url).toBe('/__ui/api/config/operations/op-9');
  });

  test('surfaces a degraded terminal as a failure', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [accepted('op-9', 'degraded')]);

    // When
    const error = await rejection(setPluginEnabled('demo', true));

    // Then
    expect(error).toBeInstanceOf(ConfigurationOperationDegradedError);
  });
});
