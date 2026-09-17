import { afterEach, expect, test } from 'bun:test';
import { connect as connectTcp } from 'node:net';
import * as http from 'node:http';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  childPids,
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
  createTestPhaseBudget,
  freePort,
  isIngressProcess,
  isWorkerProcess,
  processAlive,
  removeFixture,
  sourceMasterEntry,
  spawnMaster,
  runWithCleanup,
  waitForHealth,
  waitForWorkerPids,
  waitUntil,
  isRetryableOwnedSnapshotObservation,
  ownedSnapshotObservationEvidence,
} from '../fixtures/master-real-process-harness';
import type { WindowsOwnedSnapshotRetryEvidence } from '../fixtures/process-cleanup';
import { discoverIngressIdentity } from '../../src/ingress/supervision-http';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const INGRESS_RECOVERY_PHASES = ['health', 'initial_workers', 'initial_ingress', 'initial_publication', 'kill_old_ingress',
  'wait_old_ingress_dead', 'initial_traffic', 'replacement_tree', 'replacement_identity', 'replacement_workers', 'final_traffic',
  'final_tree', 'final_identity', 'final_workers', 'final_management_health', 'final_stats_headers', 'final_stats_body', 'final_master_output', 'cleanup'] as const;
type IngressRecoveryPhase = typeof INGRESS_RECOVERY_PHASES[number];
type ManagementTcpOutcome = 'open' | 'closed' | 'unknown';
type ManagementResponseResult = {
  status: number;
  body: string;
};
type RecoveryDebug = {
  management_tcp_outcome: ManagementTcpOutcome;
  management_health_headers_received: boolean;
  management_health_status: number | null;
  management_health_body_outcome: 'not_run' | 'read' | 'aborted' | 'invalid';
  owned_snapshot_retry: {
    first: WindowsOwnedSnapshotRetryEvidence | null;
    last: WindowsOwnedSnapshotRetryEvidence | null;
    count: number;
  };
};

