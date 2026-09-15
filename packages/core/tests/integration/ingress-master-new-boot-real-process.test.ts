import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  childPids,
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
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

test('a live master replaces workers after its authenticated ingress is SIGKILLed', async () => {
  const fixture = await createMasterFixture('bungee-master-ingress-new-boot-');
  const port = await freePort();
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('new-boot-upstream') });
  if (upstream.port === undefined) throw new Error('upstream port is unavailable');
  const master = spawnMaster(cleanupScope, sourceMasterEntry(), fixture, port);
  const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let oldWorkers: readonly number[] = [];
  let newWorkers: readonly number[] = [];
  let oldIngress = 0;
  let oldIngressIdentity: Awaited<ReturnType<typeof discoverIngressIdentity>> | undefined;
  let recoveryDebug = '';
  await runWithCleanup(async () => {
    await waitForHealth(port, master);
    if (master.child.pid === undefined) throw new Error('master PID is unavailable');
    oldWorkers = await waitForWorkerPids(master.child.pid, 2);
    try { await waitUntil(async () => {
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({ pid, ingress: await isIngressProcess(pid) })));
      oldIngress = classified.find(({ ingress }) => ingress)?.pid ?? 0;
      return classified.filter(({ ingress }) => ingress).length === 1 && oldIngress !== 0;
    }, 'master did not start ingress');
    oldIngressIdentity = await discoverIngressIdentity(`http://127.0.0.1:${port + 2}`, fetch, 5_000);
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
    expect((await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: mutationId }),
    })).status).toBe(202);
    await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json() as { operation?: { state?: string } }).operation?.state === 'converged', 'initial publication did not converge', 20_000);
    oldWorkers = await waitForWorkerPids(master.child.pid!, 2);
    expect((await fetch(`http://127.0.0.1:${port + 1}/limited`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port + 1}/limited`)).status).toBe(429);

    process.kill(oldIngress, 'SIGKILL');
    await waitUntil(() => !processAlive(oldIngress), 'old ingress did not exit');
    await waitUntil(async () => {
      const children = await childPids(master.child.pid!);
      const classified = await Promise.all(children.map(async (pid) => ({
        pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
      })));
      newWorkers = classified.filter(({ worker }) => worker).map(({ pid }) => pid);
      const ingressPids = classified.filter(({ ingress }) => ingress).map(({ pid }) => pid);
      const ingress = ingressPids[0];
      if (newWorkers.length !== 2 || ingressPids.length !== 1) {
        recoveryDebug = `ingress=${JSON.stringify(ingressPids)} workers=${JSON.stringify(newWorkers)} old=${JSON.stringify(oldWorkers)} children=${JSON.stringify(children)}`;
        return false;
      }
      let newIngressIdentity;
      try {
        newIngressIdentity = await discoverIngressIdentity(`http://127.0.0.1:${port + 2}`, fetch, 250);
      } catch {
        return false;
      }
      if (oldIngressIdentity === undefined || ingress === oldIngress
        || newIngressIdentity.process_instance_id === oldIngressIdentity.process_instance_id
        || newIngressIdentity.boot_nonce === oldIngressIdentity.boot_nonce
        || newWorkers.some((pid) => oldWorkers.includes(pid)) || oldWorkers.some(processAlive)) {
        recoveryDebug = `ingress=${ingress} workers=${JSON.stringify(newWorkers)} old=${JSON.stringify(oldWorkers)}`;
        return false;
      }
      try {
        const first = await fetch(`http://127.0.0.1:${port + 1}/limited`);
        const second = await fetch(`http://127.0.0.1:${port + 1}/limited`);
        recoveryDebug = `ingress=${ingress} workers=${JSON.stringify(newWorkers)} statuses=${first.status}/${second.status}`;
        return first.status === 200 && second.status === 429;
      } catch { return false; }
    }, 'ingress boot recovery did not replace workers', 40_000); }
    catch { throw new Error(`ingress boot recovery did not replace workers: ${master.output()} ${recoveryDebug}`); }
    expect(oldWorkers.every((pid) => !processAlive(pid))).toBeTrue();
    const children = await childPids(master.child.pid!);
    const classified = await Promise.all(children.map(async (pid) => ({
      pid, worker: await isWorkerProcess(pid), ingress: await isIngressProcess(pid),
    })));
    expect(classified.filter(({ ingress }) => ingress)).toHaveLength(1);
    const newIngressIdentity = await discoverIngressIdentity(`http://127.0.0.1:${port + 2}`, fetch, 5_000);
    expect(oldIngressIdentity).toBeDefined();
    expect(newIngressIdentity.process_instance_id).not.toBe(oldIngressIdentity!.process_instance_id);
    expect(newIngressIdentity.boot_nonce).not.toBe(oldIngressIdentity!.boot_nonce);
    expect(processAlive(master.child.pid!)).toBeTrue();
    expect((await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(master.output()).not.toContain('Master runtime failed');
  }, async () => {
    const settled = await Promise.allSettled([
      cleanupMaster(master, [...new Set([...oldWorkers, ...newWorkers, oldIngress])].filter((pid) => pid > 0)),
      upstream.stop(true),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'new-boot cleanup failed');
    await removeFixture(fixture);
  });
}, 60_000);
