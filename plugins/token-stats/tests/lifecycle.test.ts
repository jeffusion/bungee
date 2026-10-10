import { initializeTokenStatsTestDatabase } from '../../../packages/core/tests/helpers/token-stats-database';
import { withTokenStatsMetering } from '../server/storage';
type StatsTestStorage = ReturnType<typeof withTokenStatsMetering<SQLitePluginStorage>>;
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AttemptObservationEvent, PluginLogger, PluginInitContext } from '../../../packages/core/src/hooks';
import { createPluginHooks } from '../../../packages/core/src/hooks';
import type { PluginStorage, TokenStatsAttempt } from '../../../packages/core/src/plugin.types';
import { SQLitePluginStorage } from '../../../packages/core/src/plugin-storage';
import TokenMeteringPlugin from '../../token-metering/server/index';
import { PluginServiceHost } from '../../../packages/core/src/plugin-services';
import TokenStatsPlugin from '../server/index';
import { TokenStatsRepository, REPORTING_INCOMPLETE_KEY } from '../server/repository';
import { TokenStatsPricing } from '../server/pricing';
import type { ModelsDevCatalogService } from '../../models-dev/contract';
import { rawCatalogService } from './support/catalog-service';

interface Fixture { db: Database; storage: StatsTestStorage; events: AttemptObservationEvent[]; }
const databases: Database[] = [];
const providers: Array<InstanceType<typeof TokenMeteringPlugin>> = [];
const plugins: Array<InstanceType<typeof TokenStatsPlugin>> = [];
const grokCatalog = {
  xai: { id: 'xai', api: 'https://api.x.ai/v1', models: { 'grok-4.7': { id: 'grok-4.7', cost: { input: 2, output: 6, cache_read: 0.5 } } } },
};

