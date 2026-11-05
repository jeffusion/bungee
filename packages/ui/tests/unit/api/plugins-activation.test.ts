import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ConfigurationOperation } from '../../../src/api/config';
import { PluginsAPI, setPluginEnabled } from '../../../src/api/plugins';
import { ConfigurationSubmissionUnknownError } from '../../../src/api/config';
import { pendingPublicationKey, readPendingPublication } from '../../../src/components/domain/config/workspace';
import { configurationWrite } from '../../../src/stores/configuration-write';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const operationId = '10000000-0000-4000-8000-000000000009';
let stored: Map<string, string>;
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

function accepted(state: ConfigurationOperation['state']): MockResponse {
  return init => {
    const operationId = JSON.parse(String(init?.body)).mutation_id;
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

beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true, value:{
    setItem:(key:string,value:string) => stored.set(key,value),
    getItem:(key:string) => stored.get(key) ?? null,
    removeItem:(key:string) => stored.delete(key),
  }});
});
afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else delete (globalThis as any).sessionStorage;
});

describe('plugin activation', () => {
  test('reads the target provider setup status without enabling it and rejects indeterminate responses', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [Response.json({initialized:false}), Response.json({initialized:true}), Response.json({}), Response.json({initialized:'ready'})]);
    expect(await PluginsAPI.getManagementSetup('test-auth')).toEqual({initialized:false});
    expect(await PluginsAPI.getManagementSetup('test-auth')).toEqual({initialized:true});
    for (let i = 0; i < 2; i++) await expect(PluginsAPI.getManagementSetup('test-auth')).rejects.toThrow('management_setup_unavailable');
    expect(requests.every(request => request.url === '/api/plugins/test-auth/management-setup' && !request.init?.method)).toBe(true);
  });
  test('returns unchanged for an already-active plugin without polling', async () => {
    // Given
    const requests: RequestRecord[] = [];
    install(requests, [Response.json({ revision: 7, unchanged: true }, { status: 200 })]);

    // When
    const result = await setPluginEnabled('demo', true);

    // Then
    expect(result).toBe('unchanged');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/plugins/demo/enable');
  });

  test.each(['committed','publishing','draining','converged','degraded'] as const)('retains the durable ACK in state %s without waiting for publication', async state => {
    const requests: RequestRecord[] = [];
    install(requests, [accepted(state)]);
    expect(await setPluginEnabled('demo', false)).toBe('committed');
    expect(requests.map(request => request.url)).toEqual(['/api/plugins/demo/disable']);
    const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
    expect(readPendingPublication()).toEqual({mutationId:id, accepted:true});
  });

  test('retains the ACK before login and awaits the authentication handoff only', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [accepted('draining')]);
    let release!: () => void, entered!: () => void;
    const handoff = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let completed = false;
    const pending = setPluginEnabled('user-auth', true, {onAccepted:async state => {
      const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
      expect(state.operation_id).toBe(id);
      expect(readPendingPublication()).toEqual({mutationId:id, accepted:true});
      entered(); await handoff;
    }}).then(value => { completed = true; return value; });
    await started;
    expect(completed).toBe(false);
    release();
    expect(await pending).toBe('committed');
    expect(requests).toHaveLength(1);
  });

  test('a failed login preserves the accepted identity without persisting credentials or resubmitting', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [accepted('committed')]);
    await expect(setPluginEnabled('user-auth', true, {
      managementSetup:{operation:'initialize',username:'owner',password:'fixture-password',passwordConfirmation:'fixture-password'},
      onAccepted:async () => { throw new Error('invalid_credentials'); },
    })).rejects.toThrow('invalid_credentials');
    const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
    expect(readPendingPublication()).toEqual({mutationId:id, accepted:true});
    expect(stored.size).toBe(1);
    expect(stored.get(pendingPublicationKey)).not.toContain('fixture-password');
    expect(requests).toHaveLength(1);
  });

  test('pre-commit rejection retains no accepted identity and does not retry the write', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [Response.json({error:'invalid_input'}, {status:422})]);
    await expect(setPluginEnabled('user-auth', true)).rejects.toThrow('invalid_input');
    expect(stored.size).toBe(0);
    expect(requests).toHaveLength(1);
  });

  test('a malformed ACK is reconciled by its identity and stays unconfirmed when unproven', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [Response.json({revision:8}, {status:202}),
      Response.json({error:'operation_not_found'}, {status:404})]);
    let called = false;
    await expect(setPluginEnabled('demo', true, {onAccepted:() => { called = true; }})).rejects.toBeInstanceOf(ConfigurationSubmissionUnknownError);
    const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
    expect(called).toBe(false);
    // The server accepted something we cannot identify: keep the marker so a new identity is never sent.
    expect(readPendingPublication()?.accepted).toBe(false);
    expect(requests.map(request => request.url)).toEqual(['/api/plugins/demo/enable', `/api/config/operations/${id}`]);
    configurationWrite.clear();
  });

  test('a foreign lookup identity keeps the original marker', async () => {
    const requests: RequestRecord[] = [];
    const foreign = { mutation_id: 'foreign', expected_revision: 7, committed_revision: 8,
      state: 'committed', result_status: null, error_code: null, error_detail: null };
    install(requests, [Response.json({ error: 'result_unknown' }, { status: 503 }),
      Response.json({ operation: foreign, workers: [] })]);
    await expect(setPluginEnabled('demo', true)).rejects.toBeInstanceOf(ConfigurationSubmissionUnknownError);
    const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
    expect(requests).toHaveLength(2);
    expect(readPendingPublication()).toEqual({ mutationId: id, accepted: false });
    configurationWrite.clear();
  });

  test('a lost response reconciled to superseded clears tracking and reports replacement, not failure', async () => {
    const requests: RequestRecord[] = [];
    install(requests, [
      () => { throw new TypeError('network'); },
      () => {
        const id = JSON.parse(String(requests[0]?.init?.body)).mutation_id;
        return Response.json({ operation: { mutation_id: id, expected_revision: 7, committed_revision: 8,
          state: 'superseded', result_status: 409,
          error_code: 'revision_superseded', error_detail: 'revision was superseded before publication was claimed' }, workers: [] },
        { status: 409 });
      },
    ]);
    await expect(setPluginEnabled('demo', true)).rejects.toThrow('configuration_superseded');
    expect(requests.map(request => request.url)).toEqual(['/api/plugins/demo/enable',
      expect.stringMatching(/^\/api\/config\/operations\//)]);
    expect(readPendingPublication()).toBeNull();
  });

  test('refuses a new identity while a prior write result is unconfirmed', async () => {
    const requests: RequestRecord[] = [];
    install(requests, []);
    configurationWrite.markDispatched(operationId);
    try {
      await expect(setPluginEnabled('demo', true)).rejects.toThrow('configuration_write_unconfirmed');
      expect(requests).toHaveLength(0);
      expect(readPendingPublication()).toEqual({ mutationId: operationId, accepted: false });
    } finally {
      configurationWrite.clear();
    }
  });
});