function probeManagementTcpPort(port: number, signal: AbortSignal, timeoutMs: number): Promise<ManagementTcpOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('unknown');
      return;
    }
    const socket = connectTcp({ host: '127.0.0.1', port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish('unknown');
    const finish = (outcome: ManagementTcpOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(outcome);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error: unknown) => finish(
      error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED' ? 'closed' : 'unknown',
    ));
    socket.setTimeout(timeoutMs, () => finish('unknown'));
    timer = setTimeout(() => finish('unknown'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const MANAGEMENT_HEALTH_MAX_BODY_BYTES = 64;
const MANAGEMENT_STATS_MAX_BODY_BYTES = 4 * 1024;

function getBoundedManagementGet(
  port: number,
  signal: AbortSignal,
  remainingMs: number,
  path: string,
  maxBodyBytes: number,
  label: string,
  headers: Record<string, string> = {},
  onHeaders?: (status: number) => void,
): Promise<ManagementResponseResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    let request: ReturnType<typeof http.request> | undefined;
    let response: http.IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let responseEnded = false;
    const abort = () => finish(new DOMException('The operation was aborted', 'AbortError'));
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      response?.removeAllListeners();
      response?.destroy();
      request?.removeAllListeners();
      request?.destroy();
    };
    const finish = (error?: unknown, result?: ManagementResponseResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const fail = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)));

    try {
      request = http.request({
        hostname: '127.0.0.1', port, path, method: 'GET', agent: false,
        headers: { ...headers, Connection: 'close' },
      }, (incomingResponse) => {
        if (settled) {
          incomingResponse.destroy();
          return;
        }
        response = incomingResponse;
        onHeaders?.(incomingResponse.statusCode ?? 0);
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        incomingResponse.once('error', fail);
        incomingResponse.once('aborted', () => fail(new Error(`${label} response was aborted`)));
        incomingResponse.once('close', () => {
          if (!responseEnded) fail(new Error(`${label} response closed before end`));
        });
        incomingResponse.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += buffer.byteLength;
          if (bodyBytes > maxBodyBytes) {
            fail(new Error(`${label} response body exceeds byte limit`));
            return;
          }
          chunks.push(buffer);
        });
        incomingResponse.once('end', () => {
          responseEnded = true;
          finish(undefined, {
            status: incomingResponse.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      request.once('error', fail);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error(`${label} request timed out`)), Math.max(0, remainingMs));
      if (signal.aborted) {
        abort();
        return;
      }
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function getManagementHealth(
  port: number,
  signal: AbortSignal,
  remainingMs: number,
  onHeaders?: (status: number) => void,
): Promise<ManagementResponseResult> {
  return getBoundedManagementGet(
    port, signal, remainingMs, '/health', MANAGEMENT_HEALTH_MAX_BODY_BYTES, 'management health', {}, onHeaders,
  );
}

function getManagementStats(
  port: number,
  token: string,
  signal: AbortSignal,
  remainingMs: number,
  onHeaders?: (status: number) => void,
): Promise<ManagementResponseResult> {
  return getBoundedManagementGet(
    port, signal, remainingMs, '/api/stats', MANAGEMENT_STATS_MAX_BODY_BYTES, 'management stats',
    { Authorization: `Bearer ${token}` }, onHeaders,
  );
}

async function listenManagementTestServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('management test server address is unavailable');
  return { server, port: address.port };
}

function closeManagementTestServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

test('bounded management health GET reads the exact response and closes the connection', async () => {
  let method: string | undefined;
  let connection: string | undefined;
  const { server, port } = await listenManagementTestServer((request, response) => {
    method = request.method;
    connection = request.headers.connection;
    response.end('{"status":"ok"}');
  });
  try {
    await expect(getManagementHealth(port, new AbortController().signal, 1_000)).resolves.toEqual({
      status: 200, body: '{"status":"ok"}',
    });
    expect(method).toBe('GET');
    expect(connection).toBe('close');
  } finally {
    await closeManagementTestServer(server);
  }
});

test('bounded management health GET rejects an oversized body', async () => {
  const { server, port } = await listenManagementTestServer((_request, response) => {
    response.end('x'.repeat(MANAGEMENT_HEALTH_MAX_BODY_BYTES + 1));
  });
  try {
    await expect(getManagementHealth(port, new AbortController().signal, 1_000)).rejects.toThrow('body exceeds byte limit');
  } finally {
    await closeManagementTestServer(server);
  }
});

test('bounded management health GET cleans up on timeout, abort, and request error', async () => {
  const timeoutServer = await listenManagementTestServer(() => {});
  try {
    await expect(getManagementHealth(timeoutServer.port, new AbortController().signal, 20)).rejects.toThrow('timed out');
  } finally {
    await closeManagementTestServer(timeoutServer.server);
  }

  const abortServer = await listenManagementTestServer(() => {});
  try {
    const controller = new AbortController();
    const request = getManagementHealth(abortServer.port, controller.signal, 1_000);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    await closeManagementTestServer(abortServer.server);
  }

  const errorServer = await listenManagementTestServer((request) => request.socket.destroy());
  try {
    await expect(getManagementHealth(errorServer.port, new AbortController().signal, 1_000)).rejects.toBeInstanceOf(Error);
  } finally {
    await closeManagementTestServer(errorServer.server);
  }
});

test('bounded management stats GET sends bearer auth and reads a bounded JSON response', async () => {
  let authorization: string | undefined;
  let connection: string | undefined;
  const { server, port } = await listenManagementTestServer((request, response) => {
    authorization = request.headers.authorization;
    connection = request.headers.connection;
    response.end(JSON.stringify({ totalRequests: 0 }));
  });
  try {
    await expect(getManagementStats(port, 'test-token', new AbortController().signal, 1_000)).resolves.toEqual({
      status: 200, body: '{"totalRequests":0}',
    });
    expect(authorization).toBe('Bearer test-token');
    expect(connection).toBe('close');
  } finally {
    await closeManagementTestServer(server);
  }
});

test('bounded management stats GET cleans up on timeout, abort, and request error', async () => {
  const timeoutServer = await listenManagementTestServer(() => {});
  try {
    await expect(getManagementStats(timeoutServer.port, 'test-token', new AbortController().signal, 20)).rejects.toThrow('timed out');
  } finally {
    await closeManagementTestServer(timeoutServer.server);
  }

  const abortServer = await listenManagementTestServer(() => {});
  try {
    const controller = new AbortController();
    const request = getManagementStats(abortServer.port, 'test-token', controller.signal, 1_000);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    await closeManagementTestServer(abortServer.server);
  }

  const errorServer = await listenManagementTestServer((request) => request.socket.destroy());
  try {
    await expect(getManagementStats(errorServer.port, 'test-token', new AbortController().signal, 1_000)).rejects.toBeInstanceOf(Error);
  } finally {
    await closeManagementTestServer(errorServer.server);
  }
});

test('a live master replaces workers after its authenticated ingress is SIGKILLed', async () => {
  const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let fixture!: Awaited<ReturnType<typeof createMasterFixture>>;
  let upstream!: ReturnType<typeof Bun.serve>;
  let port = 0;
  let master!: Awaited<ReturnType<typeof spawnMaster>>;
  let oldWorkers: readonly number[] = [];
  let newWorkers: readonly number[] = [];
  let oldIngress = 0;
  let oldIngressIdentity: Awaited<ReturnType<typeof discoverIngressIdentity>> | undefined;
  const recoveryDebug: RecoveryDebug = {
    management_tcp_outcome: 'unknown', management_health_headers_received: false,
    management_health_status: null, management_health_body_outcome: 'not_run', owned_snapshot_retry: { first: null, last: null, count: 0 },
  };
  let currentPhase: IngressRecoveryPhase = 'health';
  const budget = createTestPhaseBudget(55_000);
  const runPhase = async <T>(phase: IngressRecoveryPhase, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>): Promise<T> => {
    currentPhase = phase;
    try { return await budget.run(phase, operation); }
    catch (error) {
      throw new Error(`ingress recovery phase=${phase} remaining_ms=${budget.remaining()} recoveryDebug=${JSON.stringify(recoveryDebug)}`, { cause: error });
    }
  };
  const discoverWithBudget = (signal: AbortSignal, remainingMs: number, url: string, timeoutMs: number) =>
    discoverIngressIdentity(url, (input, init) => fetch(input, {
      ...init,
      signal: init?.signal === undefined || init.signal === null ? signal : AbortSignal.any([signal, init.signal]),
    }), Math.min(timeoutMs, remainingMs));
  await runWithCleanup(async () => {
    await runPhase('health', async (signal) => {
      fixture = await createMasterFixture('bungee-master-ingress-new-boot-');
      port = await freePort(cleanupScope);
      upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('new-boot-upstream') });
      if (upstream.port === undefined) throw new Error('upstream port is unavailable');
      master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
      await waitForHealth(port, master, signal);
    });
    if (fixture === undefined || upstream === undefined || master === undefined) throw new Error('test setup did not complete');
    await runPhase('initial_workers', async (signal) => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      oldWorkers = await waitForWorkerPids(master, 2, signal);
    });
    await runPhase('initial_ingress', async (signal, remainingMs) => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitUntil(async () => {
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({ pid, ingress: await isIngressProcess(pid) })));
      oldIngress = classified.find(({ ingress }) => ingress)?.pid ?? 0;
      return classified.filter(({ ingress }) => ingress).length === 1 && oldIngress !== 0;
      }, 'master did not start ingress', remainingMs, signal);
      oldIngressIdentity = await discoverWithBudget(signal, remainingMs, `http://127.0.0.1:${port + 2}`, 5_000);
    });
    const aggregate: ConfigurationAggregateV2 = {
      plugin_activations: [],
      logical_configuration: {
        auth: { enabled: true, tokens: [token] }, plugins: [],
        services: [{ id: 'b1000000-0000-4000-8000-000000000001', position: 1, name: 'new-boot-service', plugins: [], endpoints: [{
          id: 'b2000000-0000-4000-8000-000000000001', position: 1, target: `http://127.0.0.1:${upstream.port}`,
          weight: 100, priority: 1, is_disabled: false, plugins: [],
        }] }],
        routes: [{ id: 'b3000000-0000-4000-8000-000000000001', position: 1, path: '/limited', service_id: 'b1000000-0000-4000-8000-000000000001',
          auth: { enabled: false, tokens: [] }, plugins: [], rate_limit: { enabled: true, requests_per_second: 1, burst: 1 } }],
      },
    };
    const mutationId = 'b4000000-0000-4000-8000-000000000001';
    await runPhase('initial_publication', async (signal, remainingMs) => {
      expect((await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: mutationId }), signal,
      })).status).toBe(202);
      await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, {
        headers: { authorization: `Bearer ${token}` }, signal,
      })).json() as { operation?: { state?: string } }).operation?.state === 'converged', 'initial publication did not converge', remainingMs, signal);
    });
    await runPhase('initial_workers', (signal) => waitForWorkerPids(master, 2, signal).then((workers) => { oldWorkers = workers; }));
    await runPhase('initial_traffic', async (signal) => {
      expect((await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal })).status).toBe(429);
    });

    await runPhase('kill_old_ingress', async () => { process.kill(oldIngress, 'SIGKILL'); });
    await runPhase('wait_old_ingress_dead', (signal, remainingMs) => waitUntil(() => !processAlive(oldIngress), 'old ingress did not exit', remainingMs, signal));
    let newIngressIdentity: Awaited<ReturnType<typeof discoverIngressIdentity>> | undefined;
    let replacementIngress = 0;
    let ownedSnapshotAttempt: WindowsOwnedSnapshotRetryEvidence['poll_attempt'] = 'initial';
    await runPhase('replacement_tree', async (signal, remainingMs) => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitUntil(async () => {
      let children: readonly number[];
      try { children = await childPids(master.child.pid!); }
      catch (error) {
        if (!isRetryableOwnedSnapshotObservation(error)) throw error;
        const evidence = ownedSnapshotObservationEvidence(error, ownedSnapshotAttempt);
        if (evidence !== null) {
          recoveryDebug.owned_snapshot_retry.first ??= evidence;
          recoveryDebug.owned_snapshot_retry.last = evidence;
          recoveryDebug.owned_snapshot_retry.count += 1;
        }
        ownedSnapshotAttempt = 'retry';
        return false;
      }
      const classified = await Promise.all(children.map(async (pid) => ({
        pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
      })));
      newWorkers = classified.filter(({ worker }) => worker).map(({ pid }) => pid);
      const ingressPids = classified.filter(({ ingress }) => ingress).map(({ pid }) => pid);
      replacementIngress = ingressPids[0] ?? 0;
      if (newWorkers.length !== 2 || ingressPids.length !== 1) {
        return false;
      }
      return true;
      }, 'ingress boot recovery did not replace workers', remainingMs, signal);
    });
    await runPhase('replacement_identity', async (signal, remainingMs) => {
      await waitUntil(async () => {
        try { newIngressIdentity = await discoverWithBudget(signal, remainingMs, `http://127.0.0.1:${port + 2}`, 250); }
        catch { return false; }
        return oldIngressIdentity !== undefined && newIngressIdentity.process_instance_id !== oldIngressIdentity.process_instance_id
          && newIngressIdentity.boot_nonce !== oldIngressIdentity.boot_nonce && replacementIngress !== oldIngress;
      }, 'replacement ingress identity did not converge', remainingMs, signal);
    });
    await runPhase('replacement_workers', async (signal, remainingMs) => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitUntil(async () => {
        const children = await childPids(master.child.pid!);
        const classified = await Promise.all(children.map(async (pid) => ({ pid, worker: await isWorkerProcess(pid) })));
        newWorkers = classified.filter(({ worker }) => worker).map(({ pid }) => pid);
        return newWorkers.length === 2 && !newWorkers.some((pid) => oldWorkers.includes(pid)) && !oldWorkers.some(processAlive);
      }, 'replacement workers did not converge', remainingMs, signal);
    });
    await runPhase('final_traffic', async (signal, remainingMs) => {
      let statuses: readonly [number, number] = [0, 0];
      await waitUntil(async () => {
        const first = await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal });
        const second = await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal });
        statuses = [first.status, second.status];
        const passed = first.status === 200 && second.status === 429;
        return passed;
      }, 'replacement traffic did not converge', remainingMs, signal);
      expect(statuses).toEqual([200, 429]);
    });
    await runPhase('final_tree', async () => {
      expect(oldWorkers.every((pid) => !processAlive(pid))).toBeTrue();
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({
        pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
      })));
      expect(classified.filter(({ ingress }) => ingress)).toHaveLength(1);
    });
    await runPhase('final_identity', async (signal, remainingMs) => {
      newIngressIdentity = await discoverWithBudget(signal, remainingMs, `http://127.0.0.1:${port + 2}`, 5_000);
      expect(oldIngressIdentity).toBeDefined();
      expect(newIngressIdentity.process_instance_id).not.toBe(oldIngressIdentity!.process_instance_id);
      expect(newIngressIdentity.boot_nonce).not.toBe(oldIngressIdentity!.boot_nonce);
    });
    await runPhase('final_workers', async () => {
      expect(processAlive(master.child.pid!)).toBeTrue();
    });
    let statsBody: string | undefined;
    let statsStatus: number | null = null;
    await runPhase('final_management_health', async (signal, remainingMs) => {
      recoveryDebug.management_tcp_outcome = await probeManagementTcpPort(port, signal, Math.min(1000, remainingMs));
      expect(recoveryDebug.management_tcp_outcome).toBe('open');

      try {
        const health = await getManagementHealth(port, signal, remainingMs, (status) => {
          recoveryDebug.management_health_headers_received = true;
          recoveryDebug.management_health_status = status;
        });
        expect(health.status).toBe(200);
        expect(health.body).toBe('{"status":"ok"}');
        recoveryDebug.management_health_body_outcome = 'read';
      } catch (error) {
        recoveryDebug.management_health_body_outcome = error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'invalid';
        throw error;
      }
    });
    await runPhase('final_stats_headers', async (signal, remainingMs) => {
      const stats = await getManagementStats(port, token, signal, remainingMs, (status) => { statsStatus = status; });
      statsBody = stats.body;
      expect(statsStatus).toBe(200);
    });
    await runPhase('final_stats_body', async (signal) => {
      signal.throwIfAborted();
      if (statsBody === undefined) throw new Error('management stats body was not read');
      const stats = JSON.parse(statsBody) as Record<string, unknown>;
      expect(stats).toMatchObject({
        totalRequests: expect.any(Number),
        requestsPerSecond: expect.any(Number),
        successRate: expect.any(Number),
        averageResponseTime: expect.any(Number),
        timestamp: expect.any(String),
      });
    });
    await runPhase('final_master_output', async () => {
      expect(statsStatus).toBe(200);
      expect(master.output()).not.toContain('Master runtime failed');
    });
  }, async () => {
    currentPhase = 'cleanup';
    await budget.runCleanup('cleanup', async () => {
      const cleanupTasks: Promise<unknown>[] = [];
      if (master !== undefined) cleanupTasks.push(cleanupMaster(master, [...new Set([...oldWorkers, ...newWorkers, oldIngress])].filter((pid) => pid > 0)));
      if (upstream !== undefined) cleanupTasks.push(upstream.stop(true));
      const settled = await Promise.allSettled(cleanupTasks);
      const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'new-boot cleanup failed');
      if (fixture !== undefined) await removeFixture(fixture);
    });
  });
}, 60_000);
