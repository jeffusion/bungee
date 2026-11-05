import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import {
  captureProcessIdentity,
  probeProcessIdentity,
  type CapturedProcessIdentity,
} from '../../packages/core/src/master-runtime/process-identity';
import {
  cleanupGatewayFixture,
  createGatewayFixture,
  quarantinePortBlock,
  recordOwnedWorkers,
  releasePortBlock,
  requestJson,
  reservePortBlock,
  safeGatewayError,
  scrub,
  startTrackedGatewayMaster,
  stopOwnedMaster,
  waitForHealth,
  waitUntil,
  type GatewayFixture,
  type GatewayMasterStartupState,
  type OwnedMaster,
  type PortLease,
} from '../helpers/gateway-runtime';
import { ensureTestPortBlockClosed } from '../helpers/test-port-block-broker';
import { waitForFixturePublication } from '../helpers/publication-fixture';

const SERVICE_ID = '10000000-0000-4000-8000-000000000101';
const ENDPOINT_ID = '20000000-0000-4000-8000-000000000101';
const STREAM_ROUTE_ID = '30000000-0000-4000-8000-000000000101';
const PROBE_ROUTE_ID = '30000000-0000-4000-8000-000000000102';
const STREAM_REFERENCE_ID = '40000000-0000-4000-8000-000000000101';
const PROBE_REFERENCE_ID = '40000000-0000-4000-8000-000000000102';
const GATE_BINDING_ID = '50000000-0000-4000-8000-000000000101';
const GATE_PLUGIN_NAME = 'candidate-gate';
const encoder = new TextEncoder();
const CANDIDATE_GATE_MAIN = `
export default class CandidateGate {
  static name = '${GATE_PLUGIN_NAME}';
  static version = '1.0.0';
  static configSchema = [
    { name: 'gate_url', type: 'string', label: 'gate_url' },
    { name: 'cleanup_gate_url', type: 'string', label: 'cleanup_gate_url' },
  ];
  constructor(options) {
    this.gateUrl = options.gate_url;
    this.cleanupGateUrl = options.cleanup_gate_url;
  }
  bodyRequirements() { return { request: 'none' }; }
  marker() {
    const marker = process.argv.find((argument) => argument.startsWith('--bungee-process-identity='))
      ?.slice('--bungee-process-identity='.length) ?? '';
    if (marker === '') throw new Error('candidate gate could not read worker identity');
    return marker;
  }
  async init(context) {
    const response = await fetch(this.gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, marker: this.marker() }),
      signal: context.signal,
    });
    if (!response.ok) throw new Error('candidate gate rejected worker initialization');
  }
  async onDestroy() {
    if (!this.cleanupGateUrl) return;
    const response = await fetch(this.cleanupGateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, marker: this.marker() }),
    });
    if (!response.ok) throw new Error('candidate cleanup gate rejected worker shutdown');
  }
  register() {}
}
`;
const CANDIDATE_GATE_MANIFEST = {
  name: GATE_PLUGIN_NAME,
  version: '1.0.0',
  schemaVersion: 3,
  artifactKind: 'runtime-plugin',
  main: 'index.js',
  capabilities: ['hooks', 'dynamicRuntimeLoad'],
  runtimeScope: 'global',
  uiExtensionMode: 'none',
  engines: { bungee: '^6.0.0' },
  configSchema: [
    { name: 'gate_url', type: 'string', label: 'gate_url' },
    { name: 'cleanup_gate_url', type: 'string', label: 'cleanup_gate_url' },
  ],
} as const;

async function prepareCandidateGatePlugin(pluginsPath: string): Promise<void> {
  const directory = join(pluginsPath, GATE_PLUGIN_NAME);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.js'), CANDIDATE_GATE_MAIN, 'utf8');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(CANDIDATE_GATE_MANIFEST), 'utf8');
}

type RuntimeWorker = Readonly<{
  pid: number;
  worker_instance_id: string;
  boot_nonce: string;
  revision: number;
  content_hash: string;
}>;

type RuntimeBody = Readonly<{
  revision?: number;
  workers?: readonly RuntimeWorker[];
  publication?: Readonly<{ serving_complete?: boolean; serving_revision?: number | null }>;
}>;

type OperationBody = Readonly<{
  operation?: Readonly<{
    mutation_id?: string;
    expected_revision?: number;
    committed_revision?: number;
    target_worker_count?: number;
    state?: string;
    result_status?: number;
    error_code?: string | null;
    error_detail?: string | null;
  }>;
  workers?: readonly Readonly<{
    mutation_id?: string;
    target_revision?: number;
    attempt_no?: number;
    last_begin_previous_attempt_no?: number | null;
    last_begin_reason?: string | null;
    state?: string;
    applied_revision?: number | null;
  }>[];
}>;

type SnapshotBody = Readonly<{ revision?: number; content_hash?: string }>;

function aggregate(
  targetPort: number,
  logLevel?: string,
  gateUrl?: string,
  cleanupGateUrl?: string,
): ConfigurationAggregate {
  const reference = (id: string, position: number) => ({
    id, position, service_id: SERVICE_ID, weight: 100, priority: 1, is_disabled: false,
  });
  return {
    plugin_activations: gateUrl === undefined ? [] : [{ plugin_name: GATE_PLUGIN_NAME }],
    logical_configuration: {
      ...(logLevel === undefined ? {} : { log_level: logLevel }),
      plugins: gateUrl === undefined ? [] : [{
        id: GATE_BINDING_ID, position: 1, name: GATE_PLUGIN_NAME, enabled: true,
        options: { gate_url: gateUrl, ...(cleanupGateUrl === undefined ? {} : { cleanup_gate_url: cleanupGateUrl }) },
      }],
      publication: {
        drain_start_timeout_ms: 5_000,
        drain_timeout_ms: 20_000,
        worker_exit_timeout_ms: 10_000,
      },
      services: [{
        id: SERVICE_ID,
        position: 1,
        name: 'configuration-update-fixture',
        plugins: [],
        endpoints: [{
          id: ENDPOINT_ID,
          position: 1,
          target: `http://127.0.0.1:${targetPort}`,
          weight: 100,
          priority: 1,
          is_disabled: false,
          plugins: [],
        }],
      }],
      routes: [{
        id: STREAM_ROUTE_ID,
        position: 1,
        path: '/stream',
        service_references: [reference(STREAM_REFERENCE_ID, 0)],
        plugins: [],
      }, {
        id: PROBE_ROUTE_ID,
        position: 2,
        path: '/probe',
        service_references: [reference(PROBE_REFERENCE_ID, 1)],
        plugins: [],
      }],
    },
  };
}

type GateHit = Readonly<{
  pid: number;
  marker: string;
  identity: CapturedProcessIdentity;
}>;

async function readGateHit(request: Request): Promise<GateHit> {
  const body = await request.json() as { pid?: unknown; marker?: unknown };
  if (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 0
    || typeof body.marker !== 'string' || !/^[0-9a-f-]{36}$/.test(body.marker)) {
    throw new Error('candidate gate received an invalid worker identity');
  }
  const pid = body.pid as number;
  return { pid, marker: body.marker, identity: await captureProcessIdentity(pid, body.marker) };
}

function markerUpstream(marker: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => new URL(request.url).pathname === '/probe'
      ? new Response(marker, { headers: { 'content-type': 'text/plain' } })
      : new Response('fixture not found', { status: 404 }),
  });
}

