import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
  freePort,
  processAlive,
  removeFixture,
  sourceMasterEntry,
  spawnMaster,
  runWithCleanup,
  waitForHealth,
  waitUntil,
} from '../fixtures/master-real-process-harness';
import { writeRuntimeUpstreamsFailureEvidence } from '../fixtures/runtime-upstreams-evidence';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SERVICE_ID = '91000000-0000-4000-8000-000000000001';
const ROUTE_ID = '91000000-0000-4000-8000-000000000002';
const FIRST_UPSTREAM_ID = '91000000-0000-4000-8000-000000000003';
const SECOND_UPSTREAM_ID = '91000000-0000-4000-8000-000000000004';
const FIRST_BACKUP_ID = '91000000-0000-4000-8000-000000000005';
const SECOND_BACKUP_ID = '91000000-0000-4000-8000-000000000006';

type RuntimeWorker = {
  readonly identity: { readonly worker_instance_id: string };
  readonly circuit_state: string;
  readonly active_request_count: number;
  readonly last_used_time: number | null;
};

type RuntimeUpstream = {
  readonly upstream_id: string;
  readonly circuit_state: string;
  readonly active_request_count: number | null;
  readonly last_used_time: number | null;
  readonly last_used_complete: boolean;
  readonly workers: readonly RuntimeWorker[];
};

type RuntimeBody = {
  readonly availability: string;
  readonly workers: { readonly observed: readonly unknown[] };
  readonly upstreams: readonly RuntimeUpstream[];
};

