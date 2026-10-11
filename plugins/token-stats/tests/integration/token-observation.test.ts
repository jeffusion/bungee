import { afterAll as afterDataPlaneTests } from 'bun:test';
import { createDataPlaneRuntime } from '../../../../packages/core/tests/helpers/data-plane-runtime';
const dataPlaneRuntime = await createDataPlaneRuntime();
afterDataPlaneTests(() => dataPlaneRuntime.close());
import { initializeTokenStatsTestDatabase } from '../../../../packages/core/tests/helpers/token-stats-database';
const { withTokenStatsMetering } = await import('../../server/storage');
type StatsTestStorage = ReturnType<typeof withTokenStatsMetering<SQLitePluginStorage>>;
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { AttemptObservationEvent, PluginLogger } from '../../../../packages/core/src/hooks';
import type { PluginStorage } from '../../../../packages/core/src/plugin.types.ts';
const { SQLitePluginStorage } = await import('../../../../packages/core/src/plugin-storage');
const { ScopedPluginRegistry, setScopedPluginRegistry } = await import('../../../../packages/core/src/scoped-plugin-registry');
const { initializeRuntimeState } = await import('../../../../packages/core/src/worker/state/runtime-state');
const { handleRequest } = await import('../../../../packages/core/src/worker/request/handler');
import TokenStatsPlugin from '../../server/index';
const { createControl } = await import('../../server/control');
const { TokenStatsRepository } = await import('../../server/repository');
import { startAnonymousAdmission } from '../../../../packages/core/tests/helpers/anonymous-admission';
import { TEST_WORKER_TRANSPORT_SECRET } from '../../../../packages/core/tests/fixtures/config-worker-private-transport';
const { restoreWorkerTransportRequest, signDataIdentity, INTERNAL_DATA_IDENTITY_HEADER, INTERNAL_DATA_IDENTITY_MAC_HEADER, INTERNAL_TRANSPORT_TOKEN_HEADER, INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER } = await import('../../../../packages/core/src/config-worker/private-transport');
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../../../../packages/core/tests/helpers/test-budgets';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

const databases: Array<{ db: Database; directory: string }> = [];
const registries: ScopedPluginRegistry[] = [];
const registryRoots: string[] = [];
const storageKeys: string[] = [];
const originalFetch = globalThis.fetch;

// A fake upstream must consume the upload just like the real HTTP transport.
function consumingUpstreamFetch(mockFetch: typeof fetch): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' && init?.body != null) await new Response(init.body).arrayBuffer();
    return mockFetch(input, init);
  }, { preconnect: () => undefined }) as typeof fetch;
}

const offlineFetch = Object.assign(
  async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  { preconnect: () => undefined },
) satisfies typeof fetch;

