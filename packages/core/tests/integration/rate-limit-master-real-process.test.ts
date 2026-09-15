import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  childPids,
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterFixture,
  expectPortClosed,
  freePort,
  isIngressProcess,
  isWorkerProcess,
  processAlive,
  runWithCleanup,
  readWorkerDescriptors,
  removeFixture,
  sourceMasterEntry,
  spawnMaster,
  waitForDead,
  waitForHealth,
  waitForWorkerDescriptors,
  waitForWorkerPids,
  waitUntil,
  type RunningMaster,
} from '../fixtures/master-real-process-harness';
import {
  installRateLimitFixturePlugin,
  preserveRateLimitFailure,
  RATE_LIMIT_PLUGIN,
  RATE_LIMIT_TOKEN,
} from '../fixtures/rate-limit-master-real-process.fixture';

afterEach(cleanupSpawnedProcesses);

const SERVICE_ID = '91000000-0000-4000-8000-000000000001';
const ROUTE_ID = '91000000-0000-4000-8000-000000000002';
const ENDPOINT_ID = '91000000-0000-4000-8000-000000000003';
const BINDING_ID = '91000000-0000-4000-8000-000000000004';
const INITIAL_MUTATION_ID = '91000000-0000-4000-8000-000000000005';
const REPLACEMENT_MUTATION_ID = '91000000-0000-4000-8000-000000000006';
const IDENTITY_ROUTE_ID = '91000000-0000-4000-8000-000000000007';
const IDENTITY_BINDING_ID = '91000000-0000-4000-8000-000000000008';
const CAPACITY = 4;
const RATE_PER_SECOND = 0.01;
const AUTH = { authorization: `Bearer ${RATE_LIMIT_TOKEN}` };

type WorkerDescriptor = Record<string, unknown>;
type Operation = { readonly operation?: { readonly state?: string; readonly result_status?: number | null; readonly committed_revision?: number }; readonly workers?: unknown[] };

function aggregate(upstreamPort: number, logLevel: string): ConfigurationAggregateV2 {
  return {
    plugin_activations: [{ plugin_name: RATE_LIMIT_PLUGIN }],
    logical_configuration: {
      auth: { enabled: true, tokens: [RATE_LIMIT_TOKEN] },
      log_level: logLevel,
      plugins: [],
      services: [{
        id: SERVICE_ID, position: 1, name: 'rate-limit-real-process', plugins: [],
        endpoints: [{ id: ENDPOINT_ID, position: 1, target: `http://127.0.0.1:${upstreamPort}`,
          weight: 100, priority: 1, is_disabled: false, plugins: [] }],
      }],
      routes: [{
        id: ROUTE_ID, position: 1, path: '/limited', service_id: SERVICE_ID, auth: { enabled: false, tokens: [] },
        plugins: [{ id: BINDING_ID, position: 1, name: RATE_LIMIT_PLUGIN, enabled: true, options: {} }],
        rate_limit: { enabled: true, requests_per_second: RATE_PER_SECOND, burst: CAPACITY },
      }, {
        id: IDENTITY_ROUTE_ID, position: 2, path: '/identity', service_id: SERVICE_ID, auth: { enabled: false, tokens: [] },
        plugins: [{ id: IDENTITY_BINDING_ID, position: 1, name: RATE_LIMIT_PLUGIN, enabled: true, options: {} }],
      }],
    },
  };
}

function descriptorIdentity(descriptor: WorkerDescriptor): string {
  return [descriptor.worker_instance_id, descriptor.boot_nonce, descriptor.pid, descriptor.private_port,
    descriptor.worker_slot, descriptor.master_generation, descriptor.revision].join(':');
}

function supervisionEpoch(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = db.query<{ readonly controller_epoch: number }, []>(
      'SELECT controller_epoch FROM supervision_state WHERE id=1',
    ).get();
    if (row === null) throw new Error('supervision state was not initialized');
    return row.controller_epoch;
  } finally { db.close(true); }
}

