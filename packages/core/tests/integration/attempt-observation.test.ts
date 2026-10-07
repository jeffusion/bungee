import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { ScopedPluginRegistry, setScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { initializeRuntimeState } from '../../src/worker/state/runtime-state';
import { handleRequest } from '../../src/worker/request/handler';
import type { AttemptObservationEvent } from '../../src/hooks/plugin-hooks';
import { createAttemptResponseObserver } from '../../src/worker/response/attempt-observation';
import { ChatgptOauthAdapter } from '../../../../plugins/chatgpt-oauth/server/adapter';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

const originalFetch = globalThis.fetch;

// A fake upstream must consume the upload just like the real HTTP transport.
function consumingUpstreamFetch(mockFetch: typeof fetch): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' && init?.body != null) await new Response(init.body).arrayBuffer();
    return mockFetch(input, init);
  }, { preconnect: () => undefined }) as typeof fetch;
}

const roots: string[] = [];
const registries: ScopedPluginRegistry[] = [];
const byteObserverCompletions: Promise<void>[] = [];
function trackedByteObserver(...args: Parameters<typeof createAttemptResponseObserver>) {
  const observer = createAttemptResponseObserver(...args);
  byteObserverCompletions.push(observer.completion);
  return observer;
}
async function settleByteObservers() { await Promise.all(byteObserverCompletions.splice(0)); }
async function waitForObservation(phase: AttemptObservationEvent['phase']) {
  const deadline = Date.now() + 1000;
  while (!state().events.some(({ event }) => event.phase === phase) && Date.now() < deadline) await Bun.sleep(1);
  expect(state().events.some(({ event }) => event.phase === phase)).toBe(true);
}
const stateKey = `attempt-observation:${crypto.randomUUID()}`;

function pluginFile(root: string): string {
  const path = join(root, 'observer.ts');
  writeFileSync(path, `
function state() {
  const root = globalThis;
  return root[${JSON.stringify(stateKey)}] ??= { events: [], business: 0, order: [], rawMeta: null, lateWrites: 0, lateInvalidations: 0 };
}
export default class Observer {
  static name = 'attempt-observer';
  static version = '1';
  static createHandler(config) {
    return {
      pluginName: 'attempt-observer', config,
      bodyRequirements() { return { request: 'none', response: config.oauthAdapter ? ['json','sse-json'] : [], observe: { request: true, response: true, sse: true } }; },
      register(hooks) {
        hooks.onBeforeRequest.tapPromise('business', async (ctx) => { state().business++; return ctx; });
        hooks.onAttemptObservation.tapPromise('observer', async (event) => {
          state().events.push({ label: config.label, event });
          if (event.phase === 'response') state().order.push('observed:' + event.protocol + ':' + JSON.stringify(event.body));
          if (config.holdRequestObserver && event.phase === 'request') {
            await new Promise<void>(resolve => { state().releaseRequestObserver = () => resolve(); });
          }
          if (config.lateObserver && event.phase === 'response') {
            await new Promise<void>(resolve => { state().releaseResponseObserver = () => resolve(); });
            if (event.isActive()) state().lateWrites++;
            else state().lateInvalidations++;
            state().finishLateObserver?.();
          }
          if (config.hangObserver && event.phase === 'response') return await new Promise(() => undefined);
          if (config.throwObserver && event.phase === 'response') throw new Error('observer failure');
        });
        if (config.rawTransform || config.rawReplaceWithoutRead || config.rawCleanupThrows) hooks.onRawResponse.tapPromise('raw-transform', async (result) => {
          state().order.push('raw-hook-start');
          if (config.rawReplaceWithoutRead) return { ...result, response: new Response('{"replacement":true}', { headers: { 'content-type': 'application/json' } }) };
          if (config.rawCleanupThrows) return { ...result, response: new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode('data: partial' + String.fromCharCode(10, 10))); },
            cancel() { throw new Error('cleanup cancellation failed'); },
          }), { status: 503, headers: { 'content-type': 'text/event-stream' } }) };
          state().rawMeta = { url: result.response.url, status: result.response.status, headers: [...result.response.headers.keys()] };
          await result.response.text();
          state().order.push('raw-hook-finished');
          const encoder = new TextEncoder();
          const bytes = encoder.encode('{"from":"raw-hook"}');
          const response = new Response(new ReadableStream({ start(controller) {
            controller.enqueue(bytes.slice(0, 4));
            controller.enqueue(bytes.slice(4, 9));
            controller.enqueue(bytes.slice(9));
            controller.close();
          } }), { status: result.response.status, headers: { 'content-type': 'application/json' } });
          return { ...result, response };
        });
        if (config.oauthAdapter) hooks.onRawResponse.tapPromise('chatgpt-oauth-adapter', async (result, context) => {
          const adapter = state().adapter;
          adapter.beforeRequest({
            method: 'POST', originalUrl: new URL('http://local/v1/chat/completions'),
            url: new URL('http://local/v1/chat/completions'), headers: {},
            body: { stream: true, stream_options: { include_usage: true } }, clientIP: '127.0.0.1',
            requestId: context.requestId, routeId: context.routeId, serviceName: 'svc',
          });
          return await adapter.rawResponse(result, context);
        });
        if (config.intercept) hooks.onInterceptRequest.tapPromise('intercept', async () => ({ action: 'respond', response: new Response('local') }));
      }
    };
  }
}
`);
  return path;
}

