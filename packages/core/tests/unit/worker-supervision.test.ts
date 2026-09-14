import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  importWorkerSupervisionSeed,
  parseWorkerDescriptor,
  serializeWorkerSupervisionSeed,
  signSupervisionMessage,
  verifySupervisionMessage,
  WorkerSupervisionHttpServer,
  normalizeWorkerRuntimeSnapshotBody,
  SupervisionProtocolError,
  verifyWorkerDescriptor,
  writeWorkerDescriptor,
  type ControllerAuthority,
} from '../../src/supervision';
import { WorkerControllerClient } from '../../src/master-runtime/supervised-worker-client';
import { aggregate, drainMessage, PROCESS_IDENTITY, startCurrentMessage } from './config-publication-worker-runtime.fixtures';

const ROOT = new Uint8Array(32).fill(4);
const BOOT = '70000000-0000-4000-8000-000000000001';
const AUTHORITY: ControllerAuthority = {
  controller_epoch: 1,
  controller_id: '80000000-0000-4000-8000-000000000001',
};

function signed(credential: ReturnType<typeof deriveWorkerSupervisionCredential>, kind: 'status' | 'command', sequence: number, body: unknown, path = '/start') {
  return signSupervisionMessage(kind === 'status' ? {
    protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller', ...credential.identity,
    ...AUTHORITY, sequence, request_id: randomUUID(), status: 'request', body_hash: hashSupervisionBody(null),
  } : {
    protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process', ...credential.identity,
    ...AUTHORITY, sequence, request_id: randomUUID(), method: 'POST', path, body_hash: hashSupervisionBody(body),
  }, credential);
}

function descriptorFs(counter: { writes: number; temporaryPaths: string[] }) {
  return {
    async mkdir() {},
    async chmod() {},
    async open(path: string, flags: string) {
      if (flags === 'w') {
        counter.writes += 1;
        counter.temporaryPaths.push(path);
      }
      return {
        async writeFile() {}, async chmod() {}, async sync() {}, async close() {},
      };
    },
    async rename() {},
    async rm() {},
  };
}

