import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed, hashSupervisionBody, serializeWorkerSupervisionSeed, signSupervisionMessage, verifyWorkerDescriptor } from '../../src/supervision';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { BUILTINS } from '../unit/plugin-manifest-catalog-fixtures';
import { privateWorkerHeaders, TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { cleanupProcesses, ProcessRegistry } from '../fixtures/process-cleanup';

const workerEntry = resolve(import.meta.dir, '../../src/main.ts');
const identity = {
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const root = new Uint8Array(32).fill(8);
const temporaryDirectories: string[] = [];
const processes = new ProcessRegistry();
let catalog: PluginManifestCatalog;

beforeAll(async () => { catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] }); });
afterAll(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
afterEach(async () => cleanupProcesses(processes));

function aggregate(target: string) {
  const result = parseNormalizeCompileAggregate({
    logical_configuration: {
      services: [{ id: '10000000-0000-4000-8000-000000000001', position: 1, name: 'upstream', endpoints: [{
        id: '30000000-0000-4000-8000-000000000001', position: 1, target,
      }] }],
      routes: [
        { id: '20000000-0000-4000-8000-000000000001', position: 1, path: '/proxy', service_id: '10000000-0000-4000-8000-000000000001' },
        { id: '20000000-0000-4000-8000-000000000002', position: 2, path: '/sse', service_id: '10000000-0000-4000-8000-000000000001' },
      ],
      plugins: [],
    }, plugin_activations: [],
  }, catalog.toCompileOptions());
  if (!result.ok) throw new Error('supervised worker aggregate must compile');
  return result.value;
}

async function spawnWorker(directory: string, descriptorPath: string, seed: string, startupWatchdogMs = '10000'): Promise<ChildProcess> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 204 }) });
  const managementPort = probe.port!;
  await probe.stop(true);
  const child = spawn(process.execPath, [workerEntry], {
    cwd: directory,
    env: { ...process.env, BUNGEE_ROLE: 'worker',
      BUNGEE_ACCESS_DB_PATH: join(directory, 'logs', 'access.db'), PLUGINS_DIR: BUILTINS,
      BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false', BUNGEE_MASTER_GENERATION: identity.master_generation,
      BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id, BUNGEE_WORKER_SLOT: '0',
      BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
      BUNGEE_WORKER_SUPERVISION_SEED: seed, BUNGEE_WORKER_DESCRIPTOR_PATH: descriptorPath,
      BUNGEE_WORKER_CONTROL_PORT: '0',
      BUNGEE_MANAGEMENT_HOST: '127.0.0.1', BUNGEE_MANAGEMENT_PORT: String(managementPort),
      BUNGEE_WORKER_STARTUP_WATCHDOG_MS: startupWatchdogMs, BUNGEE_WORKER_ATTACH_GRACE_MS: '1000' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  processes.registerChild(child);
  return child;
}

async function waitForDescriptor(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch { await Bun.sleep(50); }
  }
  throw new Error('supervised worker descriptor did not appear');
}

function command(credential: ReturnType<typeof deriveWorkerSupervisionCredential>, authority: { controller_epoch: number; controller_id: string }, sequence: number, path: string, body: unknown) {
  return signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
    ...credential.identity, ...authority, sequence, request_id: randomUUID(), method: 'POST', path, body_hash: hashSupervisionBody(body) }, credential);
}

