import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { hashConfigurationContent } from '../../src/config-storage/content-hash';
import { createConfigControlApi, type ConfigControlApiOptions } from '../../src/master-runtime/control-api';
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

function fixture(
  preflight?: ConfigControlApiOptions['pluginControlPreflight'],
  isMutationReady: () => boolean = () => true,
  isRecoveryReady: () => boolean = () => true,
) {
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
    publicationTasks: { enqueue }, pluginControlPreflight: preflight, isMutationReady, isRecoveryReady,
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
  test('rechecks readiness around preflight and never commits after recovery begins', async () => {
    let checks = 0;
    const controlCalls: string[] = [];
    const preflight: ConfigControlApiOptions['pluginControlPreflight'] = {
      controlNames: new Set(['fake-control']),
      async activate(name) { controlCalls.push(`activate:${name}`); },
      async deactivate(name) { controlCalls.push(`deactivate:${name}`); },
    };
    const { api, repository } = fixture(preflight, () => {
      checks += 1;
      return checks < 2;
    });
    const next = { ...disabledAggregate(), plugin_activations: [{ plugin_name: 'fake-control' }] };
    const response = await put(api, 1, next, 'readiness-race', {});

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'control_recovering' });
    expect(checks).toBe(2);
    expect(controlCalls).toEqual(['activate:fake-control', 'deactivate:fake-control']);
    expect(repository.getSnapshot().revision).toBe(1);
    expect(repository.getCurrentOperationState()).toBeNull();
  });

  test('preflight failure leaves revision, operation, and publication queue unchanged at every commit entry', async () => {
    const activated: string[] = [];
    const preflight: ConfigControlApiOptions['pluginControlPreflight'] = {
      controlNames: new Set(['fake-control']),
      async activate(name) { activated.push(name); throw new Error('control unavailable'); },
      async deactivate() { throw new Error('must not rollback a failed activation'); },
    };
    const { api, repository, publishedOperationIds } = fixture(preflight);
    const next = { ...disabledAggregate(), plugin_activations: [{ plugin_name: 'fake-control' }] };
    const baseEnvelope = {
      format: 'bungee-config-snapshot' as const, format_version: 1 as const, schema_version: 2 as const,
      exported_at: 1, source_revision: 1, content_hash: hashConfigurationContent(next), aggregate: next,
    };
    const envelope = { ...baseEnvelope, envelope_hash: hashConfigurationContent(baseEnvelope) };

    const putResponse = await put(api, 1, next, 'preflight-put', {});
    const toggleResponse = await api.handle(new Request('http://control.test/api/plugins/fake-control/enable', {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    }));
    const importResponse = await api.handle(new Request('http://control.test/api/config/import', {
      method: 'POST', body: JSON.stringify(envelope), headers: { 'content-type': 'application/json' },
    }));

    expect([putResponse?.status, toggleResponse?.status, importResponse?.status]).toEqual([503, 503, 503]);
    expect(activated).toEqual(['fake-control', 'fake-control', 'fake-control']);
    expect(repository.getSnapshot().revision).toBe(1);
    expect(repository.getCurrentOperationState()).toBeNull();
    expect(publishedOperationIds).toEqual([]);
  });

  test('rolls back only control activations created by a rejected commit', async () => {
    const calls: string[] = [];
    const { api, repository, publishedOperationIds } = fixture({
      controlNames: new Set(['fake-control']),
      async activate(name) { calls.push(`activate:${name}`); },
      async deactivate(name) { calls.push(`deactivate:${name}`); },
    });
    const next = { ...disabledAggregate(), plugin_activations: [{ plugin_name: 'fake-control' }] };
    const response = await put(api, 99, next, 'preflight-stale', {});

    expect(response?.status).toBe(409);
    expect(calls).toEqual([]);
    expect(repository.getSnapshot().revision).toBe(1);
    expect(publishedOperationIds).toEqual([]);
  });

  test('serializes the latest auth and candidate proof behind a preflight barrier', async () => {
    let preflightStarted = false;
    let signalPreflightStarted!: () => void;
    const preflightStartedPromise = new Promise<void>((resolve) => { signalPreflightStarted = resolve; });
    let releasePreflight!: () => void;
    const { api, repository } = fixture({
      controlNames: new Set(['fake-control']),
      async activate() {
        preflightStarted = true;
        signalPreflightStarted();
        await new Promise<void>((resolve) => { releasePreflight = resolve; });
      },
      async deactivate() {},
    });
    await put(api, 1, aggregate(OLD), 'seed-auth', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    const next = { ...aggregate(NEXT), plugin_activations: [{ plugin_name: 'fake-control' }] };
    const rotating = put(api, 2, next, 'rotate-auth', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    await preflightStartedPromise;
    expect(preflightStarted).toBe(true);
    const queuedOld = put(api, 2, aggregate(OLD, 'debug'), 'queued-old', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    releasePreflight();

    expect((await rotating)?.status).toBe(202);
    expect((await queuedOld)?.status).toBe(401);
    expect(repository.getSnapshot()).toMatchObject({ revision: 3, aggregate: next });
  });

  test('queued plugin toggle rejects after auth rotation without activation or readiness work', async () => {
    const calls: string[] = [];
    let readinessCalls = 0;
    let recoveryReadinessCalls = 0;
    let releasePreflight!: () => void;
    let signalPreflightStarted!: () => void;
    const preflightStarted = new Promise<void>((resolve) => { signalPreflightStarted = resolve; });
    const { api, repository } = fixture({
      controlNames: new Set(['rotation-control', 'queued-control']),
      async activate(name) {
        calls.push(`activate:${name}`);
        if (name === 'rotation-control') {
          signalPreflightStarted();
          await new Promise<void>((resolve) => { releasePreflight = resolve; });
        }
      },
      async deactivate(name) { calls.push(`deactivate:${name}`); },
    }, () => { readinessCalls += 1; return true; }, () => {
      recoveryReadinessCalls += 1;
      return true;
    });
    const next = { ...aggregate(NEXT), plugin_activations: [{ plugin_name: 'rotation-control' }] };
    const rotating = put(api, 1, next, 'rotate-before-plugin-toggle', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    await preflightStarted;
    const queued = api.handle(new Request('http://control.test/api/plugins/queued-control/enable', {
      method: 'POST', headers: { authorization: `Bearer ${OLD}` }, body: '{}',
    }));
    releasePreflight();

    expect((await rotating)?.status).toBe(202);
    expect((await queued)?.status).toBe(401);
    expect(calls).toEqual(['activate:rotation-control']);
    expect(readinessCalls).toBe(2);
    expect(recoveryReadinessCalls).toBe(0);
    expect(repository.getSnapshot().aggregate).toEqual(next);
  });

  test('queued retry rejects after auth rotation before recovery-sensitive reads', async () => {
    const calls: string[] = [];
    let recoveryReadinessCalls = 0;
    let sourceOperationReads = 0;
    let recoveryReads = 0;
    const sourceMutationId = '10000000-0000-4000-8000-000000000001';
    let releasePreflight!: () => void;
    let signalPreflightStarted!: () => void;
    const preflightStarted = new Promise<void>((resolve) => { signalPreflightStarted = resolve; });
    const { api, repository } = fixture({
      controlNames: new Set(['rotation-control']),
      async activate(name) {
        calls.push(`activate:${name}`);
        signalPreflightStarted();
        await new Promise<void>((resolve) => { releasePreflight = resolve; });
      },
      async deactivate(name) { calls.push(`deactivate:${name}`); },
    }, () => true, () => { recoveryReadinessCalls += 1; return true; });
    const originalGetOperationState = repository.getOperationState.bind(repository);
    repository.getOperationState = (mutationId) => {
      if (mutationId === sourceMutationId) sourceOperationReads += 1;
      return originalGetOperationState(mutationId);
    };
    const originalGetRecovery = repository.getRecovery.bind(repository);
    repository.getRecovery = (recoveryId) => {
      recoveryReads += 1;
      return originalGetRecovery(recoveryId);
    };

    const next = { ...aggregate(NEXT), plugin_activations: [{ plugin_name: 'rotation-control' }] };
    const rotating = put(api, 1, next, 'rotate-before-retry', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    await preflightStarted;
    const retry = api.handle(new Request(`http://control.test/api/config/operations/${sourceMutationId}/retry`, {
      method: 'POST', headers: { authorization: `Bearer ${OLD}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: '20000000-0000-4000-8000-000000000001', expected_revision: 1 }),
    }));
    releasePreflight();

    expect((await rotating)?.status).toBe(202);
    expect((await retry)?.status).toBe(401);
    expect(calls).toEqual(['activate:rotation-control']);
    expect(sourceOperationReads).toBe(0);
    expect(recoveryReads).toBe(0);
    expect(recoveryReadinessCalls).toBe(0);
  });

  test('rotation requires both current configured auth and independent candidate proof', async () => {
    let readinessCalls = 0;
    let activateCalls = 0;
    const { api, repository } = fixture({
      controlNames: new Set(['fake-control']),
      async activate() { activateCalls += 1; },
      async deactivate() {},
    }, () => { readinessCalls += 1; return true; });
    const first = await put(api, 1, aggregate(OLD), 'first', {
      authorization: `Bearer ${OLD}`,
      'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    expect(first?.status).toBe(202);
    expect(repository.getOperationState('first')?.operation.state).toBe('converged');

    const nextWithControl = { ...aggregate(NEXT), plugin_activations: [{ plugin_name: 'fake-control' }] };
    readinessCalls = 0;
    activateCalls = 0;
    const missing = await put(api, 2, nextWithControl, 'missing-next', { authorization: `Bearer ${OLD}` });
    expect(missing?.status).toBe(403);
    expect(readinessCalls).toBe(0);
    expect(activateCalls).toBe(0);
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

  test('rechecks the latest active auth after a slow import body finishes', async () => {
    const { api, repository } = fixture();
    await put(api, 1, aggregate(OLD), 'enable-old-import', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    const imported = aggregate(OLD, 'debug');
    const baseEnvelope = {
      format: 'bungee-config-snapshot' as const, format_version: 1 as const, schema_version: 2 as const,
      exported_at: 1, source_revision: 2, content_hash: hashConfigurationContent(imported), aggregate: imported,
    };
    const envelope = { ...baseEnvelope, envelope_hash: hashConfigurationContent(baseEnvelope) };
    const encoder = new TextEncoder();
    let finishBody: (() => void) | undefined;
    const slow = api.handle(new Request('http://control.test/api/config/import', {
      method: 'POST', headers: { authorization: `Bearer ${OLD}` },
      body: new ReadableStream<Uint8Array>({ start(controller) {
        finishBody = () => { controller.enqueue(encoder.encode(JSON.stringify(envelope))); controller.close(); };
      } }),
    }));

    const rotated = await put(api, 2, aggregate(NEXT), 'rotate-before-import', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${NEXT}`,
    });
    finishBody?.();
    const denied = await slow;

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

  test('rejects invalid auth before reading any streaming mutation body', async () => {
    const calls: string[] = [];
    let mutationReadinessCalls = 0;
    let recoveryReadinessCalls = 0;
    const { api } = fixture({
      controlNames: new Set(['control']),
      async activate(name) { calls.push(`activate:${name}`); },
      async deactivate(name) { calls.push(`deactivate:${name}`); },
    }, () => { mutationReadinessCalls += 1; return true; }, () => {
      recoveryReadinessCalls += 1;
      return true;
    });
    await put(api, 1, aggregate(OLD), 'stream-auth-seed', {
      authorization: `Bearer ${OLD}`, 'x-bungee-next-authorization': `Bearer ${OLD}`,
    });
    mutationReadinessCalls = 0;
    recoveryReadinessCalls = 0;
    calls.length = 0;
    const stream = (body: string): { readonly body: ReadableStream<Uint8Array>; pulls: () => number } => {
      const encoder = new TextEncoder();
      let pulls = 0;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body));
          },
          pull(controller) {
            pulls += 1;
            controller.close();
          },
        }),
        pulls: () => pulls,
      };
    };
    const requests = [
      stream(JSON.stringify({ expected_revision: 2, aggregate: aggregate(OLD), mutation_id: 'stream-put' })),
      stream('{}'),
      stream('{"enabled":false}'),
      stream('{}'),
      stream(JSON.stringify({ request_id: '20000000-0000-4000-8000-000000000001', expected_revision: 2 })),
    ];
    const responses = await Promise.all([
      api.handle(new Request('http://control.test/api/config', {
        method: 'PUT', headers: { authorization: 'Bearer invalid' }, body: requests[0]!.body,
      })),
      api.handle(new Request('http://control.test/api/config/import', {
        method: 'POST', headers: { authorization: 'Bearer invalid' }, body: requests[1]!.body,
      })),
      api.handle(new Request(`http://control.test/api/upstreams/${UPSTREAM_ID}/enabled`, {
        method: 'POST', headers: { authorization: 'Bearer invalid' }, body: requests[2]!.body,
      })),
      api.handle(new Request('http://control.test/api/plugins/control/enable', {
        method: 'POST', headers: { authorization: 'Bearer invalid' }, body: requests[3]!.body,
      })),
      api.handle(new Request('http://control.test/api/config/operations/10000000-0000-4000-8000-000000000001/retry', {
        method: 'POST', headers: { authorization: 'Bearer invalid' }, body: requests[4]!.body,
      })),
    ]);
    expect(responses.map((response) => response?.status)).toEqual([401, 401, 401, 401, 401]);
    expect(requests.map(({ pulls }) => pulls())).toEqual([0, 0, 0, 0, 0]);
    expect(mutationReadinessCalls).toBe(0);
    expect(recoveryReadinessCalls).toBe(0);
    expect(calls).toEqual([]);
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
      publicationTasks: { enqueue() {} }, isMutationReady: () => true,
    } as unknown as Parameters<typeof createConfigControlApi>[0]);
    const response = await broken.handle(new Request('http://control.test/api/config'));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'repository_unavailable' });
  });

  test('serialized mutation snapshot failure is stable JSON 503', async () => {
    const { api, repository } = fixture();
    const readSnapshot = repository.getSnapshot.bind(repository);
    let calls = 0;
    repository.getSnapshot = () => {
      calls += 1;
      if (calls === 2) throw new Error('closed during serialization');
      return readSnapshot();
    };
    const response = await put(api, 1, disabledAggregate(), 'serialized-snapshot-failure', {});
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'repository_unavailable' });
  });
});
