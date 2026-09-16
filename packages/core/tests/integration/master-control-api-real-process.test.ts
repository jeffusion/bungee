import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, hashConfigurationContent } from '../../src/config-storage';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog/catalog';
import {
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
  freePort,
  removeFixture,
  runWithCleanup,
  sourceMasterEntry,
  spawnMaster,
  waitForHealth,
  waitUntil,
} from '../fixtures/master-real-process-harness';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MUTATION_ID = '82000000-0000-4000-8000-000000000001';

const aggregate: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: true, tokens: [TOKEN] },
    services: [],
    routes: [],
    plugins: [],
  },
  plugin_activations: [],
};

test('keeps dashboard, health, and config available with no active workers', async () => {
  const fixture = await createMasterFixture('bungee-master-no-workers-');
  const port = await freePort(cleanupScope);
  const markerPath = join(fixture.root, 'worker-trap.marker');
  let master: ReturnType<typeof spawnMaster> | undefined;
  await runWithCleanup(async () => {
    await Bun.write(join(fixture.pluginsPath, 'fixture-plugin', 'manifest.json'), JSON.stringify({
      name: 'fixture-plugin', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js',
      control: { entry: 'control.ts', rpc: [] }, capabilities: ['hooks', 'controlPlane', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'none', engines: { bungee: '^4.2.0' }, builtin: false, configSchema: [], contributes: {},
    }) + '\n');
    await Bun.write(join(fixture.pluginsPath, 'fixture-plugin', 'index.js'), `await Bun.write(${JSON.stringify(markerPath)}, 'worker-hit'); export default class FixturePlugin { static name = 'fixture-plugin'; static version = '1.0.0'; register() {} }\n`);
    await Bun.write(join(fixture.pluginsPath, 'fixture-plugin', 'control.ts'),
      `export function createControl() { return { api: [], rpc: [], start() { throw new Error('control readiness trap'); }, dispose() {} }; }\n`);
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [fixture.pluginsPath] });
    const repository = ConfigRepository.open(fixture.dbPath, { compileOptions: catalog.toCompileOptions() });
    const seeded = repository.commit({
      mutation_id: '90000000-0000-4000-8000-000000000001', expected_revision: 1, aggregate: {
        ...aggregate, plugin_activations: [{ plugin_name: 'fixture-plugin' }],
      }, kind: 'config', created_at: Date.now(), target_worker_slots: [0, 1],
    });
    expect(seeded.kind).toBe('committed');
    repository.close();

    master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
    await waitForHealth(port, master);
    const dashboard = await fetch(`http://127.0.0.1:${port}/__ui`);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const runtime = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(dashboard.status).toBe(200);
    expect(health.status).toBe(200);
    expect(config.status).toBe(200);
    expect((await runtime.json()).workers).toEqual([]);
    expect(await Bun.file(markerPath).exists()).toBeFalse();
  }, async () => {
    const settled = await Promise.allSettled([
      master === undefined ? Promise.resolve() : cleanupMaster(master),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master control cleanup failed');
    await removeFixture(fixture);
  });
}, 45_000);

test('revision switch keeps continuing traffic on the public listener and replaces the upstream set', async () => {
  const fixture = await createMasterFixture('bungee-proxy-continuity-');
  const port = await freePort(cleanupScope);
  type Target = { readonly port: number; readonly hits: number; stop(): void };
  const makeUpstream = (label: string): Target => {
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => { hits += 1; return new Response(label); },
    });
    if (server.port === undefined) throw new Error('upstream did not expose its port');
    return { port: server.port, hits, stop: () => server.stop(true) };
  };
  const serviceA = 'aaaaaaaa-0000-4000-8000-000000000001';
  const routeA = 'bbbbbbbb-0000-4000-8000-000000000001';
  const endpointA = 'cccccccc-0000-4000-8000-000000000001';
  const endpointB = 'dddddddd-0000-4000-8000-000000000001';

  const upstreamA = makeUpstream('upstream-A');
  const upstreamB = makeUpstream('upstream-B');
  const buildAggregate = (endpointId: string, targetPort: number): ConfigurationAggregateV2 => ({
    plugin_activations: [],
    logical_configuration: {
      auth: { enabled: true, tokens: [TOKEN] },
      services: [{
        id: serviceA, position: 1, name: 's下游', plugins: [],
        endpoints: [{ id: endpointId, position: 1, target: `http://127.0.0.1:${targetPort}`, weight: 100, priority: 1, is_disabled: false, plugins: [] }],
      }],
      routes: [{ id: routeA, position: 1, path: '/proxy', service_id: serviceA, auth: { enabled: false, tokens: [] }, plugins: [] }],
      plugins: [],
    },
  });

  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  const proxy = async () => fetch(`http://127.0.0.1:${port + 1}/proxy`).then(res => res.text());
  const putConfig = async (expectedRevision: number, aggregate: ConfigurationAggregateV2, mutationId: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision, aggregate, mutation_id: mutationId }),
    });
    if (response.status !== 202) throw new Error(`PUT rejected: ${response.status}`);
    await waitUntil(async () => {
      const poll = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return poll.status === 200;
    }, `operation ${mutationId} did not converge`, 20_000);
  };

  await runWithCleanup(async () => {
    await waitForHealth(port, master);
    const managementData = await fetch(`http://127.0.0.1:${port}/v1/data`);
    expect(managementData.status).toBe(404);
    expect(await managementData.json()).toEqual({ error: 'not_found' });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const before = await fetch(`http://127.0.0.1:${port + 1}/proxy`);
    expect(before.status).toBe(404);

    await putConfig(1, buildAggregate(endpointA, upstreamA.port), 'e0000000-0000-4000-8000-000000000001');
    expect(await proxy()).toBe('upstream-A');

    // Stop upstream A before publishing the switch; old workers must not keep serving it.
    upstreamA.stop();
    await putConfig(2, buildAggregate(endpointB, upstreamB.port), 'e0000000-0000-4000-8000-000000000002');
    expect(await proxy()).toBe('upstream-B');
  }, async () => {
    const settled = await Promise.allSettled([
      cleanupMaster(master),
      upstreamB.stop(),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master control cleanup failed');
    await removeFixture(fixture);
  });
}, 45_000);

