import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { SQLitePluginStorage } from '../packages/core/src/plugin-storage';
import { PRICE_CACHE_KEY, PRICE_SETTINGS_KEY, PRICE_STATUS_KEY } from '../plugins/token-stats/server/price-catalog';
import {
  cleanupGatewayFixture,
  createGatewayFixture,
  quarantinePortBlock,
  recordOwnedWorkers,
  releasePortBlock,
  requestJson,
  reservePortBlock,
  scrub,
  safeGatewayError,
  startTrackedGatewayMaster,
  stopOwnedMaster,
  waitForHealth,
  waitUntil,
  type GatewayFixture,
  type OwnedMaster,
  type GatewayMasterStartupState,
  type PortLease,
} from './support/token-stats-gateway';
import { ensureTestPortBlockClosed } from './support/test-port-block-broker';

const TOKEN_STATS_ACTIVATION = { plugin_name: 'token-stats' };
const ROUTE_ID = '30000000-0000-4000-8000-000000000001';
const UPSTREAM_ID = '20000000-0000-4000-8000-000000000001';
const SERVICE_ID = '10000000-0000-4000-8000-000000000001';

type Stats = {
  groupBy: string;
  bucketMs?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  officialInputTokens: number;
  officialOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  logicalRequests: number;
  upstreamAttempts: number;
  estimatedCostUsd: number | null;
  data: Array<Record<string, unknown>>;
};

