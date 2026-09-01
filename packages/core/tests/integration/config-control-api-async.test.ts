import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { WorkerAdmissionRegistry } from '../../src/public-listener';

const OLD = 'old-control-token';
const NEXT = 'next-control-token';
const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function aggregate(token: string, log_level: 'info' | 'debug' = 'info'): ConfigurationAggregateV2 {
  return { logical_configuration: { log_level, auth: { enabled: true, tokens: [token] },
    services: [], routes: [], plugins: [] }, plugin_activations: [] };
}

function disabledAggregate(): ConfigurationAggregateV2 {
  return { logical_configuration: { auth: { enabled: false, tokens: [] },
    services: [], routes: [], plugins: [] }, plugin_activations: [] };
}

const UPSTREAM_ID = 'b0000000-0000-4000-8000-000000000002';
function upstreamAggregate(token: string): ConfigurationAggregateV2 {
  return { logical_configuration: { auth: { enabled: true, tokens: [token] }, services: [{
    id: 'a0000000-0000-4000-8000-000000000001', position: 1, name: 'slow-auth', plugins: [],
    endpoints: [{ id: UPSTREAM_ID, position: 1, target: 'http://127.0.0.1:9', weight: 100,
      priority: 1, is_disabled: false, plugins: [] }],
  }], routes: [], plugins: [] }, plugin_activations: [] };
}

function finalize(repository: ConfigRepository, active: ReturnType<ConfigRepository['getActivePublication']>): void {
  if (active === null) throw new Error('active publication missing');
  const id = active.operation.mutation_id;
  repository.beginPublication(id, 2);
  repository.beginWorkerAttempt(id, 0, 0, 'initial', 3);
  repository.recordWorkerResult(id, 0, { kind: 'converged', attempt_no: 1,
    applied_revision: active.snapshot.revision }, 4);
  repository.markDraining(id, 5);
  repository.finalizePublication(id, { outcome: 'converged', old_workers_exited: true }, 6);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bungee-control-async-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'));
  repositories.push(repository);
  const publishedOperationIds: string[] = [];
  const enqueue = (active: NonNullable<ReturnType<ConfigRepository['getActivePublication']>>) => {
    publishedOperationIds.push(active.operation.mutation_id);
    finalize(repository, active);
  };
  const apiOptions = { repository, admission: new WorkerAdmissionRegistry(), workerCount: 1,
    clock: { now: () => 1 }, resolveAuthToken: (value: string) => value,
    parseAggregate: parseNormalizeCompileAggregate,
    publicationTasks: { enqueue },
  };
  const api = createConfigControlApi(apiOptions);
  return { api, repository, publishedOperationIds };
}

