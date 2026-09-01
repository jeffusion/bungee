import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { PublicationTaskManager } from '../../src/master-runtime/publication-task-manager';
import { createPublicListener, WorkerAdmissionRegistry } from '../../src/public-listener';
import {
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  restoreWorkerTransportRequest,
} from '../../src/config-worker/private-transport';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { servingWorker } from '../fixtures/public-listener';

const roots: string[] = [];
const repositories: ConfigRepository[] = [];
const publicationManagers: PublicationTaskManager[] = [];
const TOKEN = 'control-token';
const NEXT_TOKEN = 'next-control-token';
function aggregate(logLevel: 'info' | 'debug' = 'info'): ConfigurationAggregateV2 {
  return {
    logical_configuration: {
      log_level: logLevel,
      auth: { enabled: true, tokens: [TOKEN] },
      services: [], routes: [], plugins: [],
    },
    plugin_activations: [],
  };
}

function fixture(
  workerCount = 2,
  publication: 'deferred' | 'converged' | 'degraded' = 'deferred',
  resolveAuthToken: (value: string) => unknown = (value) => value,
) {
  let publicationMode = publication;
  const root = mkdtempSync(join(tmpdir(), 'bungee-control-api-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'));
  repositories.push(repository);
  const admission = new WorkerAdmissionRegistry();
  const publishCalls: string[] = [];
  let clockNow = 1_700_000_000_000;
  const monotonicNow = () => {
    const value = clockNow;
    clockNow += 100;
    return value;
  };
  const publicationTasks = new PublicationTaskManager({
    async publish(active) {
      publishCalls.push(active.operation.mutation_id);
      if (publicationMode === 'deferred') return { kind: 'outcome_unknown', fatal: false,
        code: 'recovery_replacements_failed', error: new Error('deferred by test'), serving: [], pending: [] };
      const mutationId = active.operation.mutation_id;
      repository.beginPublication(mutationId, monotonicNow());
      for (const target of active.targets) {
        repository.beginWorkerAttempt(mutationId, target.worker_slot, 0, 'initial', monotonicNow());
        if (publicationMode === 'converged') {
          repository.recordWorkerResult(mutationId, target.worker_slot,
            { kind: 'converged', attempt_no: 1, applied_revision: active.snapshot.revision }, monotonicNow());
        } else {
          repository.recordWorkerResult(mutationId, target.worker_slot,
            { kind: 'failed', attempt_no: 1, error: 'worker rejected configuration' }, monotonicNow());
        }
      }
      if (publicationMode === 'converged') {
        repository.markDraining(mutationId, monotonicNow());
        repository.finalizePublication(mutationId, { outcome: 'converged', old_workers_exited: true }, monotonicNow());
        return { kind: 'converged', http_status: 200, operation: repository.getOperation(mutationId)!, serving: [] };
      }
      repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'worker rejected configuration',
      }, monotonicNow());
      return { kind: 'degraded', http_status: 202, error_code: 'replacement_convergence_failed', failures: [],
        operation: repository.getOperation(mutationId)!, serving: [] };
    },
  });
  publicationTasks.setFatalHandler((error) => { throw error; });
  publicationManagers.push(publicationTasks);
  const apiOptions = { repository, admission, workerCount,
    clock: { now: monotonicNow }, resolveAuthToken,
    parseAggregate: parseNormalizeCompileAggregate, publicationTasks };
  const api = createConfigControlApi(apiOptions);
  return {
    api,
    repository,
    admission,
    publicationTasks,
    publishCalls,
    setPublicationMode(mode: typeof publicationMode) {
      publicationMode = mode;
    },
  };
}

async function waitForNoActivePublication(repository: ConfigRepository): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (repository.getActivePublication() === null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('publication did not converge');
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://control.test${path}`, init);
}