function createFixture(): Fixture {
  const db = new Database(':memory:');
  initializeTokenStatsTestDatabase(db);
  databases.push(db);
  return { db, storage: withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats')), events: [] };
}

async function createObserver(
  fixture: Fixture,
  onRepository?: (repository: TokenStatsRepository) => void,
  catalog: ModelsDevCatalogService | null = null,
) {
  const logger: PluginLogger = {
    debug() {}, info() {}, warn() {}, error() {},
  };
  const plugin = new TokenStatsPlugin({}, () => new TokenStatsPricing(catalog));
  plugins.push(plugin);
  const host = new PluginServiceHost();
  const provider = new TokenMeteringPlugin(); providers.push(provider);
  await provider.init({ config: {}, storage: fixture.storage, logger, services: host.createContext('token-metering') });
  host.markReady('token-metering');
  const init: PluginInitContext = { config: {}, storage: fixture.storage, logger, services: host.createContext('token-stats', 'global', { 'token-metering': '^1.0.0' }) };
  await plugin.init(init);
  onRepository?.(plugin.repository);
  const hooks = createPluginHooks();
  hooks.onAttemptObservation.tapPromise('test-event-capture', async (event) => { fixture.events.push(event); });
  provider.register(hooks);
  plugin.register(hooks);
  return hooks;
}

function base(requestId: string, attemptId = `${requestId}:attempt`, upstreamId = 'upstream-a') {
  return { requestId, routeId: 'route-chat', attemptId, upstreamId, isActive: () => true };
}
function selected(requestId: string, attemptId?: string, upstreamId?: string): AttemptObservationEvent {
  return { ...base(requestId, attemptId, upstreamId), phase: 'selected' };
}
function request(requestId: string, options: { attemptId?: string; upstreamId?: string; url?: string; body?: unknown } = {}): AttemptObservationEvent {
  return { ...base(requestId, options.attemptId, options.upstreamId), phase: 'request',
    url: options.url ?? 'https://api.openai.com/v1/responses',
    // Fixtures represent the already decoded gateway observation, not its wire encoding.
    body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body ?? { model: 'gpt-4o-mini', input: 'hello' } };
}
function response(requestId: string, body: Record<string, unknown>, options: {
  attemptId?: string; upstreamId?: string; status?: number; protocol?: 'json' | 'sse';
} = {}): AttemptObservationEvent {
  return { ...base(requestId, options.attemptId, options.upstreamId), phase: 'response', status: options.status ?? 200,
    protocol: options.protocol ?? 'json', body };
}
function end(requestId: string, outcome: 'completed' | 'failed' | 'cancelled', options: {
  attemptId?: string; upstreamId?: string; sent?: boolean;
} = {}): AttemptObservationEvent {
  return { ...base(requestId, options.attemptId, options.upstreamId), phase: 'end', outcome, sent: options.sent ?? true };
}
function requestEnd(requestId: string, attemptId?: string): AttemptObservationEvent {
  return { ...base(requestId, attemptId), phase: 'request-end' };
}
function incomplete(requestId: string, attemptId = `${requestId}:attempt`): AttemptObservationEvent {
  return { ...base(requestId, attemptId), phase: 'incomplete', reason: 'raw-response-incomplete' };
}
async function observe(hooks: ReturnType<typeof createPluginHooks>, event: AttemptObservationEvent): Promise<void> {
  await hooks.onAttemptObservation.promise(event);
}
function readRows(db: Database, requestId?: string): TokenStatsAttempt[] {
  return db.query(`SELECT * FROM token_stats_attempts ${requestId ? 'WHERE request_id = ?' : ''} ORDER BY attempt_id`)
    .all(...(requestId ? [requestId] : [])) as TokenStatsAttempt[];
}
async function waitForRows(db: Database, expected: number, requestId?: string): Promise<TokenStatsAttempt[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = readRows(db, requestId);
    if (rows.length === expected) return rows;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${expected} token-stats rows`);
}

afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.onDestroy();
  for (const provider of providers.splice(0)) await provider.onDestroy();
  for (const db of databases.splice(0)) db.close();
});

describe('token-stats attempt observer', () => {
  test('global observation ignores ordinary requests and usage-shaped business responses', async () => {
    const fixture = createFixture();
    const tasks: Array<unknown> = [];
    const hooks = await createObserver(fixture, (repository) => {
      repository.enqueueAttempt = (task) => { tasks.push(task); return true; };
    });
    for (const [id, body, reply] of [
      ['ordinary-input', { input: 'search' }, { usage: { prompt_tokens: 100, completion_tokens: 20 } }],
      ['ordinary-messages', { messages: ['notification'] }, { type: 'message', content: 'hello' }],
      ['ordinary-choices', { model: 'product' }, { choices: ['A'], usage: { input_tokens: 100 } }],
    ] as const) {
      await observe(hooks, selected(id));
      await observe(hooks, request(id, { url: 'https://app.example/api', body }));
      await observe(hooks, response(id, reply));
      await observe(hooks, end(id, 'completed'));
    }
    await observe(hooks, request('ordinary-failed', { url: 'https://app.example/messages', body: {} }));
    await observe(hooks, end('ordinary-failed', 'failed'));
    expect(tasks).toHaveLength(0);
    expect(readRows(fixture.db)).toHaveLength(0);
  });

  test('recognizes a generation response when the request payload cannot identify the protocol', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    await observe(hooks, request('response-only', { url: 'https://relay.example/custom', body: '{}' }));
    await observe(hooks, response('response-only', {
      object: 'chat.completion', model: 'response-model', choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 4 },
    }));
    await observe(hooks, end('response-only', 'completed'));
    const [row] = await waitForRows(fixture.db, 1);
    expect(row).toMatchObject({ provider: 'openai', model: 'response-model', input_tokens: 0, output_tokens: 4 });
  });

  test('observes selected/request/response/end, records usage zero, and request-end does not wait or write', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const requestId = 'zero-usage';
    await observe(hooks, selected(requestId));
    await observe(hooks, request(requestId, { body: JSON.stringify({ model: 'actual-upstream-model', input: 'hello' }) }));
    await observe(hooks, response(requestId, { usage: { input_tokens: 0, output_tokens: 3 } }));
    await observe(hooks, end(requestId, 'completed'));
    await observe(hooks, end(requestId, 'completed'));
    await observe(hooks, requestEnd(requestId));
    expect(fixture.events.map((event) => event.phase)).toEqual(['selected', 'request', 'response', 'end', 'end', 'request-end']);
    // The hook only enqueues; scheduled SQLite work has not run during this microtask turn.
    expect(readRows(fixture.db)).toHaveLength(0);
    const [row] = await waitForRows(fixture.db, 1, requestId);
    expect(row).toMatchObject({ model: 'actual-upstream-model', input_tokens: 0, input_source: 'usage', output_tokens: 3, output_source: 'usage' });
  });

  test('end callback stays nonblocking while the queued finalizer writes cost once from the loaded catalog', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture, undefined, rawCatalogService(grokCatalog));
    const id = 'deferred-grok-pricing';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, {
      url: 'https://api.x.ai/v1/chat/completions',
      body: JSON.stringify({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hello' }] }),
    }));
    await observe(hooks, response(id, {
      model: 'grok-4.7', choices: [{ message: { role: 'assistant', content: 'answer' } }],
      usage: { prompt_tokens: 17, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
    }));

    const endCallback = observe(hooks, end(id, 'completed'));
    expect(await Promise.race([endCallback.then(() => true), Bun.sleep(50).then(() => false)])).toBe(true);
    await observe(hooks, end(id, 'completed'));
    expect(readRows(fixture.db)).toHaveLength(0);

    const [row] = await waitForRows(fixture.db, 1, id);
    expect(row).toMatchObject({
      model: 'grok-4.7', input_tokens: 17, output_tokens: 7,
      cache_read_tokens: 5,
    });
    expect(row.cost_usd).toBeCloseTo(0.0000685, 15);
    expect(readRows(fixture.db)).toHaveLength(1);
  });

  test('an absent catalog keeps official usage with NULL cost instead of blocking', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const id = 'no-catalog-pricing';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, {
      url: 'https://api.x.ai/v1/chat/completions',
      body: JSON.stringify({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hello' }] }),
    }));
    await observe(hooks, response(id, {
      usage: { prompt_tokens: 17, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
    }));
    await observe(hooks, end(id, 'completed'));
    const [row] = await waitForRows(fixture.db, 1, id);
    expect(row).toMatchObject({ model: 'grok-4.7', input_tokens: 17, output_tokens: 7, cost_usd: null });
  });

  test('shared provider finalizes estimates while stats defers reporting and preserves end timestamp', async () => {
    const fixture = createFixture();
    const tasks: Array<() => TokenStatsAttempt | undefined | Promise<TokenStatsAttempt | undefined>> = [];
    const hooks = await createObserver(fixture, (repository) => {
      repository.enqueueAttempt = (task) => { tasks.push(task); return true; };
    });
    const id = 'deferred-json-estimate';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'input to estimate' }] }),
    }));
    await observe(hooks, response(id, {
      choices: [{ message: { role: 'assistant', content: 'response to estimate' }, finish_reason: 'stop' }],
    }));
    await observe(hooks, { ...end(id, 'completed'), isActive: () => false });
    expect(tasks).toHaveLength(0);
    await observe(hooks, selected(id));
    await observe(hooks, request(id, {
      url: 'https://api.openai.com/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'input to estimate' }] }),
    }));
    await observe(hooks, response(id, {
      choices: [{ message: { role: 'assistant', content: 'response to estimate' }, finish_reason: 'stop' }],
    }));
    const beforeEnd = Date.now();
    await observe(hooks, end(id, 'completed'));
    await observe(hooks, end(id, 'completed'));
    const afterEnd = Date.now();

    expect(tasks).toHaveLength(1);
    expect(readRows(fixture.db)).toHaveLength(0);
    await Bun.sleep(20);
    expect(readRows(fixture.db)).toHaveLength(0);
    const row = await tasks[0]!();
    expect(row).toMatchObject({ input_source: 'estimated', output_source: 'estimated' });
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.finished_at_ms).toBeGreaterThanOrEqual(beforeEnd);
    expect(row.finished_at_ms).toBeLessThanOrEqual(afterEnd);
    expect(readRows(fixture.db)).toHaveLength(0);
  });

  test('counts each ended failover attempt once for the shared logical request', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const requestId = 'failover-shared';
    for (const [attemptId, upstreamId, input] of [
      ['failover-a', 'upstream-a', 2], ['failover-b', 'upstream-b', 0],
    ] as const) {
      await observe(hooks, selected(requestId, attemptId, upstreamId));
      await observe(hooks, request(requestId, { attemptId, upstreamId }));
      await observe(hooks, response(requestId, { usage: { input_tokens: input, output_tokens: 0 } }, { attemptId, upstreamId }));
      await observe(hooks, end(requestId, 'completed', { attemptId, upstreamId }));
    }
    await observe(hooks, requestEnd(requestId));
    const rows = await waitForRows(fixture.db, 2, requestId);
    expect(rows.map((row) => row.attempt_id)).toEqual(['failover-a', 'failover-b']);
    const repo = new TokenStatsRepository(fixture.storage);
    expect(rows.map((row) => row.model)).toEqual(['gpt-4o-mini', 'gpt-4o-mini']);
    const byModel = await repo.query('1h', 'model');
    expect(byModel).toMatchObject({ logicalRequests: 1, upstreamAttempts: 2 });
    expect(byModel.data).toMatchObject([{ dimension: 'gpt-4o-mini', upstreamAttempts: 2 }]);
    const byTime = await repo.query('1h', 'time');
    expect(byTime).toMatchObject({ bucketMs: 300_000, logicalRequests: 1, upstreamAttempts: 2 });
    expect(byTime.data.reduce((sum, row) => sum + row.upstreamAttempts, 0)).toBe(2);
  });

  test('does not guess Anthropic from max_tokens and records no-response/error response as unknown', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const ambiguous = 'ambiguous-body';
    await observe(hooks, selected(ambiguous));
    await observe(hooks, request(ambiguous, { url: 'https://gateway.example/proxy', body: JSON.stringify({ model: 'x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) }));
    await observe(hooks, end(ambiguous, 'failed'));

    const errorId = 'error-body';
    await observe(hooks, selected(errorId));
    await observe(hooks, request(errorId));
    await observe(hooks, response(errorId, { error: { message: 'not generated text' } }, { status: 502 }));
    await observe(hooks, end(errorId, 'failed'));
    const missingRequestModel = 'missing-request-model';
    await observe(hooks, selected(missingRequestModel));
    await observe(hooks, request(missingRequestModel, {
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }));
    await observe(hooks, response(missingRequestModel, {
      model: 'response-only-model', usage: { prompt_tokens: 0, completion_tokens: 0 },
    }));
    await observe(hooks, end(missingRequestModel, 'completed'));
    const rows = await waitForRows(fixture.db, 3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt_id: `${ambiguous}:attempt`, provider: 'unknown', input_source: 'unknown', output_source: 'unknown' }),
      expect.objectContaining({ attempt_id: `${errorId}:attempt`, input_source: 'unknown', output_source: 'unknown', outcome: 'failed' }),
      expect.objectContaining({ attempt_id: `${missingRequestModel}:attempt`, model: 'unknown', input_tokens: 0, output_tokens: 0, input_source: 'usage', output_source: 'usage' }),
    ]));
    expect(rows.find((row) => row.attempt_id === `${ambiguous}:attempt`)?.output_tokens).toBeNull();
    expect(rows.find((row) => row.attempt_id === `${errorId}:attempt`)?.output_tokens).toBeNull();
  });

  test('preserves one official zero while using terminal session estimate for the missing side', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const id = 'one-side-usage';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, { url: 'https://api.openai.com/v1/chat/completions', body: JSON.stringify({
      model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'please estimate input' }],
    }) }));
    await observe(hooks, response(id, { choices: [{ message: { role: 'assistant', content: 'estimated answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0 } }));
    await observe(hooks, end(id, 'completed'));
    const [row] = await waitForRows(fixture.db, 1, id);
    expect(row).toMatchObject({ input_tokens: 0, input_source: 'usage', output_source: 'estimated' });
    expect(row.output_tokens).toBeGreaterThan(0);
  });

  test('retains late SSE usage once and keeps cache usage without double-counting', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const id = 'late-stream-usage';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, { url: 'https://api.openai.com/v1/chat/completions', body: JSON.stringify({
      model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hello' }],
    }) }));
    await observe(hooks, response(id, { choices: [{ delta: { content: 'answer' }, finish_reason: null }] }, { protocol: 'sse' }));
    await observe(hooks, response(id, { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }, { protocol: 'sse' }));
    await observe(hooks, end(id, 'completed'));
    const [row] = await waitForRows(fixture.db, 1, id);
    expect(row).toMatchObject({ input_tokens: 0, input_source: 'usage', output_tokens: 0, output_source: 'usage', cache_read_tokens: 0 });
  });

  test('OpenAI response.completed and Anthropic message_stop still accept late official zero usage', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);

    const openai = 'openai-response-completed-late-usage';
    await observe(hooks, selected(openai));
    await observe(hooks, request(openai, { url: 'https://api.openai.com/v1/responses', body: JSON.stringify({
      model: 'gpt-4o-mini', stream: true, input: 'hello',
    }) }));
    await observe(hooks, response(openai, { type: 'response.output_text.delta', delta: 'answer' }, { protocol: 'sse' }));
    await observe(hooks, response(openai, { type: 'response.completed', response: {
      status: 'completed', output: [{ content: [{ type: 'output_text', text: 'answer' }] }],
    } }, { protocol: 'sse' }));
    await observe(hooks, response(openai, { type: 'response.completed', response: {
      status: 'completed', usage: { input_tokens: 0, output_tokens: 0 },
    } }, { protocol: 'sse' }));
    await observe(hooks, end(openai, 'completed'));

    const anthropic = 'anthropic-message-stop-late-usage';
    await observe(hooks, selected(anthropic));
    await observe(hooks, request(anthropic, { url: 'https://api.anthropic.com/v1/messages', body: JSON.stringify({
      model: 'claude-3-5-sonnet', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }],
    }) }));
    await observe(hooks, response(anthropic, { type: 'message_start', message: {
      model: 'claude-3-5-sonnet', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } }, { protocol: 'sse' }));
    await observe(hooks, response(anthropic, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }, { protocol: 'sse' }));
    await observe(hooks, response(anthropic, { type: 'message_stop' }, { protocol: 'sse' }));
    await observe(hooks, response(anthropic, { type: 'message_delta', usage: { output_tokens: 0 } }, { protocol: 'sse' }));
    await observe(hooks, end(anthropic, 'completed'));

    const rows = await waitForRows(fixture.db, 2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt_id: `${openai}:attempt`, input_tokens: 0, output_tokens: 0, input_source: 'usage', output_source: 'usage' }),
      expect.objectContaining({ attempt_id: `${anthropic}:attempt`, input_tokens: 0, output_tokens: 0,
        input_source: 'usage', output_source: 'usage', cache_read_tokens: 0, cache_write_tokens: 0 }),
    ]));
  });

  test('merging absent cache observations preserves unknown instead of manufacturing zero', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const id = 'anthropic-cache-unknown';
    await observe(hooks, selected(id));
    await observe(hooks, request(id, { url: 'https://api.anthropic.com/v1/messages', body: JSON.stringify({
      model: 'claude-3-5-sonnet', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }],
    }) }));
    await observe(hooks, response(id, { type: 'message_start', message: {
      model: 'claude-3-5-sonnet', usage: { input_tokens: 1 },
    } }, { protocol: 'sse' }));
    await observe(hooks, response(id, { type: 'message_delta', usage: { output_tokens: 1 } }, { protocol: 'sse' }));
    await observe(hooks, response(id, { type: 'message_stop' }, { protocol: 'sse' }));
    await observe(hooks, end(id, 'completed'));
    const [row] = await waitForRows(fixture.db, 1);
    expect(row).toMatchObject({ cache_read_tokens: null, cache_write_tokens: null });
  });

  test('cancelled and HTTP-error attempts retain only observed official usage', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const cancelled = 'cancelled-official-only';
    await observe(hooks, selected(cancelled));
    await observe(hooks, request(cancelled, { url: 'https://api.openai.com/v1/chat/completions', body: JSON.stringify({
      model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hello' }],
    }) }));
    await observe(hooks, response(cancelled, { choices: [{ delta: { content: 'partial output' }, finish_reason: null }],
      usage: { prompt_tokens: 0 } }, { protocol: 'sse' }));
    await observe(hooks, end(cancelled, 'cancelled'));

    const httpError = 'http-error-official-only';
    await observe(hooks, selected(httpError));
    await observe(hooks, request(httpError));
    await observe(hooks, response(httpError, { error: { message: 'upstream failed' }, usage: { input_tokens: 0 } }, { status: 502 }));
    await observe(hooks, end(httpError, 'failed'));

    const rows = await waitForRows(fixture.db, 2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt_id: `${cancelled}:attempt`, outcome: 'aborted', input_tokens: 0,
        input_source: 'usage', output_tokens: null, output_source: 'unknown' }),
      expect.objectContaining({ attempt_id: `${httpError}:attempt`, outcome: 'failed', input_tokens: 0,
        input_source: 'usage', output_tokens: null, output_source: 'unknown' }),
    ]));
  });

  test('incomplete observations retain official usage and no-response failures remain unknown', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    const id = 'incomplete-official';
    await observe(hooks, selected(id));
    await observe(hooks, request(id));
    await observe(hooks, response(id, { usage: { input_tokens: 4, output_tokens: 0 } }));
    await observe(hooks, incomplete(id));
    await observe(hooks, end(id, 'completed'));
    const noResponse = 'failed-no-response';
    await observe(hooks, selected(noResponse));
    await observe(hooks, request(noResponse));
    await observe(hooks, end(noResponse, 'failed'));
    const rows = await waitForRows(fixture.db, 2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt_id: `${id}:attempt`, input_tokens: 4, input_source: 'usage', output_tokens: 0, output_source: 'usage', observation_incomplete: 1 }),
      expect.objectContaining({ attempt_id: `${noResponse}:attempt`, input_tokens: null, output_tokens: null, input_source: 'unknown', output_source: 'unknown' }),
    ]));
  });

  test('queue saturation drops stats without delaying observer return; SQLite errors do not escape or poison later writes', async () => {
    const fixture = createFixture();
    const hooks = await createObserver(fixture);
    for (let i = 0; i < 257; i++) {
      const id = `queue-${i}`;
      await observe(hooks, selected(id));
      await observe(hooks, request(id));
      await observe(hooks, end(id, 'completed'));
      await observe(hooks, requestEnd(id));
    }
    // All observer callbacks returned immediately; exactly 256 rows are accepted
    // and the 257th is dropped by the bounded queue.
    const acceptedRows = await waitForRows(fixture.db, 256);
    expect(await fixture.storage.uncached().get(REPORTING_INCOMPLETE_KEY)).toBe(true);
    expect((await new TokenStatsRepository(fixture.storage).query('1h', 'model')).reportingIncomplete).toBe(true);
    expect(acceptedRows.map((row) => row.request_id).sort()).toEqual(
      Array.from({ length: 256 }, (_, index) => `queue-${index}`).sort(),
    );

    fixture.db.run("CREATE TRIGGER fail_attempt_write BEFORE INSERT ON token_stats_attempts BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    const badId = 'storage-failure';
    const metering = fixture.storage.metering!;
    const recordAttempt = metering.recordAttempt.bind(metering);
    let signalBadWrite!: () => void;
    const badWriteReachedStorage = new Promise<void>((resolve) => { signalBadWrite = resolve; });
    metering.recordAttempt = (row) => {
      if (row.request_id === badId) signalBadWrite();
      return recordAttempt(row);
    };
    await observe(hooks, selected(badId)); await observe(hooks, request(badId)); await observe(hooks, end(badId, 'completed'));
    await Promise.race([
      badWriteReachedStorage,
      Bun.sleep(5_000).then(() => { throw new Error('queued SQLite failure did not reach storage'); }),
    ]);
    fixture.db.run('DROP TRIGGER fail_attempt_write');
    const goodId = 'after-storage-failure';
    await observe(hooks, selected(goodId)); await observe(hooks, request(goodId)); await observe(hooks, end(goodId, 'completed'));
    const rowsAfterRecovery = await waitForRows(fixture.db, 257);
    expect(rowsAfterRecovery.some((row) => row.request_id === badId)).toBe(false);
    expect(rowsAfterRecovery.some((row) => row.request_id === goodId)).toBe(true);
  });

  test('requires the isolated metering capability', () => {
    expect(() => new TokenStatsRepository({} as PluginStorage)).toThrow('token-stats metering storage is required');
  });
});