function put(api: ReturnType<typeof createConfigControlApi>, expected_revision: number,
  value: ConfigurationAggregateV2, mutation_id: string, headers: HeadersInit) {
  return api.handle(new Request('http://control.test/api/config', { method: 'PUT', headers,
    body: JSON.stringify({ expected_revision, aggregate: value, mutation_id }) }));
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('asynchronous configuration control', () => {
  test('rotation requires both current configured auth and independent candidate proof', async () => {
    const { api, repository } = fixture();
    const first = await put(api, 1, aggregate(OLD), 'first', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    expect(first?.status).toBe(202);
    expect(repository.getOperationState('first')?.operation.state).toBe('converged');

    const missing = await put(api, 2, aggregate(NEXT), 'missing-next', { authorization: `Bearer ${OLD}` });
    expect(missing?.status).toBe(403);
    const missingCurrent = await put(api, 2, aggregate(NEXT), 'missing-current', {
      'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    expect(missingCurrent?.status).toBe(401);
    const rotated = await put(api, 2, aggregate(NEXT), 'rotated', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    expect(rotated?.status).toBe(202);
    expect(repository.getSnapshot().revision).toBe(3);
    const stalePoll = await api.handle(new Request('http://control.test/api/config/operations/rotated', {
      headers: { authorization: `Bearer ${OLD}` },
    }));
    const candidatePoll = await api.handle(new Request('http://control.test/api/config/operations/rotated', {
      headers: { authorization: `Bearer ${NEXT}` },
    }));
    expect(stalePoll?.status).toBe(401);
    expect(candidatePoll?.status).toBe(200);
  });

  test('concurrent CAS commits one revision and terminal replay mismatch remains 409', async () => {
    const { api, repository } = fixture();
    const headers = { authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${OLD}` };
    const [first, stale] = await Promise.all([
      put(api, 1, aggregate(OLD), 'cas-first', headers),
      put(api, 1, aggregate(OLD, 'debug'), 'cas-second', headers),
    ]);
    expect([first?.status, stale?.status].sort()).toEqual([202, 409]);
    const replay = await put(api, 1, aggregate(OLD, 'debug'), 'cas-first', headers);
    expect(replay?.status).toBe(409);
    expect(await replay?.json()).toMatchObject({ error: 'idempotency_key_reused' });
    expect(repository.getSnapshot().revision).toBe(2);
  });

  test('rechecks the latest active auth after a slow PUT body finishes', async () => {
    // Given
    const { api, repository } = fixture();
    await put(api, 1, aggregate(OLD), 'enable-old', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    const encoder = new TextEncoder();
    let finishBody: (() => void) | undefined;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(encoder.encode(JSON.stringify({
            expected_revision: 3,
            aggregate: aggregate(OLD, 'debug'),
            mutation_id: 'slow-old-regain',
          })));
          controller.close();
        };
      },
    });
    const slow = api.handle(new Request('http://control.test/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${OLD}`,
        'x-bungee-next-authorization': `Bearer ${OLD}`,
      },
      body: slowBody,
    }));

    // When
    const rotated = await put(api, 2, aggregate(NEXT), 'rotate-to-next', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    finishBody?.();
    const denied = await slow;

    // Then
    expect(rotated?.status).toBe(202);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: 'unauthorized' });
    expect(repository.getSnapshot()).toMatchObject({ revision: 3, aggregate: aggregate(NEXT) });
  });

  test('rejects a slow upstream toggle when active auth changes before its body finishes', async () => {
    // Given
    const { api, repository, publishedOperationIds } = fixture();
    await put(api, 1, upstreamAggregate(OLD), 'enable-old-upstream', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    const encoder = new TextEncoder();
    let finishBody: (() => void) | undefined;
    const slow = api.handle(new Request(`http://control.test/api/upstreams/${UPSTREAM_ID}/enabled`, {
      method: 'PUT', headers: { authorization: `Bearer ${OLD}` },
      body: new ReadableStream<Uint8Array>({ start(controller) {
        finishBody = () => { controller.enqueue(encoder.encode('{"enabled":false}')); controller.close(); };
      } }),
    }));

    // When
    const rotated = await put(api, 2, upstreamAggregate(NEXT), 'rotate-upstream-auth', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    finishBody?.();
    const denied = await slow;

    // Then
    expect(rotated?.status).toBe(202);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: 'unauthorized' });
    expect(repository.getSnapshot()).toMatchObject({ revision: 3, aggregate: upstreamAggregate(NEXT) });
    expect(publishedOperationIds).toEqual(['enable-old-upstream', 'rotate-upstream-auth']);
  });

  test('allows disabling auth with the active credential but requires next proof to enable it again', async () => {
    // Given
    const { api, repository } = fixture();
    await put(api, 1, aggregate(OLD), 'enable-auth', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${OLD}`,
    });

    // When
    const missingCurrent = await put(api, 2, disabledAggregate(), 'disable-without-current', {});
    const disabled = await put(api, 2, disabledAggregate(), 'disable-auth', {
      authorization: `Bearer ${OLD}`,
    });
    const enabledWithoutProof = await put(api, 3, aggregate(NEXT), 'enable-without-proof', {});
    const enabled = await put(api, 3, aggregate(NEXT), 'enable-with-proof', {
      'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });

    // Then
    expect(missingCurrent?.status).toBe(401);
    expect(disabled?.status).toBe(202);
    expect(enabledWithoutProof?.status).toBe(403);
    expect(enabled?.status).toBe(202);
    expect(repository.getSnapshot()).toMatchObject({ revision: 4, aggregate: aggregate(NEXT) });
  });

  test('repository snapshot failure is stable JSON 503', async () => {
    const broken = createConfigControlApi({
      repository: { getSnapshot() { throw new ConfigRepositoryError('repository_failure', 'closed'); } },
      admission: new WorkerAdmissionRegistry(), workerCount: 1, clock: { now: () => 1 },
      resolveAuthToken: (value: string) => value, parseAggregate: parseNormalizeCompileAggregate,
      publicationTasks: { enqueue() {} },
    } as unknown as Parameters<typeof createConfigControlApi>[0]);
    const response = await broken.handle(new Request('http://control.test/api/config'));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'repository_unavailable' });
  });
});
