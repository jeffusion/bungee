import { describe, expect, test } from 'bun:test';
import { createManagementListener, handleManagementRequest, mergeManagementRequestSignals } from '../../src/management-listener';
import { closeForNormalShutdown } from '../../src/master-runtime/runtime-cleanup';
import type { MasterRuntimeOptions } from '../../src/master-runtime/runtime-contracts';

function request(path: string): Request {
  return new Request(`http://management.test${path}`);
}

describe('management listener routing', () => {
  test('routes the exact internal plugin control path before the control API', async () => {
    let controlCalls = 0;
    const response = await handleManagementRequest(request('/__bungee/internal/plugin-control/v1'), {
      profile: 'master-control',
      controlApi: { async handle() { controlCalls += 1; return null; } },
      internalPluginControl: { async handle() { return new Response('internal'); } },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('internal');
    expect(controlCalls).toBe(0);
  });

  test('returns a fixed 404 for the internal path when no plugin control handler exists', async () => {
    let controlCalls = 0;
    const response = await handleManagementRequest(request('/__bungee/internal/plugin-control/v1'), {
      profile: 'management',
      controlApi: { async handle() { controlCalls += 1; return new Response('control'); } },
    });

    expect(response.status).toBe(404);
    expect(controlCalls).toBe(0);
  });

  test('returns a local 404 for /v1/data', async () => {
    const response = await handleManagementRequest(request('/v1/data'), {
      profile: 'management',
      controlApi: { async handle() { return null; } },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('runs health before the control API', async () => {
    let controlCalls = 0;
    const response = await handleManagementRequest(request('/health'), {
      profile: 'management',
      controlApi: { async handle() { controlCalls += 1; return null; } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(controlCalls).toBe(0);
  });

  test('runs the master UI handler after the control API', async () => {
    const calls: string[] = [];
    const response = await handleManagementRequest(request('/'), {
      profile: 'management',
      controlApi: { async handle() { calls.push('control'); return null; } },
      masterUIHandler: async () => { calls.push('ui'); return new Response('<html>'); },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>');
    expect(calls).toEqual(['control', 'ui']);
  });

  test.each(['/api/unknown', '/api/unknown/sub'])('returns JSON 404 for %s without invoking the UI handler',
    async (path) => {
      let uiCalls = 0;
      const response = await handleManagementRequest(request(path), {
        profile: 'management',
        controlApi: { async handle() { return Response.json({ error: 'not_found' }, { status: 404 }); } },
        masterUIHandler: async () => { uiCalls += 1; return new Response('<html>'); },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(uiCalls).toBe(0);
    });

  test('rejects the removed /__ui alias', async () => {
    const response = await handleManagementRequest(request('/__ui/apiary'), {
      profile: 'management',
      controlApi: { async handle() { return null; } },
      masterUIHandler: async () => new Response('<html>'),
    });

    expect(response.status).toBe(404);
  });

  test('management profile keeps control routes off the public listener', async () => {
    const calls: string[] = [];
    const options = {
      profile: 'management' as const,
      controlApi: { async handle() { calls.push('api'); return null; } },
      internalPluginControl: { async handle() { calls.push('plugin'); return new Response('internal'); } },
      daemonControl: { accepted: false, async handle() { calls.push('daemon'); return new Response('internal'); } },
      masterUIHandler: async () => { calls.push('ui'); return null; },
    };
    expect((await handleManagementRequest(request('/__bungee/internal/plugin-control/v1'), options)).status).toBe(404);
    expect((await handleManagementRequest(request('/__bungee/internal/daemon/shutdown'), options)).status).toBe(404);
    expect((await handleManagementRequest(request('/__ui/'), options)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('master-control profile serves only daemon shutdown and plugin control', async () => {
    const options = {
      profile: 'master-control' as const,
      controlApi: { async handle() { return new Response('api'); } },
      internalPluginControl: { async handle() { return new Response('plugin'); } },
      daemonControl: { accepted: false, async handle() { return new Response('daemon'); } },
    };
    expect(await (await handleManagementRequest(request('/__bungee/internal/plugin-control/v1'), options)).text()).toBe('plugin');
    expect((await handleManagementRequest(request('/api/config'), options)).status).toBe(404);
    expect((await handleManagementRequest(request('/health'), options)).status).toBe(404);
  });
});

test('merges an already-aborted request signal without retaining fallback listeners', () => {
  const shutdown = new AbortController();
  const merged = mergeManagementRequestSignals(AbortSignal.abort('client cancelled'), shutdown.signal);
  expect(merged.signal.aborted).toBeTrue();
  merged.dispose();
});

test('forces a long-lived management stream to settle within its shutdown grace period', async () => {
  let aborted = false;
  const events: string[] = [];
  const listener = createManagementListener({ profile: 'management',
    hostname: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs: 25,
    controlApi: { async handle() { return null; } },
    masterUIHandler: async (request) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: connected\n\n'));
        request.signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  listener.start();
  listener.ready();
  const response = await fetch(`http://127.0.0.1:${listener.port}/stream`);
  expect(response.status).toBe(200);
  await response.body!.getReader().read();

  const started = Date.now();
  const errors = await closeForNormalShutdown({
    workerCount: 1,
    publicListener: listener,
    alwaysClose: async () => { events.push('stats.close'); },
    repository: { getSnapshot() { throw new Error('unused'); }, close() { events.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { async stop() { events.push('publication.stop'); } },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot() { return []; }, clear() { events.push('admission.clear'); } },
    workerPool: {
      pids() { return []; }, owns() { return false; }, subscribeExit() { return () => undefined; },
      subscribeUnavailable() { return () => undefined; }, markCommitted() {}, disconnectAll() {},
      async shutdownAll() { events.push('workers.shutdown'); return []; },
    },
    instanceLock: { async release() { events.push('lock.release'); } },
    onWorkerUnavailable() {},
  } as unknown as MasterRuntimeOptions, null, Promise.resolve());
  expect(Date.now() - started).toBeLessThan(500);
  expect(aborted).toBeTrue();
  expect(errors).toEqual([]);
  expect(events.indexOf('stats.close')).toBeLessThan(events.indexOf('workers.shutdown'));
});

test('retains the instance lock when management listener stop is unconfirmed', async () => {
  const events: string[] = [];
  const errors = await closeForNormalShutdown({
    workerCount: 1,
    publicListener: {
      port: null, start() {}, stopAccepting() { events.push('listener.reject'); },
      async stop() { events.push('listener.stop'); throw new Error('force stop failed'); },
    },
    alwaysClose: async () => { events.push('stats.close'); },
    repository: { getSnapshot() { throw new Error('unused'); }, close() { events.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { async stop() { events.push('publication.stop'); } },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot() { return []; }, clear() { events.push('admission.clear'); } },
    workerPool: {
      pids() { return []; }, owns() { return false; }, subscribeExit() { return () => undefined; },
      subscribeUnavailable() { return () => undefined; }, markCommitted() {}, disconnectAll() {},
      async shutdownAll() { events.push('workers.shutdown'); return []; },
    },
    instanceLock: { async release() { events.push('lock.release'); } },
    onWorkerUnavailable() {},
  } as unknown as MasterRuntimeOptions, null, Promise.resolve());

  expect(errors.length).toBeGreaterThan(0);
  expect(events).toContain('stats.close');
  expect(events).toContain('workers.shutdown');
  expect(events).toContain('repository.close');
  expect(events).not.toContain('lock.release');
});

test('rejects new management requests before a hanging beforeStop settles', async () => {
  const listener = createManagementListener({ profile: 'management',
    hostname: '127.0.0.1', port: 0,
    controlApi: { async handle() { return new Response('stats'); } },
  });
  listener.start();
  listener.ready();
  let releaseBeforeStop: () => void = () => { throw new Error('beforeStop was not entered'); };
  const cleanup = closeForNormalShutdown({
    workerCount: 1,
    publicListener: listener,
    repository: { getSnapshot() { throw new Error('unused'); }, close() {} },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { async stop() {} },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot() { return []; }, clear() {} },
    workerPool: {
      pids() { return []; }, owns() { return false; }, subscribeExit() { return () => undefined; },
      subscribeUnavailable() { return () => undefined; }, markCommitted() {}, disconnectAll() {}, async shutdownAll() { return []; },
    },
    instanceLock: { async release() {} },
    onWorkerUnavailable() {},
    ancillary: {
      beforeStop() { return new Promise<void>((resolve) => { releaseBeforeStop = resolve; }); },
      closeForNormalShutdown() {},
    },
  } as unknown as MasterRuntimeOptions, null, Promise.resolve());

  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseBeforeStop();
  expect(await cleanup).toEqual([]);
});

test('binds closed and returns 503 until explicitly ready', async () => {
  const listener = createManagementListener({ profile: 'management',
    hostname: '127.0.0.1',
    port: 0,
    controlApi: { async handle() { return new Response('unexpected'); } },
  });
  listener.start();
  try {
    if (listener.port === null) throw new Error('listener did not bind');
    const beforeReady = await fetch(`http://127.0.0.1:${listener.port}/health`);
    expect(beforeReady.status).toBe(503);
    listener.ready();
    const afterReady = await fetch(`http://127.0.0.1:${listener.port}/health`);
    expect(afterReady.status).toBe(200);
  } finally {
    await listener.stop();
  }
});

test('fails deterministically when the management port is occupied', async () => {
  const occupied = createManagementListener({ profile: 'management', hostname: '127.0.0.1', port: 0, controlApi: { async handle() { return null; } } });
  occupied.start();
  const port = occupied.port;
  if (port === null) throw new Error('occupied listener did not bind');
  const contender = createManagementListener({ profile: 'management', hostname: '127.0.0.1', port, controlApi: { async handle() { return null; } } });
  try {
    expect(() => contender.start()).toThrow();
  } finally {
    await contender.stop();
    await occupied.stop();
  }
});

test('propagates an original request cancellation to a waiting forwarded request', async () => {
  const original = new AbortController();
  const shutdown = new AbortController();
  const merged = mergeManagementRequestSignals(original.signal, shutdown.signal);
  const forwarded = new Request('http://management.test/api/stats', { signal: merged.signal });
  const aborted = new Promise<void>((resolve) => forwarded.signal.addEventListener('abort', () => resolve(), { once: true }));

  original.abort('client cancelled');
  await aborted;
  expect(forwarded.signal.aborted).toBeTrue();
  merged.dispose();
});
