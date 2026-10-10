import { initializeTokenStatsTestDatabase } from '../../../../packages/core/tests/helpers/token-stats-database';
import { fileURLToPath } from 'node:url';
import { withTokenStatsMetering } from '../../server/storage';
type StatsTestStorage = ReturnType<typeof withTokenStatsMetering<SQLitePluginStorage>>;
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPluginHooks, type PluginLogger } from '../../../../packages/core/src/hooks';
import type { PluginStorage, TokenStatsAttempt } from '../../../../packages/core/src/plugin.types.ts';
import { SQLitePluginStorage } from '../../../../packages/core/src/plugin-storage';
import type { ControlHostContext, SecretStore } from '../../../../packages/core/src/plugin-control/contracts';
import { loadImmutableControlArtifact } from '../../../../packages/core/src/plugin-control/artifact-loader';
import { PluginManifestCatalog } from '../../../../packages/core/src/plugin-manifest-catalog/catalog';
import { parsePluginManifestText } from '../../../../packages/core/src/plugin-manifest-catalog';
import TokenMeteringPlugin from '../../../token-metering/server/index';
import { PluginServiceHost } from '../../../../packages/core/src/plugin-services';
import TokenStatsPlugin from '../../server/index';
import { createControl } from '../../server/control';
import { TokenStatsRepository } from '../../server/repository';
import { TokenStatsPricing } from '../../server/pricing';
import { rawCatalogService } from '../helpers/catalog-service';

const databases: Database[] = [];
const providers = new Map<InstanceType<typeof TokenStatsPlugin>, InstanceType<typeof TokenMeteringPlugin>>();
const plugins: Array<InstanceType<typeof TokenStatsPlugin>> = [];
const costCatalog = {
  xai: { id: 'xai', models: { 'grok-4.7': { id: 'grok-4.7', name: 'Grok 4.7', cost: {
    input: 2, output: 6, cache_read: 0.5,
  } } } },
  openai: { id: 'openai', models: { 'gpt-4o-mini': { id: 'gpt-4o-mini', name: 'GPT-4o mini', cost: { input: 1, output: 2 } } } },
};

function createStorage(): StatsTestStorage {
  const db = new Database(':memory:');
  initializeTokenStatsTestDatabase(db);
  databases.push(db);
  return withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats'));
}

afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.onDestroy();
  for (const provider of providers.values()) await provider.onDestroy();
  providers.clear();
  for (const db of databases.splice(0)) db.close();
});

const secretStore: SecretStore = {
  namespace: 'token-stats-test',
  async get() { return null; },
  async compareAndSet() { return 1; },
  async delete() {},
};

function host(storage: PluginStorage, signal = new AbortController().signal): ControlHostContext {
  return { signal, secretStore, storage };
}

function logger(): PluginLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createPlugin(catalog: unknown = {}): InstanceType<typeof TokenStatsPlugin> {
  const plugin = new TokenStatsPlugin({}, () => new TokenStatsPricing(rawCatalogService(catalog)));
  plugins.push(plugin);
  return plugin;
}

async function initRuntime(plugin: InstanceType<typeof TokenStatsPlugin>, storage: PluginStorage): Promise<void> {
  const services = new PluginServiceHost(); const provider = new TokenMeteringPlugin();
  await provider.init({ config: {}, storage, logger: logger(), services: services.createContext('token-metering') });
  services.markReady('token-metering'); providers.set(plugin, provider);
  await plugin.init({ config: {}, storage, logger: logger(), services: services.createContext('token-stats', 'global', { 'token-metering': '^1.0.0' }) });
}

const offlineGlobalFetch = Object.assign(
  async () => Response.json(costCatalog),
  { preconnect: () => undefined },
) satisfies typeof fetch;

function attemptRow(attempt_id: string, finished_at_ms: number): TokenStatsAttempt {
  return {
    attempt_id,
    request_id: 'queue-request',
    finished_at_ms,
    route_id: 'route-chat',
    upstream_id: 'upstream-a',
    provider: 'openai',
    outcome: 'completed',
    model: 'unknown',
    input_tokens: null,
    output_tokens: null,
    input_source: 'unknown',
    output_source: 'unknown',
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    observation_incomplete: false,
  };
}

