import { describe, expect, test } from 'bun:test';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { ConfigRepositoryError } from '../../src/config-storage';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const HASH = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const TOKEN = 'control-token';

function fixture() {
  let ready = true;
  let recovery: any = {
    recovery_id: '22222222-2222-4222-8222-222222222222', source_mutation_id: 'operation-1',
    target_revision: 1, trigger: 'automatic', state: 'stopped', attempt_count: 6,
    max_attempts: 6, next_retry_at: null, final_reason_code: 'retry_exhausted',
    final_reason_detail: 'internal detail', created_at: 1, updated_at: 1,
  };
  const recoveries = new Map<string, any>();
  let wakes = 0;
  let manualError: unknown = null;
  const repository: any = {
    getSnapshot: () => ({ revision: 1, content_hash: HASH,
      aggregate: { logical_configuration: { auth: { enabled: true, tokens: [TOKEN] } }, plugin_activations: [] } }),
    getActivePublication: () => null,
    getOperationState: () => ({ operation: { state: 'degraded', error_code: 'replacement_convergence_failed', committed_revision: 1 }, workers: [] }),
    getCurrentOperationState: () => ({ operation: { state: 'degraded', error_code: 'replacement_convergence_failed', committed_revision: 1 }, workers: [] }),
    getCurrentRecovery: () => recovery,
    getRecovery: (id: string) => recoveries.get(id) ?? null,
  };
  const api = createConfigControlApi({
    repository, admission: { snapshot: () => [] }, workerCount: 1, clock: { now: () => 2 },
    resolveAuthToken: (value) => value, parseAggregate: () => ({ ok: true, value: {} as never }),
    publicationTasks: { enqueue: () => undefined }, isMutationReady: () => false,
    isRecoveryReady: () => ready,
    requestManualRecovery: async (id, source, revision) => {
      if (manualError !== null) throw manualError;
      wakes += 1;
      const created = { ...recovery, recovery_id: id, source_mutation_id: source,
        target_revision: revision, trigger: 'manual', state: 'scheduled', attempt_count: 0,
        final_reason_code: null, final_reason_detail: null };
      recoveries.set(id, created);
      recovery = created;
      return created;
    },
  });
  return { api, repository, recoveries, setReady: (value: boolean) => { ready = value; },
    setManualError: (value: unknown) => { manualError = value; }, getWakes: () => wakes };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://control.test${path}`, init);
}

function authorized(path: string, init: RequestInit = {}): Request {
  return request(path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });
}