test('real master export → modify → import round-trips through the public listener and advances revision', async () => {
  const fixture = await createMasterFixture('bungee-config-io-');
  const port = await freePort(cleanupScope);
  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  await runWithCleanup(async () => {
    await waitForHealth(port, master);

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/config`);
    const initialExport = await fetch(`http://127.0.0.1:${port}/api/config/export`);
    expect(anonymous.status).toBe(200);
    expect(initialExport.status).toBe(200);

    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: {
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: 'f0000000-0000-4000-8000-000000000001' }),
    });
    expect(put.status).toBe(202);
    await waitUntil(async () => {
      const poll = await fetch(`http://127.0.0.1:${port}/api/config/operations/f0000000-0000-4000-8000-000000000001`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      return poll.status === 200;
    }, 'initial configuration operation did not converge', 20_000);

    const configuredUnauthorized = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect(configuredUnauthorized.status).toBe(401);

    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/config/export`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-disposition')).toContain('attachment');
    const envelope = await exportResponse.json() as Record<string, unknown>;
    expect(envelope).toMatchObject({
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      source_revision: 2,
    });
    expect(envelope.content_hash).toBeString();

    const exportedAggregate = envelope.aggregate as ConfigurationAggregateV2;
    const importedAggregate: ConfigurationAggregateV2 = {
      ...exportedAggregate,
      logical_configuration: {
        ...exportedAggregate.logical_configuration,
        log_level: 'debug',
      },
    };
    const importedBase = {
      format: 'bungee-config-snapshot',
      format_version: 1,
      schema_version: 2,
      exported_at: envelope.exported_at,
      source_revision: envelope.source_revision,
      content_hash: hashConfigurationContent(importedAggregate),
      aggregate: importedAggregate,
    };

    const importResponse = await fetch(`http://127.0.0.1:${port}/api/config/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        ...importedBase,
        envelope_hash: hashConfigurationContent(importedBase),
      }),
    });
    expect(envelope.envelope_hash).toBeString();
    expect(importResponse.status).toBe(202);
    const imported = await importResponse.json() as Record<string, unknown>;
    expect(imported.revision).toBe(3);

    const revisionPollUrl = `http://127.0.0.1:${port}/api/config/operations/${imported.operation_id as string}`;
    await waitUntil(async () => {
      const poll = await fetch(revisionPollUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
      return poll.status === 200;
    }, 'import operation did not converge', 20_000);

    const runtime = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(runtime.status).toBe(200);
    const runtimeBody = await runtime.json() as Record<string, unknown>;
    expect((runtimeBody.config as { logical_configuration?: { log_level?: string } }).logical_configuration?.log_level).toBe('debug');

    const db = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(db.query<{ active_revision: number }, []>(
      'SELECT active_revision FROM configuration_state WHERE id=1',
    ).get()?.active_revision).toBe(3);
    db.close(true);
  }, async () => {
    const settled = await Promise.allSettled([cleanupMaster(master)]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master control cleanup failed');
    await removeFixture(fixture);
  });
}, 30_000);

