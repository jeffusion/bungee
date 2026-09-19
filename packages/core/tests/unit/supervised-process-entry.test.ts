import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runSupervisedWorkerProcess } from '../../src/config-worker/supervised-process-entry';
import { hasBoundControlClientProvider } from '../../src/config-worker/runtime-dependencies';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  serializeWorkerSupervisionSeed,
  signSupervisionMessage,
} from '../../src/supervision';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

const identity = {
  master_generation: '50000000-0000-4000-8000-000000000009',
  worker_instance_id: '60000000-0000-4000-8000-000000000009',
  worker_slot: 0,
} as const;
const authority = { controller_epoch: 1, controller_id: '70000000-0000-4000-8000-000000000009' } as const;

async function unusedPort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 204 }) });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

async function environment(directory: string, controlPort: number | string = 0): Promise<NodeJS.ProcessEnv> {
  const seed = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(7), identity.master_generation, identity.worker_instance_id, identity.worker_slot);
  return {
    BUNGEE_ROLE: 'worker',
    BUNGEE_MASTER_GENERATION: identity.master_generation, BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id,
    BUNGEE_WORKER_SLOT: '0', BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
    BUNGEE_ACCESS_DB_PATH: join(directory, 'access.db'), BUNGEE_WORKER_SUPERVISION_SEED: serializeWorkerSupervisionSeed(seed),
    BUNGEE_WORKER_CONTROL_PORT: String(controlPort), BUNGEE_MANAGEMENT_HOST: '127.0.0.1',
    BUNGEE_MANAGEMENT_PORT: String(await unusedPort()), BUNGEE_WORKER_DESCRIPTOR_PATH: join(directory, 'worker.json'),
    BUNGEE_WORKER_STARTUP_WATCHDOG_MS: '1000', BUNGEE_WORKER_ATTACH_GRACE_MS: '100',
  };
}

async function waitForDescriptor(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch { await Bun.sleep(10); }
  }
  throw new Error('descriptor did not appear');
}

test('supervised process clears the global provider on normal shutdown and startup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-supervised-entry-'));
  const exitProcess = mock((_code: number) => undefined);
  try {
    const env = await environment(directory);
    const running = runSupervisedWorkerProcess({ env, loadCatalog: async () => ({}) as any, exitProcess });
    const descriptor = await waitForDescriptor(env.BUNGEE_WORKER_DESCRIPTOR_PATH!);
    expect(hasBoundControlClientProvider()).toBe(true);
    const seed = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(7), identity.master_generation, identity.worker_instance_id, identity.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, descriptor.boot_nonce as string);
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${descriptor.control_port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const challenge = await post('/__supervision/challenge', { ...authority, request_id: randomUUID(), sequence: 1 }).then((response) => response.json()) as any;
    const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...credential.identity, ...authority, sequence: 1, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, credential);
    await post('/__supervision/attach', attach);
    const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...credential.identity, ...authority, sequence: 2, request_id: randomUUID(), lease_expires_at: Date.now() + 1_000 }, credential);
    await post('/__supervision/lease', lease);
    const body = {};
    const shutdown = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
      ...credential.identity, ...authority, sequence: 3, request_id: randomUUID(), method: 'POST', path: '/shutdown', body_hash: hashSupervisionBody(body) }, credential);
    await post('/__supervision/command', { message: shutdown, body });
    await running;
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(hasBoundControlClientProvider()).toBe(false);

    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
    try {
      const failed = await environment(directory, occupied.port);
      await expect(runSupervisedWorkerProcess({ env: failed, loadCatalog: async () => ({}) as any, exitProcess })).rejects.toThrow();
      expect(exitProcess).toHaveBeenCalledWith(1);
      expect(hasBoundControlClientProvider()).toBe(false);
    } finally {
      await occupied.stop(true);
    }
  } finally {
    expect(hasBoundControlClientProvider()).toBe(false);
    await rm(directory, { recursive: true, force: true });
  }
});