async function waitForAttempts(storage: StatsTestStorage, expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshot = await storage.metering!.queryWindowSnapshot({ asOfMs: Date.now() + 10, range: '1h', groupBy: 'model' });
    if (snapshot.all.upstreamAttempts === expected) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${expected} token-stats attempts`);
}

async function invoke(control: ReturnType<typeof createControl>, request: Request, context = host(createStorage())) {
  const handler = control.api.find((item) => item.handler === 'getStats')!;
  return handler.invoke({ ...context, request, requestSignal: new AbortController().signal });
}

describe('token-stats control artifact', () => {
  test('immutable control artifact loads without worker conversion dynamic imports and declares pricing service', async () => {
    const catalog = await PluginManifestCatalog.build({scanDirectories:[fileURLToPath(new URL('../../..', import.meta.url))]});
    const record = catalog.get('token-stats')!;
    expect(record.manifest.services?.provides).toEqual([{id:'token-stats.pricing.v1',version:1,process:'worker'}]);
    expect(typeof (await loadImmutableControlArtifact(record)).createControl).toBe('function');
  });

  test('keyId filters all aggregates and model/time rows; missing IDs stay empty and null selects unattributed', async () => {
    const storage = createStorage(); const now = Date.now() - 1000;
    for (const [id,keyId,tokens] of [['a','key-a',11],['b','key-b',7],['c',null,3],['d',undefined,2]] as const) {
      await storage.metering.recordAttempt({...attemptRow(id,now),key_id:keyId,model:id,input_tokens:tokens,input_source:'usage',cost_usd:tokens/100});
    }
    const control = createControl(host(storage));
    try {
      for (const groupBy of ['model','time']) {
        for (const [keyId,tokens,attempts] of [['key-a',11,1],['key-b',7,1],['__unattributed__',5,2],['deleted',0,0],[undefined,23,4]] as const) {
          const query = new URLSearchParams({range:'1h',groupBy}); if (keyId) query.set('keyId',keyId);
          const response = await invoke(control,new Request(`http://localhost/stats?${query}`),host(storage));
          expect(response.status).toBe(200);
          const data = await response.json();
          expect(data.totalInputTokens).toBe(tokens); expect(data.upstreamAttempts).toBe(attempts);
          expect(data.data.reduce((sum: number,row: {inputTokens:number}) => sum+row.inputTokens,0)).toBe(tokens);
          expect(data.estimatedCostUsd).toBe(attempts ? tokens/100 : null);
        }
      }
      for (const query of ['keyId=','keyId=a&keyId=b',`keyId=${'a'.repeat(129)}`]) {
        expect((await invoke(control,new Request(`http://localhost/stats?${query}`),host(storage))).status).toBe(400);
      }
    } finally { control.dispose(); }
  });

  test('accepts the host plugin config constructor shape and initializes without network access', async () => {
    const storage = createStorage();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = offlineGlobalFetch;
    const plugin = new TokenStatsPlugin({});
    plugins.push(plugin);
    try {
      await initRuntime(plugin, storage);
      expect(() => plugin.register(createPluginHooks())).not.toThrow();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('repository deferred queue runs one task per timer turn and preserves its finished time', async () => {
    const writes: TokenStatsAttempt[] = [];
    const storage = { metering: { async recordAttempt(row: TokenStatsAttempt) { writes.push(row); } } } as unknown as PluginStorage;
    const repository = new TokenStatsRepository(storage);
    const log = logger();
    const first = attemptRow('queue-first', 1234);
    const second = attemptRow('queue-second', 5678);
    const turns: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let resolveDrained!: () => void;
    const allDrained = new Promise<void>((resolve) => { resolveDrained = resolve; });

    expect(repository.enqueueAttempt(async () => {
      turns.push('first');
      repository.enqueueAttempt(async () => { turns.push('second'); resolveSecond(); return second; }, log);
      resolveFirst();
      await firstGate;
      return first;
    }, log)).toBe(true);
    expect(turns).toEqual([]);
    await firstStarted;
    expect(turns).toEqual(['first']);
    await Bun.sleep(5);
    expect(turns).toEqual(['first']);
    for (let index = 0; index < 253; index++) {
      expect(repository.enqueueAttempt(() => undefined, log)).toBe(true);
    }
    expect(repository.enqueueAttempt(async () => {
      setTimeout(resolveDrained, 0);
      return undefined;
    }, log)).toBe(true);
    expect(repository.enqueueAttempt(() => undefined, log)).toBe(false);
    releaseFirst();
    await secondStarted;
    expect(turns).toEqual(['first', 'second']);
    await allDrained;

    expect(writes).toEqual([first, second]);
  });

  test('repository groups model totals by descending tokens and time rows by ascending bucket', async () => {
    const storage = createStorage();
    const asOf = Math.floor(Date.now() / 7_200_000) * 7_200_000;
    const write = (row: TokenStatsAttempt) => storage.metering!.recordAttempt(row);
    const official = (id: string, model: string, finishedAt: number, input: number): TokenStatsAttempt => ({
      ...attemptRow(id, finishedAt), model, input_tokens: input, output_tokens: 0,
      input_source: 'usage', output_source: 'usage',
    });
    await write(official('model-heavy-1', 'model-heavy', asOf - 3_600_000, 10));
    await write(official('model-heavy-2', 'model-heavy', asOf - 3_599_999, 5));
    await write(official('model-light', 'model-light', asOf - 300_000, 2));
    await write({ ...attemptRow('model-unknown', asOf - 1), model: 'unknown' });

    const repository = new TokenStatsRepository(storage);
    const byModel = await repository.query('1h', 'model', asOf);
    expect(byModel.data.map((row) => [row.dimension, row.inputTokens, row.upstreamAttempts]))
      .toEqual([['model-heavy', 15, 2], ['model-light', 2, 1], ['unknown', 0, 1]]);
    const byTime = await repository.query('1h', 'time', asOf);
    expect(byTime.asOfMs).toBe(asOf);
    expect(byTime.bucketMs).toBe(300_000);
    expect(byTime.data.map((row) => [row.bucketStartMs, row.dimension]))
      .toEqual([[asOf - 3_600_000, 'model-heavy'], [asOf - 300_000, 'model-light'], [asOf - 300_000, 'unknown']]);
  });

  test('repository queue drops task errors, missing rows, and storage failures; 257th task is never run', async () => {
    const writes: TokenStatsAttempt[] = [];
    const log = logger();
    const storage = { metering: { async recordAttempt(row: TokenStatsAttempt) {
      if (row.attempt_id === 'queue-db-failure') throw new Error('injected DB failure');
      writes.push(row);
    } } } as unknown as PluginStorage;
    const repository = new TokenStatsRepository(storage);
    const good = attemptRow('queue-after-failures', 9876);
    let callbackCount = 0;

    expect(repository.enqueueAttempt(async () => {
      callbackCount++;
      await Promise.resolve();
      throw new Error('injected task failure');
    }, log)).toBe(true);
    expect(repository.enqueueAttempt(() => { callbackCount++; return undefined; }, log)).toBe(true);
    expect(repository.enqueueAttempt(() => { callbackCount++; return attemptRow('queue-db-failure', 8); }, log)).toBe(true);
    expect(repository.enqueueAttempt(() => { callbackCount++; return good; }, log)).toBe(true);
    expect(callbackCount).toBe(0);
    const firstDeadline = Date.now() + 2_000;
    while (writes.length < 1 && Date.now() < firstDeadline) await Bun.sleep(1);
    expect(writes).toEqual([good]);
    await Bun.sleep(5); // allow the final drain's finally block to release its slot

    const executed: number[] = [];
    const capacityResults: boolean[] = [];
    for (let index = 0; index < 257; index++) {
      const current = index;
      capacityResults.push(repository.enqueueAttempt(() => {
        executed.push(current);
        return attemptRow(`queue-capacity-${current}`, 10_000 + current);
      }, log));
    }
    expect(capacityResults.filter(Boolean)).toHaveLength(256);
    expect(capacityResults[256]).toBe(false);
    expect(executed).toEqual([]);

    const fullDeadline = Date.now() + 5_000;
    while (executed.length < 256 && Date.now() < fullDeadline) await Bun.sleep(2);
    expect(executed).toHaveLength(256);
    expect(executed).not.toContain(256);
    expect(writes).toHaveLength(257);
  });

  test('runtime writes and control reads the same SQLite metering store', async () => {
    const storage = createStorage();
    const plugin = createPlugin();
    await initRuntime(plugin, storage);
    const hooks = createPluginHooks();
    providers.get(plugin)!.register(hooks);
    plugin.register(hooks);
    const requestId = 'token-stats-control-test';
    const observe = (attemptId: string, upstreamId: string, phase: 'selected' | 'request' | 'response' | 'incomplete' | 'end' | 'request-end', extra: Record<string, unknown> = {}) =>
      hooks.onAttemptObservation.promise({
        requestId,
        routeId: 'route-test',
        attemptId,
        upstreamId,
        isActive: () => true,
        phase,
        ...extra,
        ...(phase === 'request' && typeof extra.body === 'string' ? {body:JSON.parse(extra.body)} : {}),
      } as Parameters<typeof hooks.onAttemptObservation.promise>[0]);

    await observe('official-attempt', 'upstream-official', 'selected');
    await observe('official-attempt', 'upstream-official', 'request', {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'official request' }] }),
    });
    await observe('official-attempt', 'upstream-official', 'response', {
      status: 200,
      protocol: 'json',
      body: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    });
    await observe('official-attempt', 'upstream-official', 'end', { outcome: 'completed', sent: true });

    await observe('estimated-attempt', 'upstream-estimated', 'selected');
    await observe('estimated-attempt', 'upstream-estimated', 'request', {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'estimate this request' }] }),
    });
    await observe('estimated-attempt', 'upstream-estimated', 'response', {
      status: 200,
      protocol: 'json',
      body: { choices: [{ message: { role: 'assistant', content: 'estimated response tokens' }, finish_reason: 'stop' }] },
    });
    await observe('estimated-attempt', 'upstream-estimated', 'end', { outcome: 'completed', sent: true });
    await observe('incomplete-attempt', 'upstream-incomplete', 'selected');
    await observe('incomplete-attempt', 'upstream-incomplete', 'request', {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'incomplete observation' }] }),
    });
    await observe('incomplete-attempt', 'upstream-incomplete', 'incomplete', { reason: 'raw-response-incomplete' });
    await observe('incomplete-attempt', 'upstream-incomplete', 'end', { outcome: 'completed', sent: true });
    await observe('request-end', 'upstream-estimated', 'request-end');
    await waitForAttempts(storage, 3);

    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    expect(response.status).toBe(200);
    const stats = await response.json() as Record<string, number>;
    expect(stats).toMatchObject({
      totalInputTokens: 22, totalOutputTokens: 12,
      officialInputTokens: 10, officialOutputTokens: 5,
      logicalRequests: 1, upstreamAttempts: 3, observationIncompleteAttempts: 1,
    });
    expect(typeof stats.estimatedInputTokens).toBe('number');
    expect(typeof stats.estimatedOutputTokens).toBe('number');
    expect(stats.estimatedInputTokens > 0).toBe(true);
    expect(stats.estimatedOutputTokens > 0).toBe(true);
    const routeResponse = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    expect(routeResponse.status).toBe(200);
    const routeStats = await routeResponse.json() as { observationIncompleteAttempts: number; data: Array<{ dimension: string; observationIncompleteAttempts: number }> };
    expect(routeStats.observationIncompleteAttempts).toBe(1);
    expect(routeStats.data.find((row) => row.dimension === 'gpt-4o-mini')?.observationIncompleteAttempts).toBe(1);
    control.dispose();
  });

  test('media partial usage remains distinct from heuristic and observation-incomplete metrics', async () => {
    const storage = createStorage();
    const plugin = createPlugin();
    await initRuntime(plugin, storage);
    const hooks = createPluginHooks();
    providers.get(plugin)!.register(hooks);
    plugin.register(hooks);
    const requestId = 'token-stats-media-partial-control-test';
    const observe = (phase: 'selected' | 'request' | 'response' | 'end', extra: Record<string, unknown> = {}) =>
      hooks.onAttemptObservation.promise({
        requestId, routeId: 'route-test', attemptId: 'media-partial-attempt', upstreamId: 'upstream-media',
        isActive: () => true, phase, ...extra,
        ...(phase === 'request' && typeof extra.body === 'string' ? {body:JSON.parse(extra.body)} : {}),
      } as Parameters<typeof hooks.onAttemptObservation.promise>[0]);

    const imageDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
    await observe('selected');
    await observe('request', {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: [
        { type: 'text', text: 'visual partial text' },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ] }] }),
    });
    await observe('response', {
      status: 200,
      protocol: 'json',
      body: { choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }] },
    });
    await observe('end', { outcome: 'completed', sent: true });
    await waitForAttempts(storage, 1);

    const control = createControl(host(storage));
    const allResponse = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    expect(allResponse.status).toBe(200);
    const stats = await allResponse.json() as {
      totalInputTokens: number; totalOutputTokens: number; officialInputTokens: number; estimatedInputTokens: number;
      estimatedOutputTokens: number; partialOutputs: number; observationIncompleteAttempts: number;
      authorityBreakdown: { input: Record<string, number>; output: Record<string, number> };
    };
    expect(stats).toMatchObject({
      totalInputTokens: 14, totalOutputTokens: 0, officialInputTokens: 0,
      estimatedInputTokens: 14, estimatedOutputTokens: 0,
      partialOutputs: 0, observationIncompleteAttempts: 0,
      authorityBreakdown: { input: { partial: 1, heuristic: 0, official: 0, none: 0 },
        output: { partial: 0, heuristic: 0, official: 0, none: 1 } },
    });
    const routeResponse = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    const routeStats = await routeResponse.json() as { data: Array<{
      dimension: string; inputTokens: number; estimatedInputTokens: number;
      authorityBreakdown: { input: Record<string, number> };
    }> };
    expect(routeStats.data).toHaveLength(1);
    expect(routeStats.data[0]).toMatchObject({
      dimension: 'gpt-4o-mini', inputTokens: 14, estimatedInputTokens: 14,
      authorityBreakdown: { input: { partial: 1, heuristic: 0 } },
    });
    control.dispose();
  });

  test('prices cached usage from the direct xAI host, not the OpenAI wire protocol', async () => {
    const storage = createStorage();
    const db = databases[databases.length - 1]!;
    const plugin = createPlugin(costCatalog);
    await initRuntime(plugin, storage);
    const hooks = createPluginHooks();
    providers.get(plugin)!.register(hooks);
    plugin.register(hooks);
    const requestId = 'token-stats-xai-cost-control-test';
    const observe = (phase: 'selected' | 'request' | 'response' | 'end', extra: Record<string, unknown> = {}) =>
      hooks.onAttemptObservation.promise({
        requestId, routeId: 'route-xai', attemptId: 'xai-cost-attempt', upstreamId: 'upstream-xai',
        isActive: () => true, phase, ...extra,
        ...(phase === 'request' && typeof extra.body === 'string' ? {body:JSON.parse(extra.body)} : {}),
      } as Parameters<typeof hooks.onAttemptObservation.promise>[0]);

    await observe('selected');
    await observe('request', {
      url: new URL('/v1/chat/completions', 'http://token-stats-observation.invalid').pathname,
      body: JSON.stringify({ model: 'grok-4.7', stream: false, messages: [{ role: 'user', content: 'xAI billable input' }] }),
    });
    await observe('response', {
      status: 200, protocol: 'json',
      body: { choices: [{ index: 0, message: { role: 'assistant', content: 'xAI output' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 1_000 } } },
    });
    await observe('end', { outcome: 'completed', sent: true });
    await waitForAttempts(storage, 1);

    const stored = db.query<{ input_source: string; output_source: string; cache_read_tokens: number; cost_usd: number | null }, [string]>(
      'SELECT input_source, output_source, cache_read_tokens, cost_usd FROM token_stats_attempts WHERE attempt_id = ?',
    ).get('xai-cost-attempt');
    expect(stored).toMatchObject({ input_source: 'usage', output_source: 'usage', cache_read_tokens: 1_000 });
    expect(stored!.cost_usd).toBeCloseTo(0.2585, 12);

    const control = createControl(host(storage));
    const all = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    expect(all.status).toBe(200);
    expect((await all.json() as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(0.2585, 12);
    const grouped = await invoke(control, new Request('http://localhost/stats?range=1h&groupBy=time'), host(storage));
    const groupedStats = await grouped.json() as { bucketMs: number; data: Array<{ dimension: string; bucketStartMs: number; estimatedCostUsd: number }> };
    expect(groupedStats.data).toHaveLength(1);
    expect(groupedStats.data[0]!.dimension).toBe('grok-4.7');
    expect(groupedStats.data[0]!.estimatedCostUsd).toBeCloseTo(0.2585, 12);
    expect(groupedStats.bucketMs).toBe(300_000);
    expect(Number.isSafeInteger(groupedStats.data[0]!.bucketStartMs)).toBe(true);
    control.dispose();
  });

  test('empty storage returns a bounded empty DTO', async () => {
    const storage = createStorage();
    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats'), host(storage));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: null,
      groupBy: 'model', logicalRequests: 0, upstreamAttempts: 0, observationIncompleteAttempts: 0 });
    control.dispose();
  });

  test('range and groupBy reject unknown values without defaulting', async () => {
    const storage = createStorage();
    const control = createControl(host(storage));
    for (const query of ['range=90d', 'groupBy=unknown', 'groupBy=all', 'groupBy=route', 'groupBy=provider', 'range=', 'groupBy=', 'timeZone=', 'timeZone=invalid', 'timeZone=UTC&timeZone=UTC', 'range=1d&range=7d']) {
      const response = await invoke(control, new Request(`http://localhost/stats?${query}`), host(storage));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_input' });
    }
    control.dispose();
  });

  test('page ranges expose server bucket boundaries while dashboard ranges keep their original granularity', async () => {
    const storage = createStorage();
    const control = createControl(host(storage));
    try {
      for (const [range, bucketMs, count] of [['day', 3_600_000, 24], ['1d', 3_600_000, 24], ['7d', 86_400_000, 7], ['30d', 86_400_000, 30], ['week', 86_400_000, 7], ['month', 86_400_000, null], ['1h', 300_000, undefined], ['12h', 3_600_000, undefined], ['24h', 7_200_000, undefined]] as const) {
        const response = await invoke(control, new Request(`http://localhost/stats?range=${range}&groupBy=time&timeZone=Asia%2FShanghai`), host(storage));
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.bucketMs).toBe(bucketMs);
        if (typeof count === 'number') expect(result.bucketStarts).toHaveLength(count);
        else if (count === undefined) expect(result.bucketStarts).toBeUndefined();
        else expect(result.bucketStarts.length).toBeGreaterThan(0);
        if (range === 'day' || range === 'week' || range === 'month') {
          expect(result.bucketEndMs).toBeGreaterThan(result.asOfMs);
          expect(result.bucketEndMs).toBeGreaterThan(result.bucketStarts.at(-1));
        } else expect(result.bucketEndMs).toBeUndefined();
      }
    } finally { control.dispose(); }
  });

  test('30-day per-model time stats fit a bounded page budget beyond the dashboard response limit', async () => {
    const storage = createStorage();
    const control = createControl(host(storage));
    const now = Date.now();
    try {
      for (let day = 0; day < 30; day++) {
        for (let model = 0; model < 25; model++) {
          await storage.metering!.recordAttempt({ ...attemptRow(`daily-${day}-${model}`, now - day * 86_400_000 - 1000),
            model: `model-${model}`, input_tokens: 10, output_tokens: 2, input_source: 'usage', output_source: 'usage' });
        }
      }
      const response = await invoke(control, new Request('http://localhost/stats?range=30d&groupBy=time'), host(storage));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(256 * 1024);
      expect(new TextEncoder().encode(text).byteLength).toBeLessThan(4 * 1024 * 1024);
      expect(JSON.parse(text).data).toHaveLength(750);
    } finally { control.dispose(); }
  });

  test('metering query failures propagate instead of becoming zero-valued stats', async () => {
    const storage = createStorage();
    storage.metering!.queryWindowSnapshot = async () => { throw new Error('injected metering failure'); };
    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats?groupBy=model'), host(storage));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    control.dispose();
  });

  test('control refuses storage without the token-stats metering capability', async () => {
    const storage = {} as PluginStorage;
    expect(() => createControl(host(storage))).toThrow('token-stats metering storage is required');
  });

  test('manifest declares stats and pricing APIs on the control process', () => {
    const manifest = parsePluginManifestText(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.control?.entry).toBe('server/control.ts');
    expect(manifest.capabilities).toContain('controlPlane');
    expect(manifest.contributes?.api).toEqual([
      { path: '/stats', methods: ['GET'], handler: 'getStats', execution: 'control', capability: 'logs.read' },
      { path: '/pricing', methods: ['GET'], handler: 'getPricing', execution: 'control', capability: 'config.read' },
      { path: '/pricing/models', methods: ['GET'], handler: 'getPricingModels', execution: 'control', capability: 'config.read' },
      { path: '/pricing/mappings', methods: ['GET'], handler: 'getPricingMappings', execution: 'control', capability: 'config.read' },
      { path: '/pricing/mappings', methods: ['PUT'], handler: 'configurePricingMappings', execution: 'control', capability: 'config.write' },
      { path: '/models', methods: ['GET'], handler: 'getClientModels', execution: 'control', capability: 'logs.read' },
    ]);
  });

  test('client model list returns distinct raw attempt models, bounded and case-preserving', async () => {
    const storage = createStorage();
    const now = Date.now();
    for (const [index, model] of ['GLM-5.3-flash', 'GLM-5.3-flash', 'deepseek-v4-flash'].entries()) {
      await storage.metering.recordAttempt({
        ...attemptRow(`models-${index}`, now - index), model,
        input_tokens: 1, output_tokens: 0, input_source: 'usage', output_source: 'usage',
      });
    }
    const control = createControl(host(storage));
    const invokeModels = (url: string) => control.api.find(api => api.handler === 'getClientModels')!.invoke({
      ...host(storage), request: new Request(url), requestSignal: new AbortController().signal,
    });
    try {
      const all = await invokeModels('http://localhost/models');
      expect(all.status).toBe(200);
      const body = await all.json() as { models: string[]; total: number; page: number; pageSize: number };
      expect(body.models).toEqual(['GLM-5.3-flash', 'deepseek-v4-flash']);
      expect(body.total).toBe(2);
      const searched = await (await invokeModels('http://localhost/models?search=deepseek')).json() as { models: string[]; total: number };
      expect(searched.models).toEqual(['deepseek-v4-flash']);
      expect(searched.total).toBe(1);
      const paged = await (await invokeModels('http://localhost/models?pageSize=1&page=2')).json() as { models: string[]; page: number; pageSize: number };
      expect(paged.models).toEqual(['deepseek-v4-flash']);
      expect(paged.page).toBe(2);
      expect((await invokeModels('http://localhost/models?pageSize=0')).status).toBe(400);
    } finally { control.dispose(); }
  });

  test('method, request signal, and disposal are rejected by the control', async () => {
    const storage = createStorage();
    const control = createControl(host(storage));
    const handler = control.api[0]!;
    const methodResponse = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats', { method: 'POST' }), requestSignal: new AbortController().signal });
    expect(methodResponse.status).toBe(405);

    const requestController = new AbortController();
    requestController.abort();
    const cancelled = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats'), requestSignal: requestController.signal });
    expect(cancelled.status).toBe(400);

    control.dispose();
    const inactive = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats'), requestSignal: new AbortController().signal });
    expect(inactive.status).toBe(409);

    const hostController = new AbortController();
    hostController.abort();
    const inactiveHost = createControl(host(storage, hostController.signal));
    const refused = await inactiveHost.api[0]!.invoke({ ...host(storage, hostController.signal), request: new Request('http://localhost/stats'), requestSignal: new AbortController().signal });
    expect(refused.status).toBe(409);
  });
});
