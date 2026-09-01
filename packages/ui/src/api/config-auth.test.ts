import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigurationNextAuthorizationRequiredError,
  ConfigurationOperationConflictError,
  ConfigurationOperationIdentityError,
  getConfigSnapshot,
  updateConfig,
} from './config';

const aggregate: ConfigurationAggregateV2 = {
  logical_configuration: { auth: { enabled: false, tokens: [] }, services: [], routes: [], plugins: [] },
  plugin_activations: [],
};
const authenticated = {
  ...aggregate,
  logical_configuration: { ...aggregate.logical_configuration, auth: { enabled: true, tokens: ['current-token'] } },
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

function snapshot(config: ConfigurationAggregateV2 = authenticated): Response {
  return Response.json({ config, revision: 7, content_hash: 'sha256:before' });
}

function accepted(state: 'committed' | 'converged'): MockResponse {
  return (init) => {
    const mutationId = JSON.parse(String(init?.body)).mutation_id;
    return Response.json({ operation_id: mutationId, revision: 8,
      operation: { mutation_id: mutationId, state, result_status: state === 'converged' ? 200 : null,
        error_code: null, error_detail: null }, workers: [] }, { status: 202 });
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

describe('configuration auth rotation', () => {
  test('uses next authorization only for an auth change and logs in after acceptance', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [snapshot(), accepted('converged'), snapshot(), accepted('committed'),
      Response.json({ operation: { state: 'converged' }, workers: [] })]);

    const unchanged = await getConfigSnapshot();
    await updateConfig(unchanged, { ...unchanged.config.logical_configuration, log_level: 'debug' });
    const changed = await getConfigSnapshot();
    await updateConfig(changed, { ...changed.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' });

    expect(new Headers(requests[1]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
    expect(new Headers(requests[3]?.init?.headers).get('X-Bungee-Next-Authorization')).toBe('Bearer next-token');
    expect(new Headers(requests[4]?.init?.headers).get('Authorization')).toBe('Bearer next-token');
    expect(values.get('bungee_auth_token')).toBe('next-token');
  });

  test('does not guess credentials from config expressions', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [snapshot({ ...authenticated, logical_configuration: {
      ...authenticated.logical_configuration, auth: { enabled: true, tokens: ['{{ env.API_TOKEN }}'] },
    } })]);
    const loaded = await getConfigSnapshot();

    const error = await rejection(updateConfig(loaded, { ...loaded.config.logical_configuration,
      auth: { enabled: true, tokens: ['{{ env.NEXT_API_TOKEN }}'] } }));

    expect(error).toBeInstanceOf(ConfigurationNextAuthorizationRequiredError);
    expect(requests).toHaveLength(1);
  });

  test('commits unchanged auth without a candidate authorization', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [snapshot(), accepted('converged')]);
    const loaded = await getConfigSnapshot();

    await updateConfig(loaded, loaded.config.logical_configuration);

    expect(new Headers(requests[1]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
    expect(values.get('bungee_auth_token')).toBe('current-token');
    expect(requests).toHaveLength(2);
  });

  test('requires a candidate token when enabling auth', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [snapshot(aggregate)]);
    const loaded = await getConfigSnapshot();

    const error = await rejection(updateConfig(loaded, { ...loaded.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }));

    expect(error).toBeInstanceOf(ConfigurationNextAuthorizationRequiredError);
    expect(requests).toHaveLength(1);
  });

  test('does not require a candidate when auth stays disabled', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [snapshot(aggregate), accepted('converged')]);
    const loaded = await getConfigSnapshot();

    await updateConfig(loaded, { ...loaded.config.logical_configuration, log_level: 'debug' });

    expect(new Headers(requests[1]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
    expect(requests).toHaveLength(2);
  });

  test('keeps the current token and does not poll on operation_in_progress', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [snapshot(), Response.json({ error: 'operation_in_progress',
      operation_id: 'existing', revision: 8, state: 'publishing' }, { status: 409 })]);
    const loaded = await getConfigSnapshot();

    const error = await rejection(updateConfig(loaded, { ...loaded.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' }));

    expect(error).toBeInstanceOf(ConfigurationOperationConflictError);
    expect(error).toMatchObject({ operationId: 'existing', revision: 8, state: 'publishing' });
    expect(values.get('bungee_auth_token')).toBe('current-token');
    expect(requests).toHaveLength(2);
  });

  test('rejects an accepted operation id mismatch before polling or login', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [snapshot(), Response.json({ operation_id: 'different-operation', revision: 8,
      operation: { state: 'committed' }, workers: [] }, { status: 202 })]);
    const loaded = await getConfigSnapshot();

    const error = await rejection(updateConfig(loaded, { ...loaded.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' }));

    expect(error).toBeInstanceOf(ConfigurationOperationIdentityError);
    expect(values.get('bungee_auth_token')).toBe('current-token');
    expect(requests).toHaveLength(2);
  });

  test('disables auth without next authorization and clears the current token', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [snapshot(), accepted('converged')]);
    const loaded = await getConfigSnapshot();

    await updateConfig(loaded, { ...loaded.config.logical_configuration, auth: { enabled: false, tokens: [] } });

    expect(new Headers(requests[1]?.init?.headers).has('X-Bungee-Next-Authorization')).toBe(false);
    expect(values.get('bungee_auth_token')).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  test('accepted 202 keeps current local token during poll and persists only after converged', async () => {
    const requests: RequestRecord[] = [];
    const observed: { token: string | null } = { token: null };
    const values = install(requests, [
      snapshot(),
      accepted('committed'),
      () => {
        observed.token = values.get('bungee_auth_token') ?? null;
        return Response.json({ operation: { state: 'converged' }, workers: [] });
      }
    ]);

    const changed = await getConfigSnapshot();
    await updateConfig(changed, { ...changed.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' });

    expect(observed.token).toBe('current-token');
    expect(values.get('bungee_auth_token')).toBe('next-token');
  });

  test('fast converged persists token immediately', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [
      snapshot(),
      accepted('converged')
    ]);

    const changed = await getConfigSnapshot();
    await updateConfig(changed, { ...changed.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' });

    expect(values.get('bungee_auth_token')).toBe('next-token');
  });

  test('degraded keeps current token', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [
      snapshot(),
      accepted('committed'),
      Response.json({
        operation: {
          mutation_id: 'some-id',
          state: 'degraded',
          result_status: 202,
          error_code: 'replacement_convergence_failed',
          error_detail: 'degraded error'
        },
        workers: []
      })
    ]);

    const changed = await getConfigSnapshot();
    const error = await rejection(updateConfig(changed, { ...changed.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' }));

    expect(error).toBeInstanceOf(Error);
    expect(values.get('bungee_auth_token')).toBe('current-token');
  });

  test('error during poll keeps current token', async () => {
    const requests: RequestRecord[] = [];
    const values = install(requests, [
      snapshot(),
      accepted('committed'),
      () => {
        throw new Error('Network error');
      }
    ]);

    const changed = await getConfigSnapshot();
    const error = await rejection(updateConfig(changed, { ...changed.config.logical_configuration,
      auth: { enabled: true, tokens: ['next-token'] } }, { nextAuthorization: 'next-token' }));

    expect(error).toBeInstanceOf(Error);
    expect(values.get('bungee_auth_token')).toBe('current-token');
  });
});
