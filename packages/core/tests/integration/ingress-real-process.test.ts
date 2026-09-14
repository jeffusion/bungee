import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateWorkerTransportSecret } from '../../src/config-worker/private-transport';
import { startIngressProcess } from '../../src/ingress/runtime';
import { IngressControllerClient } from '../../src/ingress';
import type { AdmissionSet } from '../../src/ingress';
import {
  RATE_LIMIT_HTTP_PATH,
  createRateLimitCredential,
  deriveRateLimitBucketId,
  disposeRateLimitCredential,
  normalizeRateLimitKey,
  signRateLimitDebitRequest,
  type RateLimitDebitRequestBody,
  type RateLimitWorkerIdentity,
} from '../../src/rate-limit';
import { canonicalJson } from '../../src/config-storage/content-hash';
import {
  deriveSupervisionProcessKey,
  serializeSupervisionCredential,
} from '../../src/supervision';
import { captureProcessIdentity, cleanupProcesses, ProcessRegistry } from '../fixtures/process-cleanup';

const coreDirectory = resolve(import.meta.dir, '../../');
const controllerFixture = resolve(import.meta.dir, '../fixtures/ingress-controller-fixture.ts');
const controllerClientFixture = resolve(import.meta.dir, '../fixtures/ingress-controller-client-fixture.ts');
const instance = '10000000-0000-4000-8000-000000000001';
const processId = '20000000-0000-4000-8000-000000000001';
const boot = '30000000-0000-4000-8000-000000000001';
const controllerId = '40000000-0000-4000-8000-000000000001';
const newControllerId = '40000000-0000-4000-8000-000000000002';
const root = new Uint8Array(32).fill(8);

const processes = new ProcessRegistry();
const directories: string[] = [];
const { BUNGEE_PLUGIN_SECRETS_KEY: _rootKey, ...safeEnvironment } = process.env;

afterEach(async () => {
  await cleanupProcesses(processes);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function killController(child: Bun.Subprocess): void {
  if (process.platform === 'win32') child.kill();
  else child.kill('SIGKILL');
}

function killPid(pid: number): void {
  try { process.kill(pid, process.platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* already exited */ }
}

async function availablePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('probe did not receive a port');
  return port;
}

async function waitFor(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status !== 503) return response;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  throw new Error(`ingress did not become ready: ${String(lastError)}`);
}

async function waitForDown(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fetch(url); } catch { return; }
    await Bun.sleep(25);
  }
  throw new Error('ingress did not stop');
}

type ProcessDescriptor = {
  readonly ingress: { readonly pid: number; readonly public_port: number; readonly supervision_port: number };
  readonly workers: readonly { readonly label: string; readonly pid: number; readonly port: number }[];
};

async function readDescriptor(path: string): Promise<ProcessDescriptor> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await Bun.file(path).json() as ProcessDescriptor;
      if (Number.isSafeInteger(value.ingress.pid) && value.workers.length === 4) return value;
    } catch { /* fixture is still starting */ }
    await Bun.sleep(25);
  }
  throw new Error('controller fixture did not write a valid process descriptor');
}

async function waitPidDown(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(25);
  }
  throw new Error('ingress process did not exit');
}

function admission(sequence: number, workers: readonly number[], generation: string): AdmissionSet {
  return {
    master_generation: generation, admission_sequence: sequence, revision: sequence,
    content_hash: `sha256:${'a'.repeat(64)}`, plugin_catalog_hash: `sha256:${'b'.repeat(64)}`,
    workers: workers.map((private_port, worker_slot) => ({
      master_generation: generation,
      worker_instance_id: `60000000-0000-4000-8000-${String(worker_slot + 1).padStart(12, '0')}`,
      boot_nonce: `70000000-0000-4000-8000-${String(worker_slot + 1).padStart(12, '0')}`,
      worker_slot, private_port,
    })),
  };
}

function rateWorker(set: AdmissionSet, workerSlot = 0): RateLimitWorkerIdentity {
  const worker = set.workers[workerSlot]!;
  return {
    role: 'worker', process_instance_id: worker.worker_instance_id, boot_nonce: worker.boot_nonce,
    master_generation: worker.master_generation, worker_slot: worker.worker_slot,
  };
}

