import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { parseConfigWorkerMessage } from '../../src/config-publication/worker-messages';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { BUILTINS } from '../unit/plugin-manifest-catalog-fixtures';
import { privateWorkerHeaders, TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { SupervisedConfigWorkerFactory } from '../../src/master-runtime/supervised-worker-factory';
import { deriveWorkerSupervisionSeed } from '../../src/supervision';
import { DAEMON_PROCESS_IDENTITY_MARKER_PREFIX } from '@jeffusion/bungee-types';
import { captureMacProcessEnvironment, captureProcessIdentity, captureProcessSnapshot, cleanupProcesses, ProcessRegistry, processAlive } from '../fixtures/process-cleanup';
import type { ProcessIdentitySnapshot } from '../fixtures/process-cleanup';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import { MigrationManager } from '../../src/migrations';

const workerEntry = resolve(import.meta.dir, '../../src/main.ts');
const identities = [0, 1].map((worker_slot) => ({
  master_generation: '51000000-0000-4000-8000-000000000001',
  worker_instance_id: `61000000-0000-4000-8000-00000000000${worker_slot + 1}`,
  worker_slot,
} as const));
const root = new Uint8Array(32).fill(9);
let catalog: PluginManifestCatalog;
const directories: string[] = [];
const processes = new ProcessRegistry();

type SpawnedWorker = ReturnType<SupervisedConfigWorkerFactory['spawn']>;
type IdentityObservation =
  | { readonly kind: 'identity'; readonly value: ProcessIdentitySnapshot | null }
  | { readonly kind: 'exit' }
  | { readonly kind: 'deadline' };

async function waitForExactIdentity(worker: SpawnedWorker, commandMarker: string, testMarker: string): Promise<ProcessIdentitySnapshot> {
  const deadline = Date.now() + 5_000;
  let lastIdentity: ProcessIdentitySnapshot | null = null;
  let exitEvidence: unknown = null;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolvePromise) => { resolveExit = resolvePromise; });
  const unsubscribe = worker.subscribeExit((evidence) => { exitEvidence = evidence; resolveExit(); });
  const diagnostics = (reason: string): Error => new Error(
    `worker ${worker.pid} ${reason}; output=${exitEvidence === null ? '(no captured child output; stdio inherited)' : JSON.stringify(exitEvidence)}; identity=${lastIdentity === null ? '(unavailable)' : JSON.stringify(lastIdentity)}`,
  );
  const commandMarkerMatches = (commandLine: string): boolean => commandLine.split(/\s+/).filter((argument) => argument === commandMarker).length === 1;
  const entrypointMatches = (commandLine: string): boolean => commandLine.split(/\s+/).filter((argument) => argument === workerEntry).length === 1;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<IdentityObservation>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ kind: 'deadline' }), remaining);
      });
      const observation = await Promise.race<IdentityObservation>([
        captureProcessIdentity(worker.pid).then((value) => ({ kind: 'identity', value })),
        exit.then(() => ({ kind: 'exit' as const })),
        timedOut,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (observation.kind === 'exit') throw diagnostics('exited before exact identity was observed');
      if (observation.kind === 'deadline') break;
      lastIdentity = observation.value;
      if (lastIdentity !== null && lastIdentity.pid === worker.pid && commandMarkerMatches(lastIdentity.commandLine)
        && entrypointMatches(lastIdentity.commandLine)
        && (process.platform === 'win32' || process.platform === 'darwin' || lastIdentity.testMarker === testMarker)) {
        const repeated = await captureProcessIdentity(worker.pid);
        if (repeated !== null && repeated.pid === lastIdentity.pid && repeated.startToken === lastIdentity.startToken
          && repeated.executable === lastIdentity.executable && commandMarkerMatches(repeated.commandLine)
          && entrypointMatches(repeated.commandLine)
          && (process.platform === 'win32' || process.platform === 'darwin' || repeated.testMarker === testMarker)
          && exitEvidence === null && processAlive(worker.pid)) return repeated;
        lastIdentity = repeated;
      }
      if (exitEvidence !== null || !processAlive(worker.pid)) throw diagnostics('exited before exact identity was observed');
      await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    throw diagnostics('did not produce an exact identity before the deadline');
  } finally {
    unsubscribe();
  }
}

beforeAll(async () => { catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] }); });
afterAll(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))));
afterEach(async () => cleanupProcesses(processes));

