import { describe, expect, test } from 'bun:test';
import {
  deriveSupervisionProcessKey,
  hashSupervisionBody,
  PendingChallengeStore,
  signSupervisionMessage,
  SupervisionProtocolError,
  type ControllerAuthority,
} from '../../src/supervision';
import {
  IngressAdmissionRegistry,
  IngressControllerClient,
  IngressSupervisionHttpServer,
  parseIngressStatusPayload,
  type AdmissionSet,
} from '../../src/ingress';
import { discoverIngressIdentity } from '../../src/ingress/supervision-http';

const instance = '10000000-0000-4000-8000-000000000001';
const processId = '20000000-0000-4000-8000-000000000001';
const boot = '30000000-0000-4000-8000-000000000001';
const controllerId = '40000000-0000-4000-8000-000000000001';
const otherControllerId = '40000000-0000-4000-8000-000000000002';
const root = new Uint8Array(32).fill(9);
const credential = deriveSupervisionProcessKey(root, instance, 'ingress', processId, boot);
const authority: ControllerAuthority = { controller_epoch: 1, controller_id: controllerId };

function admission(sequence: number): AdmissionSet {
  return {
    master_generation: '50000000-0000-4000-8000-000000000001', admission_sequence: sequence, revision: sequence,
    content_hash: `sha256:${'a'.repeat(64)}`, plugin_catalog_hash: `sha256:${'b'.repeat(64)}`,
    workers: [{
      master_generation: '50000000-0000-4000-8000-000000000001',
      worker_instance_id: '60000000-0000-4000-8000-000000000001',
      boot_nonce: '70000000-0000-4000-8000-000000000001', worker_slot: 0, private_port: 40_001,
    }],
  };
}

function serverAt(clock: () => number = () => Date.now()): IngressSupervisionHttpServer {
  return new IngressSupervisionHttpServer({
    credential, registry: new IngressAdmissionRegistry(),
    challenges: new PendingChallengeStore({ clock, ttlMs: 10 }), clock,
  });
}