function state(): { events: Array<{ label: string; event: AttemptObservationEvent }>; business: number; order: string[]; rawMeta: unknown; lateWrites: number; lateInvalidations: number; releaseRequestObserver?: () => void; releaseResponseObserver?: () => void; finishLateObserver?: () => void } {
  return (globalThis as typeof globalThis & Record<string, any>)[stateKey];
}

function controlObserverDeadline(phase: 'request' | 'response' = 'response') {
  const originalSetTimeout = globalThis.setTimeout;
  let scheduled!: (deadline: { delay: number; expire: () => void }) => void;
  const deadline = new Promise<{ delay: number; expire: () => void }>((resolve) => { scheduled = resolve; });
  const heldTimers: Array<{ timer: ReturnType<typeof setTimeout>; fire: () => void }> = [];
  const expire = () => { for (const held of heldTimers.splice(0)) { clearTimeout(held.timer); held.fire(); } };
  // Registry dispatch and the byte side channel each own a 250 ms deadline.
  // Hold both so neither can mask a wire-delivery stall in the other layer.
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(new Proxy(originalSetTimeout, {
    apply(target, thisArg, args) {
      const [callback, delay, ...callbackArgs] = args;
      const event = state().events.at(-1)?.event;
      if (delay === 250 && event?.phase === phase && event.isActive() && typeof callback === 'function') {
        const heldTimer = Reflect.apply(target, thisArg, [callback, 60_000, ...callbackArgs]);
        heldTimers.push({ timer: heldTimer, fire: () => callback(...callbackArgs) });
        scheduled({ delay, expire });
        return heldTimer;
      }
      return Reflect.apply(target, thisArg, args);
    },
  }));
  return { deadline, restore: () => { timer.mockRestore(); expire(); } };
}