describe('supervised worker factory real detached process', () => {
  test('spawns detached workers without IPC/root, publishes start/drain evidence, and observes real exits', async () => {
    const testMarker = randomUUID();
    const directory = makeCanonicalTempDir('bungee-supervised-factory');
    directories.push(directory);
    const managementProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 204 }) });
    const managementPort = managementProbe.port!;
    await managementProbe.stop(true);
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('factory-upstream') });
    const aggregateResult = parseNormalizeCompileAggregate({
      logical_configuration: {
        services: [{ id: '11000000-0000-4000-8000-000000000001', position: 1, name: 'upstream', endpoints: [{
          id: '31000000-0000-4000-8000-000000000001', position: 1, target: `http://127.0.0.1:${upstream.port}`,
        }] }],
        routes: [
          { id: '21000000-0000-4000-8000-000000000001', position: 1, path: '/proxy', service_id: '11000000-0000-4000-8000-000000000001' },
          { id: '21000000-0000-4000-8000-000000000002', position: 2, path: '/limited', service_id: '11000000-0000-4000-8000-000000000001',
            rate_limit: { enabled: true, requests_per_second: 1, burst: 1 } },
        ],
        plugins: [],
      }, plugin_activations: [],
    }, catalog.toCompileOptions());
    if (!aggregateResult.ok) throw new Error('test aggregate did not compile');
    const aggregate = aggregateResult.value;
    const accessLogDbPath = join(directory, 'logs', 'access.db');
    const migration = await new MigrationManager(accessLogDbPath).migrate();
    expect(migration.success).toBe(true);
    const factory = new SupervisedConfigWorkerFactory({
      launch: { source: 'source', executable: process.execPath, args: [workerEntry] }, rootKey: root,
      runtimeWorkersDirectory: join(directory, 'runtime', 'workers'), authority: {
        controller_epoch: 1, controller_id: '91000000-0000-4000-8000-000000000001',
      }, managementHost: '127.0.0.1', managementPort, cwd: directory, accessLogDbPath, transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      env: { ...process.env, BUNGEE_TEST_PROCESS_MARKER: testMarker, PLUGINS_DIR: BUILTINS, BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false', BUNGEE_PLUGIN_SECRETS_KEY: 'must-not-cross',
        BUNGEE_INGRESS_CREDENTIAL: 'must-not-cross', BUNGEE_PLUGIN_BINDING_OPTIONS: 'must-not-cross',
        BUNGEE_INGRESS_SUPERVISION_PORT: '3010', BUNGEE_INGRESS_PROCESS_INSTANCE_ID: '70000000-0000-4000-8000-000000000001',
        BUNGEE_INGRESS_BOOT_NONCE: '70000000-0000-4000-8000-000000000002' },
      client: { timeoutMs: 2_000, leaseDurationMs: 1_000, renewBeforeMs: 300 },
      initializationTimeoutMs: 15_000, shutdownTimeoutMs: 15_000,
    });
    const workers: ReturnType<typeof factory.spawn>[] = [];
    try {
      for (const identity of identities) {
        const worker = factory.spawn(identity);
        const proof = await waitForExactIdentity(worker, `${DAEMON_PROCESS_IDENTITY_MARKER_PREFIX}${identity.worker_instance_id}`, testMarker);
        expect(processes.registerPid(worker.pid, proof, { role: 'worker' })).toBe(worker.pid);
        workers.push(worker);
      }
      const messages: unknown[][] = workers.map(() => []);
      workers.forEach((worker, index) => worker.subscribeMessage((message) => messages[index].push(message)));
      const startMessages = identities.map((identity) => ({ command: 'start-current-config-worker' as const, ...identity, revision: 1,
        content_hash: hashConfigurationContent(aggregate), plugin_catalog_hash: catalog.hash, aggregate,
        activated_plugin_names: [], publication: null }));
      await Promise.all(workers.map((worker, index) => worker.send(startMessages[index])));
      const ready = messages.map((messagesForWorker) => parseConfigWorkerMessage(messagesForWorker[0]));
      expect(ready.every((message) => 'status' in message && message.status === 'config-ready')).toBe(true);
      const controlPorts = await Promise.all(identities.map(async (identity) =>
        (JSON.parse(await readFile(join(directory, 'runtime', 'workers', `${identity.worker_instance_id}.json`), 'utf8')) as { control_port: number }).control_port));
      expect(controlPorts.every((port) => port > 0 && port <= 65_535)).toBe(true);
      expect(new Set(controlPorts).size).toBe(controlPorts.length);
      const privatePorts = ready.map((message) => 'status' in message && message.status === 'config-ready' ? message.private_port : 0);
      expect(await fetch(`http://127.0.0.1:${privatePorts[0]}/proxy`, { headers: privateWorkerHeaders('https://public.example/proxy') }).then((response) => response.text())).toBe('factory-upstream');
      expect(await fetch(`http://127.0.0.1:${privatePorts[0]}/limited`, { headers: privateWorkerHeaders('https://public.example/limited') }).then((response) => response.status)).toBe(503);
      const adopter = new SupervisedConfigWorkerFactory({
        launch: { source: 'source', executable: process.execPath, args: [workerEntry] }, rootKey: root,
        runtimeWorkersDirectory: join(directory, 'runtime', 'workers'), authority: {
          controller_epoch: 2, controller_id: '91000000-0000-4000-8000-000000000002',
        }, managementHost: '127.0.0.1', managementPort, accessLogDbPath, transportSecret: TEST_WORKER_TRANSPORT_SECRET,
        client: { timeoutMs: 2_000, leaseDurationMs: 1_000, renewBeforeMs: 300 }, shutdownTimeoutMs: 15_000,
      });
      const admission = {
        master_generation: identities[0]!.master_generation, admission_sequence: 1, revision: 1,
        content_hash: startMessages[0]!.content_hash, plugin_catalog_hash: catalog.hash,
        workers: ready.map((message) => {
        if (!('status' in message) || message.status !== 'config-ready') throw new Error('missing ready evidence');
        return { master_generation: message.master_generation, worker_instance_id: message.worker_instance_id, worker_slot: message.worker_slot,
          boot_nonce: message.boot_nonce, private_port: message.private_port };
      }) };
      const failedAdoption = await adopter.discoverAndAdopt({ ...admission, revision: 2 });
      expect(failedAdoption.kind).toBe('recovering');
      const adopted = await adopter.discoverAndAdopt(admission);
      expect(adopted.kind).toBe('adopted');
      const repeated = await adopter.discoverAndAdopt(admission);
      expect(repeated.kind).toBe('adopted');
      let drainWorkers = workers;
      if (adopted.kind === 'adopted') {
        expect(adopted.workers).toHaveLength(2);
        expect(adopted.workers.every((worker) => worker.origin === 'adopted')).toBe(true);
        drainWorkers = [...adopted.workers];
        if (repeated.kind === 'adopted') expect(repeated.workers).toEqual(adopted.workers);
        adopted.workers.forEach((worker, index) => worker.subscribeMessage((message) => messages[index]!.push(message)));
      }
      await Promise.all(drainWorkers.map((worker, index) => worker.send({ command: 'drain-worker', ...identities[index], revision: 1,
        content_hash: startMessages[index].content_hash, plugin_catalog_hash: catalog.hash, publication: null })));
      const drained = messages.map((messagesForWorker) => parseConfigWorkerMessage(messagesForWorker[1]));
      expect(drained.every((message) => 'status' in message && message.status === 'worker-drained')).toBe(true);
      const workerIdentities = await captureProcessSnapshot();
      for (const worker of workers) {
        const identity = workerIdentities.find(({ pid }) => pid === worker.pid);
        expect(identity).toBeDefined();
        if (identity === undefined) throw new Error(`worker ${worker.pid} identity disappeared`);
        expect(process.platform === 'win32' || process.platform === 'darwin' || identity.testMarker === testMarker).toBe(true);
        if (process.platform === 'linux') {
          const environment = (await readFile(`/proc/${worker.pid}/environ`)).toString('utf8');
          expect(environment).not.toContain('must-not-cross');
          expect(environment).not.toContain('BUNGEE_INGRESS_SUPERVISION_PORT=3010');
          expect(environment).not.toContain('BUNGEE_INGRESS_PROCESS_INSTANCE_ID=70000000-0000-4000-8000-000000000001');
          expect(environment).not.toContain('BUNGEE_INGRESS_BOOT_NONCE=70000000-0000-4000-8000-000000000002');
          expect(environment).toContain('BUNGEE_MANAGEMENT_HOST=127.0.0.1');
          expect(environment).toContain(`BUNGEE_MANAGEMENT_PORT=${managementPort}`);
          expect(environment).not.toContain(Buffer.from(root).toString('base64url'));
        } else if (process.platform === 'darwin') {
          const environment = await captureMacProcessEnvironment(worker.pid, [
            'must-not-cross', 'BUNGEE_INGRESS_SUPERVISION_PORT=3010',
            'BUNGEE_INGRESS_PROCESS_INSTANCE_ID=70000000-0000-4000-8000-000000000001',
            'BUNGEE_INGRESS_BOOT_NONCE=70000000-0000-4000-8000-000000000002', Buffer.from(root).toString('base64url'),
          ]);
          expect(environment.containsForbidden).toBe(false);
        }
        expect(worker.origin).toBe('spawned');
      }
      await adopter.shutdownOwned();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && workers.some((worker) => processAlive(worker.pid))) await Bun.sleep(25);
      const exits = await factory.shutdownOwned();
      expect(exits).toHaveLength(2);
      expect(exits.every((evidence) => evidence.exited)).toBe(true);
    } finally {
      try { await factory.shutdownOwned(); } catch { /* registry performs exact-PID fallback */ }
      factory.disconnect();
      await upstream.stop(true);
      await cleanupProcesses(processes);
    }
  }, 45_000);
});