function client(server: IngressSupervisionHttpServer): IngressControllerClient {
  return new IngressControllerClient({
    baseUrl: 'http://127.0.0.1',
    credential,
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
}

function rawRequest(client: IngressControllerClient, init: RequestInit = {}): Promise<unknown> {
  return (client as unknown as { request(path: string, init: RequestInit): Promise<unknown> }).request('/test', init);
}

describe('ingress supervision HTTP', () => {
  test('status payload pid is a strict positive integer under exact keys', () => {
    const registry = { active: null, prepared: null, retired: [] };
    const base = { state: 'attached' as const, registry };
    expect(parseIngressStatusPayload({ ...base, pid: 123 })).toMatchObject({ pid: 123, state: 'attached' });
    for (const pid of [undefined, null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const value: Record<string, unknown> = { ...base };
      if (pid !== undefined) value.pid = pid;
      expect(() => parseIngressStatusPayload(value)).toThrow(SupervisionProtocolError);
    }
  });

  test('the signed status body reports the server pid and attach exposes isAttached and onAttached', async () => {
    let attachedNotifications = 0;
    const server = new IngressSupervisionHttpServer({
      credential, registry: new IngressAdmissionRegistry(), pid: 4_242,
      onAttached: () => { attachedNotifications += 1; },
    });
    expect(server.isAttached()).toBeFalse();
    const controller = client(server);
    const attachedStatus = await controller.attach(await controller.challenge(authority), authority, 1);
    expect(attachedStatus).toMatchObject({ pid: 4_242 });
    expect(server.isAttached()).toBeTrue();
    expect(attachedNotifications).toBe(1);
    expect((await controller.status(authority)).pid).toBe(4_242);
    server.stop();
  });

  test('status remains read-only beyond the command replay capacity without weakening sequence or request replay', async () => {
    const server = serverAt();
    const controller = client(server);
    try {
      await controller.attach(await controller.challenge(authority), authority, 1);
      await controller.lease(authority, Date.now() + 5_000, 2);
      for (let sequence = 3; sequence < 303; sequence += 1) {
        await controller.status(authority, sequence);
      }

      const oldSequence = signSupervisionMessage({
        protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
        ...credential.identity, ...authority, sequence: 302,
        request_id: '80000000-0000-4000-8000-000000000010', status: 'request', body_hash: hashSupervisionBody(null),
      }, credential);
      const oldResponse = await server.fetch(new Request('http://127.0.0.1/__supervision/status', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oldSequence),
      }));
      expect(oldResponse.status).toBe(409);

      const request = signSupervisionMessage({
        protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
        ...credential.identity, ...authority, sequence: 303,
        request_id: '80000000-0000-4000-8000-000000000011', status: 'request', body_hash: hashSupervisionBody(null),
      }, credential);
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) };
      expect((await server.fetch(new Request('http://127.0.0.1/__supervision/status', init))).status).toBe(200);
      expect((await server.fetch(new Request('http://127.0.0.1/__supervision/status', init))).status).toBe(409);
    } finally {
      server.stop();
    }
  });

  test('uses one deadline for send and JSON parsing and aborts an uncooperative send', async () => {
    let aborted = false;
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 20,
      fetch: async (_input, init) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        await new Promise<void>(() => undefined);
        return Response.json({ ok: true });
      },
    });

    await expect(rawRequest(controller)).rejects.toMatchObject({
      message: 'supervision HTTP request failed',
      cause: { name: 'TimeoutError' },
    });
    expect(aborted).toBeTrue();
  });

  test('cancels a late response body after the send deadline', async () => {
    let resolveLate!: (response: Response) => void;
    let cancelled = false;
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 20,
      fetch: async () => new Promise<Response>((resolve) => { resolveLate = resolve; }),
    });

    await expect(rawRequest(controller)).rejects.toMatchObject({ message: 'supervision HTTP request failed' });
    resolveLate(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    await Bun.sleep(10);
    expect(cancelled).toBeTrue();
  });

  test('cancels a hanging response body and consumes a late JSON settlement', async () => {
    let resolveJson!: (value: unknown) => void;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
    Object.defineProperty(response, 'json', { value: () => new Promise<unknown>((resolve) => { resolveJson = resolve; }) });
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 20,
      fetch: async () => response,
    });

    await expect(rawRequest(controller)).rejects.toMatchObject({ message: 'supervision HTTP request failed' });
    resolveJson({ ok: true });
    await Bun.sleep(10);
    expect(cancelled).toBeTrue();
  });

  test('returns normal JSON responses and preserves ordinary send causes', async () => {
    const success = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 100,
      fetch: async () => Response.json({ ok: true }),
    });
    await expect(rawRequest(success)).resolves.toEqual({ ok: true });

    const cause = new Error('transport failed');
    const failure = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 100,
      fetch: async () => { throw cause; },
    });
    await expect(rawRequest(failure)).rejects.toMatchObject({ message: 'supervision HTTP request failed', cause });
  });

  test('closes each local control request without replacing existing headers', async () => {
    const requests: RequestInit[] = [];
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential,
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        return Response.json({ ok: true });
      },
    });

    await rawRequest(controller, { method: 'GET', headers: { 'x-test': 'get' } });
    await rawRequest(controller, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test': 'post' }, body: '{}' });

    expect(requests.map(({ headers }) => new Headers(headers))).toEqual([
      new Headers({ connection: 'close', 'x-test': 'get' }),
      new Headers({ connection: 'close', 'content-type': 'application/json', 'x-test': 'post' }),
    ]);
  });

  test('allows a new control request after an aborted send that ignores abort', async () => {
    const server = serverAt();
    const signalController = new AbortController();
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let ignoreNext = false;
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 5_000,
      fetch: async (_input, init) => {
        if (ignoreNext) {
          ignoreNext = false;
          firstStarted();
          await new Promise<Response>(() => undefined);
        }
        return server.fetch(new Request(_input, init));
      },
    });

    try {
      await controller.attach(await controller.challenge(authority), authority, 1);
      await controller.lease(authority, Date.now() + 5_000, 2);
      ignoreNext = true;
      const oldFence = controller.fence(authority, 3, undefined, signalController.signal);
      await started;
      signalController.abort(new Error('generation changed'));
      await expect(oldFence).rejects.toMatchObject({ cause: { message: 'generation changed' } });
      await expect(controller.fence(authority, 4)).resolves.toMatchObject({ state: 'attached' });
    } finally {
      server.stop();
    }
  });

  test('handles a late transport rejection without unhandled rejection', async () => {
    let rejectLate!: (cause: unknown) => void;
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown): void => { unhandled.push(cause); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new IngressControllerClient({
        baseUrl: 'http://127.0.0.1', credential, timeoutMs: 20,
        fetch: async () => new Promise<Response>((_resolve, reject) => { rejectLate = reject; }),
      });
      await expect(rawRequest(controller)).rejects.toMatchObject({ message: 'supervision HTTP request failed' });
      rejectLate(new Error('late transport failure'));
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('aborts a hanging request through the caller signal without waiting for fetch', async () => {
    const signalController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const controller = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential, timeoutMs: 5_000,
      fetch: async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        await new Promise<Response>(() => undefined);
        throw new Error('unreachable');
      },
    });
    const request = rawRequest(controller, { signal: signalController.signal });
    signalController.abort(new Error('cancelled by generation'));
    await expect(request).rejects.toMatchObject({ cause: { message: 'cancelled by generation' } });
    expect(receivedSignal?.aborted).toBeTrue();
  });

  test('uses challenge/attach, strict body hashes, admission commands, and frozen lease state', async () => {
    let now = 100;
    const server = serverAt(() => now);
    const controller = client(server);
    const challenge = await controller.challenge(authority);
    await controller.attach(challenge, authority, 1);
    await controller.lease(authority, 200, 2);
    await controller.command(authority, 3, '/prepare', admission(1));
    await controller.command(authority, 4, '/commit', admission(1));
    await controller.command(authority, 5, '/prepare', admission(2));
    await controller.lease(authority, 110, 6);
    now = 110;
    const statusBody = await controller.status(authority);
    expect(statusBody.state).toBe('frozen');
    expect(statusBody.registry.prepared).toBeNull();
    const frozen = await controller.command(authority, 7, '/prepare', admission(2)).catch((error: unknown) => error);
    expect(frozen).toBeInstanceOf(SupervisionProtocolError);
    expect(frozen).toMatchObject({ code: 'ingress_frozen' });
  });

  test('fences delayed admission commands with a signed correlated no-op', async () => {
    const server = serverAt(() => 100);
    const controller = client(server);
    await controller.attach(await controller.challenge(authority), authority, 1);
    await controller.lease(authority, 200, 2);
    await controller.command(authority, 3, '/prepare', admission(1));

    const fenced = await controller.fence(authority, 5);
    expect(fenced.registry.active).toBeNull();
    expect(fenced.registry.prepared?.admission_sequence).toBe(1);

    const delayedCommit = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process', ...credential.identity,
      ...authority, sequence: 4, request_id: '80000000-0000-4000-8000-000000000003', method: 'POST',
      path: '/commit', body_hash: hashSupervisionBody(admission(1)),
    }, credential);
    const response = await server.fetch(new Request('http://127.0.0.1/__supervision/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: delayedCommit, body: admission(1) }),
    }));
    expect(response.status).toBe(409);
    expect(await controller.status(authority)).toMatchObject({ registry: { active: null, prepared: admission(1) } });
    server.stop();
  });

  test('accepts the commit-first schedule and leaves the target active after the fence', async () => {
    const server = serverAt(() => 100);
    const controller = client(server);
    await controller.attach(await controller.challenge(authority), authority, 1);
    await controller.lease(authority, 200, 2);
    await controller.command(authority, 3, '/prepare', admission(1));
    await controller.command(authority, 4, '/commit', admission(1));
    const fenced = await controller.fence(authority, 5);
    expect(fenced.registry.active).toEqual(admission(1));
    expect((await controller.status(authority)).registry.prepared).toBeNull();
    server.stop();
  });

  test('rejects tamper, replay, stale, split-brain, wrong direction, and malformed bodies', async () => {
    let now = 100;
    const server = serverAt(() => now);
    const controller = client(server);
    const challenge = await controller.challenge(authority);
    await controller.attach(challenge, authority, 1);
    const command = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process', ...credential.identity,
      ...authority, sequence: 2, request_id: '80000000-0000-4000-8000-000000000001', method: 'POST',
      path: '/prepare', body_hash: hashSupervisionBody(admission(1)),
    }, credential);
    const tampered = await server.fetch(new Request('http://127.0.0.1/__supervision/command', {
      method: 'POST', body: JSON.stringify({ message: command, body: admission(2) }),
    }));
    expect(tampered.status).toBe(400);
    const replay = await controller.attach(challenge, authority, 1).catch((error: unknown) => error);
    expect(replay).toMatchObject({ code: 'challenge_replayed' });
    const staleChallenge = await controller.challenge({ controller_epoch: 0, controller_id: controllerId });
    const stale = await controller.attach(staleChallenge, { controller_epoch: 0, controller_id: controllerId }).catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: 'stale_controller' });
    const splitChallenge = await controller.challenge({ controller_epoch: 1, controller_id: otherControllerId });
    const split = await controller.attach(splitChallenge, { controller_epoch: 1, controller_id: otherControllerId }).catch((error: unknown) => error);
    expect(split).toMatchObject({ code: 'split_brain' });
    const malformed = await server.fetch(new Request('http://127.0.0.1/__supervision/command', {
      method: 'POST', body: '{"message":{}}',
    }));
    expect(malformed.status).toBe(400);
    now = 111;
  });

  test('verifies a forged lease before touching state or replay watermarks', async () => {
    let now = 100;
    const server = serverAt(() => now);
    const controller = client(server);
    await controller.attach(await controller.challenge(authority), authority, 1);
    await controller.lease(authority, 200, 2);
    const valid = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process', ...credential.identity,
      ...authority, sequence: 3, request_id: '80000000-0000-4000-8000-000000000002', lease_expires_at: 300,
    }, credential);
    const forged = { ...valid, lease_expires_at: 400 };
    const response = await server.fetch(new Request('http://127.0.0.1/__supervision/lease', {
      method: 'POST', body: JSON.stringify(forged), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(401);
    expect((await controller.status(authority)).state).toBe('attached');
    await controller.lease(authority, 300, 3);
    expect((await controller.status(authority)).state).toBe('attached');
  });

  test('client rejects a tampered signed status payload', async () => {
    const server = serverAt();
    const controller = client(server);
    await controller.attach(await controller.challenge(authority), authority, 1);
    const tamperedClient = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential,
      fetch: async (input, init) => {
        const response = await server.fetch(new Request(input, init));
        const body = await response.json() as { readonly message: unknown; readonly body: { readonly state: string } };
        return Response.json({ ...body, body: { ...body.body, state: body.body.state === 'frozen' ? 'attached' : 'frozen' } });
      },
    });
    await expect(tamperedClient.status(authority)).rejects.toMatchObject({ code: 'malformed_message' });
    server.stop();
  });

  test('binds status evidence to request correlation and expected epoch', async () => {
    const server = serverAt();
    let oldStatus: unknown;
    const capturing = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential,
      fetch: async (input, init) => {
        const response = await server.fetch(new Request(input, init));
        if (new URL(String(input)).pathname === '/__supervision/status') oldStatus = await response.clone().json();
        return response;
      },
    });
    await capturing.attach(await capturing.challenge(authority), authority, 1);
    await capturing.lease(authority, Date.now() + 5_000, 2);
    await capturing.status(authority);
    const sameEpochReplay = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential,
      fetch: async () => Response.json(oldStatus),
    });
    await expect(sameEpochReplay.status(authority)).rejects.toMatchObject({ code: 'status_correlation_mismatch' });

    const nextAuthority = { controller_epoch: 2, controller_id: otherControllerId };
    await capturing.attach(await capturing.challenge(nextAuthority), nextAuthority, 1);
    const oldEpochReplay = new IngressControllerClient({
      baseUrl: 'http://127.0.0.1', credential,
      fetch: async () => Response.json(oldStatus),
    });
    await expect(oldEpochReplay.status(nextAuthority)).rejects.toMatchObject({ code: 'stale_controller' });
    server.stop();
  });

  test('timer expiry freezes and clears prepared without stopping active service state', async () => {
    const server = new IngressSupervisionHttpServer({
      credential, registry: new IngressAdmissionRegistry(), attachGraceMs: 20,
    });
    const controller = client(server);
    await controller.attach(await controller.challenge(authority), authority, 1);
    expect((await controller.status(authority)).state).toBe('frozen');
    await controller.lease(authority, Date.now() + 40, 2);
    await controller.command(authority, 3, '/prepare', admission(1));
    await new Promise((resolve) => setTimeout(resolve, 70));
    const status = await controller.status(authority);
    expect(status.state).toBe('frozen');
    expect(status.registry.prepared).toBeNull();
    expect(server.isFrozen()).toBeTrue();
    server.stop();
  });

  test('cancels chunked oversized control bodies at the reader boundary', async () => {
    const server = new IngressSupervisionHttpServer({
      credential, registry: new IngressAdmissionRegistry(), maxBodyBytes: 16, bodyTimeoutMs: 100,
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(32)); },
      cancel() { cancelled = true; },
    });
    const response = await server.fetch(new Request('http://127.0.0.1/__supervision/challenge', {
      method: 'POST', body, duplex: 'half',
    } as RequestInit & { readonly duplex: 'half' }));
    expect(response.status).toBe(413);
    expect(cancelled).toBeTrue();
    server.stop();
  });

  test('cancels a slow control reader at the body timeout', async () => {
    const server = new IngressSupervisionHttpServer({
      credential, registry: new IngressAdmissionRegistry(), maxBodyBytes: 1024, bodyTimeoutMs: 20,
    });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { timer = setTimeout(() => controller.close(), 200); },
      cancel() { cancelled = true; if (timer !== undefined) clearTimeout(timer); },
    });
    const response = await server.fetch(new Request('http://127.0.0.1/__supervision/challenge', {
      method: 'POST', body, duplex: 'half',
    } as RequestInit & { readonly duplex: 'half' }));
    expect(response.status).toBe(408);
    expect(cancelled).toBeTrue();
    server.stop();
  });

  test('classifies Bun ConnectionRefused errors as unavailable and preserves the cause', async () => {
    const cause = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
    const error = await discoverIngressIdentity('http://127.0.0.1', async () => { throw cause; }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: 'unavailable', cause });
  });

  test('does not classify an uncoded unable-to-connect message as unavailable', async () => {
    const cause = new Error('Unable to connect. Is the computer able to access the url?');
    const error = await discoverIngressIdentity('http://127.0.0.1', async () => { throw cause; }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: 'outcome_unknown', cause });
  });

  test('recognizes refused connection codes through nested causes', async () => {
    const refused = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    const cause = new Error('fetch failed', { cause: refused });
    const error = await discoverIngressIdentity('http://127.0.0.1', async () => { throw cause; }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: 'unavailable', cause });
  });
});
