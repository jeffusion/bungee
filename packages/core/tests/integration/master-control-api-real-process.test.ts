import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { hashConfigurationContent } from '../../src/config-storage';
import {
  cleanupMaster,
  createMasterFixture,
  freePort,
  removeFixture,
  sourceMasterEntry,
  spawnMaster,
  waitForHealth,
  waitUntil,
} from '../fixtures/master-real-process-harness';

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

test('revision switch keeps continuing traffic on the public listener and replaces the upstream set', async () => {
  const fixture = await createMasterFixture('bungee-proxy-continuity-');
  const port = await freePort();
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

  const master = spawnMaster(sourceMasterEntry(), fixture, port);
  const proxy = async () => fetch(`http://127.0.0.1:${port}/proxy`).then(res => res.text());
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

  try {
    await waitForHealth(port, master);
    const before = await fetch(`http://127.0.0.1:${port}/proxy`);
    expect(before.status).toBe(404);

    await putConfig(1, buildAggregate(endpointA, upstreamA.port), 'e0000000-0000-4000-8000-000000000001');
    expect(await proxy()).toBe('upstream-A');

    // Stop upstream A before publishing the switch; old workers must not keep serving it.
    upstreamA.stop();
    await putConfig(2, buildAggregate(endpointB, upstreamB.port), 'e0000000-0000-4000-8000-000000000002');
    expect(await proxy()).toBe('upstream-B');
  } finally {
    upstreamB.stop();
    await cleanupMaster(master);
    await removeFixture(fixture);
  }
}, 45_000);

test('real master export → modify → import round-trips through the public listener and advances revision', async () => {
  const fixture = await createMasterFixture('bungee-config-io-');
  const port = await freePort();
  const master = spawnMaster(sourceMasterEntry(), fixture, port);
  try {
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
  } finally {
    await cleanupMaster(master);
    await removeFixture(fixture);
  }
}, 30_000);

test('real master PUT publishes and exposes durable ACK evidence on its public port', async () => {
  const fixture = await createMasterFixture('bungee-control-api-');
  const port = await freePort();
  const master = spawnMaster(sourceMasterEntry(), fixture, port);
  try {
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
  } finally {
    await cleanupMaster(master);
    await removeFixture(fixture);
  }
}, 30_000);
