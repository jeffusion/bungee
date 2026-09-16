import { afterEach, expect, test } from 'bun:test';
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
} from '../fixtures/master-real-process-harness';
import { discoverIngressIdentity } from '../../src/ingress/supervision-http';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const INGRESS_RECOVERY_PHASES = ['health', 'initial_workers', 'initial_ingress', 'initial_publication', 'kill_old_ingress',
  'wait_old_ingress_dead', 'replacement_tree', 'replacement_identity', 'replacement_workers', 'replacement_traffic', 'final_assertions', 'cleanup'] as const;
type IngressRecoveryPhase = typeof INGRESS_RECOVERY_PHASES[number];

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
  let recoveryDebug = '';
  let currentPhase: IngressRecoveryPhase = 'health';
  const budget = createTestPhaseBudget(55_000);
  const runPhase = async <T>(phase: IngressRecoveryPhase, operation: (signal: AbortSignal, remainingMs: number) => Promise<T>): Promise<T> => {
    currentPhase = phase;
    try { return await budget.run(phase, operation); }
    catch (error) {
      const evidence = master?.output().slice(-2_048) ?? '';
      throw new Error(`ingress recovery phase=${phase} remaining_ms=${budget.remaining()} recoveryDebug=${recoveryDebug} bounded_evidence=${evidence}`, { cause: error });
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
    await runPhase('replacement_traffic', async (signal) => {
      expect((await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal })).status).toBe(429);
    });

    await runPhase('kill_old_ingress', async () => { process.kill(oldIngress, 'SIGKILL'); });
    await runPhase('wait_old_ingress_dead', (signal, remainingMs) => waitUntil(() => !processAlive(oldIngress), 'old ingress did not exit', remainingMs, signal));
    let newIngressIdentity: Awaited<ReturnType<typeof discoverIngressIdentity>> | undefined;
    let replacementIngress = 0;
    await runPhase('replacement_tree', async (signal, remainingMs) => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitUntil(async () => {
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({
        pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
      })));
      newWorkers = classified.filter(({ worker }) => worker).map(({ pid }) => pid);
      const ingressPids = classified.filter(({ ingress }) => ingress).map(({ pid }) => pid);
      replacementIngress = ingressPids[0] ?? 0;
      if (newWorkers.length !== 2 || ingressPids.length !== 1) {
        recoveryDebug = `ingress=${JSON.stringify(ingressPids)} workers=${JSON.stringify(newWorkers)} old=${JSON.stringify(oldWorkers)} children=${JSON.stringify(children)}`;
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
    await runPhase('replacement_traffic', async (signal, remainingMs) => {
      let statuses: readonly [number, number] = [0, 0];
      await waitUntil(async () => {
        const first = await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal });
        const second = await fetch(`http://127.0.0.1:${port + 1}/limited`, { signal });
        statuses = [first.status, second.status];
        recoveryDebug = `workers=${JSON.stringify(newWorkers)} statuses=${first.status}/${second.status}`;
        return first.status === 200 && second.status === 429;
      }, 'replacement traffic did not converge', remainingMs, signal);
      expect(statuses).toEqual([200, 429]);
    });
    await runPhase('final_assertions', async (signal, remainingMs) => {
      expect(oldWorkers.every((pid) => !processAlive(pid))).toBeTrue();
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({
        pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
      })));
      expect(classified.filter(({ ingress }) => ingress)).toHaveLength(1);
      newIngressIdentity = await discoverWithBudget(signal, remainingMs, `http://127.0.0.1:${port + 2}`, 5_000);
      expect(oldIngressIdentity).toBeDefined();
      expect(newIngressIdentity.process_instance_id).not.toBe(oldIngressIdentity!.process_instance_id);
      expect(newIngressIdentity.boot_nonce).not.toBe(oldIngressIdentity!.boot_nonce);
      expect(processAlive(master.child.pid!)).toBeTrue();
      expect((await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { authorization: `Bearer ${token}` }, signal })).status).toBe(200);
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
