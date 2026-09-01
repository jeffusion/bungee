import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigurationOperationDegradedError,
  ConfigurationOperationTimeoutError,
  ConfigurationStaleError,
  ConfigurationValidationError,
  getConfigSnapshot,
  updateConfig,
} from './config';

const aggregate: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: false, tokens: [] },
    services: [],
    routes: [],
    plugins: [],
  },
  plugin_activations: [],
};

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

function accepted(state: 'committed' | 'converged' | 'degraded'): MockResponse {
  return (_input, init) => {
    const mutationId = JSON.parse(String(init?.body)).mutation_id;
    return Response.json({
      operation_id: mutationId,
      revision: 8,
      operation: { ...operation(state), mutation_id: mutationId },
      workers: [],
    }, { status: 202 });
  };
}

function operation(state: 'committed' | 'converged' | 'degraded') {
  return {
    mutation_id: 'server-operation-id',
    request_hash: 'sha256:request',
    expected_revision: 7,
    committed_revision: 8,
    kind: 'config',
    target_worker_count: 1,
    drain_recovery_generation: 0,
    last_drain_recovery_previous_generation: null,
    created_at: 1,
    updated_at: 2,
    state,
    result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null,
    error_code: state === 'degraded' ? 'replacement_convergence_failed' : null,
    error_detail: state === 'degraded' ? 'worker rejected configuration' : null,
  };
}

function snapshot(config: ConfigurationAggregateV2 = aggregate): Response {
  return Response.json({ config, revision: 7, content_hash: 'sha256:before' });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const none = Symbol('no error');
  let result: unknown = none;
  try {
    await promise;
  } catch (error) {
    result = error;
  }
  if (result === none) throw new Error('Expected promise to reject');
  return result;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
});

describe('configuration snapshot shape', () => {
  test('snapshot exposes exactly config, revision, and content_hash', async () => {
    // Given
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    setResponses(requests, [snapshot()]);

    // When
    const loaded = await getConfigSnapshot();

    // Then
    expect(Object.keys(loaded).sort()).toEqual(['config', 'content_hash', 'revision']);
    expect(loaded.revision).toBe(7);
    expect(loaded.content_hash).toBe('sha256:before');
  });
});

describe('configuration v2 bridge', () => {
  test('uses the loaded snapshot for CAS and polls the stable mutation id until converged', async () => {
    // Given
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    setResponses(requests, [
      snapshot(),
      accepted('committed'),
      Response.json({
        operation: operation('converged'),
        workers: [],
      }),
    ]);

    // When
    const loaded = await getConfigSnapshot();
    await updateConfig(loaded, { ...loaded.config.logical_configuration, log_level: 'debug' });

    // Then
    expect(requests).toHaveLength(3);
    const putBody = JSON.parse(String(requests[1]?.init?.body));
    expect(putBody.expected_revision).toBe(7);
    expect(putBody.aggregate.logical_configuration.log_level).toBe('debug');
    expect(putBody.mutation_id).toBeString();
    expect(requests[2]?.url).toBe(`/__ui/api/config/operations/${putBody.mutation_id}`);
  });

  test('throws a structured stale error for HTTP 409', async () => {
    // Given
    setResponses([], [snapshot(), Response.json({ error: 'stale_revision', active: { revision: 8 } }, { status: 409 })]);
    const loaded = await getConfigSnapshot();

    // When
    const error = await rejection(updateConfig(loaded, loaded.config.logical_configuration));

    // Then
    expect(error).toBeInstanceOf(ConfigurationStaleError);
    expect(error).toMatchObject({ expectedRevision: 7 });
  });

  test('throws a structured validation error for HTTP 422', async () => {
    // Given
    const errors = [{ path: 'logical_configuration.routes[0]', message: 'invalid route' }];
    setResponses([], [snapshot(), Response.json({ error: 'invalid_configuration', errors }, { status: 422 })]);
    const loaded = await getConfigSnapshot();

    // When
    const error = await rejection(updateConfig(loaded, loaded.config.logical_configuration));

    // Then
    expect(error).toBeInstanceOf(ConfigurationValidationError);
    expect(error).toMatchObject({ errors });
  });

  test('treats a degraded HTTP 202 operation body as terminal failure', async () => {
    // Given
    setResponses([], [snapshot(), accepted('degraded')]);
    const loaded = await getConfigSnapshot();

    // When
    const error = await rejection(updateConfig(loaded, loaded.config.logical_configuration));

    // Then
    expect(error).toBeInstanceOf(ConfigurationOperationDegradedError);
    expect(error).toMatchObject({
      operation: { state: 'degraded', result_status: 202, error_code: 'replacement_convergence_failed' },
    });
  });

  test('throws a structured timeout error when a nonterminal operation misses its deadline', async () => {
    // Given
    setResponses([], [snapshot(), accepted('committed')]);
    const loaded = await getConfigSnapshot();

    // When
    const error = await rejection(updateConfig(
      loaded,
      loaded.config.logical_configuration,
      { timeoutMs: -1 },
    ));

    // Then
    expect(error).toBeInstanceOf(ConfigurationOperationTimeoutError);
  });

});
