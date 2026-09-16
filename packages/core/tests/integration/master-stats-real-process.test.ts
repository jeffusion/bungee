import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RepositorySnapshot } from '../../src/config-storage';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { handleManagementRequest } from '../../src/management-listener/listener';
import {
  childPids,
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
  expectPortClosed,
  freePort,
  isIngressProcess,
  pathExists,
  removeFixture,
  sourceMasterEntry,
  spawnMaster,
  runWithCleanup,
  waitForDead,
  waitForHealth,
  waitForWorkerPids,
  waitUntil,
} from '../fixtures/master-real-process-harness';
import {
  preserveMasterStatsFailure,
  STATS_TOKEN,
  statsAggregate,
  withAccessLogQuery,
} from '../fixtures/master-stats-real-process.fixture';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const AUTH = { authorization: `Bearer ${STATS_TOKEN}` };
const MUTATION_ID = '73000000-0000-4000-8000-000000000004';

test('real master owns SQL stats for authenticated management and UI alias requests', async () => {
  const fixture = await createMasterFixture('bungee-master-stats-');
  const port = await freePort(cleanupScope);
  const outcomes = [200, 503, 200];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('upstream', { status: outcomes.shift() ?? 200 }),
  });
  if (upstream.port === undefined) throw new Error('upstream did not expose a port');

  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port, 1);
  const evidence: Record<string, unknown> = {};
  let workerPids: readonly number[] = [];
  let ingressPids: readonly number[] = [];
  await runWithCleanup(async () => {
    try {
    await waitForHealth(port, master);
    expect(master.child.pid).toBeNumber();
    workerPids = await waitForWorkerPids(master.child.pid!, 1);
    await waitUntil(async () => {
      ingressPids = (await Promise.all((await childPids(master.child.pid!)).map(async (pid) =>
        await isIngressProcess(pid) ? pid : null))).filter((pid): pid is number => pid !== null);
      return ingressPids.length === 1;
    }, 'master did not expose an ingress process');
    expect(await pathExists(join(fixture.root, 'logs', 'access.db'))).toBeFalse();

    const publish = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: {
        ...AUTH,
        'x-bungee-next-authorization': `Bearer ${STATS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_revision: 1, aggregate: statsAggregate(upstream.port!), mutation_id: MUTATION_ID }),
    });
    evidence.publish = { status: publish.status, body: await publish.clone().json() };
    expect(publish.status).toBe(202);
    await waitUntil(async () => {
      const operation = await fetch(`http://127.0.0.1:${port}/api/config/operations/${MUTATION_ID}`, { headers: AUTH });
      evidence.operation = { status: operation.status, body: await operation.clone().json() };
      return operation.status === 200;
    }, 'configuration operation did not converge', 20_000);

    for (const status of [200, 503, 200]) {
      const response = await fetch(`http://127.0.0.1:${port + 1}/proxy`);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('upstream');
    }
    await waitUntil(async () => await withAccessLogQuery(fixture, async (logs) =>
      (await logs.getStats()).totalRequests === 3,
    ), 'public requests were not persisted as three access-log chains');

    for (const path of ['/api/stats', '/__ui/api/stats']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(401);
    }

    const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: AUTH });
    const snapshot = await snapshotResponse.json() as Record<string, number | string>;
    expect(snapshotResponse.status).toBe(200);
    const snapshotTime = Date.parse(snapshot.timestamp as string);
    const snapshotExpected = await withAccessLogQuery(fixture, async (logs) => {
      const bucketEnd = Math.floor(snapshotTime / 60_000) * 60_000;
      const stats = await logs.getStats();
      return {
        totalRequests: stats.totalRequests,
        requestsPerSecond: (await logs.getChainCount(bucketEnd - 60_000, bucketEnd)) / 60,
        successRate: (stats.successRequests / stats.totalRequests) * 100,
        averageResponseTime: stats.avgResponseTime,
      };
    });
    expect(snapshot).toMatchObject(snapshotExpected);

    const aliasResponse = await fetch(`http://127.0.0.1:${port}/__ui/api/stats`, { headers: AUTH });
    expect(aliasResponse.status).toBe(200);
    expect(await aliasResponse.json()).toMatchObject({ totalRequests: 3, successRate: 66.66666666666666 });

    const history = await (await fetch(`http://127.0.0.1:${port}/api/stats/history?interval=10s`, { headers: AUTH })).json() as {
      timestamps: string[]; requests: number[]; errors: number[]; responseTime: number[];
    };
    const historyEnd = Date.parse(history.timestamps.at(-1)!);
    const expectedHistory = await withAccessLogQuery(fixture, async (logs) =>
      await logs.getCumulativeHistory(historyEnd - 60 * 60 * 1000, historyEnd, '10s'),
    );
    expect(history).toEqual({
      timestamps: expectedHistory.map(({ timestamp }) => new Date(timestamp).toISOString()),
      requests: expectedHistory.map(({ requests }) => requests),
      errors: expectedHistory.map(({ errors }) => errors),
      responseTime: expectedHistory.map(({ responseTime }) => responseTime),
    });

    const historyV2 = await (await fetch(`http://127.0.0.1:${port}/api/stats/history/v2?range=1h`, { headers: AUTH })).json() as {
      timestamps: string[]; requests: number[]; errors: number[]; responseTime: number[]; successRate: number[];
    };
    const historyV2Start = Date.parse(historyV2.timestamps[0]!);
    const historyV2End = Date.parse(historyV2.timestamps.at(-1)!) + 60_000;
    const expectedHistoryV2 = await withAccessLogQuery(fixture, async (logs) =>
      await logs.getTimeSeriesStats(historyV2Start, historyV2End, 'minute'),
    );
    expect(historyV2).toEqual({
      timestamps: expectedHistoryV2.map(({ timestamp }) => new Date(timestamp).toISOString()),
      requests: expectedHistoryV2.map(({ totalRequests }) => totalRequests),
      errors: expectedHistoryV2.map(({ failedRequests }) => failedRequests),
      responseTime: expectedHistoryV2.map(({ avgResponseTime }) => Math.round(avgResponseTime)),
      successRate: expectedHistoryV2.map(({ totalRequests, successRequests }) => totalRequests === 0 ? 100
        : Math.round((successRequests / totalRequests) * 10_000) / 100),
    });

    const now = Date.now();
    const upstreamExpected = await withAccessLogQuery(fixture, async (logs) => ({
      distribution: await logs.getUpstreamDistribution(now - 60 * 60 * 1000, now),
      failures: await logs.getUpstreamFailureStats(now - 60 * 60 * 1000, now),
      all: await logs.getUnifiedUpstreamStats(now - 60 * 60 * 1000, now, 'all'),
      statusCodes: await logs.getUpstreamStatusCodeStats(now - 60 * 60 * 1000, now),
    }));
    expect(await (await fetch(`http://127.0.0.1:${port}/api/stats/upstream-distribution?range=1h`, { headers: AUTH })).json())
      .toEqual({ data: upstreamExpected.distribution, total: 3 });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/stats/upstream-failures?range=1h`, { headers: AUTH })).json())
      .toEqual({ data: upstreamExpected.failures });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/stats/upstream-stats?range=1h&type=all`, { headers: AUTH })).json())
      .toEqual({ data: upstreamExpected.all, type: 'all' });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/stats/upstream-status-codes?range=1h`, { headers: AUTH })).json())
      .toEqual({ data: upstreamExpected.statusCodes });
    expect(await pathExists(join(fixture.root, 'logs', 'access.db'))).toBeFalse();
    } catch (error) {
    await preserveMasterStatsFailure(master, evidence);
    throw error;
    }
  }, async () => {
    const settled = await Promise.allSettled([
      cleanupMaster(master, workerPids),
      waitForDead([master.child.pid!, ...workerPids, ...ingressPids]),
      expectPortClosed(port),
      expectPortClosed(port + 1),
      upstream.stop(true),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'master stats cleanup failed');
    await removeFixture(fixture);
  });
}, 45_000);

test('master control composition serves stats without forwarding to a worker', async () => {
  const snapshot = {
    revision: 1,
    content_hash: `sha256:${'a'.repeat(64)}`,
    aggregate: statsAggregate(1),
  } as unknown as RepositorySnapshot;
  let handled = 0;
  const controlApi = createConfigControlApi({
    repository: {
      getSnapshot: () => snapshot,
      getActivePublication: () => null,
      getOperationState: () => null,
      commit: () => { throw new Error('mutation is not part of this test'); },
    },
    admission: { snapshot: () => [] },
    workerCount: 1,
    clock: { now: () => 0 },
    resolveAuthToken: (token) => token,
    parseAggregate: () => ({ ok: false, errors: [] }),
    publicationTasks: { enqueue: () => undefined },
    isMutationReady: () => true,
    statsApi: {
      matches: (path) => path === '/api/stats',
      async handle() { handled += 1; return Response.json({ source: 'master' }); },
    },
  });

  const response = await handleManagementRequest(new Request('http://127.0.0.1/api/stats', { headers: AUTH }), {
    controlApi,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ source: 'master' });
  expect(handled).toBe(1);
});