describe('supervised worker real process', () => {
  test('attaches, starts the real worker, serves, freezes safely, and shuts down', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-supervised-worker-'));
    temporaryDirectories.push(directory);
    const descriptorPath = join(directory, 'runtime', 'worker.json');
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => request.url.endsWith('/sse')
      ? new Response('data: upstream\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response('upstream-ok') });
    const seed = deriveWorkerSupervisionSeed(root, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
    const child = await spawnWorker(directory, descriptorPath, serializeWorkerSupervisionSeed(seed));
    const authority = { controller_epoch: 1, controller_id: '90000000-0000-4000-8000-000000000001' };
    const descriptor = await waitForDescriptor(descriptorPath);
    const credential = deriveWorkerSupervisionCredential(seed, descriptor.boot_nonce as string);
    expect(verifyWorkerDescriptor(descriptor, credential.process_key)).toBe(true);
    const post = async (path: string, body: unknown) => fetch(`http://127.0.0.1:${descriptor.control_port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      const challenge = await post('/__supervision/challenge', { ...authority, request_id: randomUUID(), sequence: 1 }).then((response) => response.json()) as any;
      const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
        ...credential.identity, ...authority, sequence: 1, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, credential);
      expect((await post('/__supervision/attach', attach)).ok).toBe(true);
      const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...credential.identity, ...authority, sequence: 2, request_id: randomUUID(), lease_expires_at: Date.now() + 2_000 }, credential);
      expect((await post('/__supervision/lease', lease)).ok).toBe(true);
      const config = aggregate(`http://127.0.0.1:${upstream.port}`);
      const start = { command: 'start-current-config-worker' as const, ...identity, revision: 1,
        content_hash: hashConfigurationContent(config), plugin_catalog_hash: catalog.hash, aggregate: config,
        activated_plugin_names: [], publication: null };
      const started = await post('/__supervision/command', { message: command(credential, authority, 3, '/start', start), body: start }).then((response) => response.json()) as any;
      expect(started.body.evidence.kind).toBe('ready');
      const readyEvidence = started.body.evidence.message;
      expect(readyEvidence).toMatchObject({
        status: 'config-ready', plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: null,
        revision: 1, content_hash: start.content_hash, plugin_catalog_hash: catalog.hash,
      });
      const privatePort = started.body.private_port as number;
      expect(await fetch(`http://127.0.0.1:${privatePort}/health`, { headers: privateWorkerHeaders('https://public.example/health') }).then((response) => response.status)).toBe(404);
      expect(await fetch(`http://127.0.0.1:${privatePort}/proxy`, { headers: privateWorkerHeaders('https://public.example/proxy') }).then((response) => response.text())).toBe('upstream-ok');
      expect(await fetch(`http://127.0.0.1:${privatePort}/sse`, { headers: privateWorkerHeaders('https://public.example/sse') }).then((response) => response.text())).toBe('data: upstream\n\n');
      const renewal = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...credential.identity, ...authority, sequence: 4, request_id: randomUUID(), lease_expires_at: Date.now() + 2_000 }, credential);
      const renewed = await post('/__supervision/lease', renewal).then((response) => response.json()) as any;
      expect(renewed.body.evidence.message).toEqual(readyEvidence);
      const status = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
        ...credential.identity, ...authority, sequence: 5, request_id: randomUUID(), status: 'request', body_hash: hashSupervisionBody(null) }, credential);
      await Bun.sleep(2_100);
      const frozen = await post('/__supervision/status', status).then((response) => response.json()) as any;
      expect(frozen.body.frozen).toBe(true);
      expect(frozen.body.evidence.message).toEqual(readyEvidence);
      const frozenDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>;
      expect(verifyWorkerDescriptor(frozenDescriptor, credential.process_key)).toBe(true);
      expect((frozenDescriptor.evidence as any).message).toEqual(readyEvidence);
      expect(await fetch(`http://127.0.0.1:${privatePort}/proxy`, { headers: privateWorkerHeaders('https://public.example/proxy') }).then((response) => response.text())).toBe('upstream-ok');
      const replacementAuthority = { controller_epoch: 2, controller_id: '90000000-0000-4000-8000-000000000002' };
      const replacementChallenge = await post('/__supervision/challenge', { ...replacementAuthority, request_id: randomUUID(), sequence: 1 }).then((response) => response.json()) as any;
      const replacementAttach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
        ...credential.identity, ...replacementAuthority, sequence: 1, request_id: randomUUID(), challenge_nonce: replacementChallenge.message.challenge_nonce }, credential);
      const replacementAttached = await post('/__supervision/attach', replacementAttach).then((response) => response.json()) as any;
      expect(replacementAttached.body.evidence.message).toEqual(readyEvidence);
      const replacementLease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...credential.identity, ...replacementAuthority, sequence: 2, request_id: randomUUID(), lease_expires_at: Date.now() + 2_000 }, credential);
      const replacementLeased = await post('/__supervision/lease', replacementLease).then((response) => response.json()) as any;
      expect(replacementLeased.body.evidence.message).toEqual(readyEvidence);
      const drainBody = { command: 'drain-worker' as const, ...identity, revision: 1,
        content_hash: hashConfigurationContent(config), plugin_catalog_hash: catalog.hash, publication: null };
      const drained = await post('/__supervision/command', {
        message: command(credential, replacementAuthority, 3, '/drain', drainBody), body: drainBody,
      }).then((response) => response.json()) as any;
      expect(drained.body.evidence.kind).toBe('drained');
      const shutdown = await post('/__supervision/command', { message: command(credential, replacementAuthority, 4, '/shutdown', {}), body: {} });
      expect(shutdown.ok).toBe(true);
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('supervised worker did not stop')), 10_000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
      await readFile(descriptorPath).then(
        () => { throw new Error('worker descriptor was not removed'); },
        () => undefined,
      );
    } finally {
      upstream.stop(true);
      await cleanupProcesses(processes);
    }
  }, 30_000);

  test('candidate worker exits on startup watchdog and removes its descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-supervised-worker-candidate-'));
    temporaryDirectories.push(directory);
    const descriptorPath = join(directory, 'runtime', 'worker.json');
    const seed = deriveWorkerSupervisionSeed(root, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
    const child = await spawnWorker(directory, descriptorPath, serializeWorkerSupervisionSeed(seed), '100');
    try {
      await waitForDescriptor(descriptorPath);
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('candidate worker did not exit')), 10_000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
      await readFile(descriptorPath).then(
        () => { throw new Error('candidate descriptor was not removed'); },
        () => undefined,
      );
    } finally {
      await cleanupProcesses(processes);
    }
  }, 20_000);
});
