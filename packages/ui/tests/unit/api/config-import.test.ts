import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import {
  ConfigurationOperationDegradedError,
  ConfigurationStaleError,
  ConfigurationOperationTimeoutError,
  importConfig,
  validateImport,
  commitConfiguration,
  type ConfigurationSnapshot,
  type ConfigurationImportPreview,
} from '../../../src/api/config';
import { preCommitRejection } from '../../../src/components/domain/config/publication-state';

const activeAggregate: ConfigurationAggregate = {
  logical_configuration: { auth: { enabled: true, tokens: ['current-token'] }, services: [], routes: [], plugins: [] },
  plugin_activations: [],
};

function envelope(tokens: string[], enabled = true) {
  return {
    format: 'bungee-config-snapshot',
    format_version: 1,
    schema_version: 1,
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

let lastMutationId = '';
function acceptedImport(state: 'committed' | 'converged' | 'degraded'): MockResponse {
  return (init) => {
    const operationId = lastMutationId = JSON.parse(String(init?.body)).mutation_id;
    return Response.json({
    operation_id: operationId,
    revision: 8,
    operation: {
      mutation_id: operationId,
      expected_revision: 7,
      committed_revision: 8,
      state,
      result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null,
      error_code: state === 'degraded' ? 'replacement_convergence_failed' : null,
      error_detail: state === 'degraded' ? 'worker rejected configuration' : null,
    },
    workers: [],
  }, { status: 202 });
  };
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
  test('previews the original sealed snapshot through the server without writing or mutating it', async () => {
    const requests:RequestRecord[]=[];
    const original=envelope(['current-token']), before=JSON.stringify(original);
    const report: ConfigurationImportPreview={valid:true,errors:[],aggregate:activeAggregate};
    install(requests,[Response.json(report)]);
    expect(await validateImport(original)).toEqual(report);
    expect(requests).toHaveLength(1); expect(requests[0].url).toBe('/api/config/validate');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({envelope:original});
    expect(JSON.stringify(original)).toBe(before);
  });
  test('posts only the frozen CAS wrapper and polls the exact client mutation until converged', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [
      acceptedImport('committed'),
      () => Response.json({ operation: { mutation_id: lastMutationId, expected_revision: 7, committed_revision: 8, state: 'converged', result_status: 200 }, workers: [] }),
    ]);

    // When
    const result = await importConfig(snapshot, envelope(['current-token']));

    // Then
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe('/api/config/import');
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(Object.keys(body).sort()).toEqual(['envelope', 'expected_revision', 'mutation_id']);
    expect(body.expected_revision).toBe(7);
    expect(body.mutation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.envelope).toEqual(envelope(['current-token']));
    expect(requests[1]?.url).toBe(`/api/config/operations/${body.mutation_id}`);
    expect(result.operation.state).toBe('converged');
  });

  test('sends explicit next authorization when the imported envelope changes auth', async () => {
    // Given
    const requests: RequestRecord[] = [];
    const values = install(requests, [acceptedImport('converged')]);

    // When
    await importConfig(snapshot, envelope(['next-token']), { nextAuthorization: 'next-token' });

    // Then
    expect(new Headers(requests[0]?.init?.headers).get('X-Bungee-Next-Authorization')).toBe('Bearer next-token');
    expect(values.get('bungee_auth_token')).toBe('current-token');
  });

  test('ordinary import does not infer an authentication switch from legacy auth', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [acceptedImport('converged')]);
    await importConfig(snapshot, envelope(['next-token']));
    expect(new Headers(requests[0]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test('keeps the current token when the operation terminal is degraded', async () => {
    // Given
    const requests: RequestRecord[] = [];
    const values = install(requests, [acceptedImport('degraded')]);

    // When
    const error = await rejection(importConfig(snapshot, envelope(['next-token']), { nextAuthorization: 'next-token' }));

    // Then
    expect(error).toBeInstanceOf(ConfigurationOperationDegradedError);
    expect(values.get('bungee_auth_token')).toBe('current-token');
  });

  test('does not send next authorization when auth is unchanged', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [acceptedImport('converged')]);

    // When
    await importConfig(snapshot, envelope(['current-token']));

    // Then
    expect(new Headers(requests[0]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
  });
});

test('import CAS conflict is structured; it never silently retries or posts a naked envelope', async () => {
  const requests: RequestRecord[] = [];
  install(requests, [Response.json({ error: 'stale_revision' }, { status: 409 })]);
  expect(await rejection(importConfig(snapshot, envelope(['current-token'])))).toBeInstanceOf(ConfigurationStaleError);
  expect(requests).toHaveLength(1);
});

test('import timeout retains the dispatched identity and performs no second POST', async () => {
  const requests: RequestRecord[] = [], ids: string[] = [], states: string[] = [];
  install(requests, [acceptedImport('committed')]);
  expect(await rejection(importConfig(snapshot, envelope(['current-token']), {
    timeoutMs: -1, onDispatch: id => ids.push(id), onOperation: s => states.push(s.operation.state),
  }))).toBeInstanceOf(ConfigurationOperationTimeoutError);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(String(requests[0].init?.body)).mutation_id).toBe(ids[0]);
  expect(states).toEqual(['committed']);
});