test('real master aggregates active upstream state from two workers and drops retired publications', async () => {
  const fixture = await createMasterFixture('bungee-runtime-upstreams-');
  const port = await freePort(cleanupScope);
  const pending: Array<(response: Response) => void> = [];
  let blockRequests = true;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => blockRequests
      ? new Promise<Response>((resolve) => { pending.push(resolve); })
      : new Response('replacement'),
  });
  if (upstream.port === undefined) throw new Error('upstream did not expose its port');
  const backup = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('backup') });
  if (backup.port === undefined) throw new Error('backup upstream did not expose its port');

  const aggregate = (upstreamId: string, backupId: string): ConfigurationAggregateV2 => ({
    plugin_activations: [],
    logical_configuration: {
      auth: { enabled: true, tokens: [TOKEN] },
      plugins: [],
      services: [{
        id: SERVICE_ID,
        position: 1,
        name: 'runtime-upstreams',
        plugins: [],
        load_balancing: { policy: 'round_robin' },
        failover: {
          enabled: true,
          retry_on: [500],
          passive_health: { consecutive_failures: 1, healthy_successes: 1 },
          recovery: { backoff_base_ms: 60_000 },
        },
        endpoints: [
          { id: upstreamId, position: 1, target: `http://127.0.0.1:${upstream.port}`, weight: 100, priority: 1, is_disabled: false, plugins: [] },
          { id: backupId, position: 2, target: `http://127.0.0.1:${backup.port}`, weight: 100, priority: 1, is_disabled: false, plugins: [] },
        ],
      }],
      routes: [{ id: ROUTE_ID, position: 1, path: '/proxy', service_id: SERVICE_ID, auth: { enabled: false, tokens: [] }, plugins: [] }],
    },
  });

  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  const managementHeaders = { authorization: `Bearer ${TOKEN}` };
  const putResponses: unknown[] = [];
  const lastOperationJson: Record<string, unknown> = {};
  const mutationIds: string[] = [];
  let failure: unknown;
  const runtime = async (): Promise<RuntimeBody> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime/upstreams`, { headers: managementHeaders, signal: AbortSignal.timeout(2_000) });
    expect(response.status).toBe(200);
    return await response.json() as RuntimeBody;
  };
  const publish = async (expectedRevision: number, value: ConfigurationAggregateV2, mutationId: string): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { ...managementHeaders, 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision, aggregate: value, mutation_id: mutationId }),
      signal: AbortSignal.timeout(5_000),
    });
    putResponses.push({ mutation_id: mutationId, status: response.status, body: await response.json() });
    mutationIds.push(mutationId);
    expect(response.status).toBe(202);
    await waitUntil(async () => {
      const operation = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, { headers: managementHeaders, signal: AbortSignal.timeout(2_000) });
      if (operation.status !== 200) return false;
      const body = await operation.json() as { operation?: { state?: string } };
      lastOperationJson[mutationId] = body;
      return body.operation?.state === 'converged';
    }, `configuration operation ${mutationId} did not converge`, 20_000);
  };

  await runWithCleanup(async () => {
    try {
    await waitForHealth(port, master);
    await publish(1, aggregate(FIRST_UPSTREAM_ID, FIRST_BACKUP_ID), '91000000-0000-4000-8000-000000000010');

    const requests = [
      fetch(`http://127.0.0.1:${port + 1}/proxy`, { signal: AbortSignal.timeout(15_000) }),
      fetch(`http://127.0.0.1:${port + 1}/proxy`, { signal: AbortSignal.timeout(15_000) }),
    ];
    await waitUntil(() => pending.length === 2, 'two public requests did not reach the real upstream', 10_000);

    let active: RuntimeBody | undefined;
    await waitUntil(async () => {
      const body = await runtime();
      const current = body.upstreams.find(({ upstream_id }) => upstream_id === FIRST_UPSTREAM_ID);
      if (body.availability !== 'complete' || body.workers.observed.length !== 2 || current === undefined) return false;
      if (current.workers.length !== 2 || current.active_request_count !== 2) return false;
      if (!current.workers.every((worker) => worker.active_request_count === 1)) return false;
      active = body;
      return true;
    }, 'runtime API did not observe one active request on each real worker', 10_000);
    const activeUpstream = active!.upstreams.find(({ upstream_id }) => upstream_id === FIRST_UPSTREAM_ID)!;
    expect(activeUpstream.workers).toHaveLength(2);
    expect(activeUpstream.workers.map(({ active_request_count }) => active_request_count)).toEqual([1, 1]);
    expect(activeUpstream.active_request_count).toBe(2);

    // The active snapshot proves these queued requests reached different workers.
    pending.shift()!(new Response('failure', { status: 500 }));
    pending.shift()!(new Response('success', { status: 200 }));
    expect((await Promise.all(requests)).map(({ status }) => status).sort()).toEqual([200, 200]);

    let mixed: RuntimeUpstream | undefined;
    await waitUntil(async () => {
      const body = await runtime();
      const current = body.upstreams.find(({ upstream_id }) => upstream_id === FIRST_UPSTREAM_ID);
      if (body.availability !== 'complete' || current?.circuit_state !== 'MIXED') return false;
      if (current.workers.length !== 2 || !current.workers.some(({ circuit_state }) => circuit_state === 'HEALTHY')
        || !current.workers.some(({ circuit_state }) => circuit_state === 'UNHEALTHY')) return false;
      if (current.active_request_count !== 0 || !current.last_used_complete || current.last_used_time === null
        || current.workers.some(({ last_used_time }) => last_used_time === null)) return false;
      mixed = current;
      return true;
    }, 'real per-worker failure/success did not produce a mixed circuit state', 10_000);
    expect(mixed!.last_used_time).toBe(Math.max(...mixed!.workers.map(({ last_used_time }) => last_used_time!)));

    const oldWorkerIds = new Set(mixed!.workers.map(({ identity }) => identity.worker_instance_id));
    blockRequests = false;
    await publish(2, aggregate(SECOND_UPSTREAM_ID, SECOND_BACKUP_ID), '91000000-0000-4000-8000-000000000011');

    let replacement: RuntimeBody | undefined;
    await waitUntil(async () => {
      const body = await runtime();
      // UNKNOWN/partial is an allowed publication window; assert only a complete replacement.
      if (body.availability !== 'complete' || body.workers.observed.length !== 2) return false;
      const ids = new Set(body.upstreams.map(({ upstream_id }) => upstream_id));
      const current = body.upstreams.find(({ upstream_id }) => upstream_id === SECOND_UPSTREAM_ID);
      if (current === undefined || ids.has(FIRST_UPSTREAM_ID) || ids.has(FIRST_BACKUP_ID) || current.workers.length !== 2) return false;
      if (current.workers.some(({ identity }) => oldWorkerIds.has(identity.worker_instance_id))) return false;
      replacement = body;
      return true;
    }, 'runtime API retained a retired publication or did not expose the replacement', 20_000);
    expect(new Set(replacement!.upstreams.map(({ upstream_id }) => upstream_id))).toEqual(new Set([SECOND_UPSTREAM_ID, SECOND_BACKUP_ID]));
    } catch (error) {
    failure = error;
    throw error;
    }
  }, async () => {
    if (failure !== undefined) {
      try {
        const evidencePath = await writeRuntimeUpstreamsFailureEvidence({ fixture, master, mutationIds, putResponses, lastOperationJson, failure });
        console.error(`runtime upstreams failure evidence: ${evidencePath}`);
      } catch (evidenceError) {
        console.error(`runtime upstreams failure evidence could not be written: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`);
      }
    }
    for (const resolve of pending.splice(0)) resolve(new Response('cleanup', { status: 503 }));
    const settled = await Promise.allSettled([
      cleanupMaster(master),
      upstream.stop(true),
      backup.stop(true),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'runtime upstreams cleanup failed');
    expect(master.processes.registeredPids.filter(processAlive)).toEqual([]);
    await removeFixture(fixture);
  });
}, 75_000);