function rateBody(secret: string, key: string, burst = 2): RateLimitDebitRequestBody {
  return {
    bucket_id: deriveRateLimitBucketId(secret, '80000000-0000-4000-8000-000000000001', 'tenant', normalizeRateLimitKey(key)),
    policy_id: 'ingress-rate-policy', revision: 1, rps: 1, burst,
  };
}

function signedDebit(secret: string, worker: RateLimitWorkerIdentity, body: RateLimitDebitRequestBody): string {
  const credential = createRateLimitCredential(secret, worker);
  try {
    return canonicalJson(signRateLimitDebitRequest({
      request_id: randomUUID(), debit_id: randomUUID(), deadline_at: Date.now() + 1_000, body,
    }, credential));
  } finally {
    disposeRateLimitCredential(credential);
  }
}

async function debit(url: string, wire: string): Promise<Response> {
  return fetch(new URL(RATE_LIMIT_HTTP_PATH, url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: wire,
  });
}

describe('real independent ingress process', () => {
  test('serves rate-limit debits only on its private listener and retains buckets across admission and freeze', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-ingress-rate-limit-'));
    directories.push(directory);
    const transportSecret = generateWorkerTransportSecret();
    const credential = deriveSupervisionProcessKey(root, instance, 'ingress', processId, boot);
    const ingress = await startIngressProcess({
      instanceLockPath: join(directory, 'ingress.instance.lock'), credential, transportSecret,
      publicHost: '127.0.0.1', publicPort: 0, supervisionPort: 0,
    });
    const businessWorker = Bun.serve({
      hostname: '127.0.0.1', port: 0, fetch: () => new Response('business'),
    });
    const privateUrl = `http://127.0.0.1:${ingress.supervisionPort}`;
    try {
      const publicUrl = `http://127.0.0.1:${ingress.publicPort}`;
      const authority = { controller_epoch: 1, controller_id: controllerId };
      const controller = new IngressControllerClient({ baseUrl: privateUrl, credential });
      const challenge = await controller.challenge(authority);
      await controller.attach(challenge, authority, 1);
      await controller.lease(authority, Date.now() + 5_000, 2);
      const old = admission(1, [await availablePort()], '50000000-0000-4000-8000-000000000011');
      const next = admission(2, [businessWorker.port!], '50000000-0000-4000-8000-000000000012');
      await controller.command(authority, 3, '/prepare', old);
      await controller.command(authority, 4, '/commit', old);

      const shared = rateBody(transportSecret, 'shared');
      const oldWire = signedDebit(transportSecret, rateWorker(old), shared);
      expect((await debit(privateUrl, oldWire)).status).toBe(200);
      await controller.command(authority, 5, '/prepare', next);
      expect((await debit(privateUrl, signedDebit(transportSecret, rateWorker(next), shared))).status).toBe(403);
      await controller.command(authority, 6, '/commit', next);
      expect((await debit(privateUrl, signedDebit(transportSecret, rateWorker(old), shared))).status).toBe(200);
      const exhausted = await debit(privateUrl, signedDebit(transportSecret, rateWorker(next), shared));
      expect((await exhausted.json() as { body: { allowed: boolean } }).body.allowed).toBe(false);
      await controller.command(authority, 7, '/release-retired', old);
      expect((await debit(privateUrl, oldWire)).status).toBe(403);

      const publicWire = signedDebit(transportSecret, rateWorker(next), rateBody(transportSecret, 'public'));
      expect(await (await debit(publicUrl, publicWire)).text()).toBe('business');
      expect((await debit(privateUrl, publicWire)).status).toBe(200);

      const frozenBody = rateBody(transportSecret, 'frozen');
      expect((await debit(privateUrl, signedDebit(transportSecret, rateWorker(next), frozenBody))).status).toBe(200);
      await controller.lease(authority, Date.now() + 50, 8);
      await Bun.sleep(100);
      expect((await controller.status(authority)).state).toBe('frozen');
      expect((await debit(privateUrl, signedDebit(transportSecret, rateWorker(next), frozenBody))).status).toBe(200);
      const frozenExhausted = await debit(privateUrl, signedDebit(transportSecret, rateWorker(next), frozenBody));
      expect((await frozenExhausted.json() as { body: { allowed: boolean } }).body.allowed).toBe(false);
    } finally {
      await ingress.stop();
      expect(await (await fetch(new URL(RATE_LIMIT_HTTP_PATH, privateUrl))).json()).toEqual({ error: 'inactive' });
      await businessWorker.stop(true);
    }
  });

  test('runs a real main.ts ingress child, authenticates workers, freezes safely, and shuts down by command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-ingress-real-'));
    directories.push(directory);
    const lockPath = join(directory, 'ingress.instance.lock');
    const oldPorts = [await availablePort(), await availablePort()];
    const newPorts = [await availablePort(), await availablePort()];
    const transportSecret = generateWorkerTransportSecret();
    const credential = deriveSupervisionProcessKey(root, instance, 'ingress', processId, boot);
    const descriptorPath = join(directory, 'process-descriptor.json');
    const environment = {
      ...safeEnvironment,
      BUNGEE_TEST_PROCESS_MARKER: randomUUID(),
      BUNGEE_ROLE: 'ingress',
      BUNGEE_INGRESS_CREDENTIAL: serializeSupervisionCredential(credential),
      BUNGEE_INGRESS_TRANSPORT_SECRET: transportSecret,
      BUNGEE_INGRESS_INSTANCE_LOCK_PATH: lockPath,
      BUNGEE_INGRESS_DESCRIPTOR_PATH: descriptorPath,
      BUNGEE_FIXTURE_OLD_PORT_0: String(oldPorts[0]), BUNGEE_FIXTURE_OLD_PORT_1: String(oldPorts[1]),
      BUNGEE_FIXTURE_NEW_PORT_0: String(newPorts[0]), BUNGEE_FIXTURE_NEW_PORT_1: String(newPorts[1]),
      BUNGEE_FIXTURE_TRANSPORT_SECRET: transportSecret,
      BUNGEE_INGRESS_PUBLIC_HOST: '127.0.0.1',
      BUNGEE_INGRESS_PUBLIC_PORT: String(await availablePort()),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(await availablePort()),
    };
    const controller = Bun.spawn([process.execPath, controllerFixture], {
      cwd: coreDirectory, env: environment, detached: false, stdout: 'pipe', stderr: 'ignore',
    });
    processes.registerChild(controller);
    const descriptor = await readDescriptor(descriptorPath);
    const ingressPid = descriptor.ingress.pid;
    const identities = await Promise.all([ingressPid, ...descriptor.workers.map(({ pid }) => pid)].map((pid) => captureProcessIdentity(pid)));
    if (identities.some((identity) => identity === null)) throw new Error('ingress fixture process identity is unavailable');
    processes.registerPids(identities.filter((identity): identity is NonNullable<typeof identity> => identity !== null));
    const workerPids = descriptor.workers.map(({ pid }) => pid);
    const supervisionPort = descriptor.ingress.supervision_port;
    const publicPort = descriptor.ingress.public_port;
    const firstController = new IngressControllerClient({ baseUrl: `http://127.0.0.1:${supervisionPort}`, credential });
    await waitFor(`http://127.0.0.1:${supervisionPort}/__supervision/identity`);
    for (const worker of descriptor.workers) await waitFor(`http://127.0.0.1:${worker.port}/ready`);
    const authority = { controller_epoch: 1, controller_id: controllerId };
    const challenge = await firstController.challenge(authority);
    await firstController.attach(challenge, authority, 1);
    await firstController.lease(authority, Date.now() + 5_000, 2);
    const oldGeneration = '50000000-0000-4000-8000-000000000001';
    const newGeneration = '50000000-0000-4000-8000-000000000002';
    await firstController.command(authority, 3, '/prepare', admission(1, oldPorts, oldGeneration));
    await firstController.command(authority, 4, '/commit', admission(1, oldPorts, oldGeneration));
    const oldFlow = fetch(`http://127.0.0.1:${publicPort}/hold`);
    await Bun.sleep(20);
    await firstController.command(authority, 5, '/prepare', admission(2, newPorts, newGeneration));
    await firstController.lease(authority, Date.now() + 100, 6);
    killController(controller);
    await controller.exited;
    for (const pid of [ingressPid, ...workerPids]) expect(() => process.kill(pid, 0)).not.toThrow();
    await Bun.sleep(180);
    const expiredStatus = await firstController.status(authority);
    expect(expiredStatus.state).toBe('frozen');
    expect(expiredStatus.registry.prepared).toBeNull();
    expect(expiredStatus.registry.active?.master_generation).toBe(oldGeneration);
    expect(await (await oldFlow).text()).toBe('old-0:/hold');
    expect(await (await fetch(`http://127.0.0.1:${publicPort}/still`)).text()).toContain('old-1:/still');

    const newAuthority = { controller_epoch: 2, controller_id: newControllerId };
    const newController = Bun.spawn([process.execPath, controllerClientFixture], {
      cwd: coreDirectory,
      env: {
        ...safeEnvironment,
        BUNGEE_CONTROLLER_BASE_URL: `http://127.0.0.1:${supervisionPort}`,
        BUNGEE_CONTROLLER_CREDENTIAL: serializeSupervisionCredential(credential),
        BUNGEE_CONTROLLER_AUTHORITY: JSON.stringify(newAuthority),
        BUNGEE_CONTROLLER_ADMISSION: JSON.stringify(admission(3, newPorts, newGeneration)),
      },
      stdout: 'pipe', stderr: 'ignore',
    });
    processes.registerChild(newController);
    if (typeof newController.stdout === 'number' || newController.stdout === undefined) throw new Error('controller client fixture stdout is unavailable');
    const newControllerResult = await new Response(newController.stdout).json() as {
      readonly frozenStatus: { readonly state: string };
      readonly attachedStatus: { readonly state: string };
    };
    expect(newControllerResult.frozenStatus.state).toBe('frozen');
    expect(newControllerResult.attachedStatus.state).toBe('attached');
    const newControllerExit = await newController.exited;
    expect(newControllerExit).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${publicPort}/new`)).text()).toContain('new-0:/new');
    const shutdownController = Bun.spawn([process.execPath, controllerClientFixture], {
      cwd: coreDirectory,
      env: {
        ...safeEnvironment,
        BUNGEE_CONTROLLER_BASE_URL: `http://127.0.0.1:${supervisionPort}`,
        BUNGEE_CONTROLLER_CREDENTIAL: serializeSupervisionCredential(credential),
        BUNGEE_CONTROLLER_AUTHORITY: JSON.stringify(newAuthority),
        BUNGEE_CONTROLLER_MODE: 'shutdown',
      },
      stdout: 'ignore', stderr: 'ignore',
    });
    processes.registerChild(shutdownController);
    expect(await shutdownController.exited).toBe(0);
    await waitForDown(`http://127.0.0.1:${supervisionPort}/__supervision/identity`);
    await waitPidDown(ingressPid);
    for (const pid of workerPids) {
      killPid(pid);
      await waitPidDown(pid);
    }
  });

  test('rejects a second ingress with a different lock path when the public port is already bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-ingress-lock-'));
    directories.push(directory);
    const credential = deriveSupervisionProcessKey(root, instance, 'ingress', processId, boot);
    const first = await startIngressProcess({
      instanceLockPath: join(directory, 'one.lock'), credential,
      transportSecret: generateWorkerTransportSecret(), publicHost: '127.0.0.1', publicPort: 0, supervisionPort: 0,
    });
    try {
      expect(first.publicPort).not.toBeNull();
      const failedLockPath = join(directory, 'failed.lock');
      const failedSupervisionPort = await availablePort();
      await expect(startIngressProcess({
        instanceLockPath: failedLockPath, credential,
        transportSecret: generateWorkerTransportSecret(), publicHost: '127.0.0.1',
        publicPort: first.publicPort!, supervisionPort: failedSupervisionPort,
      })).rejects.toThrow();
      const recovered = await startIngressProcess({
        instanceLockPath: failedLockPath, credential,
        transportSecret: generateWorkerTransportSecret(), publicHost: '127.0.0.1',
        publicPort: 0, supervisionPort: failedSupervisionPort,
      });
      await recovered.stop();
    } finally {
      await first.stop();
    }
  });
});
