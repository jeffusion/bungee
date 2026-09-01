import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigurationNextAuthorizationRequiredError,
  ConfigurationOperationDegradedError,
  importConfig,
  type ConfigurationSnapshot,
} from './config';

const activeAggregate: ConfigurationAggregateV2 = {
  logical_configuration: { auth: { enabled: true, tokens: ['current-token'] }, services: [], routes: [], plugins: [] },
  plugin_activations: [],
};

function envelope(tokens: string[], enabled = true) {
  return {
    format: 'bungee-config-snapshot',
    format_version: 1,
    schema_version: 2,
    exported_at: 1,
    source_revision: 3,
    content_hash: 'sha256:content',
    envelope_hash: 'sha256:envelope',
    aggregate: {
      logical_configuration: { auth: { enabled, tokens }, services: [], routes: [], plugins: [] },
      plugin_activations: [],
    },
  };
}

const snapshot: ConfigurationSnapshot = {
  config: activeAggregate,
  revision: 7,
  content_hash: 'sha256:before',
};

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
type RequestRecord = { readonly url: string; readonly init?: RequestInit };
type MockResponse = Response | ((init?: RequestInit) => Response);

function install(requests: RequestRecord[], responses: MockResponse[]): Map<string, string> {
  const values = new Map([['bungee_auth_token', 'current-token']]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected HTTP request');
      return typeof response === 'function' ? response(init) : response;
    } });
  return values;
}

function acceptedImport(operationId: string, state: 'committed' | 'converged' | 'degraded'): MockResponse {
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
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('configuration snapshot import', () => {
  test('posts the envelope and polls the accepted operation until converged', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [
      acceptedImport('op-1', 'committed'),
      Response.json({ operation: { mutation_id: 'op-1', state: 'converged', result_status: 200 }, workers: [] }),
    ]);

    // When
    const result = await importConfig(snapshot, envelope(['current-token']));

    // Then
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe('/__ui/api/config/import');
    expect(requests[1]?.url).toBe('/__ui/api/config/operations/op-1');
    expect(result.operation.state).toBe('converged');
  });

  test('sends explicit next authorization when the imported envelope changes auth', async () => {
    // Given
    const requests: RequestRecord[] = [];
    const values = install(requests, [acceptedImport('op-1', 'converged')]);

    // When
    await importConfig(snapshot, envelope(['next-token']), { nextAuthorization: 'next-token' });

    // Then
    expect(new Headers(requests[0]?.init?.headers).get('X-Bungee-Next-Authorization')).toBe('Bearer next-token');
    expect(values.get('bungee_auth_token')).toBe('next-token');
  });

  test('requires an explicit candidate when the imported envelope changes auth', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, []);

    // When
    const error = await rejection(importConfig(snapshot, envelope(['next-token'])));

    // Then
    expect(error).toBeInstanceOf(ConfigurationNextAuthorizationRequiredError);
    expect(requests).toHaveLength(0);
  });

  test('keeps the current token when the operation terminal is degraded', async () => {
    // Given
    const requests: RequestRecord[] = [];
    const values = install(requests, [acceptedImport('op-1', 'degraded')]);

    // When
    const error = await rejection(importConfig(snapshot, envelope(['next-token']), { nextAuthorization: 'next-token' }));

    // Then
    expect(error).toBeInstanceOf(ConfigurationOperationDegradedError);
    expect(values.get('bungee_auth_token')).toBe('current-token');
  });

  test('does not send next authorization when auth is unchanged', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [acceptedImport('op-1', 'converged')]);

    // When
    await importConfig(snapshot, envelope(['current-token']));

    // Then
    expect(new Headers(requests[0]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
  });
});