async function setup(options: { twoUpstreams?: boolean; retry?: boolean; intercept?: boolean; multiScope?: boolean; throwObserver?: boolean; hangObserver?: boolean; lateObserver?: boolean; rawTransform?: boolean; rawReplaceWithoutRead?: boolean; rawCleanupThrows?: boolean; oauthAdapter?: boolean; noObserver?: boolean; holdRequestObserver?: boolean; firstResponseTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bungee-attempt-observer-'));
  roots.push(root);
  const path = pluginFile(root);
  const binding = (label: string, allowIntercept = false) => ({ name: 'attempt-observer', path, options: { label, intercept: allowIntercept && options.intercept, throwObserver: options.throwObserver, hangObserver: options.hangObserver, lateObserver: options.lateObserver, holdRequestObserver: options.holdRequestObserver, rawTransform: options.rawTransform, rawReplaceWithoutRead: options.rawReplaceWithoutRead, rawCleanupThrows: options.rawCleanupThrows, oauthAdapter: options.oauthAdapter } });
  const endpoints = [
    { id: 'a', target: 'http://attempt-a.test', priority: 1, plugins: options.multiScope || options.intercept ? [binding('upstream', true)] : [] },
    ...(options.twoUpstreams ? [{ id: 'b', target: 'http://attempt-b.test', priority: 2, plugins: [] }] : []),
  ];
  const config = {
    plugins: options.multiScope ? [binding('global')] : [],
    services: [{ name: 'svc', endpoints, plugins: options.multiScope ? [binding('service')] : [],
      failover: { enabled: options.twoUpstreams, retry_on: [500] },
    }],
      routes: [{ id: 'route-id', path: '/attempt', service: 'svc', plugins: options.noObserver ? [] : [binding('route')],
      timeouts: options.firstResponseTimeoutMs === undefined ? undefined : { request_ms: 1000, first_response_ms: options.firstResponseTimeoutMs },
      retry: options.retry ? { enabled: true, max_retries: 1, retry_on: [503] } : undefined,
    }],
  } as unknown as AppConfig;
  const registry = new ScopedPluginRegistry(root);
  registries.push(registry);
  const result = await registry.initializeFromConfig(config);
  expect(result.failed).toBe(0);
  setScopedPluginRegistry(registry);
  initializeRuntimeState(config);
  (globalThis as typeof globalThis & Record<string, any>)[stateKey] = { events: [], business: 0, order: [], rawMeta: null, lateWrites: 0, lateInvalidations: 0 };
  return { config, registry };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setScopedPluginRegistry(null);
  for (const registry of registries.splice(0)) await registry.destroy();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('attempt observation lifecycle', () => {
  test('pending optional request observer does not block dispatch or cause a first-response deadline', async () => {
    const { config } = await setup({ holdRequestObserver: true, firstResponseTimeoutMs: 20 });
    let fetchCalls = 0;
    globalThis.fetch = consumingUpstreamFetch((async () => { fetchCalls++; return new Response('upstream response'); }) as unknown as typeof fetch);
    const control = controlObserverDeadline('request');
    try {
      const response = await handleRequest(new Request('http://local/attempt', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"hello"}',
      }), config);
      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(1);
      const { delay } = await control.deadline;
      expect(delay).toBe(250);
      const event = state().events.find(({ event }) => event.phase === 'request')!.event;
      let forwarded = false;
      const pending = response.text().then(text => { forwarded = true; return text; });
      await Promise.race([pending, Bun.sleep(50)]);
      expect(forwarded).toBe(true);
      expect(await pending).toBe('upstream response');
      // The callback is still withheld while forwarding has already completed.
      expect(state().releaseRequestObserver).toBeDefined();
      expect(event.isActive()).toBe(true);
      state().releaseRequestObserver!();
      await waitForObservation('request-end');
      expect(event.isActive()).toBe(false);
      expect(state().events.find(({ event }) => event.phase === 'end')?.event).toMatchObject({ outcome: 'completed', sent: true });
    } finally { state().releaseRequestObserver?.(); control.restore(); }
  });

  test('deduplicates same-name bindings with upstream ownership without repeating business hooks', async () => {
    const { config, registry } = await setup({ multiScope: true });
    globalThis.fetch = consumingUpstreamFetch((async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    const owner = registry.getAttemptObservationOwners('route-id', 'a', 'svc');
    expect(owner).toHaveLength(1);
    const response = await handleRequest(new Request('http://local/attempt?key=/userinfo&model=secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-private': 'not-observable' },
      body: JSON.stringify({ message: 'snapshot' }),
    }), config);
    await response.text();
    await waitForObservation('request-end');
    expect(state().events.filter(({ event }) => event.phase === 'selected')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(1);
    expect(state().events.every(({ label }) => label === 'upstream')).toBe(true);
    const requestEvent = state().events.find(({ event }) => event.phase === 'request')?.event;
    expect(requestEvent).toMatchObject({ phase: 'request', url: '/attempt', body: { message: 'snapshot' } });
    expect(JSON.stringify(requestEvent)).not.toContain('secret');
    expect(Object.keys(requestEvent ?? {})).not.toContain('headers');
    expect(Object.isFrozen(requestEvent)).toBe(true);
    expect(state().business).toBe(3);
  });

  test('does not clone a request-body observer snapshot when no observer is registered', async () => {
    const { config } = await setup({ noObserver: true });
    const originalClone = globalThis.structuredClone;
    const clonedValues: unknown[] = [];
    globalThis.structuredClone = ((value: unknown) => { clonedValues.push(value); return originalClone(value); }) as typeof structuredClone;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response('ok')) as unknown as typeof fetch);
    try {
      const response = await handleRequest(new Request('http://local/attempt', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"no observer"}',
      }), config);
      expect(await response.text()).toBe('ok');
      expect(clonedValues).not.toContain('{"message":"no observer"}');
    } finally {
      globalThis.structuredClone = originalClone;
    }
  });

  test('emits distinct attempt IDs and sent state for failover and same-upstream retry', async () => {
    const { config } = await setup({ twoUpstreams: true });
    let calls = 0;
    globalThis.fetch = consumingUpstreamFetch((async () => {
      calls++;
      if (calls === 1) throw new Error('network unavailable');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    await response.text();
    await waitForObservation('request-end');
    const selected = state().events.filter(({ event }) => event.phase === 'selected').map(({ event }) => event);
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map(event => event.attemptId)).size).toBe(2);
    expect(selected.map(event => event.upstreamId)).toEqual(['a', 'b']);
    expect(state().events.filter(({ event }) => event.phase === 'end').map(({ event }) => event.phase === 'end' && event.outcome)).toEqual(['failed', 'completed']);
    expect(state().events.filter(({ event }) => event.phase === 'end').map(({ event }) => event.phase === 'end' && event.sent)).toEqual([true, true]);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(1);

    const retrySetup = await setup({ retry: true });
    calls = 0;
    globalThis.fetch = consumingUpstreamFetch((async () => ++calls === 1
      ? new Response('retry', { status: 503 })
      : new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    const retryResponse = await handleRequest(new Request('http://local/attempt'), retrySetup.config);
    await retryResponse.text();
    await waitForObservation('request-end');
    const retryIds = state().events.filter(({ event }) => event.phase === 'selected').map(({ event }) => event.attemptId);
    expect(retryIds).toHaveLength(2);
    expect(new Set(retryIds).size).toBe(2);
    expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(2);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
  });

  test.each(['retry','failover'] as const)('observed %s waits for the original source cancellation gate', async (mode) => {
    const {config}=await setup(mode==='retry' ? {retry:true} : {twoUpstreams:true});
    let calls=0;let cancelled=false;let released=false;let release!:()=>void;let started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const cancellation=new Promise<void>(resolve=>{started=resolve;});
    globalThis.fetch=consumingUpstreamFetch((async()=>{
      calls++;if(calls>1){expect(released).toBe(true);return Response.json({ok:true});}
      return new Response(new ReadableStream<Uint8Array>({
        start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},
        async cancel(){cancelled=true;started();await gate;released=true;},
      }),{status:mode==='retry'?503:500,headers:{'content-type':'application/json'}});
    }) as unknown as typeof fetch);
    const pending=handleRequest(new Request('http://local/attempt'),config);
    try {await cancellation;await Bun.sleep(10);expect(cancelled).toBe(true);expect(calls).toBe(1);
      release();const response=await pending;expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});await waitForObservation('request-end');expect(calls).toBe(2);
    } finally {release();}
  });

  test('closes the selected attempt when retry cleanup fails', async () => {
    const { config } = await setup({ retry: true, rawCleanupThrows: true });
    globalThis.fetch = consumingUpstreamFetch((async () => new Response('retry', { status: 503 })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(state().events.filter(({ event }) => event.phase === 'selected')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'end')).toMatchObject([
      { event: { outcome: 'failed', sent: true } },
    ]);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
  });

  test('ends local interception with sent=false', async () => {
    const { config } = await setup({ intercept: true });
    let fetchCalls = 0;
    globalThis.fetch = consumingUpstreamFetch((async () => { fetchCalls++; return new Response('unexpected'); }) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(await response.text()).toBe('local');
    await waitForObservation('request-end');
    expect(fetchCalls).toBe(0);
    expect(state().events.map(({ event }) => event.phase)).toContain('selected');
    expect(state().events.filter(({ event }) => event.phase === 'end')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ outcome: 'completed', sent: false }) }),
    ]);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
    expect(state().business).toBe(2);
  });

  test('isolates a throwing response observer, marks observation incomplete, and preserves the response', async () => {
    const { config } = await setup({ throwObserver: true });
    globalThis.fetch = consumingUpstreamFetch((async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(await response.json()).toEqual({ ok: true });
    await waitForObservation('request-end');
    expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toMatchObject([
      { event: { reason: 'observer-error' } },
    ]);
    expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
  });

  test('times out and disables a hanging observer without blocking proxy completion', async () => {
    const { config } = await setup({ hangObserver: true });
    const body = 'data: {"ok":true}\n\ndata: {"later":true}\n\n';
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const control = controlObserverDeadline();
    try {
      let completed = false;
      const pending = handleRequest(new Request('http://local/attempt'), config)
        .then(response => response.text()).then(text => { completed = true; return text; });
      const { delay, expire } = await control.deadline;
      expect(delay).toBe(250);
      await Promise.race([pending, Bun.sleep(50)]);
      expect(completed).toBe(true);
      expect(await pending).toBe(body);
      expect(completed).toBe(true);
      const responseEvent = state().events.find(({ event }) => event.phase === 'response')!.event;
      expect(responseEvent.isActive()).toBe(true);
      expect(state().events.some(({ event }) => event.phase === 'incomplete')).toBe(false);

      expire();
      await waitForObservation('request-end');
      expect(responseEvent.isActive()).toBe(false);
      // The second frame passes through but no longer reaches the disabled observer.
      expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(1);
      expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toMatchObject([
        { event: { reason: 'observer-timeout' } },
      ]);
      expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(1);
      expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
    } finally { control.restore(); }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('invalidates a timed-out callback lease so delayed cooperative writes are rejected', async () => {
    const { config } = await setup({ lateObserver: true });
    globalThis.fetch = consumingUpstreamFetch((async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    const lateFinished = new Promise<void>((resolve) => { state().finishLateObserver = resolve; });
    const control = controlObserverDeadline();
    try {
      let completed = false;
      const pending = handleRequest(new Request('http://local/attempt'), config)
        .then(response => response.json()).then(body => { completed = true; return body; });
      const { delay, expire } = await control.deadline;
      expect(delay).toBe(250);
      const responseEvent = state().events.find(({ event }) => event.phase === 'response')!.event;
      expect(responseEvent.isActive()).toBe(true);
      expire();
      await waitForObservation('request-end');
      expect(await pending).toEqual({ ok: true });
      expect(completed).toBe(true);
      expect(responseEvent.isActive()).toBe(false);
      expect(state().lateInvalidations).toBe(0);
      state().releaseResponseObserver!();
      await lateFinished;
      expect(state().lateWrites).toBe(0);
      expect(state().lateInvalidations).toBe(1);
      expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toMatchObject([
        { event: { reason: 'observer-timeout' } },
      ]);
    } finally {
      state().releaseResponseObserver?.();
      control.restore();
    }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('defers stream end and request-end until client cancellation', async () => {
    const { config } = await setup();
    let sourceCancelled = false;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: partial\\n\\n')); },
      cancel() { sourceCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    const reader = response.body!.getReader();
    await reader.read();
    expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(0);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(0);
    await reader.cancel('test cancel');
    expect(state().events.filter(({ event }) => event.phase === 'end')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ outcome: 'cancelled', sent: true }) }),
    ]);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
    expect(sourceCancelled).toBe(true);
  });

  test('observes raw JSON before raw-response N:M conversion while preserving the converted response', async () => {
    const { config } = await setup({ rawTransform: true, throwObserver: true });
    const originalBody = '{"usage":{"input_tokens":7},"source":"upstream"}';
    globalThis.fetch = consumingUpstreamFetch((async () => {
      const response = new Response(originalBody, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-upstream-only': 'hidden' },
      });
      Object.defineProperty(response, 'url', { value: 'http://attempt-a.test/final-url' });
      return response;
    }) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(await response.json()).toEqual({ from: 'raw-hook' });
    const responseEvents = state().events.filter(({ event }) => event.phase === 'response');
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]!.event).toMatchObject({
      phase: 'response', status: 200, protocol: 'json',
      body: { usage: { input_tokens: 7 }, source: 'upstream' },
    });
    expect(state().order).toHaveLength(3);
    expect(state().order).toContain('observed:json:{"usage":{"input_tokens":7},"source":"upstream"}');
    expect(state().order.indexOf('raw-hook-start')).toBeLessThan(state().order.indexOf('raw-hook-finished'));
    expect(state().rawMeta).toEqual({ url: 'http://attempt-a.test/final-url', status: 200, headers: ['content-type', 'x-upstream-only'] });
  });

  test('passes a successful ChatgptOauthAdapter lazy stream through the raw observer', async () => {
    const { config } = await setup({ oauthAdapter: true });
    (state() as any).adapter = new ChatgptOauthAdapter();
    const source = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_1","model":"codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    );
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(source.slice(0, 37)); controller.enqueue(source.slice(37)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    const converted = await response.text();
    expect(converted).toContain('chat.completion.chunk');
    expect(converted).toContain('"usage"');
    expect(converted).toContain('[DONE]');
    const observed = state().events.filter(({ event }) => event.phase === 'response');
    expect(observed).toHaveLength(2);
    expect(observed[1]!.event).toMatchObject({ phase: 'response', protocol: 'sse', body: { type: 'response.completed', response: { usage: { input_tokens: 2 } } } });
    expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toHaveLength(0);
  });

  test.each(['gzip','zstd'] as const)('ChatgptOauthAdapter explicitly decodes %s raw SSE', async (coding) => {
    const {config}=await setup({oauthAdapter:true});(state() as any).adapter=new ChatgptOauthAdapter();
    const wire='data: {"type":"response.completed","response":{"id":"resp_gzip","model":"codex","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n';
    const bytes=coding==='gzip'?gzipSync(Buffer.from(wire)):zstdCompressSync(Buffer.from(wire));
    globalThis.fetch=consumingUpstreamFetch((async()=>new Response(new Uint8Array(bytes),{headers:{'content-type':'text/event-stream','content-encoding':coding}})) as unknown as typeof fetch);
    const response=await handleRequest(new Request('http://local/attempt'),config);const text=await response.text();await waitForObservation('request-end');
    expect(text).toContain('chat.completion.chunk');expect(text).toContain('[DONE]');expect(text).toContain('"total_tokens":5');expect(response.headers.get('content-encoding')).toBeNull();
  });

  test.each(['gzip','zstd'] as const)('real HTTP raw OAuth consumer decodes %s after fetch preserves wire',async(coding)=>{
    const {config}=await setup({oauthAdapter:true});(state() as any).adapter=new ChatgptOauthAdapter();
    const wire='data: {"type":"response.completed","response":{"id":"resp_network","model":"codex","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n';
    const bytes=coding==='gzip'?gzipSync(Buffer.from(wire)):zstdCompressSync(Buffer.from(wire));
    const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response(new Uint8Array(bytes),{headers:{'content-type':'text/event-stream','content-encoding':coding,'content-length':String(bytes.byteLength)}});}});
    config.services![0]!.endpoints[0]!.target=upstream.url.origin;initializeRuntimeState(config);globalThis.fetch=originalFetch;
    try {const response=await handleRequest(new Request('http://local/attempt'),config);const text=await response.text();await waitForObservation('request-end');
      expect(response.status).toBe(200);expect(response.headers.get('content-encoding')).toBeNull();expect(text).toContain('chat.completion.chunk');expect(text).toContain('"total_tokens":5');expect(text).toContain('[DONE]');
      expect(state().events.filter(({event})=>event.phase==='response')).toHaveLength(1);
    }finally{await upstream.stop(true);}
  });

  test('raw mandatory decoding rejects an unsupported coding without a retained reader',async()=>{
    const {config}=await setup({oauthAdapter:true});(state() as any).adapter=new ChatgptOauthAdapter();
    globalThis.fetch=consumingUpstreamFetch((async()=>new Response(new Uint8Array([1,2]),{headers:{'content-type':'text/event-stream','content-encoding':'unsupported'}})) as unknown as typeof fetch);
    const response=await handleRequest(new Request('http://local/attempt'),config);expect(response.status).toBe(502);expect(await response.json()).toMatchObject({code:'invalid_response_body'});
  });

  test('keeps ChatgptOauthAdapter asynchronous error-body discard non-fatal to observation', async () => {
    const { config } = await setup({ oauthAdapter: true });
    (state() as any).adapter = new ChatgptOauthAdapter();
    const bytes = new TextEncoder().encode('data: {"type":"error","error":{"message":"upstream denied"}}\n\n');
    let pulls = 0;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.resolve();
        if (pulls++ === 0) controller.enqueue(bytes);
        else controller.close();
      },
    }), { status: 401, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.any(Object) });
    expect(pulls).toBeGreaterThan(1);
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(1);
    expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toHaveLength(0);
  });

  test('keeps an unconsumed raw replacement successful, marks observation incomplete, and cancels the source', async () => {
    const { config } = await setup({ rawReplaceWithoutRead: true });
    let sourceCancelled = false;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"raw":true}')); },
      cancel() { sourceCancelled = true; },
    }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(await response.json()).toEqual({ replacement: true });
    await waitForObservation('request-end');
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(0);
    expect(state().events.filter(({ event }) => event.phase === 'incomplete')).toMatchObject([
      { event: { reason: 'raw-response-incomplete' } },
    ]);
    const phases = state().events.map(({ event }) => event.phase);
    expect(phases.indexOf('incomplete')).toBeLessThan(phases.indexOf('end'));
    expect(phases.indexOf('end')).toBeLessThan(phases.indexOf('request-end'));
    expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(1);
    expect(sourceCancelled).toBe(true);
  });

  test('does not wrap null-body no-content responses', async () => {
    const { config } = await setup();
    let status = 204;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(null, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    for (status of [204, 304]) {
      const response = await handleRequest(new Request('http://local/attempt'), config);
      expect(response.status).toBe(status);
      expect(await response.arrayBuffer()).toHaveLength(0);
    }
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(0);
    expect(state().events.filter(({ event }) => event.phase === 'end')).toHaveLength(2);
  });

  test('skips oversized JSON observations while passing every byte downstream', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"payload":"' + 'x'.repeat(1024 * 1024) + '"}');
    const events: AttemptObservationEvent[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }).pipeThrough(trackedByteObserver('json', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => { events.push(event); }));
    const output = new Uint8Array(await new Response(source).arrayBuffer());
    expect(output).toEqual(bytes);
    await settleByteObservers();
    expect(events).toMatchObject([{ phase: 'incomplete', reason: 'buffer-limit' }]);
  });

  test('observes only complete SSE frames across UTF-8 and CRLF splits without changing bytes', async () => {
    const encoder = new TextEncoder();
    const sourceText = [
      'data: {"usageMetadata":{"promptTokenCount":1},"text":"😀"}\r\n\r\n',
      'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3}}\n\n',
      'data: [DONE]\n\n',
      'data: {"usage":{"input_tokens":99}}',
    ].join('');
    const originalBytes = encoder.encode(sourceText);
    const emojiOffset = originalBytes.indexOf(0xf0);
    const chunks = [originalBytes.slice(0, emojiOffset + 2), originalBytes.slice(emojiOffset + 2, emojiOffset + 3), originalBytes.slice(emojiOffset + 3)];
    const events: AttemptObservationEvent[] = [];
    const observed = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    }).pipeThrough(trackedByteObserver('sse', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => { events.push(event); }));
    const reader = observed.getReader();
    const output: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output.push(value);
    }
    const copy = new Uint8Array(output.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of output) { copy.set(chunk, offset); offset += chunk.byteLength; }
    expect(copy).toEqual(originalBytes);
    await settleByteObservers();
    expect(events).toHaveLength(4);
    expect(events.filter(event => event.phase === 'response').every(event => !('_event' in event.body))).toBe(true);
    expect(events.map(event => event.phase === 'response' ? (event.envelope as { event?: string } | undefined)?.event : undefined)).toEqual([undefined, 'message_delta', undefined]);
    expect(events[0]).toMatchObject({ phase: 'response', status: 200, protocol: 'sse', body: { usageMetadata: { promptTokenCount: 1 }, text: '😀' } });
    expect(events[1]).toMatchObject({ phase: 'response', body: { type: 'message_delta', usage: { output_tokens: 2 } }, envelope: { event: 'message_delta' } });
    expect(events[2]).toMatchObject({ phase: 'response', body: { choices: [], usage: { prompt_tokens: 3 } } });
    expect(events[3]).toMatchObject({ phase: 'incomplete', reason: 'frame-truncated' });
    expect(events.filter(event => event.phase === 'response')).toHaveLength(3);
    const firstBody = (events[0] as Extract<AttemptObservationEvent, { phase: 'response' }>).body;
    expect(Object.isFrozen(firstBody)).toBe(true);
    expect(Object.isFrozen(firstBody.usageMetadata)).toBe(true);
  });

  test('reports an unterminated SSE data frame before completion without observing its payload', async () => {
    const encoder = new TextEncoder();
    const sourceText = ': keepalive\r\n\r\ndata: {"usage":{"output_tokens":99}}\r\ndata: {"unfinished":true}';
    const source = encoder.encode(sourceText);
    const events: AttemptObservationEvent[] = [];
    const order: string[] = [];
    const observed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source.slice(0, sourceText.indexOf('\r\n') + 1));
        controller.enqueue(source.slice(sourceText.indexOf('\r\n') + 1));
        controller.close();
      },
    }).pipeThrough(trackedByteObserver('sse', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => { events.push(event); order.push(event.phase); }, () => { order.push('complete'); }));
    const output = new Uint8Array(await new Response(observed).arrayBuffer());
    expect(output).toEqual(source);
    await settleByteObservers();
    expect(events.filter(event => event.phase === 'response')).toHaveLength(0);
    expect(events).toMatchObject([{ phase: 'incomplete', reason: 'frame-truncated' }]);
    expect(order).toEqual(['incomplete', 'complete']);
  });

  test('does not report comments or whitespace-only SSE at EOF as truncated data', async () => {
    const source = new TextEncoder().encode(': comment\r\n\r\n  \n\t');
    const events: AttemptObservationEvent[] = [];
    const observed = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(source); controller.close(); },
    }).pipeThrough(trackedByteObserver('sse', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => { events.push(event); }));
    expect(new Uint8Array(await new Response(observed).arrayBuffer())).toEqual(source);
    await settleByteObservers();
    expect(events.filter(event => event.phase === 'incomplete')).toHaveLength(0);
    expect(events.filter(event => event.phase === 'response')).toHaveLength(0);
  });

  test('observes all 65 frames from one chunk serially in source order', async () => {
    const encoder = new TextEncoder();
    const source = encoder.encode(Array.from({ length: 65 }, (_, index) => `data:{"n":${index}}\n\n`).join(''));
    const order: number[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(source); controller.close(); },
    }).pipeThrough(trackedByteObserver('sse', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => {
      if (event.phase !== 'response') return;
      const n = event.body.n as number;
      if (n === 0) await new Promise(resolve => setTimeout(resolve, 10));
      order.push(n);
    }));
    const output = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(output).toEqual(source);
    await settleByteObservers();
    expect(order).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  test('marks oversized SSE observation incomplete while preserving wire for single chunks and arbitrary splits', async () => {
    const encoder = new TextEncoder();
    const text = 'data:' + 'x'.repeat(1024 * 1024)
      + '\ndata:{"usage":{"output_tokens":999}}\n\n'
      + 'data:{"usage":{"output_tokens":1}}\n\n';
    const source = encoder.encode(text);
    const firstLineEnd = text.indexOf('\n');
    const run = async (cuts: number[]) => {
      const boundaries = [0, ...new Set(cuts.filter(cut => cut > 0 && cut < source.length)), source.length].sort((a, b) => a - b);
      const chunks = boundaries.slice(1).map((end, index) => source.slice(boundaries[index]!, end));
      const events: AttemptObservationEvent[] = [];
      const observed = new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
      }).pipeThrough(trackedByteObserver('sse', {
        requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
      }, async (event) => { events.push(event); }));
      const output = new Uint8Array(await new Response(observed).arrayBuffer());
      await settleByteObservers();
      return { output, events };
    };
    const single = await run([]);
    const splitBeforeLineEnding = await run([firstLineEnd, firstLineEnd + 1]);
    const arbitraryCuts = await run([1, 17, 700_003, firstLineEnd, firstLineEnd + 1, firstLineEnd + 9, source.length - 3]);
    for (const result of [single, splitBeforeLineEnding, arbitraryCuts]) {
      expect(result.output).toEqual(source);
      const incomplete = result.events.filter(event => event.phase === 'incomplete');
      expect(incomplete).toHaveLength(1);
      expect(['buffer-limit', 'frame-limit']).toContain(incomplete[0]!.reason);
      const observations = result.events.filter((event): event is Extract<AttemptObservationEvent, { phase: 'response' }> => event.phase === 'response');
      expect(observations).toHaveLength(0);
    }
  });

  test('keeps observation memory bounded for a multi-megabyte unterminated SSE line', async () => {
    const chunkSize = 64 * 1024;
    const oversizedBytes = 4 * 1024 * 1024;
    const validTail = [
      new TextEncoder().encode('\r'),
      new TextEncoder().encode('\n'),
      new TextEncoder().encode('\r'),
      new TextEncoder().encode('\n'),
      new TextEncoder().encode('data:{"usage":{"output_tokens":7}}\r'),
      new TextEncoder().encode('\n'),
      new TextEncoder().encode('\r'),
      new TextEncoder().encode('\n'),
    ];
    const expectedDigest = createHash('sha256');
    const actualDigest = createHash('sha256');
    let sourceBytes = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sourceBytes < oversizedBytes) {
          const chunk = new Uint8Array(chunkSize).fill(0x78);
          if (sourceBytes === 0) chunk.set(new TextEncoder().encode('data:'));
          sourceBytes += chunk.byteLength;
          expectedDigest.update(chunk);
          controller.enqueue(chunk);
          return;
        }
        const tailIndex = sourceBytes - oversizedBytes;
        if (tailIndex < validTail.length) {
          const chunk = validTail[tailIndex]!;
          sourceBytes += 1;
          expectedDigest.update(chunk);
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
    });
    const events: AttemptObservationEvent[] = [];
    const observed = source.pipeThrough(trackedByteObserver('sse', {
      requestId: 'r', routeId: 'route', attemptId: 'a', upstreamId: 'u', status: 200,
    }, async (event) => { events.push(event); }));

    const bun = (globalThis as typeof globalThis & { Bun?: { gc: (force?: boolean) => void } }).Bun;
    bun?.gc(true);
    const heapBefore = process.memoryUsage().heapUsed;
    const reader = observed.getReader();
    let outputBytes = 0;
    // Measure before the line terminator arrives; recovery/EOF would release
    // an accidentally retained oversized line and hide the memory regression.
    while (outputBytes < oversizedBytes) {
      const { done, value } = await reader.read();
      if (done) throw new Error('oversized SSE line ended before the memory checkpoint');
      outputBytes += value.byteLength;
      actualDigest.update(value);
    }
    bun?.gc(true);
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowth = heapAfter - heapBefore;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      outputBytes += value.byteLength;
      actualDigest.update(value);
    }

    expect(outputBytes).toBe(oversizedBytes + validTail.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    expect(actualDigest.digest('hex')).toBe(expectedDigest.digest('hex'));
    await settleByteObservers();
    const incomplete = events.filter(event => event.phase === 'incomplete');
    expect(incomplete).toHaveLength(1);
    expect(['buffer-limit', 'frame-limit']).toContain(incomplete[0]!.reason);
    const responses = events.filter((event): event is Extract<AttemptObservationEvent, { phase: 'response' }> => event.phase === 'response');
    expect(responses).toHaveLength(0);
    // The limit is relative to the 4 MiB input, with ample room for runtime noise;
    // an accidentally retained multi-megabyte line grows far beyond this before cleanup.
    expect(heapGrowth).toBeLessThan(32 * 1024 * 1024);
    console.info(`[attempt-observation memory] input=${sourceBytes} bytes heapBefore=${heapBefore} heapAfter=${heapAfter} growth=${heapGrowth} bytes`);
  });

  test('keeps upstream SSE bytes intact through the real proxy response pipeline', async () => {
    const { config } = await setup();
    const originalBytes = new TextEncoder().encode(
      'data: {"usageMetadata":{"promptTokenCount":1},"text":"😀"}\r\n\r\n'
      + 'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\r\n\r\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":3}}\n\n'
      + 'data: [DONE]\n\n',
    );
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(originalBytes.slice(0, 23));
        controller.enqueue(originalBytes.slice(23, 61));
        controller.enqueue(originalBytes.slice(61));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    const output = new Uint8Array(await response.arrayBuffer());
    expect(output).toEqual(originalBytes);
    await waitForObservation('request-end');
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(3);
    expect(state().events.filter(({ event }) => event.phase === 'end')).toMatchObject([
      { event: { outcome: 'completed', sent: true } },
    ]);
    expect(state().events.filter(({ event }) => event.phase === 'request-end')).toHaveLength(1);
  });

  test('reports a truncated SSE frame before attempt end and request-end through the proxy pipeline', async () => {
    const { config } = await setup();
    const originalBytes = new TextEncoder().encode('data: {"usage":{"output_tokens":99}}');
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(originalBytes); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
    const response = await handleRequest(new Request('http://local/attempt'), config);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(originalBytes);
    await waitForObservation('request-end');
    const phases = state().events.map(({ event }) => event.phase);
    expect(phases).toContain('incomplete');
    expect(phases.indexOf('incomplete')).toBeLessThan(phases.indexOf('end'));
    expect(phases.indexOf('end')).toBeLessThan(phases.indexOf('request-end'));
    expect(state().events.find(({ event }) => event.phase === 'incomplete')?.event).toMatchObject({ reason: 'frame-truncated' });
    expect(state().events.filter(({ event }) => event.phase === 'response')).toHaveLength(0);
  });
});
