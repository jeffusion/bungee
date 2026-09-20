import { describe, expect, test } from 'bun:test';
import {
  DAEMON_AUTHORIZATION_HEADER,
  DAEMON_BOOT_HEADER,
  DAEMON_INSTANCE_HEADER,
  DAEMON_PID_HEADER,
  createDaemonShutdownHandler,
} from '../../src/daemon-control';
import {
  DAEMON_SHUTDOWN_PATH,
  DAEMON_METADATA_MAX_BYTES,
  encodeDaemonMetadataV1,
  parseDaemonMetadataV1,
  type DaemonMetadataArmed,
  type DaemonMetadataV1,
} from '@jeffusion/bungee-types';
import { handleManagementRequest, createManagementListener, trackManagementResponse } from '../../src/management-listener';

const metadata: DaemonMetadataArmed = {
  schema: 'bungee-daemon-metadata-v1',
  launcher_pid: 5678,
  state: 'armed',
  boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890',
  instance_id: '00000000-0000-0000-0000-000000000002',
  pid: 1234,
  management_host: '127.0.0.1',
  management_port: 8089,
  executable: '/usr/local/bin/bungee',
  shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  entrypoint: null,
};

const launchingMetadata: DaemonMetadataV1 = {
  ...metadata, state: 'launching', pid: null, instance_id: null, management_host: null, management_port: null,
};
const startingMetadata: DaemonMetadataV1 = {
  ...metadata, state: 'starting', instance_id: null, management_host: null, management_port: null,
};
const stoppingMetadata: DaemonMetadataV1 = { ...metadata, state: 'stopping' };