describe('configuration recovery control API', () => {
  test('authenticates before parsing and accepts exact retry bodies', async () => {
    const h = fixture();
    const unauthorized = request('/api/config/operations/operation-1/retry', {
      method: 'POST', body: '{',
    });
    const denied = await h.api.handle(unauthorized);
    expect(denied?.status).toBe(401);

    const accepted = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1 }),
    }));
    expect(accepted?.status).toBe(202);
    expect(await accepted?.json()).toEqual({ recovery_id: REQUEST_ID, target_revision: 1,
      state: 'scheduled', attempt_count: 0, max_attempts: 6, next_retry_at: null, trigger: 'manual' });
    expect(h.getWakes()).toBe(1);
  });

  test('rejects authorized malformed, duplicate, oversized, extra, and missing retry bodies', async () => {
    const h = fixture();
    const path = '/api/config/operations/operation-1/retry';
    const cases: Array<[string, number]> = [
      ['{', 400],
      ['{"request_id":"11111111-1111-4111-8111-111111111111","request_id":"11111111-1111-4111-8111-111111111111","expected_revision":1}', 400],
      ['x'.repeat(1_048_577), 413],
      [JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1, extra: true }), 400],
      [JSON.stringify({ request_id: REQUEST_ID }), 400],
    ];
    for (const [body, status] of cases) {
      const response = await h.api.handle(authorized(path, { method: 'POST', body }));
      expect(response?.status).toBe(status);
    }
    expect(h.getWakes()).toBe(0);
  });

  test('replays by request ID without readiness and rejects payload reuse', async () => {
    const h = fixture();
    const body = JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1 });
    await h.api.handle(authorized('/api/config/operations/operation-1/retry', { method: 'POST', body }));
    h.setReady(false);
    const replay = await h.api.handle(authorized('/api/config/operations/operation-1/retry', { method: 'POST', body }));
    const reused = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: REQUEST_ID, expected_revision: 2 }),
    }));
    expect(replay?.status).toBe(202);
    expect(reused?.status).toBe(409);
    expect(await reused?.json()).toEqual({ error: 'idempotency_key_reused' });
    expect(h.getWakes()).toBe(1);
  });

  test('publishes runtime control state separately from worker evidence', async () => {
    const h = fixture();
    const response = await h.api.handle(authorized('/api/config/runtime'));
    expect(await response?.json()).toMatchObject({ publication: {
      operation: expect.objectContaining({ committed_revision: 1, state: 'degraded' }),
      recovery: expect.objectContaining({ trigger: 'automatic' }),
      retryable: true, serving_complete: false, serving_revision: null, target_revision: 1,
    } });
  });

  test('keeps retry paths canonical and returns terminal replay with only safe fields', async () => {
    const h = fixture();
    const terminal = { recovery_id: REQUEST_ID, source_mutation_id: 'operation-1', target_revision: 1,
      trigger: 'manual', state: 'stopped', attempt_count: 6, max_attempts: 6, next_retry_at: null,
      final_reason_code: 'retry_exhausted', final_reason_detail: 'secret', created_at: 1, updated_at: 2 };
    h.recoveries.set(REQUEST_ID, terminal);
    const replay = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1 }),
    }));
    const encoded = await h.api.handle(authorized('/api/config/operations/operation%2D1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1 }),
    }));
    const wrongMethod = await h.api.handle(authorized('/api/config/operations/operation-1/retry', { method: 'GET' }));
    expect(replay?.status).toBe(200);
    expect(await replay?.json()).toEqual({ recovery_id: REQUEST_ID, target_revision: 1, trigger: 'manual',
      state: 'stopped', attempt_count: 6, max_attempts: 6, next_retry_at: null, final_reason_code: 'retry_exhausted' });
    expect(encoded?.status).toBe(400);
    expect(wrongMethod?.status).toBe(405);
    expect(wrongMethod?.headers.get('allow')).toBe('POST');
  });

  test('maps a post-precheck recovery CAS race only with complete typed evidence', async () => {
    const h = fixture();
    const active = { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: 1,
      trigger: 'automatic', state: 'scheduled', attempt_count: 0, max_attempts: 6,
      next_retry_at: null, final_reason_code: null, final_reason_detail: null,
      source_mutation_id: 'operation-1', created_at: 1, updated_at: 1 } as any;
    h.setManualError(new ConfigRepositoryError('recovery_in_progress', 'race', undefined, active));
    const raced = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: REQUEST_ID, expected_revision: 1 }),
    }));
    h.setManualError(new ConfigRepositoryError('recovery_in_progress', 'race'));
    const incomplete = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
      method: 'POST', body: JSON.stringify({ request_id: '44444444-4444-4444-8444-444444444444', expected_revision: 1 }),
    }));
    expect(raced?.status).toBe(409);
    expect(await raced?.json()).toEqual({ error: 'recovery_in_progress', recovery_id: active.recovery_id,
      target_revision: 1, state: 'scheduled' });
    expect(incomplete?.status).toBe(500);
    expect(await incomplete?.json()).toEqual({ error: 'repository_error' });
  });

  test('fails closed for every malformed typed recovery identity', async () => {
    const invalidRecoveries = [
      { recovery_id: 'NOT-A-UUID', target_revision: 1, state: 'scheduled' },
      { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: 0, state: 'scheduled' },
      { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: Number.MAX_SAFE_INTEGER + 1, state: 'scheduled' },
      { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: 'mismatch', state: 'scheduled' },
      { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: 1, state: 'succeeded' },
      { recovery_id: '33333333-3333-4333-8333-333333333333', target_revision: 1 },
    ];
    for (const [index, evidence] of invalidRecoveries.entries()) {
      const h = fixture();
      h.setManualError(new ConfigRepositoryError('recovery_in_progress', 'race', undefined, evidence as any));
      const requestId = `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`;
      const response = await h.api.handle(authorized('/api/config/operations/operation-1/retry', {
        method: 'POST', body: JSON.stringify({ request_id: requestId, expected_revision: 1 }),
      }));
      expect(response?.status).toBe(500);
      expect(await response?.json()).toEqual({ error: 'repository_error' });
    }
  });
});
