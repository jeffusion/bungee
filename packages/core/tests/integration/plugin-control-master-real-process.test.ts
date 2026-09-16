import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  cleanupMaster,
  createMasterCleanupScope,
  createMasterFixture,
  expectPortClosed,
  freePort,
  isIngressProcess,
  isWorkerProcess,
  processAlive,
  readWorkerDescriptors,
  removeFixture,
  runWithCleanup,
  sourceMasterEntry,
  spawnMaster,
  waitForDead,
  waitForHealth,
  waitForWorkerDescriptors,
  waitUntil,
  childPids,
  cleanupSpawnedProcesses,
  captureProcessSnapshot,
  type RunningMaster,
} from '../fixtures/master-real-process-harness';
import { captureMacProcessEnvironment, captureProcessIdentity, processIdentityMatches, processLiveness } from '../fixtures/process-cleanup';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

const PLUGIN = 'managed-e2e';
const BINDING_ID = '50000000-0000-4000-8000-000000000001';
const MARKER = 'managed-e2e-marker';
const AUTHORIZATION = 'Bearer managed-e2e-credential';
const FIXTURE_HEADER = 'managed-e2e-header';
const ROOT_MATERIAL = Buffer.alloc(32, 9).toString('base64');
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const CONTROL = `import { appendFile } from 'node:fs/promises';
export function createControl() {
  return {
    api: [
      { path: '/fixture/accounts', methods: ['GET'], handler: 'listAccounts', invoke: async () => Response.json([]) },
      { path: '/fixture/drafts', methods: ['POST'], handler: 'createDraft', invoke: async () => Response.json({ ok: true }) },
    ],
    rpc: [{ name: 'getCredential', handler: 'getCredential', access: 'bound-attempt', invoke: async (_payload, context) => {
      const options = context.binding.bindingOptions;
      await appendFile(options.auditPath, JSON.stringify({
        attemptId: context.attempt.attemptId,
        plugin: context.binding.plugin,
        contributionId: context.binding.contributionId,
        bindingId: context.binding.bindingId,
        marker: options.marker,
      }) + '\\n');
      return { version: 1, expiresAt: Date.now() + 60_000, headers: {
        authorization: 'Bearer managed-e2e-credential',
        'x-managed-e2e-header': 'managed-e2e-header',
      } };
    } }],
    start() {},
    dispose() {},
  };
}
`;

const INDEX = `import { readFileSync } from 'node:fs';
function bootNonce() {
  const path = process.env.BUNGEE_WORKER_DESCRIPTOR_PATH;
  if (!path) return undefined;
  try {
    const descriptor = JSON.parse(readFileSync(path, 'utf8'));
    return typeof descriptor.boot_nonce === 'string' ? descriptor.boot_nonce : undefined;
  } catch { return undefined; }
}
export default class ManagedE2EPlugin {
  static name = 'managed-e2e';
  static version = '1.0.0';
  static async createHandler(config) {
    if (config.barrierUrl) {
      const barrier = await fetch(config.barrierUrl + '/wait?marker=' + encodeURIComponent(config.marker), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          marker: config.marker,
          pid: process.pid,
          master_generation: process.env.BUNGEE_MASTER_GENERATION,
          worker_instance_id: process.env.BUNGEE_WORKER_INSTANCE_ID,
          worker_slot: Number(process.env.BUNGEE_WORKER_SLOT),
          ...(bootNonce() === undefined ? {} : { boot_nonce: bootNonce() }),
        }),
      });
      if (!barrier.ok) throw new Error('publication barrier rejected candidate');
    }
    return { pluginName: 'managed-e2e', config, register() {}, destroy() {} };
  }
}
`;

type RequestRecord = { readonly path: string; readonly method: string; readonly headers: Readonly<Record<string, string>> };
type AuditRecord = { readonly attemptId: string; readonly plugin: string; readonly contributionId: string; readonly bindingId: string; readonly marker: string };
type Authority = { readonly controller_epoch: number; readonly controller_id: string };
type RuntimeWorkerDto = {
  readonly master_generation: string; readonly worker_instance_id: string; readonly boot_nonce: string;
  readonly slot: number; readonly pid: number; readonly private_port: number; readonly revision: number;
  readonly content_hash: string; readonly plugin_catalog_hash: string; readonly publication: unknown;
};

function descriptorPublication(descriptor: Record<string, unknown>): unknown {
  const evidence = descriptor.evidence as { readonly kind?: unknown; readonly message?: Record<string, unknown> } | undefined;
  return evidence?.kind === 'ready' ? evidence.message?.publication ?? null : null;
}

function supervisionState(dbPath: string): { readonly instance_id: string } & Authority {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = db.query<{ instance_id: string; controller_epoch: number; current_controller_id: string }, []>(
      'SELECT instance_id, controller_epoch, current_controller_id FROM supervision_state WHERE id=1',
    ).get();
    if (row === null || row.current_controller_id === null) throw new Error('supervision state is not claimed');
    return { instance_id: row.instance_id, controller_epoch: row.controller_epoch, controller_id: row.current_controller_id };
  } finally { db.close(true); }
}