function shutdownRequest(overrides: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}`, {
    method: 'POST',
    ...init,
    headers: {
      [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
      [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
      [DAEMON_INSTANCE_HEADER]: metadata.instance_id,
      [DAEMON_PID_HEADER]: String(metadata.pid),
      'content-length': '0',
      ...overrides,
    },
  });
}

describe('daemon metadata codec', () => {
  test('round trips strict metadata and rejects nested escaped duplicate keys', () => {
    const encoded = encodeDaemonMetadataV1(metadata);
    expect(parseDaemonMetadataV1(encoded)).toEqual(metadata);
    const duplicate = encoded.replace('"schema":"bungee-daemon-metadata-v1"', '"schema":"bungee-daemon-metadata-v1","nested":{"a":1,"\\u0061":2}');
    expect(() => parseDaemonMetadataV1(duplicate)).toThrow('duplicate object key');
    expect(() => parseDaemonMetadataV1(encoded.replace('"schema"', '"unknown","schema"'))).toThrow();
  });

  test('rejects non-canonical UUID, secret, unknown and oversized metadata', () => {
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, boot_nonce: metadata.boot_nonce.toUpperCase() }))).toThrow();
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, shutdown_secret: 'short' }))).toThrow();
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, extra: true }))).toThrow();
    expect(() => parseDaemonMetadataV1(`${JSON.stringify(metadata)}${' '.repeat(4096)}`)).toThrow('4 KiB');
  });

  test('covers metadata state, numeric boundaries, exact size, and invalid UTF-8', () => {
    for (const variant of [launchingMetadata, startingMetadata, metadata, stoppingMetadata]) {
      expect(parseDaemonMetadataV1(encodeDaemonMetadataV1(variant))).toEqual(variant);
    }
    for (const pid of [0, -1, 1.5, '1234']) {
      expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, pid }))).toThrow();
    }
    for (const launcher_pid of [0, -1, 1.5, '5678']) {
      expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, launcher_pid }))).toThrow();
    }
    for (const management_port of [0, 65_536, 1.5, '8089']) {
      expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, management_port }))).toThrow();
    }
    const emptyExecutable = JSON.stringify({ ...metadata, executable: '' });
    const emptyBytes = new TextEncoder().encode(emptyExecutable).byteLength;
    const executableBytes = DAEMON_METADATA_MAX_BYTES - emptyBytes;
    const exactExecutable = 'é'.repeat(Math.floor(executableBytes / 2)) + (executableBytes % 2 === 1 ? 'x' : '');
    const exact = JSON.stringify({ ...metadata, executable: exactExecutable });
    expect(new TextEncoder().encode(exact).byteLength).toBe(DAEMON_METADATA_MAX_BYTES);
    expect(parseDaemonMetadataV1(exact).executable).toBe(exactExecutable);
    expect(() => parseDaemonMetadataV1(`${exact} `)).toThrow('4 KiB');
    expect(() => parseDaemonMetadataV1(new Uint8Array([0xff]))).toThrow('UTF-8');
    expect(encodeDaemonMetadataV1({ ...metadata, entrypoint: '/tmp/direct.ts' })).toContain('direct.ts');
    expect(encodeDaemonMetadataV1({ ...metadata, entrypoint: null })).toContain('"entrypoint":null');
    for (const entrypoint of ['', ' relative.ts', 'relative.ts', '/bad\0path']) {
      expect(() => encodeDaemonMetadataV1({ ...metadata, entrypoint })).toThrow();
    }
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...metadata, state: 'launching' }))).toThrow();
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...startingMetadata, pid: null, instance_id: metadata.instance_id }))).toThrow();
    expect(() => parseDaemonMetadataV1(JSON.stringify({ ...launchingMetadata, pid: metadata.pid }))).toThrow();
  });
});

describe('daemon shutdown wire contract', () => {
  test('reserves the whole daemon prefix without downstream calls', async () => {
    const calls: string[] = [];
    for (const path of [
      '/__bungee/internal/daemon',
      '/__bungee/internal/daemon/v1/other',
      '/__bungee/internal/daemon%2Fv1',
      '/__bungee/internal/%64aemon%2fv1',
      '/__bungee/internal/%64%61%65%6d%6f%6e%2Fv1',
      '/__bungee/internal/%2564%2561%2565%256d%256f%256e%252Fv1',
      '/__bungee/internal/%',
    ]) {
      const result = await handleManagementRequest(new Request(`http://127.0.0.1${path}`), {
        profile: 'management',
        controlApi: { async handle() { calls.push('control'); return new Response('bad'); } },
        internalPluginControl: { async handle() { calls.push('plugin'); return new Response('bad'); } },
        masterUIHandler: async () => { calls.push('ui'); return new Response('bad'); },
      });
      expect(result.status).toBe(404);
      expect(await result.text()).toBe('{"error":"not_found"}');
    }
    expect(calls).toEqual([]);
  });

  test('compares malformed secret lengths through the padded comparator and returns fixed 404', async () => {
    const lengths: number[] = [];
    const handler = createDaemonShutdownHandler({
      metadata,
      onShutdownRequested() {},
      comparator(left, right) {
        lengths.push(left.byteLength, right.byteLength);
        return left.every((byte, index) => byte === right[index]);
      },
    });
    const result = await handler.handle(shutdownRequest({ [DAEMON_AUTHORIZATION_HEADER]: 'Bearer short' }));
    expect(result.status).toBe(404);
    expect(lengths).toEqual([metadata.shutdown_secret.length, metadata.shutdown_secret.length]);
  });

  test('runs the fixed comparator once for short, malformed, combined, and overlong authorization', async () => {
    let calls = 0;
    const handler = createDaemonShutdownHandler({
      metadata,
      onShutdownRequested() {},
      comparator(left, right) {
        calls += 1;
        expect(left.byteLength).toBe(43);
        expect(right.byteLength).toBe(43);
        return left.every((byte, index) => byte === right[index]);
      },
    });
    for (const authorization of [null, 'Basic nope', 'Bearer short', 'Bearer a'.repeat(100)]) {
      const requestHeaders = new Headers(shutdownRequestInit().headers);
      if (authorization === null) requestHeaders.delete(DAEMON_AUTHORIZATION_HEADER);
      else requestHeaders.set(DAEMON_AUTHORIZATION_HEADER, authorization);
      expect((await handler.handle(new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}`, {
        method: 'POST', headers: requestHeaders,
      }))).status).toBe(404);
    }
    expect(calls).toBe(4);
  });

  test('rejects wire hostile forms with fixed no-store responses', async () => {
    const handler = createDaemonShutdownHandler({ metadata, onShutdownRequested() {} });
    const hostile: Request[] = [
      shutdownRequest({}, { method: 'GET' }),
      new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}?x=1`, shutdownRequestInit()),
      shutdownRequest({}, { body: 'x' }),
      shutdownRequest({ 'transfer-encoding': 'chunked' }),
      shutdownRequest({ [DAEMON_PID_HEADER]: '01234' }),
      shutdownRequest({ [DAEMON_BOOT_HEADER]: 'wrong' }),
    ];
    const duplicateHeaders = new Headers(shutdownRequestInit().headers);
    duplicateHeaders.append(DAEMON_PID_HEADER, String(metadata.pid));
    hostile.push(new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}`, { method: 'POST', headers: duplicateHeaders }));
    for (const request of hostile) {
      const result = await handler.handle(request);
      expect(result.status).toBe(404);
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('returns starting only after authentication and identity validation', async () => {
    const handler = createDaemonShutdownHandler({ metadata: startingMetadata, onShutdownRequested() {} });
    expect((await handler.handle(shutdownRequest())).status).toBe(503);
    expect((await handler.handle(shutdownRequest({ [DAEMON_PID_HEADER]: '9999' }))).status).toBe(404);
    expect((await createDaemonShutdownHandler({ metadata: stoppingMetadata, onShutdownRequested() {} }).handle(shutdownRequest(), {
      onResponseSettled() {},
    })).status).toBe(202);
    expect((await createDaemonShutdownHandler({ metadata, onShutdownRequested() {} }).handle(shutdownRequest())).status).toBe(503);
    let callbacks = 0;
    const launchingHandler = createDaemonShutdownHandler({
      metadata: launchingMetadata,
      onShutdownRequested: () => { callbacks += 1; },
    });
    expect((await launchingHandler.handle(shutdownRequest(), { onResponseSettled() { callbacks += 10; } })).status).toBe(503);
    expect(callbacks).toBe(0);
  });

  test('does not notify until response settlement and notifies once on cancellation', async () => {
    let notifications = 0;
    let settle: (() => void) | undefined;
    const handler = createDaemonShutdownHandler({
      metadata,
      onShutdownRequested: () => { notifications += 1; },
    });
    const result = await handler.handle(shutdownRequest(), { onResponseSettled(callback) { settle = callback; } });
    expect(result.status).toBe(202);
    expect(notifications).toBe(0);
    settle?.();
    settle?.();
    expect(notifications).toBe(1);
  });

  test('returns 202 for an armed ACK replay after stopping without registering another callback', async () => {
    let state: DaemonMetadataV1['state'] = 'armed';
    let notifications = 0;
    const callbacks: Array<() => void | Promise<void>> = [];
    const handler = createDaemonShutdownHandler({
      metadata: () => state === 'armed' ? metadata : stoppingMetadata,
      onShutdownRequested: () => { notifications += 1; },
    });
    const first = await handler.handle(shutdownRequest(), {
      onResponseSettled(callback) { callbacks.push(callback); },
    });
    state = 'stopping';
    const replay = await handler.handle(shutdownRequest(), {
      onResponseSettled(callback) { callbacks.push(callback); },
    });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(callbacks.length).toBe(1);
    await callbacks[0]();
    expect(notifications).toBe(1);
  });

  test('does not settle the active outer stream until inner cancel completes', async () => {
    let cancelStarted = false;
    let finishCancel: (() => void) | undefined;
    let settled = 0;
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() {
        cancelStarted = true;
        return new Promise<void>((resolve) => { finishCancel = resolve; });
      },
    }));
    const outer = trackManagementResponse(inner, () => { settled += 1; });
    const reader = outer.body!.getReader();
    await reader.read();
    const cancellation = reader.cancel('client cancelled');
    await Promise.resolve();
    expect(cancelStarted).toBeTrue();
    expect(settled).toBe(0);
    finishCancel?.();
    await cancellation;
    expect(settled).toBe(1);
  });

  test('real management listener leaves a 202 unsettled until the response body closes', async () => {
    let shutdowns = 0;
    let closeBody: (() => void) | undefined;
    const port = await getAvailablePort();
    const listener = createManagementListener({ profile: 'master-control',
      hostname: '127.0.0.1',
      port,
      controlApi: { async handle() { return null; } },
      daemonControl: {
        accepted: true,
        async handle(_request, context) {
          context?.onResponseSettled(() => { shutdowns += 1; });
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":"accepted"}'));
              closeBody = () => { controller.close(); };
            },
          });
          return new Response(body, { status: 202, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    try {
      listener.start();
      listener.ready();
      if (listener.port === null) throw new Error('listener did not start');
      const response = await fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`);
      expect(response.status).toBe(202);
      expect(shutdowns).toBe(0);
      closeBody?.();
      await response.text();
      expect(shutdowns).toBe(1);
    } finally {
      await listener.stop();
    }
  });

  test('transitions once for concurrent valid requests and settles the response before notifying', async () => {
    let notifications = 0;
    const port = await getAvailablePort();
    const listener = createManagementListener({ profile: 'master-control',
      hostname: '127.0.0.1',
      port,
      controlApi: { async handle() { return null; } },
      daemonControl: createDaemonShutdownHandler({
        metadata,
        onShutdownRequested: () => { notifications += 1; },
      }),
    });
    try {
      listener.start();
      listener.ready();
      if (listener.port === null) throw new Error('listener did not start');
      const responses = await Promise.all([
        fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`, shutdownRequestInit()),
        fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`, shutdownRequestInit()),
      ]);
      expect(responses.every((result) => result.status === 202)).toBeTrue();
      await Promise.all(responses.map((result) => result.text()));
      expect(notifications).toBe(1);
    } finally {
      await listener.stop();
    }
  });

  test('reports a throwing settlement callback without failing the response stream', async () => {
    let callbackErrors = 0;
    const port = await getAvailablePort();
    const listener = createManagementListener({ profile: 'master-control',
      hostname: '127.0.0.1',
      port,
      controlApi: { async handle() { return null; } },
      onResponseSettlementError: () => { callbackErrors += 1; },
      daemonControl: createDaemonShutdownHandler({
        metadata,
        onShutdownRequested: () => { throw new Error('coordinator failed'); },
      }),
    });
    try {
      listener.start();
      listener.ready();
      if (listener.port === null) throw new Error('listener did not start');
      const result = await fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`, shutdownRequestInit());
      expect(result.status).toBe(202);
      expect(await result.text()).toBe(acceptedBody(metadata));
      expect(callbackErrors).toBe(1);
    } finally {
      await listener.stop();
    }
  });

  test('reports an async settlement rejection once without an unhandled rejection', async () => {
    let callbackErrors = 0;
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    const port = await getAvailablePort();
    process.on('unhandledRejection', onUnhandled);
    const listener = createManagementListener({ profile: 'master-control',
      hostname: '127.0.0.1',
      port,
      controlApi: { async handle() { return null; } },
      daemonControl: createDaemonShutdownHandler({
        metadata,
        onShutdownRequested: async () => { throw new Error('coordinator failed'); },
        onShutdownError: () => { callbackErrors += 1; },
      }),
    });
    try {
      listener.start();
      listener.ready();
      if (listener.port === null) throw new Error('listener did not start');
      const result = await fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`, shutdownRequestInit());
      expect(result.status).toBe(202);
      expect(await result.text()).toBe(acceptedBody(metadata));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbackErrors).toBe(1);
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await listener.stop();
    }
  });

  test('keeps the accepted response readable when its callback stops the listener', async () => {
    let listener: ReturnType<typeof createManagementListener> | undefined;
    const port = await getAvailablePort();
    listener = createManagementListener({ profile: 'master-control',
      hostname: '127.0.0.1',
      port,
      controlApi: { async handle() { return null; } },
      daemonControl: createDaemonShutdownHandler({
        metadata,
        onShutdownRequested: () => { void listener?.stop(); },
      }),
    });
    try {
      listener.start();
      listener.ready();
      if (listener.port === null) throw new Error('listener did not start');
      const result = await fetch(`http://127.0.0.1:${listener.port}${DAEMON_SHUTDOWN_PATH}`, shutdownRequestInit());
      expect(result.status).toBe(202);
      expect(await result.text()).toBe(acceptedBody(metadata));
    } finally {
      await listener.stop();
    }
  });
});

async function getAvailablePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  if (port === undefined) throw new Error('temporary listener did not bind');
  return port;
}

function shutdownRequestInit(): RequestInit {
  return {
    method: 'POST',
    headers: {
      [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
      [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
      [DAEMON_INSTANCE_HEADER]: metadata.instance_id,
      [DAEMON_PID_HEADER]: String(metadata.pid),
      'content-length': '0',
    },
  };
}

function acceptedBody(value: DaemonMetadataV1): string {
  return JSON.stringify({ status: 'accepted', boot_nonce: value.boot_nonce, instance_id: value.instance_id, pid: value.pid });
}