for (const method of ['PUT', 'import'] as const) {
  test(`${method}: a committed write whose response is lost is reconciled by the original identity`, async () => {
    const requests: RequestRecord[] = [], dispatched: string[] = [];
    let revision = snapshot.revision, operation: { mutation_id: string; state: string; expected_revision: number; committed_revision: number; result_status: null } | null = null;
    let accepted = false, observations = 0;
    const candidate = envelope(['next-token']), before = JSON.stringify(candidate);
    const values = install(requests, [
      init => {
        const body = JSON.parse(String(init?.body));
        revision++;
        operation = { mutation_id: body.mutation_id, state: 'committed', expected_revision: snapshot.revision, committed_revision: revision, result_status: null };
        return Response.json({ error: 'repository_unavailable' }, { status: 503 });
      },
      init => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer next-token');
        return Response.json({ operation, workers: [] });
      },
    ]);
    const options = { nextAuthorization: 'next-token', completion: 'committed' as const, onDispatch: (id: string) => dispatched.push(id),
      onOperation: () => { accepted = true; observations++; } };
    const result = await (method === 'PUT' ? commitConfiguration(snapshot, candidate.aggregate, options) : importConfig(snapshot, candidate, options));
    expect(revision).toBe(snapshot.revision + 1);
    expect(operation).not.toBeNull();
    expect(result.operation.mutation_id).toBe(dispatched[0]);
    expect(result.operation.state).toBe('committed');
    expect(accepted).toBe(true); expect(observations).toBe(1);
    expect(requests).toHaveLength(2); expect(dispatched).toHaveLength(1);
    expect(JSON.stringify(candidate)).toBe(before);
    expect(values.get('bungee_auth_token')).toBe('current-token');
    expect(requests[1].url).toBe(`/api/config/operations/${dispatched[0]}`);
    expect(requests.filter(r => r.init?.method === 'PUT' || r.init?.method === 'POST')).toHaveLength(1);
  });
  for (const failure of ['control_recovering', 'control_readiness_failed', 'repository_unavailable', '500', '502', '504', 'nonJSON', 'network', 'read', 'accepted503']) {
    test(`${method}: ${failure} has exactly one write and preserves candidate`, async () => {
      const requests: RequestRecord[] = [];
      const code = failure === 'accepted503' ? 'control_recovering' : failure;
      const status = ['500', '502', '504'].includes(failure) ? Number(failure) : 503;
      const response: MockResponse = failure === 'network' ? () => { throw new TypeError('SECRET'); }
        : failure === 'read' ? () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('SECRET')); } }), { status: 503 })
        : failure === 'nonJSON' ? new Response('SECRET', { status })
        : Response.json({ error: code, reason: 'lease_margin', message: 'SECRET' }, { status });
      const queried = !['control_recovering', 'control_readiness_failed', 'accepted503'].includes(failure);
      const values = install(requests, [...(failure === 'accepted503' ? [acceptedImport('committed')] : []), response,
        ...(queried ? [Response.json({ error: 'operation_not_found' }, { status: 404 })] : [])]);
      const candidate = envelope(['next-token']), before = JSON.stringify(candidate);
      let accepted = false;
      const options = { nextAuthorization: 'next-token', onOperation: () => { accepted = true; }, pollIntervalMs: 0 };
      const error = await rejection(method === 'PUT' ? commitConfiguration(snapshot, candidate.aggregate, options) : importConfig(snapshot, candidate, options));
      expect(!!preCommitRejection(error, accepted)).toBe(['control_recovering', 'control_readiness_failed'].includes(failure));
      expect(requests.filter(r => r.init?.method === 'PUT' || r.init?.method === 'POST')).toHaveLength(1);
      expect(requests).toHaveLength(failure === 'accepted503' ? 2 : queried ? 2 : 1);
      expect(accepted).toBe(failure === 'accepted503');
      if (queried) {
        const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
        expect(new URL(requests[1]!.url, 'http://ui.test').pathname).toBe(`/api/config/operations/${id}`);
        expect(new Headers(requests[1]!.init?.headers).get('Authorization')).toBe('Bearer next-token');
      }
      expect(JSON.stringify(candidate)).toBe(before);
      expect(values.get('bungee_auth_token')).toBe('current-token');
    });
  }
}