describe('worker supervision seed and HTTP state', () => {
  test('does not publish unavailable for a retry that succeeds, and emits it once after both attempts fail', async () => {
    const credential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot), BOOT,
    );
    const runtime = { async apply() { return { ok: true, message: { status: 'worker-drained', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid,
      revision: null, content_hash: null, plugin_catalog_hash: null, publication: null } }; }, async failClosed() {} };
    const server = new WorkerSupervisionHttpServer({ credential, identity: PROCESS_IDENTITY, runtime: runtime as any, controlPort: 41001 });
    let reset = true;
    const unavailable: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (input, init) => {
      if (reset) { reset = false; throw new Error('ECONNRESET'); }
      return server.fetch(new Request(String(input), init));
    }) as typeof globalThis.fetch;
    const client = new WorkerControllerClient({ baseUrl: 'http://127.0.0.1:41001', credential, authority: AUTHORITY,
      timeoutMs: 100, leaseDurationMs: 1_000, fetch: fetcher });
    client.subscribeControlState((state) => { if (state === 'unavailable') unavailable.push(state); });
    await client.attach();
    expect(unavailable).toEqual([]);
    const failed = new WorkerControllerClient({ baseUrl: 'http://127.0.0.1:41001', credential, authority: AUTHORITY,
      timeoutMs: 20, fetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof globalThis.fetch });
    failed.subscribeControlState((state) => { if (state === 'unavailable') unavailable.push(state); });
    await failed.attach().catch(() => undefined);
    expect(unavailable).toEqual(['unavailable']);
    client.disconnect(); failed.disconnect();
  });

  test('seed is identity-bound and only becomes a worker credential with boot nonce', () => {
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const serialized = serializeWorkerSupervisionSeed(seed);
    expect(serialized).not.toContain(Buffer.from(ROOT).toString('base64url'));
    expect(importWorkerSupervisionSeed(serialized)).toMatchObject({
      master_generation: PROCESS_IDENTITY.master_generation,
      worker_instance_id: PROCESS_IDENTITY.worker_instance_id,
      worker_slot: PROCESS_IDENTITY.worker_slot,
    });
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    expect(credential.identity).toEqual({ role: 'worker', process_instance_id: PROCESS_IDENTITY.worker_instance_id, boot_nonce: BOOT });
    expect(() => deriveWorkerSupervisionCredential({ ...seed, worker_instance_id: '60000000-0000-4000-8000-000000000002' }, BOOT)).toThrow();
  });

  test('requires attach and lease before start, then freezes without stopping serving', async () => {
    let now = 100;
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    let applied = 0;
    const runtime = {
      async apply(input: any) {
        applied += 1;
        if (input.command === 'start-current-config-worker') return { ok: true, message: {
          status: 'config-ready', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid, revision: input.revision,
          content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash, private_port: 41234,
          plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: null,
        } };
        return { ok: true, message: { status: 'worker-drained', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid,
          revision: input.revision, content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash, publication: null } };
      },
      async failClosed() {},
    };
    const server = new WorkerSupervisionHttpServer({ credential, identity: PROCESS_IDENTITY, runtime: runtime as any,
      clock: () => now, attachGraceMs: 20, startupWatchdogMs: 1_000 });
    const post = async (path: string, body: unknown) => server.fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const challengeRequest = { ...AUTHORITY, request_id: randomUUID(), sequence: 1 };
    const challengeResponse = await post('/__supervision/challenge', challengeRequest);
    const challenge = (await challengeResponse.json() as any).message;
    const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 1, request_id: randomUUID(), challenge_nonce: challenge.challenge_nonce }, credential);
    expect((await post('/__supervision/attach', attach)).status).toBe(200);
    const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 2, request_id: randomUUID(), lease_expires_at: 120 }, credential);
    expect((await post('/__supervision/lease', lease)).status).toBe(200);
    const commandBody = startCurrentMessage(7, aggregate());
    const command = signed(credential, 'command', 3, commandBody);
    const startResponse = await post('/__supervision/command', { message: command, body: commandBody });
    expect(startResponse.status).toBe(200);
    expect(applied).toBe(1);
    now = 120;
    const statusRequest = signed(credential, 'status', 4, null);
    const frozen = await post('/__supervision/status', statusRequest);
    expect(frozen.status).toBe(200);
    expect((await frozen.json() as any).body).toMatchObject({ phase: 'serving', frozen: true, private_port: 41234 });
    const rejected = await post('/__supervision/command', { message: signed(credential, 'command', 5, commandBody), body: commandBody });
    expect(rejected.status).toBe(409);
  });

  test('returns a signed serving runtime snapshot through the shared client sequence', async () => {
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    let drainRuns = 0;
    const runtime = {
      async apply(input: any) {
        if (input.command === 'drain-worker') {
          drainRuns += 1;
          return { ok: true, message: {
          status: 'worker-drained', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid, revision: input.revision,
          content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash, publication: input.publication,
          } };
        }
        return { ok: true, message: {
          status: 'config-ready', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid, revision: input.revision,
          content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash, private_port: 41234,
          plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: null,
        } };
      },
      async failClosed() {},
    };
    const server = new WorkerSupervisionHttpServer({
      credential, identity: PROCESS_IDENTITY, runtime: runtime as any, controlPort: 41001,
      runtimeSnapshotProvider: (input) => normalizeWorkerRuntimeSnapshotBody({
        schema: 'bungee-worker-runtime-snapshot-v1', ...input, result: { kind: 'complete', records: [] },
      }),
    });
    let droppedDrainResponse = 0;
    const client = new WorkerControllerClient({
      baseUrl: 'http://127.0.0.1:41001', credential, authority: AUTHORITY,
      fetch: (async (input, init) => {
        const root = typeof init?.body === 'string' ? JSON.parse(init.body) as { body?: { command?: string } } : undefined;
        const response = await server.fetch(new Request(String(input), init));
        if (root?.body?.command === 'drain-worker' && droppedDrainResponse === 0) {
          droppedDrainResponse += 1;
          throw new DOMException('lost drain acknowledgement', 'AbortError');
        }
        return response;
      }) as typeof globalThis.fetch,
    });
    await client.attach();
    await client.start(startCurrentMessage(7, aggregate()));
    const [status, snapshot] = await Promise.all([client.status(), client.runtimeSnapshot()]);
    expect(status.phase).toBe('serving');
    expect(snapshot).toMatchObject({ ...PROCESS_IDENTITY, boot_nonce: BOOT, result: { kind: 'complete', records: [] } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.result)).toBe(true);
    for (let index = 0; index < 513; index += 1) await client.runtimeSnapshot();
    expect((server.commands as any).requests.size).toBe(1);
    const lowerDirectionLease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 5, request_id: randomUUID(), lease_expires_at: Date.now() + 5_000 }, credential);
    expect((await server.fetch(new Request('http://127.0.0.1/__supervision/lease', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lowerDirectionLease),
    }))).status).toBe(200);
    await client.drain(drainMessage() as any);
    expect(droppedDrainResponse).toBe(1);
    expect(drainRuns).toBe(1);
    await client.shutdown();
    expect(server.currentPhase).toBe('stopped');
    client.disconnect(false);
  });

  test('rejects runtime samples before serving', async () => {
    const credential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot), BOOT,
    );
    const server = new WorkerSupervisionHttpServer({
      credential, identity: PROCESS_IDENTITY, runtime: { async apply() { throw new Error('unused'); }, async failClosed() {} } as any,
      runtimeSnapshotProvider: (input) => normalizeWorkerRuntimeSnapshotBody({
        schema: 'bungee-worker-runtime-snapshot-v1', ...input, result: { kind: 'complete', records: [] },
      }),
    });
    const response = await server.fetch(new Request('http://127.0.0.1/__supervision/runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed(credential, 'status', 1, null)),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'worker_not_ready' });
    const duplicate = JSON.stringify(signed(credential, 'status', 2, null)).replace('"status":"request"', '"status":"request","status":"request"');
    const duplicateResponse = await server.fetch(new Request('http://127.0.0.1/__supervision/runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: duplicate,
    }));
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({ error: 'invalid_json' });
  });

  test('writes an authenticated descriptor atomically and rejects tampering', async () => {
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-descriptor-'));
    const path = join(directory, 'worker.json');
    try {
      const descriptor = await writeWorkerDescriptor(path, {
        schema: 'bungee-worker-descriptor-v1', role: 'worker', ...PROCESS_IDENTITY, boot_nonce: BOOT,
        pid: process.pid, control_port: 41001, phase: 'candidate', frozen: true, private_port: null,
        revision: null, content_hash: null, plugin_catalog_hash: null, started_at: 100, evidence: { kind: 'candidate' },
      }, credential.process_key);
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(() => parseWorkerDescriptor({ ...persisted, extra: true }, credential)).toThrow();
      try { parseWorkerDescriptor({ ...persisted, extra: true }, credential); }
      catch (error) { expect(error).toMatchObject({ code: 'malformed_message' }); }
      expect(() => parseWorkerDescriptor({ ...persisted, private_port: '41234' }, credential)).toThrow();
      expect(verifyWorkerDescriptor(persisted, credential.process_key)).toBe(true);
      expect(verifyWorkerDescriptor({ ...persisted, pid: process.pid + 1 }, credential.process_key)).toBe(false);
      expect(() => parseWorkerDescriptor({ ...persisted, descriptor_mac: `hmac-sha256:${'b'.repeat(64)}` }, credential))
        .toThrow(SupervisionProtocolError);
      try { parseWorkerDescriptor({ ...persisted, descriptor_mac: `hmac-sha256:${'b'.repeat(64)}` }, credential); }
      catch (error) { expect(error).toMatchObject({ code: 'invalid_mac' }); }
      expect(descriptor.descriptor_mac).toMatch(/^hmac-sha256:/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps the lease frozen when start apply finishes after expiry', async () => {
    let now = 100;
    let resolveApply!: (value: unknown) => void;
    let markApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    const runtime = {
      apply: () => { markApplyStarted(); return new Promise((resolve) => { resolveApply = resolve; }); },
      async failClosed() {},
    };
    const server = new WorkerSupervisionHttpServer({ credential, identity: PROCESS_IDENTITY, runtime: runtime as any, clock: () => now });
    const post = async (path: string, body: unknown) => server.fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const challenge = await post('/__supervision/challenge', { ...AUTHORITY, request_id: randomUUID(), sequence: 1 }).then((r) => r.json()) as any;
    await post('/__supervision/attach', signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 1, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, credential));
    await post('/__supervision/lease', signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 2, request_id: randomUUID(), lease_expires_at: 120 }, credential));
    const body = startCurrentMessage(7, aggregate());
    const request = post('/__supervision/command', { message: signed(credential, 'command', 3, body), body });
    await applyStarted;
    now = 120;
    resolveApply({ ok: true, message: { status: 'config-ready', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid,
      revision: 7, content_hash: body.content_hash, plugin_catalog_hash: body.plugin_catalog_hash, private_port: 41234,
      plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: null } });
    const response = await request;
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`delayed start rejected: ${JSON.stringify(result)}`);
    expect(result.body).toMatchObject({ phase: 'serving', frozen: true });
  });

  test('caches one concurrent command action, descriptor update, and signed status', async () => {
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    const writes = { writes: 0, temporaryPaths: [] as string[] };
    let applied = 0;
    let resolveApply!: (value: unknown) => void;
    let markApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
    const body = startCurrentMessage(7, aggregate());
    const runtime = {
      apply: () => { applied += 1; markApplyStarted(); return new Promise((resolve) => { resolveApply = resolve; }); },
      async failClosed() {},
    };
    const server = new WorkerSupervisionHttpServer({ credential, identity: PROCESS_IDENTITY, runtime: runtime as any,
      controlPort: 41001, descriptorPath: '/virtual/worker.json', descriptorFs: descriptorFs(writes) as any, clock: () => 100 });
    const post = async (path: string, value: unknown) => server.fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    }));
    const challenge = await post('/__supervision/challenge', { ...AUTHORITY, request_id: randomUUID(), sequence: 1 }).then((r) => r.json()) as any;
    await post('/__supervision/attach', signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 1, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, credential));
    await post('/__supervision/lease', signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 2, request_id: randomUUID(), lease_expires_at: 1000 }, credential));
    writes.writes = 0;
    const requestId = randomUUID();
    const message = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
      ...credential.identity, ...AUTHORITY, sequence: 3, request_id: requestId, method: 'POST', path: '/start', body_hash: hashSupervisionBody(body) }, credential);
    const first = post('/__supervision/command', { message, body });
    const second = post('/__supervision/command', { message, body });
    await applyStarted;
    expect(applied).toBe(1);
    resolveApply({ ok: true, message: { status: 'config-ready', ...PROCESS_IDENTITY, boot_nonce: BOOT, pid: process.pid,
      revision: 7, content_hash: body.content_hash, plugin_catalog_hash: body.plugin_catalog_hash, private_port: 41234,
      plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: null } });
    const [firstBody, secondBody] = await Promise.all([first.then((r) => r.json()), second.then((r) => r.json())]) as any[];
    expect(firstBody).toEqual(secondBody);
    expect(writes.writes).toBe(1);
    expect(firstBody.message.sequence).toBe(secondBody.message.sequence);
  });

  test('serializes descriptor writes and removes failed temporary files', async () => {
    const seed = deriveWorkerSupervisionSeed(ROOT, PROCESS_IDENTITY.master_generation, PROCESS_IDENTITY.worker_instance_id, PROCESS_IDENTITY.worker_slot);
    const credential = deriveWorkerSupervisionCredential(seed, BOOT);
    const counter = { writes: 0, temporaryPaths: [] as string[] };
    const body = {
      schema: 'bungee-worker-descriptor-v1' as const, role: 'worker' as const, ...PROCESS_IDENTITY, boot_nonce: BOOT,
      pid: process.pid, control_port: 41001, phase: 'candidate' as const, frozen: true, private_port: null,
      revision: null, content_hash: null, plugin_catalog_hash: null, started_at: 100, evidence: { kind: 'candidate' as const },
    };
    const fs = descriptorFs(counter);
    await Promise.all([
      writeWorkerDescriptor('/virtual/one.json', body, credential.process_key, { fs: fs as any }),
      writeWorkerDescriptor('/virtual/two.json', body, credential.process_key, { fs: fs as any }),
    ]);
    expect(counter.writes).toBe(2);
    expect(new Set(counter.temporaryPaths).size).toBe(2);
    const removed: string[] = [];
    const failingFs = {
      ...fs,
      async open(path: string, flags: string) {
        const handle = await fs.open(path, flags);
        return { ...handle, async sync() { if (flags === 'w') throw new Error('file sync failed'); } };
      },
      async rm(path: string) { removed.push(path); },
    };
    await writeWorkerDescriptor('/virtual/fails.json', body, credential.process_key, { fs: failingFs as any }).then(
      () => { throw new Error('expected file sync failure'); },
      () => undefined,
    );
    expect(removed).toHaveLength(1);
    const directorySyncError = Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
    const directorySyncFs = {
      ...fs,
      async open(path: string, flags: string) {
        const handle = await fs.open(path, flags);
        return { ...handle, async sync() { if (flags === 'r') throw directorySyncError; } };
      },
    };
    await writeWorkerDescriptor('/virtual/windows.json', body, credential.process_key, { fs: directorySyncFs as any, platform: 'win32' });
    await writeWorkerDescriptor('/virtual/linux.json', body, credential.process_key, { fs: directorySyncFs as any, platform: 'linux' }).then(
      () => { throw new Error('expected non-Windows directory sync failure'); },
      () => undefined,
    );
  });
});