function managedAggregate(origin: string, auditPath: string, marker: string, barrierUrl?: string): ConfigurationAggregateV2 {
  return {
    plugin_activations: [{ plugin_name: PLUGIN }],
    logical_configuration: {
      auth: { enabled: true, tokens: [TOKEN] },
      services: [{ id: '10000000-0000-4000-8000-000000000001', position: 1, name: 'managed-service', plugins: [], endpoints: [{
        id: '30000000-0000-4000-8000-000000000001', position: 1, target: origin, weight: 100, priority: 1, is_disabled: false,
        managedBy: { plugin: PLUGIN, contributionId: 'managed-source', bindingId: BINDING_ID },
        plugins: [{ id: BINDING_ID, position: 1, name: PLUGIN, enabled: true, options: {
          auditPath, marker, ...(barrierUrl === undefined ? {} : { barrierUrl }),
        } }],
      }] }],
      routes: [{ id: '20000000-0000-4000-8000-000000000001', position: 1, path: '/managed', service_id: '10000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [] }],
      plugins: [],
    },
  } as ConfigurationAggregateV2;
}

async function sourceMainPids(): Promise<Set<number>> {
  const needle = resolve(import.meta.dir, '../../src/main.ts');
  const executableMatches = (actual: string): boolean => process.platform === 'win32'
    ? actual.toLowerCase() === process.execPath.toLowerCase() : actual === process.execPath;
  return new Set((await captureProcessSnapshot())
    .filter(({ executable, commandLine }) => executableMatches(executable) && commandLine.includes(needle))
    .map(({ pid }) => pid));
}

async function audit(path: string): Promise<AuditRecord[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? [] : text.trim().split('\n').map((line) => JSON.parse(line) as AuditRecord);
  } catch { return []; }
}

async function requestPublic(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/managed`, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(450),
  });
}

function descriptorIdentity(descriptor: Record<string, unknown>): string {
  return [descriptor.master_generation, descriptor.worker_instance_id, descriptor.worker_slot,
    descriptor.boot_nonce, descriptor.pid, descriptor.private_port].join(':');
}

function exactDescriptors(descriptors: readonly Record<string, unknown>[], expected: readonly Record<string, unknown>[], revision: number): readonly Record<string, unknown>[] {
  const expectedIds = new Set(expected.map(descriptorIdentity));
  return descriptors.filter((descriptor) => Number(descriptor.revision) === revision && expectedIds.has(descriptorIdentity(descriptor)));
}

test('real master takeover and publication window preserve durable serving credentials', async () => {
  const beforePids = await sourceMainPids();
  const fixture = await createMasterFixture('bungee-managed-e2e-');
  const pluginPath = join(fixture.pluginsPath, PLUGIN);
  const auditPath = join(fixture.root, 'managed-audit.jsonl');
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let first: RunningMaster | null = null;
  let second: RunningMaster | null = null;
  let third: RunningMaster | null = null;
  let firstWorkers: readonly number[] = [];
  let ingressPid: number | undefined;
  let port = 0;
  const requests: RequestRecord[] = [];
  type BarrierCandidate = {
    readonly pid: number;
    readonly master_generation: string;
    readonly worker_instance_id: string;
    readonly worker_slot: number;
    readonly boot_nonce?: string;
  };
  const barrierCandidates = new Map<string, BarrierCandidate>();
  const barrierWaiters = new Map<string, (response: Response) => void>();
  type BarrierOutcome = 'released' | 'rejected' | 'aborted' | 'timeout';
  const barrierOutcomes = new Map<string, BarrierOutcome>();
  let barrierCompleted = 0;
  const barrier = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    if (new URL(request.url).pathname !== '/wait') return new Response('not found', { status: 404 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body: Partial<BarrierCandidate> & { marker?: string };
    try { body = await request.json() as Partial<BarrierCandidate> & { marker?: string }; }
    catch { return new Response('invalid candidate', { status: 400 }); }
    const workerSlot = body.worker_slot;
    if (body.marker !== 'NEW' || typeof body.pid !== 'number' || !Number.isSafeInteger(body.pid)
      || typeof body.master_generation !== 'string' || typeof body.worker_instance_id !== 'string'
      || typeof workerSlot !== 'number' || !Number.isSafeInteger(workerSlot) || workerSlot < 0
      || (body.boot_nonce !== undefined && typeof body.boot_nonce !== 'string')) {
      return new Response('invalid candidate', { status: 400 });
    }
    const candidate: BarrierCandidate = {
      pid: body.pid,
      master_generation: body.master_generation,
      worker_instance_id: body.worker_instance_id,
      worker_slot: workerSlot,
      ...(body.boot_nonce === undefined ? {} : { boot_nonce: body.boot_nonce }),
    };
    const key = [candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':');
    if (barrierCandidates.has(key)) {
      const outcome = barrierOutcomes.get(key);
      return outcome === 'released'
        ? new Response('released')
        : new Response(outcome ?? 'duplicate candidate', { status: outcome === undefined ? 409 : 503 });
    }
    barrierCandidates.set(key, candidate);
    const response = await new Promise<Response>((resolve) => {
      let settled = false;
      const finish = (result: Response): void => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        barrierWaiters.delete(key);
        barrierOutcomes.set(key, 'aborted');
        resolve(new Response('aborted', { status: 499 }));
      };
      barrierWaiters.set(key, finish);
      request.signal.addEventListener('abort', onAbort, { once: true });
    });
    barrierCompleted += 1;
    return response;
  } });
  const releaseBarrierBatch = (keys: readonly string[]): void => {
    for (const key of keys) {
      barrierOutcomes.set(key, 'released');
      const waiter = barrierWaiters.get(key);
      if (waiter === undefined) continue;
      barrierWaiters.delete(key);
      waiter(new Response('released'));
    }
  };
  const abortBarrierBatch = (keys: readonly string[], outcome: 'rejected' | 'aborted' | 'timeout'): void => {
    for (const key of keys) {
      if (barrierOutcomes.has(key)) continue;
      barrierOutcomes.set(key, outcome);
      const waiter = barrierWaiters.get(key);
      if (waiter === undefined) continue;
      barrierWaiters.delete(key);
      waiter(new Response(outcome, { status: outcome === 'rejected' ? 503 : 504 }));
    }
  };
  await runWithCleanup(async () => {
    await Bun.write(auditPath, '');
    await Bun.write(join(pluginPath, 'index.js'), INDEX);
    const cert = await readFile(resolve(import.meta.dir, '../fixtures/tls/managed-upstream.crt.pem'), 'utf8');
    const key = await readFile(resolve(import.meta.dir, '../fixtures/tls/managed-upstream.key.pem'), 'utf8');
    upstream = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls: { cert, key },
      fetch: (request) => {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, name) => { headers[name] = value; });
        requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          headers,
        });
        return new Response('managed-upstream-ok');
      },
    });
    if (upstream.port === undefined) throw new Error('TLS upstream did not bind');
    await Bun.write(join(pluginPath, 'manifest.json'), JSON.stringify({
      name: PLUGIN, version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js',
      control: { entry: 'control.js', rpc: [{ name: 'getCredential', access: 'bound-attempt' }] },
      capabilities: ['hooks', 'api', 'controlPlane', 'dynamicRuntimeLoad'], uiExtensionMode: 'none',
      engines: { bungee: '^4.3.0' },
      configSchema: [
        { name: 'auditPath', type: 'string', label: 'Audit path', required: true },
        { name: 'marker', type: 'string', label: 'Marker', required: true },
        { name: 'barrierUrl', type: 'string', label: 'Barrier URL', required: false },
      ],
      contributes: {
        api: [
          { path: '/fixture/accounts', methods: ['GET'], handler: 'listAccounts', execution: 'control' },
          { path: '/fixture/drafts', methods: ['POST'], handler: 'createDraft', execution: 'control' },
        ],
        upstreamSources: [{
          id: 'managed-source', label: 'Managed E2E source', listAccounts: 'listAccounts', createDraft: 'createDraft',
          credentialPolicy: {
            allowedOrigins: [`https://127.0.0.1:${upstream.port}`],
            allowedRequests: [{ pathname: '/managed', methods: ['GET'] }],
            allowedHeaderNames: ['Authorization', 'x-managed-e2e-header'],
          },
        }],
      },
    }) + '\n');
    await Bun.write(join(pluginPath, 'control.js'), CONTROL);

    port = await freePort(cleanupScope);
    const entry = sourceMasterEntry();
    first = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    const firstTestMarker = first.testMarker;
    await waitForHealth(port, first);
    const firstState = supervisionState(fixture.dbPath);
    const serviceId = '10000000-0000-4000-8000-000000000001';
    const routeId = '20000000-0000-4000-8000-000000000001';
    const endpointId = '30000000-0000-4000-8000-000000000001';
    const aggregate = {
      plugin_activations: [{ plugin_name: PLUGIN }],
      logical_configuration: {
        auth: { enabled: true, tokens: [TOKEN] },
        plugins: [],
        services: [{ id: serviceId, position: 1, name: 'managed service', plugins: [], endpoints: [{
          id: endpointId, position: 1, target: `https://127.0.0.1:${upstream.port}`, weight: 100, priority: 1, is_disabled: false,
          managedBy: { plugin: PLUGIN, contributionId: 'managed-source', bindingId: BINDING_ID },
          plugins: [{ id: BINDING_ID, position: 1, name: PLUGIN, enabled: true, options: { auditPath, marker: MARKER } }],
        }] }],
        routes: [{ id: routeId, position: 1, path: '/managed', service_id: serviceId, auth: { enabled: false, tokens: [] }, plugins: [] }],
      },
    } satisfies ConfigurationAggregateV2;
    const mutationId = '40000000-0000-4000-8000-000000000001';
    const mutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: mutationId }),
    });
    expect(mutation.status).toBe(202);
    try {
      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        const body = await response.json() as { operation?: { state?: string; error?: unknown } };
        if (body.operation?.state === 'failed') throw new Error(`managed plugin operation failed: ${JSON.stringify(body)}`);
        return body.operation?.state === 'converged';
      }, 'managed plugin publication did not converge', 30_000);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${first?.output() ?? ''}`);
    }

    const ingressPort = port + 1;
    for (let index = 0; index < 3; index += 1) {
      const response = await requestPublic(ingressPort);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('managed-upstream-ok');
    }
    const firstAudit = await audit(auditPath);
    expect(firstAudit).toHaveLength(3);
    expect(new Set(firstAudit.map((entry) => entry.attemptId)).size).toBe(3);
    expect(firstAudit.every((entry) => entry.plugin === PLUGIN && entry.contributionId === 'managed-source'
      && entry.bindingId === BINDING_ID && entry.marker === MARKER)).toBe(true);
    expect(JSON.stringify(firstAudit)).not.toContain(AUTHORIZATION);

    const firstDescriptors = await waitForWorkerDescriptors(fixture, 2);
    firstWorkers = firstDescriptors.map((descriptor) => Number(descriptor.pid));
    expect(firstWorkers.every(processAlive)).toBe(true);
    if (process.platform === 'linux') {
      for (const pid of firstWorkers) {
        const environment = (await readFile(`/proc/${pid}/environ`)).toString('utf8');
        expect(environment).not.toContain(auditPath);
        expect(environment).not.toContain(MARKER);
        expect(environment).not.toContain(AUTHORIZATION);
        expect(environment).not.toContain('BUNGEE_PLUGIN_SECRETS_KEY');
        expect(environment).toContain(`BUNGEE_TEST_PROCESS_MARKER=${firstTestMarker}`);
      }
    } else {
      const workerIdentities = await captureProcessSnapshot();
      const observedWorkers = firstWorkers.map((pid) => workerIdentities.find((identity) => identity.pid === pid));
      expect(observedWorkers.every((identity) => identity !== undefined && identity.pid > 0 && processAlive(identity.pid))).toBe(true);
      if (process.platform === 'darwin') {
        const environments = await Promise.all(firstWorkers.map((pid) => captureMacProcessEnvironment(pid, [auditPath, MARKER, AUTHORIZATION, 'BUNGEE_PLUGIN_SECRETS_KEY'])));
        expect(environments.every((environment) => environment.containsForbidden === false)).toBe(true);
      }
    }
    if (first?.child.pid === undefined) throw new Error('master PID unavailable');
    for (const pid of await childPids(first.child.pid)) if (await isIngressProcess(pid)) ingressPid = pid;
    if (ingressPid === undefined) throw new Error('ingress PID unavailable');
    const beforeTakeoverRequests = requests.length;
    const beforeTakeoverAudit = firstAudit.length;
    await first.synchronizeOwnership();
    first.child.kill('SIGKILL');
    await waitForDead([first.child.pid]);
    await waitUntil(async () => {
      const response = await requestPublic(ingressPort);
      const body = await response.text();
      return response.status === 503 && body === '{"error":"Service Unavailable"}';
    }, 'ingress did not fail closed after master loss', 10_000);
    expect(requests.length).toBe(beforeTakeoverRequests);
    expect((await audit(auditPath)).length).toBe(beforeTakeoverAudit);

    second = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath,
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { adoptReparentedWorkers: true });
    await waitForHealth(port, second);
    const secondState = supervisionState(fixture.dbPath);
    expect(secondState.controller_epoch).toBe(firstState.controller_epoch + 1);
    expect(secondState.controller_id).not.toBe(firstState.controller_id);
    const secondChildren = second.child.pid === undefined ? [] : await childPids(second.child.pid);
    expect((await Promise.all(secondChildren.map(async (pid) => (await isWorkerProcess(pid)) ? pid : null)))
      .filter((pid): pid is number => pid !== null)).toHaveLength(0);
    const secondDescriptors = await waitForWorkerDescriptors(fixture, 2);
    await waitUntil(async () => {
      const registeredWorkers = second!.processes.registeredProcesses.filter(({ role }) => role === 'worker');
      if (registeredWorkers.length !== secondDescriptors.length
        || second!.processes.registeredProcesses.some(({ role }) => role === 'ingress')) return false;
      return secondDescriptors.every((descriptor) => {
        const registered = registeredWorkers.find(({ pid }) => pid === descriptor.pid);
        const identity = registered?.identity;
        return identity !== undefined && processAlive(Number(descriptor.pid))
          && identity.pid === Number(descriptor.pid)
          && identity.commandLine.split(/\s+/u).includes(`--bungee-process-identity=${descriptor.worker_instance_id}`);
      });
    }, 'adopted master did not register exact descriptor-backed candidate workers', 15_000);
    expect(secondDescriptors.map((descriptor) => ({ worker_instance_id: descriptor.worker_instance_id, pid: descriptor.pid, boot_nonce: descriptor.boot_nonce, private_port: descriptor.private_port }))
      .sort((left, right) => String(left.worker_instance_id).localeCompare(String(right.worker_instance_id))))
      .toEqual(firstDescriptors.map((descriptor) => ({ worker_instance_id: descriptor.worker_instance_id, pid: descriptor.pid, boot_nonce: descriptor.boot_nonce, private_port: descriptor.private_port }))
        .sort((left, right) => String(left.worker_instance_id).localeCompare(String(right.worker_instance_id))));
    let lastRecoveryResponse = '';
    try {
      await waitUntil(async () => {
        const response = await requestPublic(ingressPort);
        const body = await response.text();
        lastRecoveryResponse = `${response.status}:${body}`;
        return response.status === 200 && body === 'managed-upstream-ok';
      }, 'managed ingress did not recover after master takeover', 30_000);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} (last=${lastRecoveryResponse})`);
    }
    const recoveredAuditCount = (await audit(auditPath)).length;
    const recoveredRequestCount = requests.length;
    for (let index = 0; index < 3; index += 1) {
      const response = await requestPublic(ingressPort);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('managed-upstream-ok');
    }
    const finalAudit = await audit(auditPath);
    expect(finalAudit).toHaveLength(recoveredAuditCount + 3);
    expect(new Set(finalAudit.map((entry) => entry.attemptId)).size).toBe(finalAudit.length);
    expect(requests).toHaveLength(recoveredRequestCount + 3);
    expect(finalAudit.every((entry) => entry.plugin === PLUGIN && entry.contributionId === 'managed-source'
      && entry.bindingId === BINDING_ID && entry.marker === MARKER && entry.attemptId.length > 0)).toBe(true);
    expect(requests.every((request) => request.path === '/managed' && request.method === 'GET'
      && request.headers.authorization === AUTHORIZATION && request.headers['x-managed-e2e-header'] === FIXTURE_HEADER
      && !JSON.stringify(request.headers).includes(MARKER)
      && !JSON.stringify(request.headers).includes(auditPath)
      && !JSON.stringify(request.headers).includes(ROOT_MATERIAL))).toBe(true);
     if (second === null || second.child.pid === undefined || barrier.port === undefined) throw new Error('publication window setup missing');
     const secondStateForWindow = supervisionState(fixture.dbPath);
     const barrierUrl = `http://127.0.0.1:${barrier.port}`;
     const nextAggregate = managedAggregate(`https://127.0.0.1:${upstream!.port}`, auditPath, 'NEW', barrierUrl);
     const nextMutationId = crypto.randomUUID();
     const nextMutation = fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: {
       authorization: `Bearer ${TOKEN}`, 'x-bungee-next-authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json',
     }, body: JSON.stringify({ expected_revision: 2, aggregate: nextAggregate, mutation_id: nextMutationId }) });
     const nextMutationSettled = nextMutation.catch(() => undefined);
     const nextMutationResponse = await nextMutation;
     if (nextMutationResponse.status !== 202) throw new Error(`publication mutation rejected: ${nextMutationResponse.status} ${await nextMutationResponse.text()}`);
     let lastPublicationOperation: unknown;
     const publicationDiagnostics = async (): Promise<string> => {
       let operation: unknown = lastPublicationOperation;
       try {
         operation = await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${nextMutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
       } catch { /* master may be between takeover and health */ }
       return `operation=${JSON.stringify(operation)} hits=${JSON.stringify([...barrierCandidates.values()])} outcomes=${JSON.stringify([...barrierOutcomes.entries()])} descriptors=${JSON.stringify(await readWorkerDescriptors(fixture))} master=${third?.output() ?? ''}`;
     };
     try { await waitUntil(async () => {
       const candidates = [...barrierCandidates.values()];
       if (candidates.length === 2 && new Set(candidates.map((candidate) => candidate.worker_slot)).size === 2
         && candidates.every((candidate) => barrierWaiters.has([candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':')))) return true;
       const operation = await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${nextMutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any;
       lastPublicationOperation = operation;
       if (operation.operation?.state === 'failed') throw new Error(`publication failed before barrier: ${JSON.stringify(operation)}`);
       return false;
     }, 'replacement did not reach the real lifecycle barrier', 7_000); }
     catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`); }
     const firstBatchCandidates = [...barrierCandidates.values()];
     const firstBatchKeys = firstBatchCandidates.map((candidate) => [candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':'));
     const currentConfig = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { revision: number; content_hash: string };
     expect(currentConfig.revision).toBe(3);
     const publicationOperation = await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${nextMutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { operation?: { state?: string; committed_revision?: number } };
     expect(['committed', 'publishing'].includes(publicationOperation.operation?.state ?? '')).toBe(true);
     expect(publicationOperation.operation?.committed_revision).toBe(3);
     const oldBeforeTakeover = (await audit(auditPath)).filter((entry) => entry.marker === MARKER).length;
     const oldRequestsStarted = performance.now();
     for (let index = 0; index < 3; index += 1) {
       const requestStarted = performance.now();
       const response = await requestPublic(ingressPort);
       expect(performance.now() - requestStarted).toBeLessThan(500);
       expect(response.status).toBe(200);
       expect(await response.text()).toBe('managed-upstream-ok');
     }
     expect(performance.now() - oldRequestsStarted).toBeLessThan(1_500);
     expect((await audit(auditPath)).filter((entry) => entry.marker === MARKER).length).toBe(oldBeforeTakeover + 3);
     const snapshotDb = new Database(fixture.dbPath, { readonly: true, strict: true });
     try {
       const oldRows = snapshotDb.query<{ revision: number; plugin_catalog_hash: string; aggregate_json: string }, []>(
         'SELECT revision, plugin_catalog_hash, aggregate_json FROM configuration_serving_snapshots WHERE revision=2',
       ).all();
       expect(oldRows).toHaveLength(1);
       expect(oldRows[0]!.aggregate_json).toContain('"marker":"' + MARKER + '"');
       expect(oldRows[0]!.plugin_catalog_hash.length).toBeGreaterThan(0);
     } finally { snapshotDb.close(true); }
     second.child.kill('SIGKILL');
     await waitForDead([second.child.pid]);
     abortBarrierBatch(firstBatchKeys, 'rejected');
     await waitUntil(() => Promise.resolve(barrierCompleted >= 2), 'first replacement barrier did not complete', 7_000);
     await waitUntil(async () => {
       const descriptors = await readWorkerDescriptors(fixture);
       return firstBatchCandidates.every((candidate) => !processAlive(candidate.pid)
         || descriptors.some((descriptor) => descriptor.pid === candidate.pid
           && (descriptor.phase === 'failed' || descriptor.frozen === true)));
     }, 'M2 rejected candidates did not terminate', 10_000);
     expect(firstBatchKeys.every((key) => ['rejected', 'aborted'].includes(barrierOutcomes.get(key) ?? ''))).toBe(true);
     expect(firstBatchKeys.every((key) => barrierOutcomes.get(key) !== 'released')).toBe(true);
     third = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
     let thirdHealthError: unknown;
     const thirdHealth = waitForHealth(port, third).catch((error) => { thirdHealthError = error; });
     let m3ListenerCandidates: readonly BarrierCandidate[] = [];
     let secondBatchCandidates: readonly BarrierCandidate[] = [];
     try {
       await waitUntil(async () => {
         const candidates = [...barrierCandidates.entries()]
           .filter(([key]) => !firstBatchKeys.includes(key)).map(([, candidate]) => candidate);
         if (candidates.length === 2 && new Set(candidates.map((candidate) => candidate.worker_slot)).size === 2
           && candidates.every((candidate) => barrierWaiters.has([candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':')))) {
           m3ListenerCandidates = candidates;
           return true;
         }
         return false;
       }, 'Master3 listener did not expose hits 3-4', 7_000);
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     let failedPublication: any;
     try {
       await waitUntil(async () => {
         try {
           failedPublication = await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${nextMutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
         } catch { return false; }
         return failedPublication.operation?.state === 'degraded'
           && failedPublication.operation?.error_code === 'replacement_convergence_failed'
           && failedPublication.workers?.length === 2
           && failedPublication.workers.every((worker: any) => worker.attempt_no === 2
             && worker.state === 'failed' && worker.last_error === 'worker config-ready timed out');
       }, 'M3 listener batch did not time out as expected', 20_000);
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     const listenerBatchKeys = m3ListenerCandidates.map((candidate) => [candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':'));
     abortBarrierBatch(listenerBatchKeys, 'timeout');
     expect(listenerBatchKeys.every((key) => ['aborted', 'timeout'].includes(barrierOutcomes.get(key) ?? ''))).toBe(true);
     expect(listenerBatchKeys.every((key) => barrierOutcomes.get(key) !== 'released')).toBe(true);
     await thirdHealth;
     if (thirdHealthError !== undefined) throw new Error(`${thirdHealthError instanceof Error ? thirdHealthError.message : String(thirdHealthError)}\n${await publicationDiagnostics()}`);
     try {
       await waitUntil(async () => {
         const candidates = [...barrierCandidates.entries()]
           .filter(([key]) => !firstBatchKeys.includes(key)).map(([, candidate]) => candidate);
         const retryCandidates = candidates.filter((candidate) => !m3ListenerCandidates.some((listener) =>
           listener.pid === candidate.pid && listener.worker_instance_id === candidate.worker_instance_id
             && listener.worker_slot === candidate.worker_slot));
         if (retryCandidates.length === 2 && new Set(retryCandidates.map((candidate) => candidate.worker_slot)).size === 2
           && retryCandidates.every((candidate) => barrierWaiters.has([candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':')))) {
           secondBatchCandidates = retryCandidates;
           return true;
         }
         return false;
       }, 'Master3 retry did not expose hits 5-6', 20_000);
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     expect(barrierCandidates.size).toBe(6);
     const thirdState = supervisionState(fixture.dbPath);
     expect(thirdState.controller_epoch).toBe(secondStateForWindow.controller_epoch + 1);
     const oldDescriptors = exactDescriptors(await readWorkerDescriptors(fixture), secondDescriptors, 2);
     expect(oldDescriptors).toHaveLength(2);
     for (const descriptor of oldDescriptors) {
       expect(Number(descriptor.revision)).toBe(2);
       if ('phase' in descriptor) expect(descriptor.phase).toBe('serving');
       if ('frozen' in descriptor) expect(descriptor.frozen).toBe(false);
       if ('controller_epoch' in descriptor) expect(Number(descriptor.controller_epoch)).toBe(thirdState.controller_epoch);
       if ('controller_id' in descriptor) expect(descriptor.controller_id).toBe(thirdState.controller_id);
     }
     expect(secondDescriptors.every((descriptor) => processAlive(Number(descriptor.pid)))).toBe(true);
     const oldBeforeWindowRequests = (await audit(auditPath)).filter((entry) => entry.marker === MARKER).length;
     const oldRequestsWindowStarted = performance.now();
     try {
       await Promise.all(Array.from({ length: 3 }, async () => {
         const requestStarted = performance.now();
         const response = await requestPublic(port + 1);
         expect(performance.now() - requestStarted).toBeLessThan(500);
         expect(response.status).toBe(200);
         expect(await response.text()).toBe('managed-upstream-ok');
       }));
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     expect(performance.now() - oldRequestsWindowStarted).toBeLessThan(1_500);
     expect((await audit(auditPath)).filter((entry) => entry.marker === MARKER).length).toBe(oldBeforeWindowRequests + 3);
     const oldRowsAfterWindow = new Database(fixture.dbPath, { readonly: true, strict: true });
     try {
       const oldRows = oldRowsAfterWindow.query<{ aggregate_json: string }, []>(
         'SELECT aggregate_json FROM configuration_serving_snapshots WHERE revision=2',
       ).all();
       expect(oldRows).toHaveLength(1);
       expect(oldRows[0]!.aggregate_json).toContain('"marker":"' + MARKER + '"');
     } finally { oldRowsAfterWindow.close(true); }
     const retryBatchKeys = secondBatchCandidates.map((candidate) => [candidate.pid, candidate.worker_instance_id, candidate.worker_slot].join(':'));
     releaseBarrierBatch(retryBatchKeys);
     expect(retryBatchKeys.every((key) => barrierOutcomes.get(key) === 'released')).toBe(true);
     await waitUntil(() => Promise.resolve(barrierCompleted >= 4), 'Master3 replacement barrier did not complete', 7_000);
     await waitUntil(async () => {
       const operation = await (await fetch(`http://127.0.0.1:${port}/api/config/operations/${nextMutationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any;
       return ['converged', 'degraded', 'outcome_unknown'].includes(operation.operation?.state) && operation.operation?.committed_revision === 3;
     }, 'NEW publication did not reach a terminal active revision', 30_000);
     let master3Candidates: readonly Record<string, unknown>[] = [];
     const oldDescriptorIds = new Set(secondDescriptors.map(descriptorIdentity));
     try {
       await waitUntil(async () => {
         const finalDescriptors = await readWorkerDescriptors(fixture);
         master3Candidates = finalDescriptors.filter((descriptor) => Number(descriptor.revision) === 3
           && descriptor.content_hash === currentConfig.content_hash
           && !oldDescriptorIds.has(descriptorIdentity(descriptor))
           && descriptor.phase === 'serving' && descriptor.frozen === false);
         return master3Candidates.length === 2;
       }, 'NEW config-ready descriptors did not appear', 30_000);
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     expect(master3Candidates).toHaveLength(2);
     expect(new Set(master3Candidates.map(descriptorIdentity)).size).toBe(2);
     let activeRuntimeWorkers: RuntimeWorkerDto[] = [];
     await waitUntil(async () => {
       const runtime = await (await fetch(`http://127.0.0.1:${port}/api/config/runtime`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
         workers?: RuntimeWorkerDto[];
       };
       activeRuntimeWorkers = runtime.workers ?? [];
       const descriptors = await readWorkerDescriptors(fixture);
       const runtimeKeys = new Set(activeRuntimeWorkers.map((worker) => `${worker.pid}:${worker.slot}`));
       master3Candidates = descriptors.filter((descriptor) => Number(descriptor.revision) === 3
         && descriptor.content_hash === currentConfig.content_hash
         && !oldDescriptorIds.has(descriptorIdentity(descriptor))
         && descriptor.phase === 'serving' && descriptor.frozen === false
         && runtimeKeys.has(`${descriptor.pid}:${descriptor.worker_slot}`)
         && activeRuntimeWorkers.some((worker) => worker.pid === descriptor.pid
           && worker.slot === descriptor.worker_slot && worker.private_port === descriptor.private_port
           && worker.content_hash === descriptor.content_hash && worker.plugin_catalog_hash === descriptor.plugin_catalog_hash));
       if (activeRuntimeWorkers.length !== 2 || master3Candidates.length !== 2) return false;
       const sortProjection = <T extends { readonly slot: number }>(items: readonly T[]): T[] =>
         [...items].sort((left, right) => left.slot - right.slot);
       const activeProjection = sortProjection(activeRuntimeWorkers.map((worker) => ({
         master_generation: worker.master_generation, worker_instance_id: worker.worker_instance_id,
         boot_nonce: worker.boot_nonce, pid: worker.pid, slot: worker.slot, private_port: worker.private_port,
         revision: worker.revision, content_hash: worker.content_hash,
         plugin_catalog_hash: worker.plugin_catalog_hash, publication: worker.publication,
       })));
       const descriptorProjection = sortProjection(master3Candidates.map((descriptor) => ({
         master_generation: descriptor.master_generation as string, worker_instance_id: descriptor.worker_instance_id as string,
         boot_nonce: descriptor.boot_nonce as string, pid: descriptor.pid as number, slot: descriptor.worker_slot as number,
         private_port: descriptor.private_port as number, revision: descriptor.revision as number,
         content_hash: descriptor.content_hash as string, plugin_catalog_hash: descriptor.plugin_catalog_hash as string,
         publication: descriptorPublication(descriptor),
       })));
       const barrierProjection = sortProjection(secondBatchCandidates.map((candidate) => ({
         master_generation: candidate.master_generation, worker_instance_id: candidate.worker_instance_id,
         boot_nonce: candidate.boot_nonce as string, pid: candidate.pid, slot: candidate.worker_slot,
       })));
       const descriptorCoreProjection = sortProjection(master3Candidates.map((descriptor) => ({
         master_generation: descriptor.master_generation as string, worker_instance_id: descriptor.worker_instance_id as string,
         boot_nonce: descriptor.boot_nonce as string, pid: descriptor.pid as number, slot: descriptor.worker_slot as number,
       })));
       expect(activeProjection).toEqual(descriptorProjection);
       expect(barrierProjection).toEqual(descriptorCoreProjection);
       return true;
     }, 'management runtime active set did not match exact rev3 descriptors', 30_000);
     expect(activeRuntimeWorkers).toHaveLength(2);
     expect(new Set(activeRuntimeWorkers.map((worker) => `${worker.pid}:${worker.slot}`))).toEqual(
       new Set(master3Candidates.map((descriptor) => `${descriptor.pid}:${descriptor.worker_slot}`)),
     );
     for (const worker of activeRuntimeWorkers) {
       const descriptor = master3Candidates.find((candidate) => candidate.pid === worker.pid && candidate.worker_slot === worker.slot);
       expect(descriptor).toBeDefined();
       expect(worker.private_port).toBe(descriptor?.private_port as number);
       expect(worker.revision).toBe(3);
       expect(worker.content_hash).toBe(currentConfig.content_hash);
       expect(worker.plugin_catalog_hash).toBe(descriptor?.plugin_catalog_hash as string);
     }
     const activeWorkerSlots = new Set(master3Candidates.map((descriptor) => descriptor.worker_slot));
     expect(activeWorkerSlots).toEqual(new Set([0, 1]));
     expect(new Set(master3Candidates.map((descriptor) => descriptor.plugin_catalog_hash)).size).toBe(1);
     for (const descriptor of master3Candidates) {
       expect(typeof descriptor.worker_instance_id).toBe('string');
       expect(typeof descriptor.boot_nonce).toBe('string');
       expect(typeof descriptor.private_port).toBe('number');
       expect(Number(descriptor.revision)).toBe(3);
       expect(typeof descriptor.content_hash).toBe('string');
       expect(typeof descriptor.plugin_catalog_hash).toBe('string');
       expect(oldDescriptorIds.has(descriptorIdentity(descriptor))).toBe(false);
     }
     try {
       await waitUntil(async () => {
         const response = await requestPublic(port + 1);
         return response.status === 200 && await response.text() === 'managed-upstream-ok';
       }, 'NEW public data plane did not recover', 30_000);
     } catch (error) {
       throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await publicationDiagnostics()}`);
     }
     const beforeNew = (await audit(auditPath)).filter((entry) => entry.marker === 'NEW').length;
     const outboundBeforeNew = requests.length;
     for (let index = 0; index < 4; index += 1) { const response = await requestPublic(port + 1); expect(response.status).toBe(200); expect(await response.text()).toBe('managed-upstream-ok'); }
     const windowAudit = await audit(auditPath);
     expect(windowAudit.filter((entry) => entry.marker === 'NEW').length).toBeGreaterThanOrEqual(beforeNew + 4);
     expect(requests.length - outboundBeforeNew).toBe(4);
     expect(barrierCandidates.size).toBe(6);
     expect(new Set(windowAudit.map((entry) => entry.attemptId)).size).toBe(windowAudit.length);
     expect(requests.every((request) => request.headers.authorization === AUTHORIZATION
       && request.headers['x-managed-e2e-header'] === FIXTURE_HEADER
       && !JSON.stringify(request.headers).includes('OLD')
       && !JSON.stringify(request.headers).includes('NEW')
       && !JSON.stringify(request.headers).includes(auditPath)
       && !JSON.stringify(request.headers).includes(ROOT_MATERIAL))).toBe(true);
     await nextMutationSettled;
  }, async () => {
    abortBarrierBatch([...barrierWaiters.keys()], 'aborted');
    const savedRootIdentities = [first, second, third].map((master) => master === null || master.child.pid === undefined ? null
      : master.processes.registeredProcesses.find(({ pid }) => pid === master!.child.pid)?.identity ?? null);
    const masterResults = await Promise.allSettled([
      ...(third === null ? [] : [cleanupMaster({ ...third, ports: [], ingressPorts: [], workerCount: 0 }, [])]),
      ...(second === null ? [] : [cleanupMaster({ ...second, ports: [], ingressPorts: [], workerCount: 0 }, [])]),
      ...(first === null ? [] : [cleanupMaster(first, firstWorkers)]),
    ]);
    const errors = masterResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    const exactMasterResults = await Promise.allSettled([first, second, third].flatMap((master) => master === null || master.child.pid === undefined ? [] : [
      waitUntil(async () => {
        const state = processLiveness(master.child.pid!);
        if (state === 'absent' || state === 'terminal') return true;
        if (state === 'unknown') return false;
        const expected = savedRootIdentities[[first, second, third].indexOf(master)];
        const actual = await captureProcessIdentity(master.child.pid!);
        return expected !== null && actual !== null && !processIdentityMatches(expected, actual, process.platform);
      }, `master PID ${master.child.pid} remained alive after exact cleanup`, 15_000),
    ]));
    errors.push(...exactMasterResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    const resourceResults = await Promise.allSettled([
      firstWorkers.length === 0 ? Promise.resolve() : waitForDead(firstWorkers),
      ingressPid === undefined ? Promise.resolve() : waitForDead([ingressPid]),
      upstream === null ? Promise.resolve() : upstream.stop(true),
      port === 0 ? Promise.resolve() : Promise.all([expectPortClosed(port), expectPortClosed(port + 1), expectPortClosed(port + 2)]),
      barrier.stop(true).then(() => expectPortClosed(barrier.port!)),
    ]);
    errors.push(...resourceResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (errors.length === 0) {
      const fixtureResult = await Promise.allSettled([removeFixture(fixture)]);
      errors.push(...fixtureResult.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    }
    const sourceMainPidsResult = await Promise.allSettled([sourceMainPids()]);
    errors.push(...sourceMainPidsResult.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (sourceMainPidsResult[0]?.status === 'fulfilled') {
      try { expect(sourceMainPidsResult[0].value).toEqual(beforePids); }
      catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'plugin control cleanup failed');
  });
}, 120_000);