async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`stream read exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readRemaining(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`stream body exceeded ${timeoutMs}ms`);
    const chunk = await readBounded(reader, remaining);
    if (chunk.done) return text + decoder.decode();
    text += decoder.decode(chunk.value, { stream: true });
  }
}

async function snapshot(management: string, fixture: GatewayFixture): Promise<{ revision: number; content_hash: string }> {
  const result = await requestJson(`${management}/api/config`, {}, fixture);
  if (result.response.status !== 200) throw new Error(`config snapshot returned ${result.response.status}`);
  const body = result.body as SnapshotBody;
  if (!Number.isSafeInteger(body.revision) || typeof body.content_hash !== 'string') {
    throw new Error('config snapshot did not include a safe revision and content hash');
  }
  return { revision: body.revision!, content_hash: body.content_hash };
}

async function runtime(management: string, fixture: GatewayFixture): Promise<RuntimeBody> {
  const result = await requestJson(`${management}/api/config/runtime`, {}, fixture);
  if (result.response.status !== 200) throw new Error(`runtime snapshot returned ${result.response.status}`);
  return result.body as RuntimeBody;
}

async function waitForOperation(
  management: string,
  mutationId: string,
  states: readonly string[],
  fixture: GatewayFixture,
): Promise<OperationBody> {
  let last: OperationBody | undefined;
  await waitUntil(async () => {
    const result = await requestJson(`${management}/api/config/operations/${mutationId}`, {}, fixture);
    if (!result.response.ok && result.response.status !== 409) {
      throw new Error(`operation ${mutationId} returned ${result.response.status}: ${result.text}`);
    }
    const current = result.body as OperationBody;
    last = current;
    const state = current.operation?.state;
    if (state === 'failed' || (state === 'degraded' && !states.includes('degraded'))) {
      throw new Error(`operation ${mutationId} ended ${state}: ${JSON.stringify(current.operation)}`);
    }
    return state !== undefined && states.includes(state);
  }, `operation ${mutationId} did not reach ${states.join('|')}`, 30_000);
  if (last === undefined) throw new Error(`operation ${mutationId} was not observed`);
  return last;
}

async function waitForServing(
  management: string,
  revision: number,
  master: OwnedMaster,
  fixture: GatewayFixture,
): Promise<readonly RuntimeWorker[]> {
  await waitForFixturePublication({
    base: management,
    revision,
    childExited: () => master.child.exitCode !== null || master.child.signalCode !== null,
  });
  const body = await runtime(management, fixture);
  const workers = body.workers ?? [];
  if (body.revision !== revision || workers.length !== 2
    || !workers.every((worker) => Number.isSafeInteger(worker.pid)
      && typeof worker.worker_instance_id === 'string'
      && typeof worker.boot_nonce === 'string'
      && worker.revision === revision)) {
    throw new Error(`runtime did not expose two revision ${revision} workers after serving evidence`);
  }
  return workers;
}

async function probe(proxy: string, fixture: GatewayFixture): Promise<string> {
  const result = await requestJson(`${proxy}/probe`, {}, fixture);
  if (result.response.status !== 200) throw new Error(`probe returned ${result.response.status}: ${result.text}`);
  return result.text;
}

async function commit(
  management: string,
  expectedRevision: number,
  mutationId: string,
  aggregateValue: ConfigurationAggregate,
  fixture: GatewayFixture,
): Promise<void> {
  const result = await requestJson(`${management}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, mutation_id: mutationId, aggregate: aggregateValue }),
  }, fixture);
  expect(result.response.status).toBe(202);
}

async function exactWorkerCount(master: OwnedMaster, workerInstanceIds: readonly string[]): Promise<number> {
  let count = 0;
  for (const workerInstanceId of workerInstanceIds) {
    const owned = master.workers.get(workerInstanceId);
    if (owned?.identity === undefined) continue;
    if (await probeProcessIdentity(owned.identity) === 'exact') count += 1;
  }
  return count;
}

async function waitForWorkersExited(
  master: OwnedMaster,
  workerInstanceIds: readonly string[],
  message: string,
): Promise<void> {
  await waitUntil(async () => {
    for (const workerInstanceId of workerInstanceIds) {
      const owned = master.workers.get(workerInstanceId);
      if (owned?.identity === undefined) throw new Error(`worker identity ${workerInstanceId} was not captured`);
      const probeResult = await probeProcessIdentity(owned.identity);
      if (probeResult === 'unknown') throw new Error(`worker identity ${workerInstanceId} could not be inspected`);
      if (probeResult === 'exact') return false;
    }
    return true;
  }, message, 20_000);
}

function expectDisjoint(left: readonly string[], right: readonly string[]): void {
  expect(left.filter((value) => right.includes(value))).toEqual([]);
}

function expectUnstartedWorkers(operationValue: OperationBody, revision: number): void {
  expect(operationValue.operation?.target_worker_count).toBe(2);
  expect(operationValue.workers).toHaveLength(2);
  expect(operationValue.workers?.every((worker) => worker.mutation_id === operationValue.operation?.mutation_id
    && worker.target_revision === revision && worker.attempt_no === 0
    && worker.last_begin_previous_attempt_no === null && worker.last_begin_reason === null
    && worker.state === 'pending' && worker.applied_revision === null)).toBe(true);
}

function expectStartedWorkers(operationValue: OperationBody, revision: number): void {
  expect(operationValue.operation?.target_worker_count).toBe(2);
  expect(operationValue.workers).toHaveLength(2);
  expect(operationValue.workers?.every((worker) => worker.mutation_id === operationValue.operation?.mutation_id
    && worker.target_revision === revision && typeof worker.attempt_no === 'number' && worker.attempt_no > 0
    && worker.last_begin_previous_attempt_no === worker.attempt_no - 1
    && worker.last_begin_reason !== null && worker.state === 'converged'
    && worker.applied_revision === revision)).toBe(true);
}