test('real master PUT publishes and exposes durable ACK evidence on its public port', async () => {
  const fixture = await createMasterFixture('bungee-control-api-');
  const port = await freePort(cleanupScope);
  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  await runWithCleanup(async () => {
    await waitForHealth(port, master);
    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-bungee-next-authorization': `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: MUTATION_ID }),
    });
    expect(put.status).toBe(202);
    const accepted = await put.json();
    expect(accepted).toMatchObject({ operation_id: MUTATION_ID, revision: 2 });
    let operation: Record<string, any> = {};
    await waitUntil(async () => {
      const poll = await fetch(`http://127.0.0.1:${port}/api/config/operations/${MUTATION_ID}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      operation = await poll.json();
      return poll.status === 200;
    }, 'configuration operation did not converge', 10_000);
    expect(operation.operation).toMatchObject({
      mutation_id: MUTATION_ID,
      committed_revision: 2,
      state: 'converged',
      result_status: 200,
    });
    expect(operation.workers).toHaveLength(2);
    expect(operation.workers.every(({ state }: { state: string }) => state === 'converged')).toBeTrue();

    const runtime = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(runtime.status).toBe(200);
    expect((await runtime.json()).workers).toHaveLength(2);

    const db = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(db.query<{ active_revision: number }, []>(
      'SELECT active_revision FROM configuration_state WHERE id=1',
    ).get()?.active_revision).toBe(2);
    db.close(true);
  }, async () => {
    const settled = await Promise.allSettled([cleanupMaster(master)]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master control cleanup failed');
    await removeFixture(fixture);
  });
}, 30_000);

test('real management HTTP retries a durable degraded recovery and replays it after restart', async () => {
  const fixture = await createMasterFixture('bungee-recovery-control-');
  const port = await freePort(cleanupScope);
  let master!: ReturnType<typeof spawnMaster>;
  let restarted: ReturnType<typeof spawnMaster> | null = null;
  const business = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('old-admission-marker', { headers: { 'x-admission-marker': 'old-revision-2' } }) });
  if (business.port === undefined) throw new Error('business fixture did not bind');
  let releaseBarrier!: () => void;
  let reachedBarrier!: () => void;
  const barrierReached = new Promise<void>((resolve) => { reachedBarrier = resolve; });
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const replacementBarrier = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    if (new URL(request.url).pathname !== '/wait' || request.method !== 'POST') return new Response('not found', { status: 404 });
    reachedBarrier();
    await barrier;
    return new Response('released');
  } });
  if (replacementBarrier.port === undefined) throw new Error('replacement barrier did not bind');
  const pluginPath = join(fixture.pluginsPath, 'fixture-plugin');
  await Bun.write(join(pluginPath, 'manifest.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', schemaVersion: 2,
    artifactKind: 'runtime-plugin', main: 'index.js', capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none',
    engines: { bungee: '^4.2.0' }, builtin: false, configSchema: [{ name: 'barrierUrl', type: 'string', label: 'Barrier', required: false }], contributes: {} }) + '\n');
  await Bun.write(join(pluginPath, 'index.js'), `export default class FixtureRecoveryPlugin {
    static name = 'fixture-plugin'; static version = '1.0.0';
    static async createHandler(config) {
      if (config.barrierUrl) { const response = await fetch(config.barrierUrl + '/wait', { method: 'POST' });
        if (!response.ok) throw new Error('replacement barrier rejected candidate'); }
      return { pluginName: 'fixture-plugin', config, register() {}, destroy() {} };
    }
  }\n`);
  master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  const sourceId = 'f1000000-0000-4000-8000-000000000001';
  const requestId = 'f2000000-0000-4000-8000-000000000001';
  const endpointPlugin = { id: 'f6000000-0000-4000-8000-000000000001', position: 1, name: 'fixture-plugin', enabled: true, options: {} };
  const businessAggregate: ConfigurationAggregateV2 = {
    ...aggregate,
    plugin_activations: [{ plugin_name: 'fixture-plugin' }],
    logical_configuration: { ...aggregate.logical_configuration,
      services: [{ id: 'f3000000-0000-4000-8000-000000000001', position: 1, name: 'recovery-business', plugins: [], endpoints: [{
        id: 'f4000000-0000-4000-8000-000000000001', position: 1, target: `http://127.0.0.1:${business.port}`,
        weight: 100, priority: 1, is_disabled: false, plugins: [endpointPlugin],
      }] }],
      routes: [{ id: 'f5000000-0000-4000-8000-000000000001', position: 1, path: '/recovery-business',
        service_id: 'f3000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [] }],
    },
  };
  const sourceAggregate: ConfigurationAggregateV2 = {
    ...businessAggregate,
    logical_configuration: { ...businessAggregate.logical_configuration, log_level: 'debug', services: [{
      ...businessAggregate.logical_configuration.services[0]!, endpoints: [{
        ...businessAggregate.logical_configuration.services[0]!.endpoints[0]!,
        plugins: [{ ...endpointPlugin, options: { barrierUrl: `http://127.0.0.1:${replacementBarrier.port}` } }],
      }],
    }] },
  };
  await runWithCleanup(async () => {
    await waitForHealth(port, master);
    const initial = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 1, aggregate: businessAggregate, mutation_id: 'f0000000-0000-4000-8000-000000000002' }),
    });
    expect(initial.status).toBe(202);
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/api/config/operations/f0000000-0000-4000-8000-000000000002`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status === 200, 'initial auth operation did not converge', 20_000);

    const injected = ConfigRepository.open(fixture.dbPath);
    const committed = injected.commit({ mutation_id: sourceId, expected_revision: 2, aggregate: sourceAggregate,
      kind: 'config', created_at: Date.now(), target_worker_slots: [0, 1] });
    expect(committed.kind).toBe('committed');
    injected.beginPublication(sourceId, Date.now());
    for (const target of [0, 1]) {
      injected.beginWorkerAttempt(sourceId, target, 0, 'initial', Date.now());
      injected.recordWorkerResult(sourceId, target, { kind: 'failed', attempt_no: 1, error: 'injected retryable failure' }, Date.now());
    }
    injected.finalizePublication(sourceId, {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'injected retryable failure',
      recovery_disposition: 'retryable',
    }, Date.now());
    const automatic = injected.getCurrentRecovery();
    if (automatic === null) throw new Error('automatic recovery was not created');
    injected.stopRecovery(automatic.recovery_id, automatic.attempt_count, 'fatal_source_failure', 'injected stopped state', Date.now());
    const originalBytes = JSON.stringify(injected.getOperationState(sourceId));
    injected.close();

    const before = await fetch(`http://127.0.0.1:${port + 1}/recovery-business`);
    expect(before.status).toBe(200);
    expect(before.headers.get('x-admission-marker')).toBe('old-revision-2');
    let retryReturned = false;
    const retryPromise = fetch(`http://127.0.0.1:${port}/api/config/operations/${sourceId}/retry`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, expected_revision: 3 }),
    }).then((response) => { retryReturned = true; return response; });
    const barrierObserved = await Promise.race([
      barrierReached.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 7_000)),
    ]);
    if (!barrierObserved) {
      releaseBarrier();
      const rejected = await retryPromise;
      throw new Error(`replacement did not reach barrier: ${rejected.status} ${await rejected.text()}`);
    }
    expect(retryReturned).toBeTrue();
    const blockedRepository = ConfigRepository.open(fixture.dbPath);
    expect(blockedRepository.getSnapshot().revision).toBe(3);
    expect(JSON.stringify(blockedRepository.getOperationState(sourceId))).toBe(originalBytes);
    blockedRepository.close();
    const retry = await retryPromise;
    expect(retry.status).toBe(202);
    const accepted = await retry.json() as Record<string, unknown>;
    expect(accepted).not.toHaveProperty('final_reason_detail');
    expect(accepted).toMatchObject({ recovery_id: requestId, target_revision: 3, trigger: 'manual' });

    const during = await fetch(`http://127.0.0.1:${port + 1}/recovery-business`, { signal: AbortSignal.timeout(1_000) });
    expect(during.status).toBe(200);
    expect(during.headers.get('x-admission-marker')).toBe('old-revision-2');
    releaseBarrier();

    let terminal: Record<string, unknown> = {};
    await waitUntil(async () => {
      const runtime = await fetch(`http://127.0.0.1:${port}/api/config/runtime`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const publication = (await runtime.json()).publication as Record<string, unknown>;
      terminal = publication.recovery as Record<string, unknown>;
      return terminal.state === 'succeeded' || terminal.state === 'stopped';
    }, 'manual recovery did not reach a terminal state', 20_000);
    expect(terminal).toHaveProperty('final_reason_code');
    expect(terminal).not.toHaveProperty('source_mutation_id');
    expect(terminal).not.toHaveProperty('final_reason_detail');
    expect(terminal).not.toHaveProperty('created_at');

    const persisted = ConfigRepository.open(fixture.dbPath);
    expect(persisted.getSnapshot().revision).toBe(3);
    expect(JSON.stringify(persisted.getOperationState(sourceId))).toBe(originalBytes);
    persisted.close();
    const terminalReplay = await fetch(`http://127.0.0.1:${port}/api/config/operations/${sourceId}/retry`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, expected_revision: 3 }),
    });
    expect(terminalReplay.status).toBe(200);
    const terminalDto = await terminalReplay.json();
    expect(Object.keys(terminalDto).sort()).toEqual([
      'attempt_count', 'final_reason_code', 'max_attempts', 'next_retry_at',
      'recovery_id', 'state', 'target_revision', 'trigger',
    ]);
    expect(terminalDto).not.toHaveProperty('final_reason_detail');

    await cleanupMaster(master);
    restarted = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
    await waitForHealth(port, restarted);
    const replay = await fetch(`http://127.0.0.1:${port}/api/config/operations/${sourceId}/retry`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, expected_revision: 3 }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(terminalDto);
  }, async () => {
    const settled = await Promise.allSettled([
      cleanupMaster(restarted ?? master),
      replacementBarrier.stop(true),
      business.stop(true),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master control cleanup failed');
    await removeFixture(fixture);
  });
}, 60_000);