function createStorage(): { db: Database; storage: StatsTestStorage; directory: string } {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'token-stats-integration-'));
  const db = new Database(path.join(directory, 'access.db'), { create: true, readwrite: true, strict: true });
  db.run('PRAGMA foreign_keys = ON');
  initializeTokenStatsTestDatabase(db);
  databases.push({ db, directory });
  return { db, storage: withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats')), directory };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setScopedPluginRegistry(null);
  for (const registry of registries.splice(0)) await registry.destroy();
  for (const root of registryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  for (const key of storageKeys.splice(0)) delete globals[key];
  for (const { db, directory } of databases.splice(0)) {
    // Finalize all statements before deleting the file; Windows cannot unlink an open database.
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createLogger(): PluginLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

const secretStore = {
  namespace: 'token-stats-integration',
  async get() { return null; },
  async compareAndSet() { return 1; },
  async delete() {},
};

function attemptRow(overrides: Partial<import('../../../../packages/core/src/plugin.types.ts').TokenStatsAttempt> = {}) {
  return {
    attempt_id: crypto.randomUUID(), request_id: 'request', finished_at_ms: Date.now(),
    route_id: 'route-chat', upstream_id: 'upstream-a', provider: 'openai', outcome: 'completed', model: 'gpt-4o-mini',
    input_tokens: 5, output_tokens: 2, input_source: 'usage' as const, output_source: 'usage' as const,
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, observation_incomplete: false, ...overrides,
  };
}

interface GatewayFixture {
  db: Database;
  storage: StatsTestStorage;
  directory: string;
  registry: ScopedPluginRegistry;
  config: AppConfig;
  observations: AttemptObservationEvent[];
}

async function createGatewayFixture(options: {
  failover?: boolean;
  retry?: boolean;
  multiScope?: boolean;
  splitChunks?: boolean;
  intercept?: boolean;
  crossProviderFailover?: boolean;
} = {}): Promise<GatewayFixture> {
  const storageFixture = createStorage();
  const root = fs.mkdtempSync(path.join(tmpdir(), 'token-stats-gateway-'));
  registryRoots.push(root);
  const storageKey = `__tokenStatsGatewayStorage_${crypto.randomUUID().replaceAll('-', '')}`;
  const observationsKey = `${storageKey}_observations`;
  storageKeys.push(storageKey);
  storageKeys.push(observationsKey);
  (globalThis as typeof globalThis & Record<string, unknown>)[storageKey] = storageFixture.storage;
  (globalThis as typeof globalThis & Record<string, unknown>)[observationsKey] = [];
  const tokenStatsPath = path.resolve('plugins/token-stats/server/index.ts');
  const bindingPath = path.join(root, 'token-stats-binding.ts');
  fs.writeFileSync(bindingPath, `
import TokenStatsPlugin from ${JSON.stringify(tokenStatsPath)};
import TokenMeteringPlugin from ${JSON.stringify(path.resolve('plugins/token-metering/server/index.ts'))};
import { PluginServiceHost } from ${JSON.stringify(path.resolve('packages/core/src/plugin-services.ts'))};
const storageKey = ${JSON.stringify(storageKey)};
const observationsKey = ${JSON.stringify(observationsKey)};
export default class TokenStatsBinding {
  static name = 'token-stats';
  static version = '3.0.0';
  static async createHandler(config, initContext) {
    const plugin = new TokenStatsPlugin();
    const root = globalThis;
    const services = new PluginServiceHost();
    const provider = new TokenMeteringPlugin();
    await provider.init({ ...initContext, scope: { type: 'global' }, storage: root[storageKey], services: services.createContext('token-metering') });
    services.markReady('token-metering');
    await plugin.init({ ...initContext, storage: root[storageKey], services: services.createContext('token-stats', 'global', { 'token-metering': '^1.0.0' }) });
    return {
      pluginName: 'token-stats',
      bodyRequirements(ctx) { return { ...provider.bodyRequirements(ctx), request: config.crossProviderFailover ? 'json-write' : 'none', response: config.splitChunks ? ['sse-json'] : [] }; },
      register(hooks) {
        provider.register(hooks);
        plugin.register(hooks);
        hooks.onAttemptObservation.tapPromise('integration-observation-capture', async (event) => globalThis[observationsKey].push(event));
        if (config.crossProviderFailover) hooks.onBeforeRequest.tapPromise('integration-provider-switch', async (ctx) => {
          ctx.body = ctx.upstreamId === 'upstream-a'
            ? { anthropic_version: '2023-06-01', model: 'claude-3-7-sonnet-20250219', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }
            : { model: 'gpt-4o-mini', input: 'hello' };
          return ctx;
        });
        if (config.splitChunks) hooks.onStreamChunk.tapPromise('test-n-to-m-transformer', async (chunk) => [chunk, structuredClone(chunk)]);
        if (config.intercept) hooks.onInterceptRequest.tapPromise('test-local-intercept', async () => ({ action: 'respond', response: new Response('local response') }));
      },
      async destroy() { await plugin.onDestroy?.(); await provider.onDestroy?.(); },
    };
  }
}
`);

  const binding = (splitChunks = false, intercept = false) => ({
    name: 'token-stats', path: bindingPath, options: { splitChunks, intercept, crossProviderFailover: options.crossProviderFailover },
  });
  const endpoints = [
    { id: 'upstream-a', target: 'http://token-stats-a.test', priority: 1, plugins: options.multiScope ? [binding(options.splitChunks, options.intercept)] : [] },
    ...(options.failover ? [{ id: 'upstream-b', target: 'http://token-stats-b.test', priority: 2, plugins: [] }] : []),
  ];
  const rawConfig = {
    plugins: [binding()],
    services: [{ name: 'token-stats-service', endpoints, plugins: options.multiScope ? [binding()] : [],
      failover: { enabled: options.failover, retry_on: [500] },
    }],
    routes: [{ id: 'token-stats-route', path: '/token-stats', service: 'token-stats-service', plugins: options.multiScope ? [binding()] : [],
      retry: options.retry ? { enabled: true, max_retries: 1, retry_on: [429] } : undefined,
    }],
  };
  const config = rawConfig as unknown as AppConfig;
  const registry = new ScopedPluginRegistry(root);
  registries.push(registry);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = offlineFetch;
  let initialized: Awaited<ReturnType<typeof registry.initializeFromConfig>>;
  try { initialized = await registry.initializeFromConfig(config); }
  finally { globalThis.fetch = previousFetch; }
  expect(initialized.failed).toBe(0);
  setScopedPluginRegistry(registry);
  initializeRuntimeState(config);
  return {
    db: storageFixture.db,
    storage: storageFixture.storage,
    directory: storageFixture.directory,
    registry,
    config,
    observations: (globalThis as typeof globalThis & Record<string, unknown>)[observationsKey] as AttemptObservationEvent[],
  };
}

function requestToGateway(config: AppConfig, body: unknown = { model: 'gpt-4o-mini', input: 'hello' }): Promise<Response> {
  return handleRequest(new Request('http://localhost/token-stats', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(typeof body === 'object' && body !== null && 'stream' in body && body.stream === true ? { accept: 'text/event-stream' } : {}) },
    body: JSON.stringify(body),
  }), config);
}

async function waitForAttempts(db: Database, count: number, requestId?: string): Promise<Array<{ attempt_id: string; request_id: string; upstream_id: string; provider: string; outcome: string; model: string; input_tokens: number | null; output_tokens: number | null; input_source: string; output_source: string; observation_incomplete: number }>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = db.query(`SELECT attempt_id, request_id, upstream_id, provider, outcome, model, input_tokens, output_tokens, input_source, output_source, observation_incomplete
      FROM token_stats_attempts ${requestId ? 'WHERE request_id = ?' : ''} ORDER BY attempt_id`)
      .all(...(requestId ? [requestId] : [])) as Array<{ attempt_id: string; request_id: string; upstream_id: string; provider: string; outcome: string; model: string; input_tokens: number | null; output_tokens: number | null; input_source: string; output_source: string; observation_incomplete: number }>;
    if (rows.length === count) return rows;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${count} attempt rows`);
}

async function waitForRequestEnd(events: AttemptObservationEvent[], count: number) {
  const deadline = Date.now() + 1000;
  while (events.filter(event => event.phase === 'request-end').length < count && Date.now() < deadline) await Bun.sleep(1);
  expect(events.filter(event => event.phase === 'request-end')).toHaveLength(count);
}

describe('Token Stats SQLite metering integration', () => {
  test('worker emits only trusted API Key identity; spoofed headers and anonymous requests remain unattributed', async () => {
    const fixture = await createGatewayFixture();
    globalThis.fetch = consumingUpstreamFetch(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).hostname === '127.0.0.1') return originalFetch(input,init);
      return Response.json({object:'response',status:'completed',output:[],usage:{input_tokens:7,output_tokens:2}});
    }, {preconnect: () => undefined}) as typeof fetch);
    const request = new Request('http://localhost/token-stats', {method:'POST',headers:{
      'content-type':'application/json','x-api-key-id':'spoofed','x-bungee-key-id':'spoofed',
      [INTERNAL_DATA_IDENTITY_HEADER]:JSON.stringify({principal:{domain:'data',keyId:'spoofed',credentialVersion:1},requestId:crypto.randomUUID()}),
    },body:JSON.stringify({model:'gpt-4o-mini',input:'hello'})});
    const direct = await handleRequest(request,fixture.config); expect(direct.status).toBe(200); await direct.text();
    await waitForAttempts(fixture.db,1);
    await waitForRequestEnd(fixture.observations,1);
    expect(fixture.db.query('SELECT key_id FROM token_stats_attempts').all()).toEqual([{key_id:null}]);
    expect(fixture.observations.every(event => event.keyId === null)).toBe(true);
    const stopAdmission = await startAnonymousAdmission();
    try {
      for (const keyId of ['trusted-key',null]) {
        const identity = JSON.stringify({requestId:crypto.randomUUID(),principal:keyId
          ? {domain:'data',keyId,credentialVersion:1} : {domain:'anonymous',keyId:'',credentialVersion:0}});
        const originalUrl = 'http://localhost/token-stats';
        const restored = restoreWorkerTransportRequest(new Request('http://worker.local/token-stats', {method:'POST',headers:{
          'content-type':'application/json',[INTERNAL_TRANSPORT_TOKEN_HEADER]:TEST_WORKER_TRANSPORT_SECRET,
          [INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER]:originalUrl,[INTERNAL_DATA_IDENTITY_HEADER]:identity,
          [INTERNAL_DATA_IDENTITY_MAC_HEADER]:signDataIdentity(identity,'POST',originalUrl,TEST_WORKER_TRANSPORT_SECRET),
          'x-api-key-id':'spoofed',
        },body:JSON.stringify({model:'gpt-4o-mini',input:'hello'})}),TEST_WORKER_TRANSPORT_SECRET);
        expect(restored.ok).toBe(true); if (!restored.ok) throw Error('restore failed');
        const offset = fixture.observations.length;
        const response = await handleRequest(restored.request,fixture.config); expect(response.status).toBe(200); await response.text();
        await waitForRequestEnd(fixture.observations,keyId === 'trusted-key' ? 2 : 3);
        expect(fixture.observations.slice(offset).length).toBeGreaterThan(0);
        expect(fixture.observations.slice(offset).every(event => event.keyId === keyId)).toBe(true);
      }
      await waitForAttempts(fixture.db,3);
      expect(fixture.db.query('SELECT key_id, COUNT(*) AS count FROM token_stats_attempts GROUP BY key_id').all())
        .toEqual([{key_id:null,count:2},{key_id:'trusted-key',count:1}]);
      const filtered = await new TokenStatsRepository(fixture.storage).query('1h','model',Date.now()+1,undefined,'trusted-key');
      expect(filtered.upstreamAttempts).toBe(1); expect(filtered.totalInputTokens).toBe(7);
    } finally { await stopAdmission(); }
  });

  test('counts official SSE usage for an explicitly declared upstream protocol', async () => {
    const fixture = await createGatewayFixture();
    const bytes = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
      + 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":19,"output_tokens":5}}}\n\n',
    );
    globalThis.fetch = consumingUpstreamFetch(Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, 13)); controller.enqueue(bytes.slice(13)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }), { preconnect: () => undefined }) satisfies typeof fetch);
    const response = await requestToGateway(fixture.config, { model: 'custom-model', input: 'hello', stream: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('response.completed');
    const rows = await waitForAttempts(fixture.db, 1);
    expect(rows[0]).toMatchObject({ outcome: 'completed', input_tokens: 19, output_tokens: 5, input_source: 'usage', output_source: 'usage' });
  });

  test('headerless SSE preserves wire bytes and records unknown optional usage', async () => {
    const fixture = await createGatewayFixture();
    const wire = 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":19,"output_tokens":5}}}\n\n';
    globalThis.fetch = consumingUpstreamFetch(Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(wire)); controller.close(); },
    })), { preconnect: () => undefined }));
    const response = await handleRequest(new Request('http://localhost/token-stats', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'custom-model', input: 'hello', stream: true }),
    }), fixture.config);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    const [attempt] = await waitForAttempts(fixture.db, 1);
    // A JSON field alone does not declare the wire protocol when Content-Type and Accept are absent.
    expect(attempt).toMatchObject({ input_tokens: null, output_tokens: null, input_source: 'unknown', output_source: 'unknown', observation_incomplete: 1 });
  });

  test('real gateway retryable HTTP failover emits one row per attempt across scoped owners', async () => {
    const { db, storage, directory, registry, config, observations } = await createGatewayFixture({
      failover: true, multiScope: true, crossProviderFailover: true,
    });
    const targets: string[] = [];
    let calls = 0;
    globalThis.fetch = consumingUpstreamFetch((async (input: RequestInfo | URL) => {
      targets.push(new URL(String(input)).host);
      calls += 1;
      if (calls === 1) return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 7 } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch);
    const upstreamOwners = registry.getAttemptObservationOwners('/token-stats', 'upstream-a', 'token-stats-service');
    expect(upstreamOwners).toHaveLength(1);
    const gatewayResponse = await requestToGateway(config, { model: 'gpt-4o-mini', input: 'hello' });
    expect(gatewayResponse.status).toBe(200);
    await gatewayResponse.text();
    expect(targets).toEqual(['token-stats-a.test', 'token-stats-b.test']);
    await waitForRequestEnd(observations, 2);
    expect(observations.map(({ phase }) => phase)).toEqual([
      'selected', 'request', 'end', 'selected', 'request', 'response', 'end', 'request-end', 'request-end',
    ]);

    const attempts = await waitForAttempts(db, 2);
    expect(attempts.sort((a, b) => a.upstream_id.localeCompare(b.upstream_id)).map(({ upstream_id, provider, model, input_source, input_tokens }) => [upstream_id, provider, model, input_source, input_tokens]))
      .toEqual([['upstream-a', 'anthropic', 'claude-3-7-sonnet-20250219', 'unknown', null], ['upstream-b', 'openai', 'gpt-4o-mini', 'usage', 12]]);
    expect(new Set(attempts.map((row) => row.request_id)).size).toBe(1);
    const repository = new TokenStatsRepository(storage);
    const modelSnapshot = await repository.query('1h', 'model');
    expect(modelSnapshot.upstreamAttempts).toBe(2);
    expect(modelSnapshot.logicalRequests).toBe(1);
    expect(modelSnapshot.data).toMatchObject([
      { dimension: 'gpt-4o-mini', inputTokens: 12, upstreamAttempts: 1 },
      { dimension: 'claude-3-7-sonnet-20250219', inputTokens: 0, upstreamAttempts: 1 },
    ]);
    const timeSnapshot = await repository.query('1h', 'time');
    expect(timeSnapshot.bucketMs).toBe(300_000);
    expect(new Set(timeSnapshot.data.map((row) => row.dimension))).toEqual(new Set(['gpt-4o-mini', 'claude-3-7-sonnet-20250219']));
    expect(timeSnapshot.data.reduce((sum, row) => sum + row.upstreamAttempts, 0)).toBe(2);
    expect(timeSnapshot.data.every((row) => Number.isSafeInteger(row.bucketStartMs))).toBe(true);

    const control = createControl({ signal: new AbortController().signal, secretStore, storage });
    const handler = control.api[0]!;
    const statsResponse = await handler.invoke({ signal: new AbortController().signal, secretStore, storage,
      request: new Request('http://localhost/stats?range=1h&groupBy=model'), requestSignal: new AbortController().signal });
    expect(statsResponse.status).toBe(200);
    expect(await statsResponse.json()).toMatchObject({
      groupBy: 'model', totalInputTokens: 12, totalOutputTokens: 7,
      officialInputTokens: 12, officialOutputTokens: 7,
      estimatedInputTokens: 0, estimatedOutputTokens: 0,
      logicalRequests: 1, upstreamAttempts: 2,
      data: expect.arrayContaining([
        expect.objectContaining({ dimension: 'gpt-4o-mini', inputTokens: 12, officialInputTokens: 12, upstreamAttempts: 1 }),
        expect.objectContaining({ dimension: 'claude-3-7-sonnet-20250219', inputTokens: 0, upstreamAttempts: 1 }),
      ]),
    });
    control.dispose();

    const secondDb = new Database(path.join(directory, 'access.db'), { readwrite: true, strict: true });
    try {
      const persistedStorage = withTokenStatsMetering(new SQLitePluginStorage(secondDb, 'token-stats'));
      const persisted = await new TokenStatsRepository(persistedStorage).query('1h', 'model');
      expect(persisted).toMatchObject({ totalInputTokens: 12, totalOutputTokens: 7, logicalRequests: 1, upstreamAttempts: 2 });
    } finally {
      secondDb.close(true);
    }
  });

  test('real gateway same-upstream 429 retry counts each sent UUID and retains both official usages', async () => {
    const { db, storage, config } = await createGatewayFixture({ retry: true });
    const targets: string[] = [];
    let calls = 0;
    globalThis.fetch = consumingUpstreamFetch((async (input) => {
      targets.push(String(input));
      calls += 1;
      const usage = calls === 1 ? { input_tokens: 4, output_tokens: 2 } : { input_tokens: 10, output_tokens: 3 };
      return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [], usage }), {
        status: calls === 1 ? 429 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    const response = await requestToGateway(config, { model: 'gpt-4o-mini', input: 'retry me' });
    expect(response.status).toBe(200);
    await response.text();
    expect(targets).toEqual([
      'http://token-stats-a.test/token-stats',
      'http://token-stats-a.test/token-stats',
    ]);
    const attempts = await waitForAttempts(db, 2);
    expect(attempts.sort((a, b) => (a.input_tokens ?? 0) - (b.input_tokens ?? 0))
      .map((row) => [row.input_tokens, row.output_tokens, row.input_source, row.output_source]))
      .toEqual([[4, 2, 'usage', 'usage'], [10, 3, 'usage', 'usage']]);
    expect(await new TokenStatsRepository(storage).query('1h', 'model')).toMatchObject({
      totalInputTokens: 14, totalOutputTokens: 5, logicalRequests: 1, upstreamAttempts: 2,
    });
  });

  test('real gateway SSE late usage is counted once before an N:M business stream transform', async () => {
    const { db, config } = await createGatewayFixture({ multiScope: true, splitChunks: true });
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(frames)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);

    const response = await requestToGateway(config, {
      model: 'gpt-4o-mini', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    });
    const transformedOutput = await response.text();
    expect(transformedOutput.split('data:').length - 1).toBeGreaterThan(frames.split('data:').length - 1);
    const [attempt] = await waitForAttempts(db, 1);
    expect(attempt).toMatchObject({ input_tokens: 13, output_tokens: 4, input_source: 'usage', output_source: 'usage' });
  });

  test('real gateway client abort records the attempt without estimating partial output', async () => {
    const { db, config } = await createGatewayFixture();
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    globalThis.fetch = consumingUpstreamFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')); },
      cancel() { upstreamCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);

    const response = await requestToGateway(config, {
      model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hello' }],
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('integration client abort');
    expect(upstreamCancelled).toBe(true);
    const [attempt] = await waitForAttempts(db, 1);
    expect(attempt).toMatchObject({ outcome: 'aborted', output_source: 'unknown', output_tokens: null });
  });

  test('real gateway local interception creates no upstream attempt row', async () => {
    const { db, storage, config, observations } = await createGatewayFixture({ multiScope: true, intercept: true });
    globalThis.fetch = consumingUpstreamFetch((async () => { throw new Error('intercept must prevent network I/O'); }) as unknown as typeof fetch);
    const response = await requestToGateway(config, { model: 'gpt-4o-mini', input: 'local only' });
    expect(await response.text()).toBe('local response');
    await waitForRequestEnd(observations, 1);
    expect(observations.map(({ phase }) => phase)).toEqual(['selected', 'end', 'request-end']);
    await Bun.sleep(10);
    expect(db.query('SELECT attempt_id FROM token_stats_attempts').all()).toEqual([]);
    expect(await new TokenStatsRepository(storage).query('24h', 'model')).toMatchObject({ logicalRequests: 0, upstreamAttempts: 0 });
  });

  test('rolls exact 1h/12h/24h windows with official, estimated, cache, and unknown values', async () => {
    const { storage } = createStorage();
    const repository = new TokenStatsRepository(storage);
    const asOfMs = Date.now() + 10_000;
    const samples = [
      { id: 'at-1h', time: asOfMs - 60 * 60 * 1000, input: 2, upstream: 'upstream-a' },
      { id: 'inside-1h', time: asOfMs - 60 * 60 * 1000 + 1, input: 3, upstream: 'upstream-b' },
      { id: 'at-2h', time: asOfMs - 2 * 60 * 60 * 1000, input: 11, upstream: 'upstream-c' },
      { id: 'at-13h', time: asOfMs - 13 * 60 * 60 * 1000, input: 13, upstream: 'upstream-d' },
      { id: 'at-upper-bound', time: asOfMs, input: 17, upstream: 'upstream-e' },
    ];
    for (const sample of samples) {
      storage.metering!.recordAttempt(attemptRow({
        attempt_id: `${sample.id}:attempt`, request_id: sample.id, finished_at_ms: sample.time,
        upstream_id: sample.upstream, input_tokens: sample.input, output_tokens: 0,
        cache_read_tokens: sample.id === 'at-1h' ? 2 : 0,
        cache_write_tokens: sample.id === 'at-1h' ? 1 : 0,
      }));
    }
    storage.metering!.recordAttempt(attemptRow({ attempt_id: 'estimated:attempt', request_id: 'estimated',
      finished_at_ms: asOfMs - 100, upstream_id: 'upstream-estimated', input_tokens: 4, output_tokens: 2,
      input_source: 'estimated', output_source: 'estimated', cache_read_tokens: 1 }));
    storage.metering!.recordAttempt(attemptRow({ attempt_id: 'no-usage:attempt', request_id: 'no-usage',
      finished_at_ms: asOfMs - 90, upstream_id: 'upstream-none', input_tokens: null, output_tokens: null,
      input_source: 'unknown', output_source: 'unknown', cache_read_tokens: null, cache_write_tokens: null }));
    await Bun.sleep(20);

    const oneHour = await repository.query('1h', 'model', asOfMs);
    expect(oneHour).toMatchObject({ totalInputTokens: 9, officialInputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 });
    expect(oneHour.data).toHaveLength(1);
    expect(oneHour.data[0]).toMatchObject({ inputTokens: 9, officialInputTokens: 5, estimatedInputTokens: 4, estimatedOutputTokens: 2, partialOutputs: 0 });
    expect(oneHour).toMatchObject({ logicalRequests: 4, upstreamAttempts: 4 });
    expect(oneHour.authorityBreakdown.input).toMatchObject({ official: 2, heuristic: 1, none: 1, local: 0 });
    expect(oneHour.authorityBreakdown.output).toMatchObject({ official: 2, heuristic: 1, none: 1, partial: 0 });

    expect(await repository.query('12h', 'model', asOfMs)).toMatchObject({ totalInputTokens: 20, officialInputTokens: 16 });
    expect(await repository.query('24h', 'model', asOfMs)).toMatchObject({
      totalInputTokens: 33, officialInputTokens: 29,
      data: [expect.objectContaining({ dimension: 'gpt-4o-mini', inputTokens: 33, cacheReadTokens: 3, cacheWriteTokens: 1 })],
    });
  });
});