describe('configuration updates while the old generation drains', () => {
  let fixture: GatewayFixture | undefined;
  let lease: PortLease | undefined;
  let master: OwnedMaster | undefined;
  const startup: GatewayMasterStartupState = { attempted: false, errors: [] };
  let upstreamA: ReturnType<typeof Bun.serve> | undefined;
  let upstreamB: ReturnType<typeof Bun.serve> | undefined;
  let upstreamD: ReturnType<typeof Bun.serve> | undefined;
  let releaseStream: () => void = () => undefined;
  let streamGate: Promise<void> = Promise.resolve();
  let testFailed = false;

  async function startMaster(currentFixture: GatewayFixture, currentLease: PortLease): Promise<OwnedMaster> {
    try {
      master = await startTrackedGatewayMaster(startup, currentFixture, currentLease);
      return master;
    } catch (error) {
      master = startup.master;
      throw error;
    }
  }

  beforeAll(async () => {
    fixture = await createGatewayFixture({
      prefix: 'configuration-update-drain',
      plugins: [],
      preparePlugins: prepareCandidateGatePlugin,
    });
    lease = await reservePortBlock();
    const gate = Promise.withResolvers<void>();
    streamGate = gate.promise;
    releaseStream = () => gate.resolve();
    upstreamA = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/probe') return new Response('A', { headers: { 'content-type': 'text/plain' } });
        if (path !== '/stream') return new Response('fixture not found', { status: 404 });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('first\n'));
            void streamGate.then(() => {
              try {
                controller.enqueue(encoder.encode('last\n'));
                controller.close();
              } catch {
                // The client cancelled or the test already failed.
              }
            });
          },
        }), { headers: { 'content-type': 'text/plain' } });
      },
    });
    upstreamB = markerUpstream('B');
    upstreamD = markerUpstream('D');
    if (upstreamA.port === undefined || upstreamB.port === undefined || upstreamD.port === undefined) {
      throw new Error('configuration update upstreams did not bind');
    }
    master = await startMaster(fixture, lease);
    await waitForHealth(master, lease.base, fixture);
  }, 90_000);

  afterAll(async () => {
    const evidenceFixture = fixture;
    const cleanupErrors: unknown[] = [...startup.errors];
    let shutdownVerified = false;
    const ownedForShutdown = master ?? startup.master;
    if (ownedForShutdown !== undefined) {
      try {
        await stopOwnedMaster(ownedForShutdown);
        shutdownVerified = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let upstreamsClosed = true;
    for (const upstream of [upstreamA, upstreamB, upstreamD]) {
      try { await upstream?.stop(true); } catch (error) {
        upstreamsClosed = false;
        cleanupErrors.push(error);
      }
    }
    let leaseReleased = !startup.attempted;
    if (lease !== undefined) {
      try {
        await releasePortBlock(lease);
        leaseReleased = true;
      } catch (error) {
        quarantinePortBlock(lease);
        cleanupErrors.push(error);
      }
      lease = undefined;
    }
    const portsVerifiedClosed = !startup.attempted || (upstreamsClosed && leaseReleased);
    if (fixture !== undefined && testFailed) {
      console.error(`configuration update failure evidence preserved at ${scrub(fixture.root, fixture)}; process=${shutdownVerified ? 'stopped' : 'unverified'} ports=${portsVerifiedClosed ? 'closed' : 'unverified'}`);
    } else if (fixture !== undefined) {
      try {
        const removed = await cleanupGatewayFixture(fixture, {
          startupAttempted: startup.attempted,
          master,
          shutdownVerified,
          portsVerifiedClosed,
        });
        if (!removed) cleanupErrors.push(new Error(`startup, process ownership, or port closure is unverified; preserving fixture and logs at ${fixture.root}`));
      } catch (error) { cleanupErrors.push(error); }
      fixture = undefined;
    }
    if (cleanupErrors.length > 0) {
      const summaries = cleanupErrors.map((error) => evidenceFixture === undefined
        ? error instanceof Error ? error.message : 'unknown cleanup error'
        : safeGatewayError(error, evidenceFixture, 4_096));
      throw new Error(`configuration update fixture cleanup failed: ${summaries.join('\n').slice(-24_576)}`);
    }
  }, 45_000);

  test('old streaming request drains while B serves, C is superseded unclaimed, D becomes latest, and restart keeps D', async () => {
    if (fixture === undefined || lease === undefined || master === undefined
      || upstreamA?.port === undefined || upstreamB?.port === undefined || upstreamD?.port === undefined) {
      testFailed = true;
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const firstMaster = master;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const streamAbort = new AbortController();
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let restartedMaster: OwnedMaster | undefined;

    try {
      const initialWorkerIds = [...firstMaster.workers.keys()];
      expect(initialWorkerIds).toHaveLength(2);

      const initial = await snapshot(management, currentFixture);
      const mutationA = randomUUID();
      await commit(management, initial.revision, mutationA, aggregate(upstreamA.port!), currentFixture);
      const revisionA = initial.revision + 1;
      const operationA = await waitForOperation(management, mutationA, ['converged'], currentFixture);
      expect(operationA.operation).toMatchObject({ mutation_id: mutationA, expected_revision: initial.revision, committed_revision: revisionA, state: 'converged' });
      const workersA = await waitForServing(management, revisionA, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersA);
      expectDisjoint(workersA.map((worker) => worker.worker_instance_id), initialWorkerIds);
      expect(await probe(proxy, currentFixture)).toBe('A');

      const streamResponse = await fetch(`${proxy}/stream`, {
        signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(60_000)]),
      });
      expect(streamResponse.status).toBe(200);
      if (streamResponse.body === null) throw new Error('stream response body is missing');
      streamReader = streamResponse.body.getReader();
      const firstChunk = await readBounded(streamReader, 10_000);
      if (firstChunk.done || firstChunk.value === undefined) throw new Error('stream ended before its first chunk');
      expect(new TextDecoder().decode(firstChunk.value)).toContain('first');

      const mutationB = randomUUID();
      await commit(management, revisionA, mutationB, aggregate(upstreamB.port!), currentFixture);
      const revisionB = revisionA + 1;
      const workersB = await waitForServing(management, revisionB, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersB);
      expectDisjoint(workersB.map((worker) => worker.worker_instance_id), workersA.map((worker) => worker.worker_instance_id));
      const operationB = await waitForOperation(management, mutationB, ['draining'], currentFixture);
      expect(operationB.operation).toMatchObject({ mutation_id: mutationB, expected_revision: revisionA, committed_revision: revisionB, state: 'draining' });
      expectStartedWorkers(operationB, revisionB);
      expect(await probe(proxy, currentFixture)).toBe('B');
      await waitUntil(async () => await exactWorkerCount(firstMaster, workersA.map((worker) => worker.worker_instance_id)) > 0,
        'the old streaming generation exited before the held request was released', 10_000);

      // C must be a real configuration change, not a duplicate target of B.
      const mutationC = randomUUID();
      await commit(management, revisionB, mutationC, aggregate(upstreamB.port!, 'debug'), currentFixture);
      const revisionC = revisionB + 1;
      const mutationD = randomUUID();
      await commit(management, revisionC, mutationD, aggregate(upstreamD.port!), currentFixture);
      const revisionD = revisionC + 1;

      const [operationC, operationD] = await Promise.all([
        waitForOperation(management, mutationC, ['pending'], currentFixture),
        waitForOperation(management, mutationD, ['pending'], currentFixture),
      ]);
      expectUnstartedWorkers(operationC, revisionC);
      expectUnstartedWorkers(operationD, revisionD);
      expect(operationC.operation).toMatchObject({ expected_revision: revisionB, committed_revision: revisionC, state: 'pending' });
      expect(operationD.operation).toMatchObject({ expected_revision: revisionC, committed_revision: revisionD, state: 'pending' });
      const heldRuntime = await runtime(management, currentFixture);
      expect(heldRuntime.revision).toBe(revisionD);
      expect(heldRuntime.publication).toMatchObject({ serving_complete: false, serving_revision: revisionB });
      expect(heldRuntime.workers?.map((worker) => worker.worker_instance_id).sort())
        .toEqual(workersB.map((worker) => worker.worker_instance_id).sort());
      expect(heldRuntime.workers?.every((worker) => worker.revision === revisionB)).toBe(true);
      expect((await snapshot(management, currentFixture)).revision).toBe(revisionD);

      releaseStream();
      const tail = await readRemaining(streamReader, 20_000);
      expect(tail).toContain('last');
      streamReader = undefined;

      const supersededC = await waitForOperation(management, mutationC, ['superseded'], currentFixture);
      expect(supersededC.operation?.committed_revision).toBe(revisionC);
      expectUnstartedWorkers(supersededC, revisionC);
      await waitForWorkersExited(firstMaster, workersA.map((worker) => worker.worker_instance_id),
        'old A worker processes did not exit after the held request completed');

      const convergedD = await waitForOperation(management, mutationD, ['converged'], currentFixture);
      expect(convergedD.operation).toMatchObject({ mutation_id: mutationD, committed_revision: revisionD, state: 'converged' });
      expectStartedWorkers(convergedD, revisionD);
      const workersD = await waitForServing(management, revisionD, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersD);
      expectDisjoint(workersD.map((worker) => worker.worker_instance_id), workersB.map((worker) => worker.worker_instance_id));
      const finalSnapshot = await snapshot(management, currentFixture);
      expect(finalSnapshot.revision).toBe(revisionD);
      expect(finalSnapshot.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(workersD.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await probe(proxy, currentFixture)).toBe('D');
      await waitForWorkersExited(firstMaster, workersB.map((worker) => worker.worker_instance_id),
        'old B worker processes did not exit after D became serving');
      expect(await exactWorkerCount(firstMaster, workersD.map((worker) => worker.worker_instance_id))).toBe(2);

      await stopOwnedMaster(firstMaster);
      master = undefined;
      await ensureTestPortBlockClosed(currentLease.block);

      const restarted = await startMaster(currentFixture, currentLease);
      restartedMaster = restarted;
      await waitForHealth(restarted, currentLease.base, currentFixture);
      const restartedWorkers = await waitForServing(management, revisionD, restarted, currentFixture);
      await recordOwnedWorkers(restarted, restartedWorkers);
      expectDisjoint(restartedWorkers.map((worker) => worker.worker_instance_id), workersD.map((worker) => worker.worker_instance_id));
      const restartedSnapshot = await snapshot(management, currentFixture);
      expect(restartedSnapshot).toEqual(finalSnapshot);
      expect(restartedWorkers.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await probe(proxy, currentFixture)).toBe('D');
    } catch (error) {
      testFailed = true;
      const activeMaster = master ?? restartedMaster;
      const diagnostics = (await activeMaster?.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      throw new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${activeMaster?.child.exitCode ?? activeMaster?.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
    } finally {
      releaseStream();
      streamAbort.abort();
      if (streamReader !== undefined) await streamReader.cancel().catch(() => undefined);
    }
  }, 120_000);

  test('cancels a pre-ready candidate when a newer target is saved and serves only the latest batch', async () => {
    if (fixture === undefined || lease === undefined || master === undefined
      || upstreamA?.port === undefined || upstreamB?.port === undefined) {
      testFailed = true;
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const firstMaster = master;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const held = Promise.withResolvers<void>();
    const hits: { pid: number; marker: string; identity: CapturedProcessIdentity }[] = [];
    let holdGate: ReturnType<typeof Bun.serve> | undefined;
    let passGate: ReturnType<typeof Bun.serve> | undefined;
    let gateFailure: Error | undefined;

    try {
      holdGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          const body = await request.json() as { pid?: unknown; marker?: unknown };
          if (!Number.isSafeInteger(body.pid) || typeof body.marker !== 'string'
            || !/^[0-9a-f-]{36}$/.test(body.marker)) {
            return Response.json({ error: 'invalid candidate gate request' }, { status: 400 });
          }
          const pid = body.pid as number;
          const identity = await captureProcessIdentity(pid, body.marker);
          hits.push({ pid, marker: body.marker, identity });
          await held.promise;
          return new Response('released');
        },
      });
      passGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          await request.body?.cancel();
          return new Response('ready');
        },
      });
      if (holdGate.port === undefined || passGate.port === undefined) {
        throw new Error('candidate gates did not bind');
      }

      const baseline = await snapshot(management, currentFixture);
      await waitForFixturePublication({
        base: management,
        revision: baseline.revision,
        childExited: () => firstMaster.child.exitCode !== null || firstMaster.child.signalCode !== null,
      });
      const baselineRuntime = await runtime(management, currentFixture);
      const baselineWorkers = baselineRuntime.workers ?? [];
      if (baselineWorkers.length !== 2) {
        throw new Error('candidate cancellation fixture requires two currently serving workers');
      }
      await recordOwnedWorkers(firstMaster, baselineWorkers);
      const baselineIds = baselineWorkers.map((worker) => worker.worker_instance_id);

      const mutationB = randomUUID();
      await commit(management, baseline.revision, mutationB,
        aggregate(upstreamB.port!, undefined, `http://127.0.0.1:${holdGate.port}/gate`), currentFixture);
      const revisionB = baseline.revision + 1;
      await waitUntil(() => hits.length >= 2, 'two candidate workers did not reach the pre-ready gate', 20_000);
      for (const hit of hits) {
        firstMaster.workers.set(hit.marker, {
          pid: hit.pid, workerInstanceId: hit.marker, identity: hit.identity,
        });
      }
      const heldRuntime = await runtime(management, currentFixture);
      expect(heldRuntime.revision).toBe(revisionB);
      expect(heldRuntime.publication).toMatchObject({ serving_complete: false, serving_revision: baseline.revision });
      expect(heldRuntime.workers?.map((worker) => worker.worker_instance_id).sort()).toEqual([...baselineIds].sort());

      const mutationC = randomUUID();
      await commit(management, revisionB, mutationC,
        aggregate(upstreamA.port!, undefined, `http://127.0.0.1:${passGate.port}/gate`), currentFixture);
      const revisionC = revisionB + 1;

      const supersededB = await waitForOperation(management, mutationB, ['superseded'], currentFixture);
      expect(supersededB.operation).toMatchObject({ committed_revision: revisionB, state: 'superseded' });
      expect(hits).toHaveLength(2);
      await waitForWorkersExited(firstMaster, hits.map((hit) => hit.marker),
        'pre-ready candidate workers did not exit after supersession');

      const convergedC = await waitForOperation(management, mutationC, ['converged'], currentFixture);
      expect(convergedC.operation).toMatchObject({ committed_revision: revisionC, state: 'converged' });
      expectStartedWorkers(convergedC, revisionC);
      const workersC = await waitForServing(management, revisionC, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersC);
      const workerIdsC = workersC.map((worker) => worker.worker_instance_id);
      expectDisjoint(workerIdsC, baselineIds);
      expectDisjoint(workerIdsC, hits.map((hit) => hit.marker));
      expect(await probe(proxy, currentFixture)).toBe('A');
      await waitForWorkersExited(firstMaster, baselineIds,
        'old serving workers did not exit after the latest candidate became serving');

      const finalSnapshot = await snapshot(management, currentFixture);
      expect(finalSnapshot.revision).toBe(revisionC);
      expect(workersC.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await exactWorkerCount(firstMaster, workerIdsC)).toBe(2);
    } catch (error) {
      testFailed = true;
      const diagnostics = (await firstMaster.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      gateFailure = new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${firstMaster.child.exitCode ?? firstMaster.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
      throw gateFailure;
    } finally {
      held.resolve();
      const stopped = await Promise.allSettled([holdGate?.stop(true), passGate?.stop(true)]);
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        testFailed = true;
        throw new AggregateError([
          ...(gateFailure === undefined ? [] : [gateFailure]),
          ...failures.map(result => safeGatewayError(result.reason, currentFixture)),
        ], 'candidate gate shutdown failed');
      }
    }
  }, 120_000);

  test('master SIGKILL while cancelled candidate cleanup is unconfirmed blocks a third batch and resumes the latest target', async () => {
    if (fixture === undefined || lease === undefined || master === undefined
      || upstreamA?.port === undefined || upstreamB?.port === undefined || upstreamD?.port === undefined) {
      testFailed = true;
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const oldMaster = master;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const initHeld = Promise.withResolvers<void>();
    const cleanupHeld = Promise.withResolvers<void>();
    const initHits: GateHit[] = [];
    const cleanupHits: GateHit[] = [];
    const cohortHits: GateHit[] = [];
    let mutationB = '';
    let cohortStartedBeforeCandidateProof = false;
    let initGate: ReturnType<typeof Bun.serve> | undefined;
    let cleanupGate: ReturnType<typeof Bun.serve> | undefined;
    let cohortGate: ReturnType<typeof Bun.serve> | undefined;
    let restartedMaster: OwnedMaster | undefined;
    let gateFailure: Error | undefined;

    try {
      const initial = await snapshot(management, currentFixture);
      const baselineMutation = randomUUID();
      await commit(management, initial.revision, baselineMutation, aggregate(upstreamA.port!), currentFixture);
      const baselineRevision = initial.revision + 1;
      const baselineOperation = await waitForOperation(management, baselineMutation, ['converged'], currentFixture);
      expect(baselineOperation.operation).toMatchObject({ committed_revision: baselineRevision, state: 'converged' });
      const baselineWorkers = await waitForServing(management, baselineRevision, oldMaster, currentFixture);
      await recordOwnedWorkers(oldMaster, baselineWorkers);
      const baselineIds = baselineWorkers.map((worker) => worker.worker_instance_id);
      expect(await probe(proxy, currentFixture)).toBe('A');

      initGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          initHits.push(await readGateHit(request));
          await initHeld.promise;
          return new Response('released');
        },
      });
      cleanupGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          cleanupHits.push(await readGateHit(request));
          await cleanupHeld.promise;
          return new Response('cleaned');
        },
      });
      cohortGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          const hit = await readGateHit(request);
          cohortHits.push(hit);
          for (const candidate of initHits) {
            if (await probeProcessIdentity(candidate.identity) === 'exact') {
              cohortStartedBeforeCandidateProof = true;
            }
          }
          const operationState = await requestJson(
            `${management}/api/config/operations/${mutationB}`, {}, currentFixture,
          ).then(
            result => (result.body as OperationBody).operation?.state,
            () => undefined,
          );
          if (operationState !== 'superseded') cohortStartedBeforeCandidateProof = true;
          return new Response('ready');
        },
      });
      if (initGate.port === undefined || cleanupGate.port === undefined || cohortGate.port === undefined) {
        throw new Error('candidate cancellation gates did not bind');
      }

      mutationB = randomUUID();
      await commit(management, baselineRevision, mutationB,
        aggregate(upstreamB.port!, undefined,
          `http://127.0.0.1:${initGate.port}/gate`,
          `http://127.0.0.1:${cleanupGate.port}/cleanup`), currentFixture);
      const revisionB = baselineRevision + 1;
      await waitUntil(() => initHits.length >= 2, 'two candidates did not enter their pre-ready gate', 20_000);
      expect(initHits).toHaveLength(2);
      for (const hit of initHits) {
        oldMaster.workers.set(hit.marker, {
          pid: hit.pid, workerInstanceId: hit.marker, identity: hit.identity,
        });
      }

      const pendingLatestMutation = randomUUID();
      await commit(management, revisionB, pendingLatestMutation,
        aggregate(upstreamD.port!, undefined, `http://127.0.0.1:${cohortGate.port}/gate`), currentFixture);
      const pendingLatestRevision = revisionB + 1;

      await waitUntil(() => cleanupHits.length >= 2, 'cancelled candidates did not enter their managed cleanup gate', 20_000);
      expect(cleanupHits).toHaveLength(2);
      expect(cleanupHits.map((hit) => hit.marker).sort()).toEqual(initHits.map((hit) => hit.marker).sort());
      // Event-gated peak: no latest initialization may be observed while a cancelled
      // candidate is still exact or its durable cleanup is not yet superseded.
      expect(cohortHits).toHaveLength(0);
      expect(await exactWorkerCount(oldMaster, initHits.map((hit) => hit.marker))).toBe(2);
      expect(await exactWorkerCount(oldMaster, baselineIds) + await exactWorkerCount(oldMaster, initHits.map((hit) => hit.marker))).toBe(4);

      oldMaster.child.kill('SIGKILL');
      await waitUntil(() => oldMaster.child.exitCode !== null || oldMaster.child.signalCode !== null,
        'old master did not exit after SIGKILL', 10_000);
      expect(oldMaster.child.exitCode !== null || oldMaster.child.signalCode !== null).toBe(true);
      expect(await exactWorkerCount(oldMaster, initHits.map((hit) => hit.marker))).toBe(2);
      expect(await exactWorkerCount(oldMaster, baselineIds)).toBe(2);

      master = undefined;
      const restarted = await startMaster(currentFixture, currentLease);
      restartedMaster = restarted;
      await waitForHealth(restarted, currentLease.base, currentFixture);
      for (const hit of initHits) {
        restarted.workers.set(hit.marker, {
          pid: hit.pid, workerInstanceId: hit.marker, identity: hit.identity,
        });
      }

      const durableLatest = await snapshot(management, currentFixture);
      expect(durableLatest.revision).toBe(pendingLatestRevision);
      expect(await probe(proxy, currentFixture)).toBe('A');
      expect(cohortHits).toHaveLength(0);
      expect(await exactWorkerCount(restarted, initHits.map((hit) => hit.marker))).toBe(2);
      const pendingB = await requestJson(`${management}/api/config/operations/${mutationB}`, {}, currentFixture);
      expect((pendingB.body as OperationBody).operation?.state).not.toBe('superseded');

      // A new save must be accepted while the older cancelled candidate's cleanup
      // remains unconfirmed and the current latest target has not been claimed.
      const finalMutation = randomUUID();
      await commit(management, pendingLatestRevision, finalMutation,
        aggregate(upstreamD.port!, 'debug', `http://127.0.0.1:${cohortGate.port}/gate`), currentFixture);
      const finalRevision = pendingLatestRevision + 1;
      const savedFinal = await snapshot(management, currentFixture);
      expect(savedFinal.revision).toBe(finalRevision);
      expect(savedFinal.content_hash).not.toBe(durableLatest.content_hash);
      const pendingLatest = await requestJson(
        `${management}/api/config/operations/${pendingLatestMutation}`, {}, currentFixture,
      );
      expect(pendingLatest.response.status).toBe(202);
      const pendingLatestBody = pendingLatest.body as OperationBody;
      expect(pendingLatestBody.operation).toMatchObject({
        mutation_id: pendingLatestMutation, committed_revision: pendingLatestRevision, state: 'pending',
      });
      expectUnstartedWorkers(pendingLatestBody, pendingLatestRevision);
      const pendingFinal = await requestJson(
        `${management}/api/config/operations/${finalMutation}`, {}, currentFixture,
      );
      expect(pendingFinal.response.status).toBe(202);
      const pendingFinalBody = pendingFinal.body as OperationBody;
      expect(pendingFinalBody.operation).toMatchObject({
        mutation_id: finalMutation, committed_revision: finalRevision,
      });
      expect(pendingFinalBody.operation?.state).not.toBe('superseded');
      expectUnstartedWorkers(pendingFinalBody, finalRevision);
      expect(cohortHits).toHaveLength(0);
      expect(await exactWorkerCount(restarted, initHits.map((hit) => hit.marker))).toBe(2);

      cleanupHeld.resolve();
      const supersededB = await waitForOperation(management, mutationB, ['superseded'], currentFixture);
      expect(supersededB.operation).toMatchObject({ mutation_id: mutationB, committed_revision: revisionB, state: 'superseded' });
      await waitForWorkersExited(restarted, initHits.map((hit) => hit.marker),
        'cancelled candidates did not exit after their cleanup gate was released');
      const supersededPending = await waitForOperation(management, pendingLatestMutation, ['superseded'], currentFixture);
      expect(supersededPending.operation).toMatchObject({
        mutation_id: pendingLatestMutation, committed_revision: pendingLatestRevision, state: 'superseded',
      });
      expectUnstartedWorkers(supersededPending, pendingLatestRevision);

      const convergedFinal = await waitForOperation(management, finalMutation, ['converged'], currentFixture);
      expect(convergedFinal.operation).toMatchObject({ mutation_id: finalMutation, committed_revision: finalRevision, state: 'converged' });
      expectStartedWorkers(convergedFinal, finalRevision);
      const finalWorkers = await waitForServing(management, finalRevision, restarted, currentFixture);
      await recordOwnedWorkers(restarted, finalWorkers);
      const finalIds = finalWorkers.map((worker) => worker.worker_instance_id);
      expect(cohortHits).toHaveLength(2);
      expect(cohortStartedBeforeCandidateProof).toBe(false);
      expectDisjoint(finalIds, initHits.map((hit) => hit.marker));
      expectDisjoint(finalIds, baselineIds);
      expect(await probe(proxy, currentFixture)).toBe('D');
      await waitForWorkersExited(restarted, baselineIds,
        'the pre-crash serving cohort did not exit after the latest cohort became serving');
      const stillSupersededPending = await requestJson(
        `${management}/api/config/operations/${pendingLatestMutation}`, {}, currentFixture,
      );
      expect(stillSupersededPending.response.status).toBe(409);
      expectUnstartedWorkers(stillSupersededPending.body as OperationBody, pendingLatestRevision);

      const finalSnapshot = await snapshot(management, currentFixture);
      expect(finalSnapshot.revision).toBe(finalRevision);
      expect(finalWorkers.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await exactWorkerCount(restarted, finalIds)).toBe(2);
    } catch (error) {
      testFailed = true;
      const activeMaster = master ?? restartedMaster ?? oldMaster;
      const diagnostics = (await activeMaster.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      gateFailure = new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; gates=${JSON.stringify({
        init: initHits.map((hit) => hit.marker), cleanup: cleanupHits.map((hit) => hit.marker),
        cohort: cohortHits.map((hit) => hit.marker),
      })}; master exit=${activeMaster.child.exitCode ?? activeMaster.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
      throw gateFailure;
    } finally {
      initHeld.resolve();
      cleanupHeld.resolve();
      const stopped = await Promise.allSettled([initGate?.stop(true), cleanupGate?.stop(true), cohortGate?.stop(true)]);
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        testFailed = true;
        throw new AggregateError([
          ...(gateFailure === undefined ? [] : [gateFailure]),
          ...failures.map(result => safeGatewayError(result.reason, currentFixture)),
        ], 'candidate crash gates shutdown failed');
      }
    }
  }, 150_000);

  test('a rejected candidate settles degraded after exact cleanup and a corrected target serves', async () => {
    if (fixture === undefined || lease === undefined || master === undefined
      || upstreamA?.port === undefined || upstreamB?.port === undefined || upstreamD?.port === undefined) {
      testFailed = true;
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const firstMaster = master;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const failureRelease = Promise.withResolvers<void>();
    const initHits: GateHit[] = [];
    const cleanupHits: GateHit[] = [];
    let initGate: ReturnType<typeof Bun.serve> | undefined;
    let cleanupGate: ReturnType<typeof Bun.serve> | undefined;
    let passGate: ReturnType<typeof Bun.serve> | undefined;
    let gateFailure: Error | undefined;

    try {
      const initial = await snapshot(management, currentFixture);
      const baselineMutation = randomUUID();
      await commit(management, initial.revision, baselineMutation, aggregate(upstreamA.port!), currentFixture);
      const baselineRevision = initial.revision + 1;
      const baselineOperation = await waitForOperation(management, baselineMutation, ['converged'], currentFixture);
      expect(baselineOperation.operation).toMatchObject({ committed_revision: baselineRevision, state: 'converged' });
      const baselineWorkers = await waitForServing(management, baselineRevision, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, baselineWorkers);
      const baselineIds = baselineWorkers.map((worker) => worker.worker_instance_id);
      const baselineSnapshot = await snapshot(management, currentFixture);
      expect(await probe(proxy, currentFixture)).toBe('A');

      initGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          initHits.push(await readGateHit(request));
          await failureRelease.promise;
          return new Response('candidate gate rejected worker initialization', { status: 500 });
        },
      });
      cleanupGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          cleanupHits.push(await readGateHit(request));
          return new Response('cleaned');
        },
      });
      passGate = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          await request.body?.cancel();
          return new Response('ready');
        },
      });
      if (initGate.port === undefined || cleanupGate.port === undefined || passGate.port === undefined) {
        throw new Error('candidate failure gates did not bind');
      }

      const mutationB = randomUUID();
      await commit(management, baselineRevision, mutationB,
        aggregate(upstreamB.port!, undefined,
          `http://127.0.0.1:${initGate.port}/gate`,
          `http://127.0.0.1:${cleanupGate.port}/cleanup`), currentFixture);
      const revisionB = baselineRevision + 1;

      // Event-gated peak in a normal update: both A workers still serve while both B
      // candidates are alive inside init, before the gate rejects them.
      await waitUntil(() => initHits.length >= 2, 'two rejected candidates did not enter their init gate', 20_000);
      expect(initHits).toHaveLength(2);
      for (const hit of initHits) {
        firstMaster.workers.set(hit.marker, { pid: hit.pid, workerInstanceId: hit.marker, identity: hit.identity });
      }
      expect(await exactWorkerCount(firstMaster, baselineIds)).toBe(2);
      expect(await exactWorkerCount(firstMaster, initHits.map((hit) => hit.marker))).toBe(2);
      expect(await probe(proxy, currentFixture)).toBe('A');

      failureRelease.resolve();

      let failedOperation: OperationBody | undefined;
      await waitUntil(async () => {
        const result = await requestJson(`${management}/api/config/operations/${mutationB}`, {}, currentFixture);
        if (result.response.status !== 202) {
          throw new Error(`failed operation returned ${result.response.status}: ${result.text}`);
        }
        failedOperation = result.body as OperationBody;
        return failedOperation.operation?.state === 'degraded';
      }, 'rejected candidate did not settle degraded', 30_000);
      if (failedOperation === undefined) throw new Error('failed operation was not observed');
      expect(failedOperation.operation).toMatchObject({
        mutation_id: mutationB, expected_revision: baselineRevision, committed_revision: revisionB,
        state: 'degraded', result_status: 202, error_code: 'replacement_convergence_failed',
      });
      expect(failedOperation.workers).toHaveLength(2);
      expect(failedOperation.workers?.every((worker) => worker.mutation_id === mutationB
        && worker.target_revision === revisionB && worker.state === 'failed'
        && worker.applied_revision === null && (worker.attempt_no ?? 0) > 0)).toBe(true);

      // Degraded is only durable because both rejected candidates exited and their
      // managed cleanup ran; an unknown outcome would have stayed non-terminal.
      expect(cleanupHits.map((hit) => hit.marker).sort()).toEqual(initHits.map((hit) => hit.marker).sort());
      await waitForWorkersExited(firstMaster, initHits.map((hit) => hit.marker),
        'rejected candidate workers did not exit after their cleanup gate ran');
      expect(await exactWorkerCount(firstMaster, initHits.map((hit) => hit.marker))).toBe(0);

      const failedSnapshot = await snapshot(management, currentFixture);
      expect(failedSnapshot.revision).toBe(revisionB);
      expect(failedSnapshot.content_hash).not.toBe(baselineSnapshot.content_hash);
      const failedRuntime = await runtime(management, currentFixture);
      expect(failedRuntime.revision).toBe(revisionB);
      expect(failedRuntime.publication).toMatchObject({ serving_complete: false, serving_revision: baselineRevision });
      expect(failedRuntime.workers?.map((worker) => worker.worker_instance_id).sort())
        .toEqual([...baselineIds].sort());
      expect(await probe(proxy, currentFixture)).toBe('A');
      expect(await exactWorkerCount(firstMaster, baselineIds)).toBe(2);

      const mutationC = randomUUID();
      await commit(management, revisionB, mutationC,
        aggregate(upstreamD.port!, undefined, `http://127.0.0.1:${passGate.port}/gate`), currentFixture);
      const revisionC = revisionB + 1;
      const convergedC = await waitForOperation(management, mutationC, ['converged'], currentFixture);
      expect(convergedC.operation).toMatchObject({
        mutation_id: mutationC, expected_revision: revisionB, committed_revision: revisionC, state: 'converged',
      });
      expectStartedWorkers(convergedC, revisionC);
      const workersC = await waitForServing(management, revisionC, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersC);
      const workerIdsC = workersC.map((worker) => worker.worker_instance_id);
      expectDisjoint(workerIdsC, baselineIds);
      expectDisjoint(workerIdsC, initHits.map((hit) => hit.marker));
      const finalSnapshot = await snapshot(management, currentFixture);
      expect(finalSnapshot.revision).toBe(revisionC);
      expect(workersC.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await probe(proxy, currentFixture)).toBe('D');
      await waitForWorkersExited(firstMaster, baselineIds,
        'old workers did not exit after the corrected target became serving');
      expect(await exactWorkerCount(firstMaster, workerIdsC)).toBe(2);

      // C's revision must not rewrite B's terminal history.
      const retainedB = await requestJson(`${management}/api/config/operations/${mutationB}`, {}, currentFixture);
      expect(retainedB.response.status).toBe(202);
      const retained = retainedB.body as OperationBody;
      expect(retained.operation).toMatchObject({
        mutation_id: mutationB, expected_revision: baselineRevision, committed_revision: revisionB,
        state: 'degraded', result_status: 202, error_code: 'replacement_convergence_failed',
      });
      expect(retained.operation?.error_detail).toBe(failedOperation.operation?.error_detail);
      expect(retained.workers).toEqual(failedOperation.workers);
    } catch (error) {
      testFailed = true;
      const diagnostics = (await firstMaster.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      gateFailure = new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; gates=${JSON.stringify({
        init: initHits.map((hit) => hit.marker), cleanup: cleanupHits.map((hit) => hit.marker),
      })}; master exit=${firstMaster.child.exitCode ?? firstMaster.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
      throw gateFailure;
    } finally {
      failureRelease.resolve();
      const stopped = await Promise.allSettled([initGate?.stop(true), cleanupGate?.stop(true), passGate?.stop(true)]);
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        testFailed = true;
        throw new AggregateError([
          ...(gateFailure === undefined ? [] : [gateFailure]),
          ...failures.map(result => safeGatewayError(result.reason, currentFixture)),
        ], 'candidate failure gates shutdown failed');
      }
    }
  }, 180_000);

  test('master SIGKILL while the serving cohort drains resumes the persisted latest target after the held stream ends', async () => {
    if (fixture === undefined || lease === undefined || master === undefined
      || upstreamB?.port === undefined || upstreamD?.port === undefined) {
      testFailed = true;
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const firstMaster = master;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const released = Promise.withResolvers<void>();
    const streamAbort = new AbortController();
    let heldUpstream: ReturnType<typeof Bun.serve> | undefined;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let restartedMaster: OwnedMaster | undefined;
    let retirementDb: Database | undefined;

    try {
      // A dedicated held target: the shared fixture stream gate is already released by
      // the continuous-save case, so this case owns the long stream it crashes under.
      heldUpstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/probe') return new Response('A', { headers: { 'content-type': 'text/plain' } });
          if (path !== '/stream') return new Response('fixture not found', { status: 404 });
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('first\n'));
              void released.promise.then(() => {
                try {
                  controller.enqueue(encoder.encode('last\n'));
                  controller.close();
                } catch {
                  // The client cancelled or the test already failed.
                }
              });
            },
          }), { headers: { 'content-type': 'text/plain' } });
        },
      });
      if (heldUpstream.port === undefined) throw new Error('held stream upstream did not bind');

      const initial = await snapshot(management, currentFixture);
      const mutationA = randomUUID();
      await commit(management, initial.revision, mutationA, aggregate(heldUpstream.port), currentFixture);
      const revisionA = initial.revision + 1;
      const operationA = await waitForOperation(management, mutationA, ['converged'], currentFixture);
      expect(operationA.operation).toMatchObject({
        mutation_id: mutationA, expected_revision: initial.revision, committed_revision: revisionA, state: 'converged',
      });
      const workersA = await waitForServing(management, revisionA, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersA);
      const workerIdsA = workersA.map((worker) => worker.worker_instance_id);
      expect(await probe(proxy, currentFixture)).toBe('A');

      const streamResponse = await fetch(`${proxy}/stream`, {
        signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(120_000)]),
      });
      expect(streamResponse.status).toBe(200);
      if (streamResponse.body === null) throw new Error('stream response body is missing');
      streamReader = streamResponse.body.getReader();
      const firstChunk = await readBounded(streamReader, 10_000);
      if (firstChunk.done || firstChunk.value === undefined) throw new Error('stream ended before its first chunk');
      expect(new TextDecoder().decode(firstChunk.value)).toContain('first');

      // B admits and serves while A is still held, then enters draining. Crash only
      // after serving is proven, never on operation.draining alone.
      const mutationB = randomUUID();
      await commit(management, revisionA, mutationB, aggregate(upstreamB.port!), currentFixture);
      const revisionB = revisionA + 1;
      const workersB = await waitForServing(management, revisionB, firstMaster, currentFixture);
      await recordOwnedWorkers(firstMaster, workersB);
      const workerIdsB = workersB.map((worker) => worker.worker_instance_id);
      expectDisjoint(workerIdsB, workerIdsA);
      const operationB = await waitForOperation(management, mutationB, ['draining'], currentFixture);
      expect(operationB.operation).toMatchObject({
        mutation_id: mutationB, expected_revision: revisionA, committed_revision: revisionB, state: 'draining',
      });
      expectStartedWorkers(operationB, revisionB);
      expect(await probe(proxy, currentFixture)).toBe('B');
      await waitUntil(async () => await exactWorkerCount(firstMaster, workerIdsA) > 0,
        'the old streaming generation exited before the held request was released', 10_000);

      const mutationC = randomUUID();
      await commit(management, revisionB, mutationC, aggregate(upstreamB.port!, 'debug'), currentFixture);
      const revisionC = revisionB + 1;
      const mutationD = randomUUID();
      await commit(management, revisionC, mutationD, aggregate(upstreamD.port!), currentFixture);
      const revisionD = revisionC + 1;
      const [operationC, operationD] = await Promise.all([
        waitForOperation(management, mutationC, ['pending'], currentFixture),
        waitForOperation(management, mutationD, ['pending'], currentFixture),
      ]);
      expectUnstartedWorkers(operationC, revisionC);
      expectUnstartedWorkers(operationD, revisionD);
      expect(operationC.operation).toMatchObject({ expected_revision: revisionB, committed_revision: revisionC, state: 'pending' });
      expect(operationD.operation).toMatchObject({ expected_revision: revisionC, committed_revision: revisionD, state: 'pending' });
      expect((await snapshot(management, currentFixture)).revision).toBe(revisionD);
      expect(await probe(proxy, currentFixture)).toBe('B');

      const inheritedIngress = firstMaster.ingress;
      if (inheritedIngress?.identity === undefined) throw new Error('owned ingress identity is unavailable before the crash');
      expect(await probeProcessIdentity(inheritedIngress.identity)).toBe('exact');

      const crashStartedAt = Date.now();
      firstMaster.child.kill('SIGKILL');
      await waitUntil(() => firstMaster.child.exitCode !== null || firstMaster.child.signalCode !== null,
        'old master did not exit after SIGKILL', 10_000);
      expect(firstMaster.child.exitCode !== null || firstMaster.child.signalCode !== null).toBe(true);
      expect(await exactWorkerCount(firstMaster, workerIdsA)).toBeGreaterThan(0);
      expect(await exactWorkerCount(firstMaster, workerIdsB)).toBe(2);

      master = undefined;
      const restarted = await startMaster(currentFixture, currentLease);
      restartedMaster = restarted;
      master = restarted;
      restarted.ingress = inheritedIngress;
      // Inherit the pre-crash cohorts before health: a health failure must still
      // leave the surviving old A/B processes owned by the fixture for cleanup.
      for (const workerId of [...workerIdsA, ...workerIdsB]) {
        const owned = firstMaster.workers.get(workerId);
        if (owned?.identity === undefined) throw new Error(`worker identity ${workerId} was not captured`);
        restarted.workers.set(workerId, { pid: owned.pid, workerInstanceId: workerId, identity: owned.identity });
      }
      // Health only proves live+management; serving_revision=null is a legal
      // conservative state during recovery and is deliberately not asserted.
      await waitForHealth(restarted, currentLease.base, currentFixture);

      if (restarted.ingress === undefined || restarted.ingress.identity === undefined) {
        throw new Error('restarted master did not reuse the owned ingress identity');
      }
      expect(restarted.ingress.workerInstanceId).toBe(inheritedIngress.workerInstanceId);
      expect(await probeProcessIdentity(restarted.ingress.identity)).toBe('exact');

      expect((await snapshot(management, currentFixture)).revision).toBe(revisionD);
      expect(await probe(proxy, currentFixture)).toBe('B');
      expect(await exactWorkerCount(restarted, workerIdsA)).toBeGreaterThan(0);
      expect(await exactWorkerCount(restarted, workerIdsB)).toBe(2);
      const heldLatest = await requestJson(`${management}/api/config/operations/${mutationD}`, {}, currentFixture);
      expect(heldLatest.response.status).toBe(202);
      const heldLatestBody = heldLatest.body as OperationBody;
      expect(heldLatestBody.operation).toMatchObject({
        mutation_id: mutationD, committed_revision: revisionD, state: 'pending',
      });
      expectUnstartedWorkers(heldLatestBody, revisionD);
      const heldMiddle = await requestJson(`${management}/api/config/operations/${mutationC}`, {}, currentFixture);
      expect([202, 409]).toContain(heldMiddle.response.status);
      const heldMiddleBody = heldMiddle.body as OperationBody;
      expect(heldMiddleBody.operation?.committed_revision).toBe(revisionC);
      expect(heldMiddleBody.operation?.state).toMatch(/^(pending|superseded)$/);
      expectUnstartedWorkers(heldMiddleBody, revisionC);
      const heldB = await requestJson(`${management}/api/config/operations/${mutationB}`, {}, currentFixture);
      expect(heldB.response.status).toBe(202);
      expect((heldB.body as OperationBody).operation).toMatchObject({
        mutation_id: mutationB, committed_revision: revisionB, state: 'draining',
      });

      // Wait for post-restart recovery to stop on the held A member, so completion
      // requires a later observation; the other A member may already have exited.
      retirementDb = new Database(currentFixture.configDbPath, { readonly: true });
      retirementDb.exec('PRAGMA busy_timeout = 5000');
      await waitUntil(() => {
        const retirement = retirementDb!.query(
          'SELECT state, reason_code, updated_at FROM configuration_retirements WHERE mutation_id = ?',
        ).get(mutationB) as { state: string; reason_code: string | null; updated_at: number } | null;
        if (retirement?.state !== 'stopped' || retirement.reason_code !== 'exit_unknown'
          || retirement.updated_at < crashStartedAt) return false;
        const evidence = retirementDb!.query(
          'SELECT member_id, exit_state, cleanup_state FROM configuration_retirement_evidence WHERE mutation_id = ?',
        ).all(mutationB) as Array<{ member_id: string; exit_state: string; cleanup_state: string }>;
        const oldA = evidence.filter((row) => workerIdsA.includes(row.member_id));
        return oldA.length === workerIdsA.length
          && oldA.some((row) => row.exit_state === 'live' && row.cleanup_state === 'unknown');
      }, `retirement for ${mutationB} did not stop with an unproven old-A exit`, 30_000);
      expect(await exactWorkerCount(restarted, workerIdsA)).toBeGreaterThan(0);
      const stillPendingD = await requestJson(`${management}/api/config/operations/${mutationD}`, {}, currentFixture);
      expect(stillPendingD.response.status).toBe(202);
      expect((stillPendingD.body as OperationBody).operation).toMatchObject({
        mutation_id: mutationD, committed_revision: revisionD, state: 'pending',
      });
      expectUnstartedWorkers(stillPendingD.body as OperationBody, revisionD);

      released.resolve();
      const tail = await readRemaining(streamReader, 20_000);
      expect(tail).toContain('last');
      streamReader = undefined;

      await waitForWorkersExited(restarted, workerIdsA,
        'old A worker processes did not exit after the held request completed');
      expect(await exactWorkerCount(restarted, workerIdsA)).toBe(0);
      // Recovering a draining publication always terminalizes as degraded with real
      // old-worker exit proof; it is not a normal convergence.
      const drainedB = await waitForOperation(management, mutationB, ['degraded'], currentFixture);
      expect(drainedB.operation).toMatchObject({
        mutation_id: mutationB, expected_revision: revisionA, committed_revision: revisionB,
        state: 'degraded', result_status: 202, error_code: 'old_worker_drain_failed',
      });

      const supersededC = await waitForOperation(management, mutationC, ['superseded'], currentFixture);
      expect(supersededC.operation?.committed_revision).toBe(revisionC);
      expectUnstartedWorkers(supersededC, revisionC);

      const convergedD = await waitForOperation(management, mutationD, ['converged'], currentFixture);
      expect(convergedD.operation).toMatchObject({ mutation_id: mutationD, committed_revision: revisionD, state: 'converged' });
      expectStartedWorkers(convergedD, revisionD);
      const workersD = await waitForServing(management, revisionD, restarted, currentFixture);
      await recordOwnedWorkers(restarted, workersD);
      const workerIdsD = workersD.map((worker) => worker.worker_instance_id);
      expectDisjoint(workerIdsD, workerIdsA);
      expectDisjoint(workerIdsD, workerIdsB);
      const finalSnapshot = await snapshot(management, currentFixture);
      expect(finalSnapshot.revision).toBe(revisionD);
      expect(finalSnapshot.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(workersD.every((worker) => worker.content_hash === finalSnapshot.content_hash)).toBe(true);
      expect(await probe(proxy, currentFixture)).toBe('D');
      await waitForWorkersExited(restarted, workerIdsB,
        'old B worker processes did not exit after D became serving');
      expect(await exactWorkerCount(restarted, workerIdsB)).toBe(0);
      expect(await exactWorkerCount(restarted, workerIdsD)).toBe(2);
    } catch (error) {
      testFailed = true;
      const activeMaster = master ?? restartedMaster ?? firstMaster;
      const diagnostics = (await activeMaster.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      throw new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${activeMaster.child.exitCode ?? activeMaster.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
    } finally {
      released.resolve();
      retirementDb?.close();
      streamAbort.abort();
      if (streamReader !== undefined) await streamReader.cancel().catch(() => undefined);
      try {
        await heldUpstream?.stop(true);
      } catch (error) {
        testFailed = true;
        throw error;
      }
    }
  }, 150_000);
});
