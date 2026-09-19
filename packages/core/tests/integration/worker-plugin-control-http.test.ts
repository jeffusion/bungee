import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createPluginControlHttpClient,
  createPluginControlHttpServer,
  createPluginControlRpcCredential,
  parsePluginControlRpcMessage,
  type PluginControlRpcCall,
} from '../../src/plugin-control';
import { createWorkerPluginControlHttpProvider } from '../../src/config-worker/http-provider';
import { WorkerControllerClient } from '../../src/master-runtime/supervised-worker-client';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  WorkerSupervisionHttpServer,
  signSupervisionMessage,
  type ControllerAuthority,
} from '../../src/supervision';

const identity = {
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const authority: ControllerAuthority = {
  controller_epoch: 1,
  controller_id: '70000000-0000-4000-8000-000000000001',
};

test('worker supervision lease gates a real loopback plugin-control HTTP provider', async () => {
  const bootNonce = '80000000-0000-4000-8000-000000000001';
  const supervision = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(3), identity.master_generation, identity.worker_instance_id, identity.worker_slot),
    bootNonce,
  );
  const worker = new WorkerSupervisionHttpServer({
    credential: supervision,
    identity,
    runtime: { async apply() { return { ok: false, error: 'unused' }; }, async failClosed() {} } as any,
    controlPort: 0,
  });
  await worker.listen();
  const rpcCredential = createPluginControlRpcCredential(supervision, { ...identity, boot_nonce: bootNonce });
  let receivedKeys: string[] = [];
  const rpc = createPluginControlHttpServer({
    resolveCredential: (candidate) => JSON.stringify(candidate) === JSON.stringify(rpcCredential.worker)
      ? { credential: rpcCredential, authority }
      : null,
    execute: async (call: PluginControlRpcCall) => {
      receivedKeys = Object.keys(call.body).sort();
      return { payload: call.body.payload };
    },
  });
  const master = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => rpc.handle(request) });
  const provider = createWorkerPluginControlHttpProvider({
    supervision,
    worker: { ...identity, boot_nonce: bootNonce },
    managementHost: '127.0.0.1',
    managementPort: master.port!,
    authoritySource: worker,
  });
  const bound = provider.provider({
    plugin: 'ignored', contributionId: 'ignored', bindingId: 'ignored',
    bindingOptions: { secret: 'must-not-cross' },
  }, { revision: 3, endpointId: 'endpoint-1', attemptId: randomUUID() });
  try {
    expect(() => provider.provider({} as any, undefined)).toThrow('attempt identity');
    await expect(bound.call('getCredential', { bindingOptions: 'must-not-cross' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' });
    const controller = new WorkerControllerClient({
      baseUrl: `http://127.0.0.1:${worker.port}`,
      credential: supervision,
      authority,
      timeoutMs: 1_000,
      leaseDurationMs: 1_000,
      renewBeforeMs: 200,
    });
    await controller.attach();
    await expect(bound.call('getCredential', { ok: true }, new AbortController().signal))
      .resolves.toEqual({ payload: { ok: true } });
    expect(receivedKeys).toEqual(['attempt_id', 'endpoint_id', 'method', 'payload', 'revision']);
    controller.disconnect();
  } finally {
    provider.dispose();
    await worker.stop();
    await master.stop(true);
  }
});

test('lease expiry sends one cancel and preserves sequence across same-authority renewal', async () => {
  const bootNonce = '80000000-0000-4000-8000-000000000002';
  const supervision = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(4), identity.master_generation, identity.worker_instance_id, identity.worker_slot),
    bootNonce,
  );
  const worker = new WorkerSupervisionHttpServer({
    credential: supervision,
    identity,
    runtime: { async apply() { return { ok: false, error: 'unused' }; }, async failClosed() {} } as any,
    controlPort: 0,
  });
  await worker.listen();
  const rpcCredential = createPluginControlRpcCredential(supervision, { ...identity, boot_nonce: bootNonce });
  const calls: number[] = [];
  let cancelCount = 0;
  let hostAborted = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const rpc = createPluginControlHttpServer({
    resolveCredential: () => ({ credential: rpcCredential, authority }),
    execute: async (call: PluginControlRpcCall, signal) => {
      calls.push(call.sequence);
      if (call.body.method !== 'block') return { sequence: call.sequence };
      resolveStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => { hostAborted = true; reject(new Error('aborted')); }, { once: true });
      });
      return { sequence: call.sequence };
    },
  });
  const master = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const message = parsePluginControlRpcMessage(await request.clone().text());
      if (message.kind === 'cancel') cancelCount += 1;
      return rpc.handle(request);
    },
  });
  const provider = createWorkerPluginControlHttpProvider({
    supervision,
    worker: { ...identity, boot_nonce: bootNonce },
    managementHost: '127.0.0.1',
    managementPort: master.port!,
    authoritySource: worker,
    deadlineMs: 1_000,
  });
  const bound = provider.provider({
    plugin: 'ignored', contributionId: 'ignored', bindingId: 'ignored', bindingOptions: { ignored: true },
  }, { revision: 3, endpointId: 'endpoint-1', attemptId: randomUUID() });
  const post = async (path: string, body: unknown): Promise<Response> => fetch(`http://127.0.0.1:${worker.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const lease = async (sequence: number, expiresAt: number): Promise<void> => {
    const challengeRequest = { ...authority, request_id: randomUUID(), sequence };
    const challenge = await post('/__supervision/challenge', challengeRequest).then((response) => response.json()) as any;
    const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...supervision.identity, ...authority, sequence, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, supervision);
    expect((await post('/__supervision/attach', attach)).status).toBe(200);
    const signedLease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...supervision.identity, ...authority, sequence: sequence + 1, request_id: randomUUID(), lease_expires_at: expiresAt }, supervision);
    expect((await post('/__supervision/lease', signedLease)).status).toBe(200);
  };
  try {
    await lease(1, Date.now() + 80);
    await expect(bound.call('ok', {}, new AbortController().signal)).resolves.toEqual({ sequence: 1 });
    const blocked = bound.call('block', {}, new AbortController().signal).then(() => null, (error) => error);
    await started;
    await Bun.sleep(150);
    expect(await blocked).toMatchObject({ code: 'stale_controller' });
    await Bun.sleep(20);
    expect(cancelCount).toBe(1);
    expect(hostAborted).toBe(true);
    await lease(3, Date.now() + 1_000);
    await expect(bound.call('ok', {}, new AbortController().signal)).resolves.toEqual({ sequence: 4 });
    expect(calls).toEqual([1, 2, 4]);
  } finally {
    provider.dispose();
    await worker.stop();
    await master.stop(true);
  }
});

async function hostileCancel(mode: 'resolve' | 'reject'): Promise<{ readonly cancelCount: number; readonly bodyCancelCount: number }> {
  const bootNonce = mode === 'resolve' ? '80000000-0000-4000-8000-000000000003' : '80000000-0000-4000-8000-000000000005';
  const supervision = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(mode === 'resolve' ? 5 : 8), identity.master_generation, identity.worker_instance_id, identity.worker_slot),
    bootNonce,
  );
  const credential = createPluginControlRpcCredential(supervision, { ...identity, boot_nonce: bootNonce });
  let cancelCount = 0;
  let lateResolve!: (response: Response) => void;
  let lateReject!: (error: unknown) => void;
  let bodyCancelCount = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { bodyCancelCount += 1; } });
  const client = createPluginControlHttpClient({
    baseUrl: 'http://127.0.0.1:1',
    session: () => ({ credential, authority }),
    deadlineMs: 40,
    fetchImpl: (async (_input, init) => {
      const message = parsePluginControlRpcMessage(String(init?.body));
      if (message.kind === 'cancel') {
        cancelCount += 1;
        return new Promise<Response>((resolve, reject) => { lateResolve = resolve; lateReject = reject; });
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('deadline', 'AbortError'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch,
  });
  try {
    const outcome = client.call({ revision: 1, endpoint_id: 'endpoint-1', attempt_id: randomUUID(), method: 'block', payload: {} }, new AbortController().signal)
      .then(() => undefined, (error) => error);
    expect(await outcome).toMatchObject({ code: 'timeout' });
    await Bun.sleep(60);
    expect(cancelCount).toBe(1);
    expect((client as any).cancelTransports.size).toBe(0);
    expect((client as any).operations.size).toBe(0);
    expect((client as any).guard.activeCount).toBe(0);
    if (mode === 'resolve') lateResolve(new Response(body, { status: 200 }));
    else lateReject(new Error('late cancel failure'));
    await Bun.sleep(20);
    expect(bodyCancelCount).toBe(mode === 'resolve' ? 1 : 0);
    return { cancelCount, bodyCancelCount };
  } finally {
    client.dispose();
  }
}

test('cancel deadline cleans a late-resolving transport and consumes its body', async () => {
  await hostileCancel('resolve');
});

test('cancel deadline ignores a late-rejecting transport without unhandled rejection', async () => {
  await hostileCancel('reject');
});

test('higher epoch attach cancels old authority once before the new lease call', async () => {
  const bootNonce = '80000000-0000-4000-8000-000000000004';
  const higherAuthority: ControllerAuthority = { controller_epoch: 2, controller_id: '70000000-0000-4000-8000-000000000002' };
  const supervision = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(6), identity.master_generation, identity.worker_instance_id, identity.worker_slot),
    bootNonce,
  );
  const worker = new WorkerSupervisionHttpServer({
    credential: supervision,
    identity,
    runtime: { async apply() { return { ok: false, error: 'unused' }; }, async failClosed() {} } as any,
    controlPort: 0,
  });
  await worker.listen();
  const rpcCredential = createPluginControlRpcCredential(supervision, { ...identity, boot_nonce: bootNonce });
  let masterAuthority = authority;
  let cancelCount = 0;
  let hostAborted = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let resolveCancelSeen!: () => void;
  const cancelSeen = new Promise<void>((resolve) => { resolveCancelSeen = resolve; });
  const rpc = createPluginControlHttpServer({
    resolveCredential: () => ({ credential: rpcCredential, authority: masterAuthority }),
    execute: async (call: PluginControlRpcCall, signal) => {
      if (call.body.method !== 'block') return { sequence: call.sequence };
      resolveStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { hostAborted = true; reject(new Error('aborted')); }, { once: true });
      });
      return { sequence: call.sequence };
    },
  });
  const master = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const message = parsePluginControlRpcMessage(await request.clone().text());
      if (message.kind !== 'cancel') return rpc.handle(request);
      cancelCount += 1;
      const response = rpc.handle(request);
      return response.finally(() => {
        masterAuthority = higherAuthority;
        resolveCancelSeen();
      });
    },
  });
  const provider = createWorkerPluginControlHttpProvider({
    supervision,
    worker: { ...identity, boot_nonce: bootNonce },
    managementHost: '127.0.0.1',
    managementPort: master.port!,
    authoritySource: worker,
    deadlineMs: 1_000,
  });
  const bound = provider.provider({} as any, { revision: 3, endpointId: 'endpoint-1', attemptId: randomUUID() });
  const post = async (path: string, body: unknown): Promise<Response> => fetch(`http://127.0.0.1:${worker.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const lease = async (nextAuthority: ControllerAuthority, sequence: number): Promise<void> => {
    const challenge = await post('/__supervision/challenge', { ...nextAuthority, request_id: randomUUID(), sequence })
      .then((response) => response.json()) as any;
    const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...supervision.identity, ...nextAuthority, sequence, request_id: randomUUID(), challenge_nonce: challenge.message.challenge_nonce }, supervision);
    expect((await post('/__supervision/attach', attach)).status).toBe(200);
    const signedLease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...supervision.identity, ...nextAuthority, sequence: sequence + 1, request_id: randomUUID(), lease_expires_at: Date.now() + 1_000 }, supervision);
    expect((await post('/__supervision/lease', signedLease)).status).toBe(200);
  };
  try {
    await lease(authority, 1);
    const blocked = bound.call('block', {}, new AbortController().signal).then(() => null, (error) => error);
    await started;
    await lease(higherAuthority, 3);
    expect(await blocked).toMatchObject({ code: 'stale_controller' });
    await cancelSeen;
    expect(cancelCount).toBe(1);
    expect(hostAborted).toBe(true);
    await expect(bound.call('ok', {}, new AbortController().signal)).resolves.toEqual({ sequence: 3 });
  } finally {
    provider.dispose();
    await worker.stop();
    await master.stop(true);
  }
});