describe('Token Stats gateway real-process integration (local HTTP fixture)', () => {
  let fixture: GatewayFixture | undefined;
  let lease: PortLease | undefined;
  let master: OwnedMaster | undefined;
  const masterStartup: GatewayMasterStartupState = { attempted: false, errors: [] };
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let upstreamCalls = 0;
  let fixtureMode: 'success' | 'retry-once' = 'success';
  const fixtureRequests: Array<{ method: string; path: string; body: unknown }> = [];

  async function startGatewayMaster(currentFixture: GatewayFixture, currentLease: PortLease): Promise<OwnedMaster> {
    try {
      master = await startTrackedGatewayMaster(masterStartup, currentFixture, currentLease);
      return master;
    } catch (error) {
      master = masterStartup.master;
      throw error;
    }
  }

  beforeAll(async () => {
    fixture = await createGatewayFixture();
    lease = await reservePortBlock();
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/ordinary') {
          return Response.json({ input: 'search', choices: ['A', 'B'], usage: { prompt_tokens: 1000, completion_tokens: 1000 } });
        }
        if (new URL(request.url).pathname !== '/v1/chat/completions' || request.method !== 'POST') {
          return Response.json({ error: 'fixture_not_found' }, { status: 404 });
        }
        const requestBody = await request.json();
        upstreamCalls++;
        fixtureRequests.push({ method: request.method, path: new URL(request.url).pathname, body: requestBody });
        if (fixtureMode === 'retry-once' && upstreamCalls === 2) {
          return Response.json({
            id: 'fixture-429', object: 'chat.completion', model: 'gpt-4o-mini',
            choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }, { status: 429, headers: { 'content-type': 'application/json' } });
        }
        return Response.json({
          id: `fixture-${upstreamCalls}`, object: 'chat.completion', model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 17, completion_tokens: 7, total_tokens: 24,
            prompt_tokens_details: { cached_tokens: 5 },
          },
        }, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    if (upstream.port === undefined) throw new Error('local protocol fixture did not bind');
    master = await startGatewayMaster(fixture, lease);
    await waitForHealth(master, lease.base);
  }, 90_000);

  afterAll(async () => {
    const evidenceFixture = fixture;
    const cleanupErrors: unknown[] = [...masterStartup.errors];
    let shutdownVerified = false;
    if (master !== undefined) {
      try {
        await stopOwnedMaster(master);
        shutdownVerified = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let upstreamClosed = !masterStartup.attempted;
    try {
      if (upstream !== undefined) {
        await upstream.stop(true);
        upstreamClosed = true;
      }
    } catch (error) { cleanupErrors.push(error); }
    upstream = undefined;
    let leaseReleased = !masterStartup.attempted;
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
    const portsVerifiedClosed = !masterStartup.attempted || (upstreamClosed && leaseReleased);
    if (fixture !== undefined) {
      try {
        const removed = await cleanupGatewayFixture(fixture, {
          startupAttempted: masterStartup.attempted,
          master,
          shutdownVerified,
          portsVerifiedClosed,
        });
        if (!removed) cleanupErrors.push(new Error(`startup, process ownership, or port closure is unverified; preserving fixture and logs at ${fixture.root}`));
      } catch (error) { cleanupErrors.push(error); }
      fixture = undefined;
    }
    if (cleanupErrors.length) {
      const summaries = cleanupErrors.map((error) => evidenceFixture === undefined
        ? error instanceof Error ? error.message : 'unknown cleanup error'
        : safeGatewayError(error, evidenceFixture, 4_096));
      throw new Error(`gateway startup/cleanup failures: ${summaries.join('\n').slice(-24_576)}`);
    }
  }, 45_000);

  test('activation alone observes all routes, ignores ordinary APIs, and persists retry attempts across restart', async () => {
    if (fixture === undefined || lease === undefined || upstream?.port === undefined || master === undefined) {
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const upstreamPort = upstream.port;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;
    const authHeaders = { authorization: `Bearer ${currentFixture.token}` };

    const initial = await requestJson(`${management}/api/config`, { headers: authHeaders }, currentFixture);
    expect(initial.response.status).toBe(200);
    const initialSnapshot = initial.body as { revision: number };
    expect(Number.isSafeInteger(initialSnapshot.revision)).toBe(true);
    expect(initialSnapshot.revision).toBeGreaterThan(0);

    // Persist prices through a separate connection, as the control owner does.
    // Both workers must observe later updates without process-local stale KV reads.
    const writePrices = async (multiplier: number) => {
      const db = new Database(currentFixture.accessDbPath);
      try {
        const storage = new SQLitePluginStorage(db, 'token-stats');
        const fetchedAt = Date.now();
        await storage.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
        await storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt, catalog: { openai: { id: 'openai', models: {
          'gpt-4o-mini': { id: 'gpt-4o-mini', cost: { input: multiplier, output: 2 * multiplier, cache_read: 0.1 * multiplier } },
        } } } });
        await storage.set(PRICE_STATUS_KEY, { lastSuccessAt: fetchedAt });
      } finally { db.close(); }
    };
    await writePrices(1);

    const aggregate = {
      plugin_activations: [TOKEN_STATS_ACTIVATION],
      logical_configuration: {
        auth: { enabled: true, tokens: [currentFixture.token] },
        plugins: [],
        services: [{
          id: SERVICE_ID, position: 1, name: 'token-stats-test-service', plugins: [],
          endpoints: [{
            id: UPSTREAM_ID, position: 1, target: `http://127.0.0.1:${upstreamPort}`,
            weight: 100, priority: 1, is_disabled: false, plugins: [],
          }],
        }],
        routes: [{
          id: ROUTE_ID, position: 1, path: '/v1/chat/completions', service_id: SERVICE_ID,
          auth: { enabled: false, tokens: [] }, plugins: [],
          retry: { enabled: true, max_retries: 1, retry_on: [429] },
        }, {
          id: '30000000-0000-4000-8000-000000000002', position: 2, path: '/ordinary', service_id: SERVICE_ID,
          auth: { enabled: false, tokens: [] }, plugins: [],
        }],
      },
    };
    const mutationId = randomUUID();
    const commit = await requestJson(`${management}/api/config`, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'x-bungee-next-authorization': `Bearer ${currentFixture.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_revision: initialSnapshot.revision, mutation_id: mutationId, aggregate }),
    }, currentFixture);
    expect(commit.response.status).toBe(202);
    await waitForOperation(management, mutationId, currentFixture);
    const firstWorkers = await waitForWorkers(management, initialSnapshot.revision + 1, currentFixture);
    await recordOwnedWorkers(master, firstWorkers);
    expect(firstWorkers).toHaveLength(2);

    expect(await getStats(management, 'model', currentFixture)).toMatchObject({
      totalInputTokens: 0, totalOutputTokens: 0, logicalRequests: 0, upstreamAttempts: 0,
    });
    const ordinary = await requestJson(`${proxy}/ordinary`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'search' }),
    }, currentFixture);
    expect(ordinary.response.status).toBe(200);
    await postChat(proxy, currentFixture);
    expect(upstreamCalls).toBe(1);
    assertFixtureReceived(fixtureRequests, 1);
    await assertStats(management, currentFixture, { input: 17, output: 7, cache: 5, logical: 1, attempts: 1 });
    await assertGrouped(management, currentFixture, { input: 17, output: 7, logical: 1, attempts: 1 });
    expect((await getStats(management, 'model', currentFixture)).estimatedCostUsd).toBeCloseTo(0.0000265, 9);
    await writePrices(10);

    const unauthorized = await requestJson(
      `${management}/api/plugins/token-stats/control/stats?range=1h&groupBy=model`,
      { headers: { authorization: 'Bearer intentionally-wrong-token' } }, currentFixture,
    );
    expect(unauthorized.response.status).toBe(401);

    fixtureMode = 'retry-once';
    await postChat(proxy, currentFixture);
    expect(upstreamCalls).toBe(3);
    assertFixtureReceived(fixtureRequests, 3);
    fixtureMode = 'success';
    await assertStats(management, currentFixture, { input: 36, output: 15, cache: 10, logical: 2, attempts: 3 });

    // Identical request bodies remain separate logical gateway requests (not deduplicated).
    const costBefore = (await getStats(management, 'model', currentFixture)).estimatedCostUsd;
    await postChat(proxy, currentFixture);
    expect(upstreamCalls).toBe(4);
    assertFixtureReceived(fixtureRequests, 4);
    await assertStats(management, currentFixture, { input: 53, output: 22, cache: 15, logical: 3, attempts: 4 });
    const costAfter = (await getStats(management, 'model', currentFixture)).estimatedCostUsd;
    expect(costBefore).not.toBeNull();
    expect(costAfter).not.toBeNull();
    expect(costAfter! - costBefore!).toBeCloseTo(0.000265, 9);

    const oldWorkerPids = firstWorkers.map((worker) => worker.pid);
    await stopOwnedMaster(master);
    master = undefined;
    await waitUntil(async () => oldWorkerPids.every((pid) => !isPidAlive(pid)), 'old serving workers did not exit', 15_000);
    await ensureTestPortBlockClosed(currentLease.block);

    master = await startGatewayMaster(currentFixture, currentLease);
    await waitForHealth(master, currentLease.base);
    const afterRestart = await waitForWorkers(management, initialSnapshot.revision + 1, currentFixture);
    expect(afterRestart).toHaveLength(2);
    await recordOwnedWorkers(master, afterRestart);
    expect(afterRestart.map((worker) => worker.worker_instance_id)).not.toEqual(firstWorkers.map((worker) => worker.worker_instance_id));
    await assertStats(management, currentFixture, { input: 53, output: 22, cache: 15, logical: 3, attempts: 4 });

    await postChat(proxy, currentFixture);
    expect(upstreamCalls).toBe(5);
    assertFixtureReceived(fixtureRequests, 5);
    await assertStats(management, currentFixture, { input: 70, output: 29, cache: 20, logical: 4, attempts: 5 });
  }, 120_000);
});

async function waitForOperation(portBaseUrl: string, mutationId: string, fixture: GatewayFixture): Promise<void> {
  await waitUntil(async () => {
    const result = await requestJson(`${portBaseUrl}/api/config/operations/${mutationId}`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    }, fixture);
    const body = result.body as { operation?: { state?: string } };
    if (body.operation?.state === 'degraded' || body.operation?.state === 'failed') {
      throw new Error(`config operation ${body.operation.state}: ${scrub(result.text, fixture)}`);
    }
    return result.response.status === 200 && body.operation?.state === 'converged';
  }, `configuration mutation ${mutationId} did not converge`, 30_000);
}

type RuntimeWorker = { pid: number; worker_instance_id: string; boot_nonce: string };

async function waitForWorkers(portBaseUrl: string, expectedRevision: number, fixture: GatewayFixture): Promise<RuntimeWorker[]> {
  let workers: RuntimeWorker[] = [];
  await waitUntil(async () => {
    const result = await requestJson(`${portBaseUrl}/api/config/runtime`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    }, fixture);
    if (!result.response.ok) return false;
    const body = result.body as {
      revision?: number;
      workers?: RuntimeWorker[];
      publication?: { serving_complete?: boolean; serving_revision?: number | null };
    };
    workers = body.workers ?? [];
    return body.revision === expectedRevision && body.publication?.serving_complete === true
      && body.publication.serving_revision === expectedRevision && workers.length === 2
      && workers.every((worker) => Number.isSafeInteger(worker.pid)
        && typeof worker.worker_instance_id === 'string' && typeof worker.boot_nonce === 'string');
  }, `two workers did not serve revision ${expectedRevision}`, 30_000);
  return workers;
}

async function getStats(portBaseUrl: string, groupBy: string, fixture: GatewayFixture, timeoutMs = 5_000): Promise<Stats> {
  const result = await requestJson(
    `${portBaseUrl}/api/plugins/token-stats/control/stats?range=1h&groupBy=${groupBy}`,
    { headers: { authorization: `Bearer ${fixture.token}` }, signal: AbortSignal.timeout(timeoutMs) }, fixture,
  );
  if (!result.response.ok) throw new Error(`token-stats ${groupBy} query returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  return result.body as Stats;
}

async function assertStats(
  portBaseUrl: string,
  fixture: GatewayFixture,
  expected: { input: number; output: number; cache: number; logical: number; attempts: number },
): Promise<void> {
  // TokenLens startup pricing readiness is bounded at 4s; leave 2s for queued SQLite finalization.
  const deadline = Date.now() + 6_000;
  let last: Stats | undefined;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    last = await getStats(portBaseUrl, 'model', fixture, Math.min(500, remainingMs));
    const actual = [last.totalInputTokens, last.totalOutputTokens, last.officialInputTokens, last.officialOutputTokens,
      last.estimatedInputTokens, last.estimatedOutputTokens, last.cacheReadTokens, last.cacheWriteTokens,
      last.logicalRequests, last.upstreamAttempts];
    const target = [expected.input, expected.output, expected.input, expected.output, 0, 0,
      expected.cache, 0, expected.logical, expected.attempts];
    if (actual.some((value, index) => value > target[index]!)) {
      throw new Error(`token-stats exceeded expected totals immediately: actual=${actual.join('/')} expected=${target.join('/')}`);
    }
    if (actual.every((value, index) => value === target[index]!)) {
      expect(last).toMatchObject({
        groupBy: 'model', totalInputTokens: expected.input, totalOutputTokens: expected.output,
        officialInputTokens: expected.input, officialOutputTokens: expected.output,
        estimatedInputTokens: 0, estimatedOutputTokens: 0,
        cacheReadTokens: expected.cache, cacheWriteTokens: 0,
        logicalRequests: expected.logical, upstreamAttempts: expected.attempts,
      });
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`token-stats did not reach expected totals within 6s: last=${JSON.stringify(last)}`);
}

async function assertGrouped(
  portBaseUrl: string,
  fixture: GatewayFixture,
  expected: { input: number; output: number; logical: number; attempts: number },
): Promise<void> {
  const modelStats = await getStats(portBaseUrl, 'model', fixture);
  expect(modelStats).toMatchObject({
    groupBy: 'model', totalInputTokens: expected.input, totalOutputTokens: expected.output,
    officialInputTokens: expected.input, officialOutputTokens: expected.output,
    estimatedInputTokens: 0, estimatedOutputTokens: 0,
    logicalRequests: expected.logical, upstreamAttempts: expected.attempts,
  });
  expect(modelStats.data).toHaveLength(1);
  expect(modelStats.data[0]).toMatchObject({
    dimension: 'gpt-4o-mini', inputTokens: expected.input, outputTokens: expected.output,
    logicalRequests: expected.logical, upstreamAttempts: expected.attempts,
  });

  const timeStats = await getStats(portBaseUrl, 'time', fixture);
  expect(timeStats).toMatchObject({
    groupBy: 'time', bucketMs: 300_000, totalInputTokens: expected.input,
    totalOutputTokens: expected.output, logicalRequests: expected.logical, upstreamAttempts: expected.attempts,
  });
  expect(timeStats.data.length).toBeGreaterThan(0);
  expect(timeStats.data.every((row) => row.dimension === 'gpt-4o-mini'
    && Number.isSafeInteger(row.bucketStartMs) && Number(row.bucketStartMs) % 300_000 === 0)).toBe(true);
  expect(timeStats.data.reduce((sum, row) => sum + Number(row.upstreamAttempts), 0)).toBe(expected.attempts);
  expect(timeStats.data.reduce((sum, row) => sum + Number(row.inputTokens), 0)).toBe(expected.input);
  expect(timeStats.data.reduce((sum, row) => sum + Number(row.outputTokens), 0)).toBe(expected.output);
  expect(timeStats.data.map((row) => Number(row.bucketStartMs)))
    .toEqual([...timeStats.data.map((row) => Number(row.bucketStartMs))].sort((a, b) => a - b));
}

function assertFixtureReceived(requests: readonly { method: string; path: string; body: unknown }[], expectedCount: number): void {
  expect(requests).toHaveLength(expectedCount);
  for (const request of requests) {
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'local fixture request' }],
    });
  }
}

async function postChat(proxyBaseUrl: string, fixture: GatewayFixture): Promise<void> {
  const result = await requestJson(`${proxyBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'local fixture request' }] }),
  }, fixture);
  if (result.response.status !== 200) {
    throw new Error(`gateway POST returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  }
  expect(result.body).toMatchObject({ usage: { prompt_tokens: 17, completion_tokens: 7 } });
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