function profileSummaries(master: RunningMaster): Array<Record<string, unknown>> {
  return master.output().split('\n').flatMap((line) => {
    if (!line.startsWith('{"kind":"rate_limit_profile"')) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

async function ingressPid(master: RunningMaster): Promise<number> {
  if (master.child.pid === undefined) throw new Error('master PID is unavailable');
  let pid: number | undefined;
  await waitUntil(async () => {
    for (const candidate of await childPids(master.child.pid!)) if (await isIngressProcess(candidate)) pid = candidate;
    return pid !== undefined;
  }, 'master did not expose its ingress process');
  return pid!;
}

test('real Master, Ingress, and four Workers retain one trusted-peer bucket through publication and takeover', async () => {
  const fixture = await createMasterFixture('bungee-rate-limit-real-');
  const port = await freePort();
  await installRateLimitFixturePlugin(fixture);
  let upstreamHits = 0;
  const upstream = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => { upstreamHits += 1; return new Response('rate-limit-upstream'); },
  });
  if (upstream.port === undefined) throw new Error('upstream port is unavailable');
  const evidence: Record<string, unknown> = {};
  const trackedPids = new Set<number>();
  let first: RunningMaster | null = null;
  let second: RunningMaster | null = null;
  let ingress: number | undefined;
  await runWithCleanup(async () => {
    try {
    first = spawnMaster(sourceMasterEntry(), fixture, port, 4);
    await waitForHealth(port, first);
    ingress = await ingressPid(first);
    trackedPids.add(first.child.pid!);
    trackedPids.add(ingress);
    const firstWorkers = await waitForWorkerPids(first.child.pid!, 4);
    firstWorkers.forEach((pid) => trackedPids.add(pid));
    expect(new Set(firstWorkers).size).toBe(4);
    expect(firstWorkers.every(processAlive)).toBeTrue();

    const initialPut = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { ...AUTH, 'x-bungee-next-authorization': `Bearer ${RATE_LIMIT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(upstream.port!, 'info'), mutation_id: INITIAL_MUTATION_ID }),
    });
    evidence.initial_put = { status: initialPut.status, body: await initialPut.clone().json() };
    expect(initialPut.status).toBe(202);
    let initialOperation: Operation = {};
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${INITIAL_MUTATION_ID}`, { headers: AUTH });
      initialOperation = await response.json() as Operation;
      evidence.initial_operation = { status: response.status, body: initialOperation };
      return initialOperation.operation?.state === 'converged';
    }, 'initial four-worker publication did not converge', 30_000);
    expect(initialOperation.workers).toHaveLength(4);

    const descriptors = await waitForWorkerDescriptors(fixture, 4);
    evidence.initial_workers = descriptors;
    expect(new Set(descriptors.map(descriptorIdentity)).size).toBe(4);
    descriptors.forEach((descriptor) => trackedPids.add(Number(descriptor.pid)));
    expect(descriptors.every((descriptor) => processAlive(Number(descriptor.pid)))).toBeTrue();
    expect(descriptors.every((descriptor) => descriptor.phase === 'serving' && descriptor.frozen === false && descriptor.revision === 2)).toBeTrue();

    const identityResponses: Response[] = [];
    for (let index = 0; index < CAPACITY * 2; index += 1) {
      identityResponses.push(await fetch(`http://127.0.0.1:${port + 1}/identity`, { headers: { connection: 'close' } }));
    }
    expect(identityResponses.every((response) => response.status === 200)).toBeTrue();
    expect(new Set(identityResponses.map((response) => response.headers.get('x-rate-limit-worker') ?? 'missing-worker-identity')))
      .toEqual(new Set(descriptors.map((descriptor) => String(descriptor.worker_instance_id))));

    const depletedAt = Date.now();
    const upstreamBeforeBurst = upstreamHits;
    const burst = await Promise.all(Array.from({ length: CAPACITY * 2 }, (_, index) => fetch(`http://127.0.0.1:${port + 1}/limited`, {
      headers: { connection: 'close', 'x-forwarded-for': `198.51.100.${index + 1}` }, signal: AbortSignal.timeout(2_000),
    })));
    const statuses = burst.map((response) => response.status);
    const admitted = burst.filter((response) => response.status === 200);
    expect(statuses.filter((status) => status === 200)).toHaveLength(CAPACITY);
    expect(statuses.filter((status) => status === 429)).toHaveLength(CAPACITY);
    expect(upstreamHits).toBe(upstreamBeforeBurst + CAPACITY);
    expect(await Promise.all(admitted.map((response) => response.text()))).toEqual(Array(CAPACITY).fill('rate-limit-upstream'));
    const admittedWorkerIds = admitted.map((response) => response.headers.get('x-rate-limit-worker') ?? 'missing-worker-identity');
    expect(admittedWorkerIds.every((worker) => descriptors.some((descriptor) => String(descriptor.worker_instance_id) === worker))).toBeTrue();

    const replacementPut = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { ...AUTH, 'x-bungee-next-authorization': `Bearer ${RATE_LIMIT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 2, aggregate: aggregate(upstream.port!, 'debug'), mutation_id: REPLACEMENT_MUTATION_ID }),
    });
    evidence.replacement_put = { status: replacementPut.status, body: await replacementPut.clone().json() };
    expect(replacementPut.status).toBe(202);
    let replacementOperation: Operation = {};
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${REPLACEMENT_MUTATION_ID}`, { headers: AUTH });
      replacementOperation = await response.json() as Operation;
      evidence.replacement_operation = { status: response.status, body: replacementOperation };
      return replacementOperation.operation?.state === 'converged' || replacementOperation.operation?.state === 'degraded';
    }, 'same-policy replacement did not reach a terminal state', 30_000);
    expect(replacementOperation.operation?.committed_revision).toBe(3);
    const replacementStatus = replacementOperation.operation?.result_status;
    expect(replacementStatus).toBeDefined();
    expect([200, 202]).toContain(replacementStatus!);
    const replacementWorkers = await waitForWorkerDescriptors(fixture, 4);
    replacementWorkers.forEach((descriptor) => trackedPids.add(Number(descriptor.pid)));
    evidence.replacement_workers = replacementWorkers;
    expect(replacementWorkers.every((descriptor) => descriptor.revision === 3 && descriptor.phase === 'serving' && descriptor.frozen === false)).toBeTrue();
    expect(Date.now() - depletedAt).toBeLessThan(15_000);

    const noGiftStarted = performance.now();
    const noGift = await fetch(`http://127.0.0.1:${port + 1}/limited`, {
      headers: { connection: 'close', 'x-forwarded-for': '203.0.113.99' }, signal: AbortSignal.timeout(2_000),
    });
    expect(performance.now() - noGiftStarted).toBeLessThan(2_000);
    expect(noGift.status).toBe(429);
    expect(upstreamHits).toBe(upstreamBeforeBurst + CAPACITY);

    const firstEpoch = supervisionEpoch(fixture.dbPath);
    first.child.kill('SIGKILL');
    await waitForDead([first.child.pid!]);
    // The production lease is 15 seconds; no control-plane client is created by this test.
    await Bun.sleep(17_000);

    second = spawnMaster(sourceMasterEntry(), fixture, port, 4);
    trackedPids.add(second.child.pid!);
    await waitForHealth(port, second);
    expect(supervisionEpoch(fixture.dbPath)).toBe(firstEpoch + 1);
    expect(processAlive(ingress)).toBeTrue();
    const adoptedChildren = await childPids(second.child.pid!);
    expect((await Promise.all(adoptedChildren.map(async (pid) => await isWorkerProcess(pid) ? pid : null)))
      .filter((pid): pid is number => pid !== null)).toHaveLength(0);
    const adoptedDescriptors = await waitForWorkerDescriptors(fixture, 4);
    evidence.adopted_workers = adoptedDescriptors;
    expect(adoptedDescriptors.map(descriptorIdentity).sort()).toEqual(replacementWorkers.map(descriptorIdentity).sort());

    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port + 1}/limited`, {
        headers: { connection: 'close', 'x-forwarded-for': '192.0.2.250' }, signal: AbortSignal.timeout(1_000),
      });
      return response.status === 429;
    }, 'adopted ingress/workers did not retain the exhausted bucket', 15_000);
    expect(upstreamHits).toBe(upstreamBeforeBurst + CAPACITY);
    } catch (error) {
    await preserveRateLimitFailure({ evidence, first, second });
    throw error;
    }
  }, async () => {
    const masters = await Promise.allSettled([
      ...(second === null ? [] : [cleanupMaster(second, [...trackedPids])]),
      ...(first === null ? [] : [cleanupMaster(first, [...trackedPids])]),
    ]);
    const resources = await Promise.allSettled([
      waitForDead([...trackedPids]),
      expectPortClosed(port),
      expectPortClosed(port + 1),
      expectPortClosed(port + 2),
      upstream.stop(true),
    ]);
    const errors = [
      ...masters.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...resources.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (errors.length > 0) throw new AggregateError(errors, 'rate-limit cleanup failed');
    await removeFixture(fixture);
  });
}, 90_000);

test('rate-limit profile emits one summary per graceful Ingress and Worker, and none when disabled', async () => {
  const enabledFixture = await createMasterFixture('bungee-rate-limit-profile-enabled-');
  const disabledFixture = await createMasterFixture('bungee-rate-limit-profile-disabled-');
  const port = await freePort();
  const disabledPort = await freePort();
  let enabled: RunningMaster | null = null;
  let disabled: RunningMaster | null = null;
  await runWithCleanup(async () => {
    enabled = spawnMaster(sourceMasterEntry(), enabledFixture, port, 4, enabledFixture.root, enabledFixture.accessDbPath, {
      BUNGEE_RATE_LIMIT_PROFILE: '1',
    });
    await waitForHealth(port, enabled);
    await waitForWorkerPids(enabled.child.pid!, 4);
    await cleanupMaster(enabled);
    await Bun.sleep(50);
    const enabledSummaries = profileSummaries(enabled);
    expect(enabledSummaries.every((summary) => Number.isSafeInteger(summary.pid) && Number(summary.pid) > 0)).toBe(true);
    expect(enabledSummaries.filter((summary) => summary.role === 'ingress')).toHaveLength(1);
    expect(enabledSummaries.filter((summary) => summary.role === 'worker')).toHaveLength(4);

    disabled = spawnMaster(sourceMasterEntry(), disabledFixture, disabledPort, 4, disabledFixture.root, disabledFixture.accessDbPath, {
      BUNGEE_RATE_LIMIT_PROFILE: '',
    });
    await waitForHealth(disabledPort, disabled);
    await waitForWorkerPids(disabled.child.pid!, 4);
    await cleanupMaster(disabled);
    await Bun.sleep(50);
    expect(profileSummaries(disabled)).toHaveLength(0);
  }, async () => {
    const masters = await Promise.allSettled([
      ...(enabled === null ? [] : [cleanupMaster(enabled)]),
      ...(disabled === null ? [] : [cleanupMaster(disabled)]),
    ]);
    const ports = await Promise.allSettled([
      expectPortClosed(port),
      expectPortClosed(disabledPort),
    ]);
    const failures = [
      ...masters.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...ports.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (failures.length > 0) throw new AggregateError(failures, 'rate-limit profile cleanup failed');
    const fixtures = await Promise.allSettled([removeFixture(enabledFixture), removeFixture(disabledFixture)]);
    const fixtureFailures = fixtures.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (fixtureFailures.length > 0) throw new AggregateError(fixtureFailures, 'rate-limit profile fixture cleanup failed');
  });
}, 60_000);