function authorized(path: string, init: RequestInit = {}): Request {
  return request(path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json();
}

afterEach(async () => {
  await Promise.all(publicationManagers.splice(0).map((manager) => manager.stop()));
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('master configuration control API', () => {
  test('serves auth-disabled snapshot metadata anonymously and validates aggregates without committing', async () => {
    const { api, repository } = fixture();

    const getResponse = await api.handle(request('/__ui/api/config'));
    const validResponse = await api.handle(request('/api/config/validate', {
      method: 'POST', body: JSON.stringify({ aggregate: aggregate() }),
    }));
    const invalidResponse = await api.handle(request('/api/config/validate', {
      method: 'POST', body: JSON.stringify({ aggregate: { logical_configuration: {} } }),
    }));
    const invalidPut = await api.handle(request('/api/config', {
      method: 'PUT', body: JSON.stringify({ expected_revision: 1, aggregate: { logical_configuration: {} } }),
    }));
    const malformedPut = await api.handle(request('/api/config', { method: 'PUT', body: '{' }));
    const oversizedPut = await api.handle(request('/api/config', { method: 'PUT', body: 'x'.repeat(1_048_577) }));
    const exportResponse = await api.handle(request('/api/config/export'));

    expect(getResponse?.status).toBe(200);
    expect(await json(getResponse as Response)).toEqual({
      config: repository.getSnapshot().aggregate,
      revision: 1,
      content_hash: repository.getSnapshot().content_hash,
    });
    expect(await json(validResponse as Response)).toEqual({ valid: true, errors: [] });
    expect(await json(invalidResponse as Response)).toMatchObject({ valid: false, errors: expect.any(Array) });
    expect(invalidPut?.status).toBe(422);
    expect(malformedPut?.status).toBe(400);
    expect(oversizedPut?.status).toBe(413);
    expect(exportResponse?.status).toBe(200);
    expect(repository.getSnapshot().revision).toBe(1);
  });

  test('enables configured authentication anonymously only with correct candidate proof', async () => {
    const { api, publicationTasks } = fixture(1, 'converged');

    const anonymousBeforeCommit = await api.handle(request('/api/config'));
    const missingProof = await api.handle(request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'enable-missing-proof' }),
    }));
    const wrongProof = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: { 'x-bungee-next-authorization': 'Bearer wrong-token' },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'enable-wrong-proof' }),
    }));
    const commit = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: { 'x-bungee-next-authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'enable-configured-auth' }),
    }));
    await publicationTasks.stop();
    const anonymousAfterCommit = await api.handle(request('/api/config'));
    const configuredAfterCommit = await api.handle(authorized('/api/config'));

    expect(anonymousBeforeCommit?.status).toBe(200);
    expect(missingProof?.status).toBe(403);
    expect(wrongProof?.status).toBe(403);
    expect(commit?.status).toBe(202);
    expect(anonymousAfterCommit?.status).toBe(401);
    expect(configuredAfterCommit?.status).toBe(200);
  });

  test('keeps forwarded management anonymous when configured authentication is disabled', async () => {
    // Given
    const { api, repository, publicationTasks } = fixture(1, 'converged');
    const enabled = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'enable-configured-auth' }),
    }));
    await waitForNoActivePublication(repository);
    const disabled: ConfigurationAggregateV2 = {
      logical_configuration: {
        auth: { enabled: false, tokens: [] }, services: [], routes: [], plugins: [],
      },
      plugin_activations: [],
    };
    const disable = await api.handle(authorized('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: 2, aggregate: disabled, mutation_id: 'disable-configured-auth' }),
    }));
    await waitForNoActivePublication(repository);

    // When
    const authorization = await api.authorizeForward(request('/__ui/api/plugins'));
    const verification = await api.handle(request('/__ui/api/auth/verify'));
    const currentSnapshot = await api.handle(request('/api/config'));

    // Then
    expect(enabled?.status).toBe(202);
    expect(disable?.status).toBe(202);
    expect(repository.getSnapshot()).toMatchObject({ revision: 3 });
    expect(authorization).toBe(true);
    expect(verification?.status).toBe(200);
    expect(await json(verification as Response)).toEqual({ success: true });
    expect(currentSnapshot?.status).toBe(200);
    expect(await json(currentSnapshot as Response)).toEqual({
      config: disabled,
      revision: 3,
      content_hash: hashConfigurationContent(disabled),
    });
    await publicationTasks.stop();
  });

  test('keeps auth-absent and disabled revisions anonymous while enabling requires candidate proof', async () => {
    // Given
    const { api, repository, publicationTasks } = fixture(1, 'converged');
    const commit = (value: ConfigurationAggregateV2, revision: number, mutationId: string, next?: string) =>
      api.handle(request('/api/config', {
        method: 'PUT',
        headers: {
          ...(next === undefined ? {} : { 'x-bungee-next-authorization': `Bearer ${next}` }),
        },
        body: JSON.stringify({ expected_revision: revision, aggregate: value, mutation_id: mutationId }),
      }));
    const authLess: ConfigurationAggregateV2 = {
      logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [],
    };
    const disabled: ConfigurationAggregateV2 = {
      logical_configuration: { auth: { enabled: false, tokens: [] }, services: [], routes: [], plugins: [] },
      plugin_activations: [],
    };

    // When
    const authLessResponse = await commit(authLess, 1, 'setup-auth-less');
    await waitForNoActivePublication(repository);
    const anonymousAfterAuthLess = await api.handle(request('/api/config'));
    const disabledResponse = await commit(disabled, 2, 'setup-disabled');
    await waitForNoActivePublication(repository);
    const anonymousAfterDisabled = await api.handle(request('/api/config'));
    const missingProof = await commit(aggregate(), 3, 'enable-missing-proof');
    const wrongProof = await commit(aggregate(), 3, 'enable-wrong-proof', 'wrong');
    const enabledResponse = await commit(aggregate(), 3, 'enable-proven', TOKEN);

    // Then
    expect([authLessResponse?.status, disabledResponse?.status]).toEqual([202, 202]);
    expect(anonymousAfterAuthLess?.status).toBe(200);
    expect(anonymousAfterDisabled?.status).toBe(200);
    expect(missingProof?.status).toBe(403);
    expect(wrongProof?.status).toBe(403);
    expect(enabledResponse?.status).toBe(202);
    expect(repository.getSnapshot()).toMatchObject({ revision: 4 });
    expect((await api.handle(authorized('/api/config')))?.status).toBe(200);
    await publicationTasks.stop();
  });

  test('allows plugin, upstream, and export operations anonymously while auth is disabled', async () => {
    // Given
    const { api, repository, publicationTasks } = fixture(1, 'converged');
    const endpointId = 'b0000000-0000-4000-8000-000000000002';
    const setup: ConfigurationAggregateV2 = {
      logical_configuration: {
        services: [{
          id: 'a0000000-0000-4000-8000-000000000001', position: 1, name: 'setup', plugins: [],
          endpoints: [{ id: endpointId, position: 1, target: 'http://127.0.0.1:9', weight: 100,
            priority: 1, is_disabled: false, plugins: [] }],
        }],
        routes: [], plugins: [],
      },
      plugin_activations: [],
    };
    const setupResponse = await api.handle(request('/api/config', {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ expected_revision: 1, aggregate: setup, mutation_id: 'anonymous-admin-setup' }),
    }));
    await waitForNoActivePublication(repository);

    // When
    const plugin = await api.handle(request('/api/plugins/ai-transformer/enable', {
      method: 'POST',
    }));
    await waitForNoActivePublication(repository);
    const upstream = await api.handle(request(`/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT', body: JSON.stringify({ enabled: false }),
    }));
    await waitForNoActivePublication(repository);
    const exported = await api.handle(request('/api/config/export', {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));

    // Then
    expect(setupResponse?.status).toBe(202);
    expect(exported?.status).toBe(200);
    expect(plugin?.status).toBe(202);
    expect(upstream?.status).toBe(202);
    expect(repository.getSnapshot()).toMatchObject({ revision: 4 });
    expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([{ plugin_name: 'ai-transformer' }]);
    expect(repository.getSnapshot().aggregate.logical_configuration.services[0]?.endpoints[0]?.is_disabled).toBe(true);
    await publicationTasks.stop();
  });

  for (const mutation of [
    { name: 'plugin activation', path: '/api/plugins/ai-transformer/enable', method: 'POST', body: undefined },
    { name: 'upstream toggle', path: '/api/upstreams/b0000000-0000-4000-8000-000000000002/enabled',
      method: 'PUT', body: JSON.stringify({ enabled: false }) },
  ] as const) {
    test(`requires current configured auth for ${mutation.name} without candidate proof`, async () => {
      // Given
      const { api, repository, publicationTasks, publishCalls } = fixture(1, 'converged');
      const endpointId = 'b0000000-0000-4000-8000-000000000002';
      const setup: ConfigurationAggregateV2 = {
        logical_configuration: {
          auth: { enabled: true, tokens: [TOKEN] },
          services: [{
            id: 'a0000000-0000-4000-8000-000000000001', position: 1, name: 'delayed-auth', plugins: [],
            endpoints: [{ id: endpointId, position: 1, target: 'http://127.0.0.1:9', weight: 100,
              priority: 1, is_disabled: false, plugins: [] }],
          }],
          routes: [], plugins: [],
        },
        plugin_activations: [],
      };
      const setupResponse = await api.handle(request('/api/config', {
        method: 'PUT', headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-bungee-next-authorization': `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ expected_revision: 1, aggregate: setup, mutation_id: `setup-${mutation.method}` }),
      }));
      await waitForNoActivePublication(repository);
      const operationCount = () => repository['db'].query<{ count: number }, []>(
        'SELECT count(*) AS count FROM configuration_operations',
      ).get()?.count;

      // When
      const rejected = await api.handle(request(mutation.path, {
        method: mutation.method, headers: { authorization: 'Bearer stale-token' }, body: mutation.body,
      }));
      const revisionAfterReject = repository.getSnapshot().revision;
      const operationsAfterReject = operationCount();
      const publicationsAfterReject = publishCalls.length;
      const accepted = await api.handle(request(mutation.path, {
        method: mutation.method,
        headers: { authorization: `Bearer ${TOKEN}` },
        body: mutation.body,
      }));
      await waitForNoActivePublication(repository);

      // Then
      expect(setupResponse?.status).toBe(202);
      expect(rejected?.status).toBe(401);
      expect(await json(rejected as Response)).toEqual({ error: 'unauthorized' });
      expect(revisionAfterReject).toBe(2);
      expect(operationsAfterReject).toBe(1);
      expect(publicationsAfterReject).toBe(1);
      expect(accepted?.status).toBe(202);
      expect(repository.getSnapshot()).toMatchObject({ revision: 3 });
      expect(operationCount()).toBe(2);
      expect(publishCalls).toHaveLength(2);
      await publicationTasks.stop();
    });
  }

  test('commits configured auth with master-owned targets and returns durable 202 polling state', async () => {
    const { api, repository, publicationTasks, publishCalls } = fixture(2);
    const next = aggregate();

    const response = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: next, mutation_id: 'api-mutation-1' }),
    }));
    const poll = await api.handle(authorized('/api/config/operations/api-mutation-1'));

    expect(response?.status).toBe(202);
    expect(await json(response as Response)).toMatchObject({ operation_id: 'api-mutation-1', revision: 2 });
    await publicationTasks.stop();
    expect(publishCalls).toEqual(['api-mutation-1']);
    expect(repository.getSnapshot()).toMatchObject({ revision: 2, content_hash: hashConfigurationContent(next) });
    expect(poll?.status).toBe(202);
    expect(await json(poll as Response)).toMatchObject({
      operation: { mutation_id: 'api-mutation-1', state: 'committed', target_worker_count: 2 },
      workers: [{ worker_slot: 0, state: 'pending' }, { worker_slot: 1, state: 'pending' }],
    });
  });

  test('maps stale, duplicate replay, changed replay, and concurrent CAS outcomes exactly', async () => {
    const { api } = fixture(1);
    const first = { expected_revision: 1, aggregate: aggregate(), mutation_id: 'replay-key' };
    const send = (body: object) => api.handle(request('/api/config', {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    }));
    const committed = await send(first);

    const duplicate = await send(first);
    const changed = await send({ ...first, aggregate: aggregate('debug') });
    const stale = await send({ ...first, mutation_id: 'stale-key' });
    const concurrent = await Promise.all([
      send({ expected_revision: 2, aggregate: aggregate('debug'), mutation_id: 'cas-a' }),
      send({ expected_revision: 2, aggregate: aggregate('debug'), mutation_id: 'cas-b' }),
    ]);

    expect(committed?.status).toBe(202);
    expect(duplicate?.status).toBe(202);
    expect(changed?.status).toBe(409);
    expect(await json(changed as Response)).toMatchObject({ error: 'idempotency_key_reused' });
    expect(stale?.status).toBe(409);
    expect(await json(stale as Response)).toMatchObject({ error: 'stale_revision', active: { revision: 2 } });
    expect(concurrent.map((item) => item?.status)).toEqual([409, 409]);
    expect(await json(concurrent[0] as Response)).toEqual({
      error: 'operation_in_progress',
      operation_id: 'replay-key',
      revision: 2,
      state: 'committed',
    });
  });

  test('authenticates under active aggregate and internal transport headers cannot bypass it', async () => {
    const { api } = fixture(1);
    await api.handle(request('/api/config', {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'auth-enabled' }),
    }));

    const missing = await api.handle(request('/api/config'));
    const internal = await api.handle(request('/api/config', {
      headers: { [INTERNAL_TRANSPORT_TOKEN_HEADER]: TEST_WORKER_TRANSPORT_SECRET },
    }));
    const valid = await api.handle(authorized('/api/config/runtime'));

    expect(missing?.status).toBe(401);
    expect(internal?.status).toBe(401);
    expect(valid?.status).toBe(200);
    expect(await json(valid as Response)).toMatchObject({ revision: 2, workers: [] });
  });

  test('requires the request token to match changed next auth and exposes exact terminal publication states', async () => {
    const deniedFixture = fixture(1);
    const convergedFixture = fixture(1, 'converged');
    const degradedFixture = fixture(1, 'degraded');
    const commit = (api: ReturnType<typeof createConfigControlApi>, token: string, mutationId: string) => api.handle(request('/api/config', {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: mutationId }),
    }));

    const denied = await commit(deniedFixture.api, 'wrong-token', 'denied-auth');
    const converged = await commit(convergedFixture.api, TOKEN, 'converged-operation');
    const degraded = await commit(degradedFixture.api, TOKEN, 'degraded-operation');
    await Promise.all([convergedFixture.publicationTasks.stop(), degradedFixture.publicationTasks.stop()]);
    const convergedPoll = await convergedFixture.api.handle(authorized('/api/config/operations/converged-operation'));
    const degradedPoll = await degradedFixture.api.handle(authorized('/api/config/operations/degraded-operation'));

    expect(denied?.status).toBe(403);
    expect(await json(denied as Response)).toEqual({ error: 'next_auth_required' });
    expect(converged?.status).toBe(202);
    expect(convergedPoll?.status).toBe(200);
    expect(await json(convergedPoll as Response)).toMatchObject({
      operation: { state: 'converged', result_status: 200 },
      workers: [{ state: 'converged', applied_revision: 2 }],
    });
    expect(degraded?.status).toBe(202);
    expect(await json(degradedPoll as Response)).toMatchObject({
      operation: { state: 'degraded', result_status: 202, error_code: 'replacement_convergence_failed' },
      workers: [{ state: 'failed', last_error: 'worker rejected configuration' }],
    });
  });

  test('exports and imports anonymously while configured authentication is disabled', async () => {
    const { api, repository, publicationTasks } = fixture(2, 'converged');

    const enabledResponse = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        expected_revision: 1, aggregate: aggregate(), mutation_id: 'anonymous-import-seed',
      }),
    }));
    expect(enabledResponse?.status).toBe(202);
    await waitForNoActivePublication(repository);
    const disabled = await api.handle(authorized('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: 2, aggregate: {
        logical_configuration: { auth: { enabled: false, tokens: [] }, services: [], routes: [], plugins: [] },
        plugin_activations: [],
      }, mutation_id: 'disable-before-export' }),
    }));
    expect(disabled?.status).toBe(202);
    await waitForNoActivePublication(repository);

    const exportResponse = await api.handle(request('/api/config/export', { method: 'GET' }));
    expect(exportResponse?.status).toBe(200);
    const contentDisposition = exportResponse?.headers.get('content-disposition');
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('.json');

    const envelope = await exportResponse!.json() as Record<string, unknown>;
    expect(envelope).toMatchObject({
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      source_revision: 3,
    });
    expect(typeof envelope.aggregate).toBe('object');
    expect(Object.keys(envelope).sort()).toEqual(
      ['aggregate', 'content_hash', 'envelope_hash', 'exported_at', 'format', 'format_version', 'schema_version', 'source_revision'],
    );
    const exportedEnvelopeHash = String(envelope.envelope_hash);
    expect(exportedEnvelopeHash).toBeString();
    const { envelope_hash: _sealed, ...envelopeBase } = envelope;
    expect(String(hashConfigurationContent(envelopeBase))).toBe(exportedEnvelopeHash);

    function sealedEnvelope(base: Record<string, unknown>): string {
      return JSON.stringify({ ...base, envelope_hash: hashConfigurationContent(base) });
    }

    const exportedAggregate = envelope.aggregate as ConfigurationAggregateV2;
    const modified: ConfigurationAggregateV2 = {
      ...exportedAggregate,
      logical_configuration: { ...exportedAggregate.logical_configuration, log_level: 'debug' },
    };
    const modifiedBase = {
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      exported_at: envelope.exported_at,
      source_revision: envelope.source_revision,
      content_hash: hashConfigurationContent(modified),
      aggregate: modified,
    };
    const importResponse = await api.handle(request('/api/config/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: sealedEnvelope(modifiedBase),
    }));
    expect(importResponse?.status).toBe(202);
    const accepted = await importResponse!.json() as Record<string, unknown>;
    expect(accepted.operation_id).toBeString();

    await publicationTasks.stop();
    const after = repository.getSnapshot();
    expect(after.revision).toBe(4);
    expect(after.aggregate.logical_configuration.log_level).toBe('debug');

    const staleSeal = JSON.stringify({ ...modifiedBase });
    const staleResponse = await api.handle(authorized('/api/config/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: staleSeal,
    }));
    expect(staleResponse?.status).toBe(400);
    expect((await staleResponse!.json() as Record<string, unknown>).error).toBe('invalid_snapshot');

    const badAggregate = { logical_configuration: {} } as unknown as ConfigurationAggregateV2;
    const tamperedAggregateBase = {
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      exported_at: 1,
      source_revision: 2,
      content_hash: envelope.content_hash,
      aggregate: modified,
    };
    const contentTamperedBody = JSON.stringify({
      ...tamperedAggregateBase,
      aggregate: badAggregate,
      envelope_hash: hashConfigurationContent(tamperedAggregateBase),
    });
    const contentTamperedResponse = await api.handle(authorized('/api/config/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: contentTamperedBody,
    }));
    expect(contentTamperedResponse?.status).toBe(400);

    const structurallyInvalidBase = {
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      exported_at: 1,
      source_revision: 2,
      content_hash: hashConfigurationContent(badAggregate),
      aggregate: badAggregate,
    };
    const badResponse = await api.handle(authorized('/api/config/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: sealedEnvelope(structurallyInvalidBase),
    }));
    expect(badResponse?.status).toBe(422);

    const legacyShape = JSON.stringify({ config_version: 4, routes: [] });
    const legacyResponse = await api.handle(authorized('/api/config/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: legacyShape,
    }));
    expect(legacyResponse?.status).toBe(400);
    expect((await legacyResponse!.json() as Record<string, unknown>).error).toBe('invalid_snapshot');
  });

  test('rejects missing, extra, wrong-type, and unsafe snapshot metadata before commit', async () => {
    const { api, repository, publicationTasks } = fixture(1, 'converged');
    const seed = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'metadata-validation-seed' }),
    }));
    expect(seed?.status).toBe(202);
    await waitForNoActivePublication(repository);

    const contentHash = hashConfigurationContent(repository.getSnapshot().aggregate);
    const base: Record<string, unknown> = {
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      exported_at: 0,
      source_revision: 2,
      content_hash: contentHash,
      aggregate: repository.getSnapshot().aggregate,
    };
    const seal = (candidate: Record<string, unknown>): string => JSON.stringify({
      ...candidate,
      envelope_hash: hashConfigurationContent(candidate),
    });
    const requiredMetadata = [
      'format', 'format_version', 'schema_version', 'exported_at',
      'source_revision', 'content_hash', 'envelope_hash',
    ] as const;
    const invalidBodies: string[] = requiredMetadata.map((field) => {
      const candidate: Record<string, unknown> = { ...base, envelope_hash: hashConfigurationContent(base) };
      delete candidate[field];
      return JSON.stringify(candidate);
    });
    const legacyKind: Record<string, unknown> = { ...base, kind: 'bungee-config-snapshot' };
    delete legacyKind.format;
    invalidBodies.push(
      seal(legacyKind),
      seal({ ...base, unexpected: true }),
      seal({ ...base, format: 1 }),
      seal({ ...base, format: 'other-format' }),
      seal({ ...base, format_version: '1' }),
      seal({ ...base, format_version: 2 }),
      seal({ ...base, schema_version: '2' }),
      seal({ ...base, schema_version: 1 }),
      seal({ ...base, exported_at: 'invalid' }),
      seal({ ...base, exported_at: -1 }),
      seal({ ...base, exported_at: 1.5 }),
      seal({ ...base, exported_at: Number.MAX_SAFE_INTEGER + 1 }),
      seal({ ...base, source_revision: null }),
      seal({ ...base, source_revision: 0 }),
      seal({ ...base, source_revision: 1.5 }),
      seal({ ...base, source_revision: Number.MAX_SAFE_INTEGER + 1 }),
      seal({ ...base, content_hash: null }),
      seal({ ...base, content_hash: 'sha256:ABCDEF' }),
      JSON.stringify({ ...base, envelope_hash: null }),
      JSON.stringify({ ...base, envelope_hash: 'sha256:ABCDEF' }),
    );

    for (const body of invalidBodies) {
      const response = await api.handle(authorized('/api/config/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }));
      expect(response?.status).toBe(400);
      expect(await json(response as Response)).toEqual({ error: 'invalid_snapshot' });
    }
    expect(repository.getSnapshot().revision).toBe(2);
    await publicationTasks.stop();
  });

  test('plugin activation toggles commit config revisions through the control plane', async () => {
    const { api, repository, publicationTasks, publishCalls } = fixture(2, 'converged');

    const setup = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'plugin-toggle-seed' }),
    }));
    expect(setup?.status).toBe(202);
    await waitForNoActivePublication(repository);

    const enable = await api.handle(authorized('/__ui/api/plugins/ai-transformer/enable', { method: 'POST' }));
    expect(enable?.status).toBe(202);
    const enabledOperation = await json(enable as Response);
    expect(enabledOperation).toMatchObject({ revision: 3 });
    expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([{ plugin_name: 'ai-transformer' }]);

    await waitForNoActivePublication(repository);

    const reEnable = await api.handle(authorized('/api/plugins/ai-transformer/enable', { method: 'POST' }));
    expect(reEnable?.status).toBe(200);
    expect((await reEnable!.json() as Record<string, unknown>).unchanged).toBe(true);

    const disable = await api.handle(authorized('/api/plugins/ai-transformer/disable', { method: 'POST' }));
    expect(disable?.status).toBe(202);
    expect(await json(disable as Response)).toMatchObject({ revision: 4 });

    await publicationTasks.stop();
    const after = repository.getSnapshot();
    expect(after.aggregate.plugin_activations).toEqual([]);
    expect(after.revision).toBe(4);
    expect(publishCalls).toHaveLength(3);

    const invalidName = await api.handle(authorized('/api/plugins/bad%2Fname/enable', { method: 'POST' }));
    expect(invalidName?.status).toBe(400);
  });

  test('returns the active plugin operation for a repeated no-op toggle', async () => {
    const { api, repository, publicationTasks, setPublicationMode } = fixture(2, 'converged');
    const setup = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(), mutation_id: 'plugin-repeat-seed' }),
    }));
    expect(setup?.status).toBe(202);
    await waitForNoActivePublication(repository);
    setPublicationMode('deferred');

    const enable = await api.handle(authorized('/api/plugins/ai-transformer/enable', { method: 'POST' }));
    expect(enable?.status).toBe(202);
    const enabledOperation = await json(enable as Response);
    const repeated = await api.handle(authorized('/api/plugins/ai-transformer/enable', { method: 'POST' }));
    expect(repeated?.status).toBe(202);
    expect(await json(repeated as Response)).toEqual(enabledOperation);
    await publicationTasks.stop();
  });

  test('rejects malformed encoded plugin and upstream path segments as JSON 400', async () => {
    const { api } = fixture();
    for (const path of ['/api/plugins/%E0%A4%A/enable', '/__ui/api/upstreams/%E0%A4%A/enabled']) {
      const response = await api.handle(authorized(path, {
        method: 'POST', body: JSON.stringify({ enabled: false }),
      }));
      expect(response?.status).toBe(400);
      expect(await json(response as Response)).toEqual({ error: 'invalid_request' });
    }
  });

  test('upstream enabled toggles commit admin_state revisions keyed by stable UUID', async () => {
    const { api, repository, publicationTasks, publishCalls } = fixture(2, 'converged');
    const serviceId = 'a0000000-0000-4000-8000-000000000001';
    const endpointId = 'b0000000-0000-4000-8000-000000000002';
    const upstreamAggregate: ConfigurationAggregateV2 = {
      logical_configuration: {
        log_level: 'info',
        auth: { enabled: true, tokens: [TOKEN] },
        services: [{
          id: serviceId, position: 1, name: 'toggle-svc', plugins: [],
          endpoints: [{
            id: endpointId, position: 1, target: 'http://127.0.0.1:9',
            weight: 100, priority: 1, is_disabled: false, plugins: [],
          }],
        }],
        routes: [], plugins: [],
      },
      plugin_activations: [],
    };

    const setup = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: upstreamAggregate, mutation_id: 'upstream-toggle-seed' }),
    }));
    expect(setup?.status).toBe(202);
    await waitForNoActivePublication(repository);

    const disable = await api.handle(authorized(`/__ui/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(disable?.status).toBe(202);
    const disabledOperation = await json(disable as Response);
    expect(disabledOperation).toMatchObject({ revision: 3 });
    const disabledSnapshot = repository.getSnapshot();
    expect(disabledSnapshot.revision).toBe(3);
    expect(disabledSnapshot.aggregate.logical_configuration.services[0]?.endpoints[0]?.is_disabled).toBe(true);

    await waitForNoActivePublication(repository);

    const noOp = await api.handle(authorized(`/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(noOp?.status).toBe(200);
    expect((await noOp!.json() as Record<string, unknown>).unchanged).toBe(true);

    const reEnable = await api.handle(authorized(`/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }));
    expect(reEnable?.status).toBe(202);
    expect(await json(reEnable as Response)).toMatchObject({ revision: 4 });
    expect(repository.getSnapshot().aggregate.logical_configuration.services[0]?.endpoints[0]?.is_disabled).toBe(false);

    const unknown = await api.handle(authorized('/api/upstreams/c0000000-0000-4000-8000-000000000003/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(unknown?.status).toBe(404);
    expect((await unknown!.json() as Record<string, unknown>).error).toBe('upstream_not_found');

    const malformed = await api.handle(authorized('/api/upstreams/not-a-uuid/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(malformed?.status).toBe(400);

    await publicationTasks.stop();
    expect(publishCalls).toHaveLength(3);
  });

  test('returns the active upstream operation for a repeated no-op toggle', async () => {
    const { api, repository, publicationTasks, setPublicationMode } = fixture(2, 'converged');
    const endpointId = 'b0000000-0000-4000-8000-000000000002';
    const upstreamAggregate: ConfigurationAggregateV2 = {
      logical_configuration: {
        log_level: 'info',
        auth: { enabled: true, tokens: [TOKEN] },
        services: [{
          id: 'a0000000-0000-4000-8000-000000000001', position: 1, name: 'toggle-svc', plugins: [],
          endpoints: [{
            id: endpointId, position: 1, target: 'http://127.0.0.1:9',
            weight: 100, priority: 1, is_disabled: false, plugins: [],
          }],
        }],
        routes: [], plugins: [],
      },
      plugin_activations: [],
    };
    const setup = await api.handle(request('/api/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: upstreamAggregate, mutation_id: 'upstream-repeat-seed' }),
    }));
    expect(setup?.status).toBe(202);
    await waitForNoActivePublication(repository);
    setPublicationMode('deferred');

    const disable = await api.handle(authorized(`/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }));
    expect(disable?.status).toBe(202);
    const disabledOperation = await json(disable as Response);
    const repeated = await api.handle(authorized(`/api/upstreams/${endpointId}/enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }));
    expect(repeated?.status).toBe(202);
    expect(await json(repeated as Response)).toEqual(disabledOperation);
    await publicationTasks.stop();
  });

  test('serves anonymous auth-disabled commits and exports over the public listener while proxy traffic remains unavailable', async () => {
    const { api, admission: registry } = fixture();
    const listener = createPublicListener({
      admission: registry,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      hostname: '127.0.0.1',
      port: 0,
      controlApi: api,
    });
    listener.start();
    if (listener.port === null) throw new Error('listener did not expose its port');

    try {
      const setup = await fetch(`http://127.0.0.1:${listener.port}/api/config`, {
        method: 'PUT',
        body: JSON.stringify({
          expected_revision: 1,
          aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
          mutation_id: 'listener-anonymous-setup',
        }),
      });
      const config = await fetch(`http://127.0.0.1:${listener.port}/api/config`);
      const exported = await fetch(`http://127.0.0.1:${listener.port}/api/config/export`);
      const proxy = await fetch(`http://127.0.0.1:${listener.port}/proxy`);

      expect(setup.status).toBe(202);
      expect(config.status).toBe(200);
      const snapshot = await json(config);
      const aggregate = {
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [],
      };
      expect(snapshot).toEqual({
        config: aggregate,
        revision: 2,
        content_hash: hashConfigurationContent(aggregate),
      });
      expect(exported.status).toBe(200);
      expect(proxy.status).toBe(503);
    } finally {
      await listener.stop();
    }
  });

  test('fences stale configured auth immediately after rotation and accepts the candidate for polling', async () => {
    // Given
    const { api, admission, repository, publicationTasks } = fixture(1, 'converged');
    const forwarded: Array<{ readonly path: string; readonly marker: string | null }> = [];
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const marker = request.headers.get('x-bungee-internal-authenticated-management');
      const restored = restoreWorkerTransportRequest(request, TEST_WORKER_TRANSPORT_SECRET);
      if (!restored.ok) return new Response(null, { status: restored.status });
      const path = new URL(restored.request.url).pathname;
      forwarded.push({ path, marker });
      return Response.json({ path, marker: restored.request.headers.get('x-bungee-internal-authenticated-management') });
    } });
    if (worker.port === undefined) throw new Error('worker did not expose its port');
    admission.prepare([servingWorker(0, worker.port)]).commit();
    const listener = createPublicListener({
      admission,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      hostname: '127.0.0.1',
      port: 0,
      controlApi: api,
    });
    listener.start();
    if (listener.port === null) throw new Error('listener did not expose its port');
    const base = `http://127.0.0.1:${listener.port}`;

    try {
      const enabled = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-bungee-next-authorization': `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          expected_revision: 1,
          aggregate: aggregate(),
          mutation_id: 'enable-auth-before-rotation',
        }),
      });
      await waitForNoActivePublication(repository);
      const committed = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-bungee-next-authorization': `Bearer ${NEXT_TOKEN}`,
        },
        body: JSON.stringify({
          expected_revision: 2,
          aggregate: { ...aggregate(), logical_configuration: {
            ...aggregate().logical_configuration,
            auth: { enabled: true, tokens: [NEXT_TOKEN] },
          } },
          mutation_id: 'rotate-configured-auth',
        }),
      });

      // When
      const stale = await fetch(`${base}/__ui/api/plugins`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const current = await fetch(`${base}/__ui/api/plugins`, {
        headers: { authorization: `Bearer ${NEXT_TOKEN}` },
      });
      const candidatePoll = await fetch(`${base}/api/config/operations/rotate-configured-auth`, {
        headers: { authorization: `Bearer ${NEXT_TOKEN}` },
      });
      const anonymousVerify = await fetch(`${base}/__ui/api/auth/verify`);
      const staleLogin = await fetch(`${base}/__ui/api/auth/login`, {
        method: 'POST', body: JSON.stringify({ token: TOKEN }),
      });
      const currentLogin = await fetch(`${base}/__ui/api/auth/login`, {
        method: 'POST', body: JSON.stringify({ token: NEXT_TOKEN }),
      });
      const proxy = await fetch(`${base}/api/test`, {
        headers: { 'x-bungee-internal-authenticated-management': 'spoofed' },
      });
      const namespacedProxy = await fetch(`${base}/api/stats/not-a-management-endpoint`);

      // Then
      expect(enabled.status).toBe(202);
      expect(committed.status).toBe(202);
      expect(stale.status).toBe(401);
      expect(current.status).toBe(200);
      expect(await current.json()).toEqual({ path: '/__ui/api/plugins', marker: null });
      expect(candidatePoll.status).toBe(200);
      expect(await candidatePoll.json()).toMatchObject({ operation: { mutation_id: 'rotate-configured-auth' } });
      expect(anonymousVerify.status).toBe(200);
      expect(await anonymousVerify.json()).toEqual({ success: false });
      expect(staleLogin.status).toBe(401);
      expect(currentLogin.status).toBe(200);
      expect(await currentLogin.json()).toEqual({ success: true });
      expect(proxy.status).toBe(200);
      expect(await proxy.json()).toEqual({ path: '/api/test', marker: null });
      expect(namespacedProxy.status).toBe(200);
      expect(await namespacedProxy.json()).toEqual({ path: '/api/stats/not-a-management-endpoint', marker: null });
      expect(forwarded).toEqual([
        { path: '/__ui/api/plugins', marker: '1' },
        { path: '/api/test', marker: null },
        { path: '/api/stats/not-a-management-endpoint', marker: null },
      ]);
    } finally {
      await listener.stop();
      worker.stop(true);
      await publicationTasks.stop();
    }
  });
});
