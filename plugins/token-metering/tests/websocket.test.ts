import { Database } from 'bun:sqlite';
import { initializeTokenStatsTestDatabase } from '../../../packages/core/tests/helpers/token-stats-database';
import { createPluginStorageCapability } from '../../../packages/core/src/plugin-storage';
import { SQLiteTokenStatsMetering } from '../../token-stats/server/storage';
import { describe, expect, test } from 'bun:test';
import TokenMeteringPlugin from '../server';
import { ResponsesWebSocketMetering } from '../server/websocket';
import { createPluginHooks, type AttemptObservationEvent } from '../../../packages/core/src/hooks';
import type { WebSocketObservationEvent } from '../../../packages/core/src/gateway/websocket-contracts';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { PluginServiceHost, TOKEN_METERING_SERVICE_ID, type TokenMeteringService, type TokenMeteringResult } from '../../../packages/core/src/plugin-services';

async function fixture(url = 'https://api.openai.com/v1/responses') {
  const host = new PluginServiceHost();
  const provider = new TokenMeteringPlugin();
  await provider.init({ config: {}, storage: {} as PluginStorage, logger: { debug() {}, info() {}, warn() {}, error() {} }, services: host.createContext('token-metering') });
  host.markReady('token-metering');
  const hooks = createPluginHooks();
  provider.register(hooks);
  const services = host.createContext('stats', 'global', { 'token-metering': '^1.0.0' }); host.markReady('stats');
  const service = services.consume<TokenMeteringService>('token-metering', TOKEN_METERING_SERVICE_ID, 1);
  const results: TokenMeteringResult[] = [];
  service.subscribe({ onResult: result => { results.push(result); } });
  const base = { connectionId: 'connection', keyId: 'trusted-key', routeId: 'route', upstreamId: 'upstream', upstreamUrl: url, servingRevision: 3, isActive: () => true };
  const send = async (phase: Record<string, unknown>) => { await hooks.onWebSocketObservation.promise({ ...base, ...phase } as WebSocketObservationEvent); await Promise.resolve(); };
  const client = (body: Record<string, unknown>) => send({ phase: 'message', direction: 'client', message: { kind: 'text', byteLength: 1, json: () => body } });
  const upstream = (body: Record<string, unknown>) => send({ phase: 'message', direction: 'upstream', message: { kind: 'text', byteLength: 1, json: () => body } });
  const create = (model = 'gpt-4o', stream_id?: string) => client({ type: 'response.create', model, stream_id, input: 'incremental private input' });
  const response = (id: string, type = 'response.created', usage?: Record<string, unknown>, stream_id?: string, model = 'gpt-4o') => upstream({ type, stream_id, response: { id, object: 'response', output: [], model, usage } });
  const close = () => send({ phase: 'close', code: 1000, reason: '', metrics: { durationMs: 1, clientMessages: 1, upstreamMessages: 1, clientBytes: 1, upstreamBytes: 1 } });
  await send({ phase: 'open' });
  return { provider, service, results, send, client, upstream, create, response, close };
}

describe('Responses WebSocket metering through the shared service', () => {
  test.each(['https://api.openai.com/v1/responses', 'https://chatgpt.com/backend-api/codex/responses'])('multiple turns have logical UUIDs and preserve official identity on %s', async url => {
    const f = await fixture(url);
    for (const id of ['first', 'second']) {
      await f.create(); await f.response(id);
      await f.response(id, 'response.completed', { input_tokens: 12, output_tokens: 3 });
    }
    await f.close();
    expect(f.results).toHaveLength(2);
    expect(new Set(f.results.map(result => result.requestId)).size).toBe(2);
    for (const result of f.results) {
      expect(result.requestId).toMatch(/^[\da-f-]{36}$/); expect(result.attemptId).toMatch(/^[\da-f-]{36}$/);
      expect(result).toMatchObject({ keyId: 'trusted-key', pricingProvider: url, provider: 'openai', inputTokens: 12, outputTokens: 3, complete: true, observationIncomplete: false });
    }
    await f.provider.onDestroy();
  });

  test('interleaved stream IDs and the default FIFO bind model to the right logical request', async () => {
    const f = await fixture();
    await f.create('model-a', 'a'); await f.create('model-b', 'b');
    await f.upstream({ type: 'response.created', stream_id: 'b', response: { id: 'b', object: 'response', output: [] } });
    await f.upstream({ type: 'response.created', stream_id: 'a', response: { id: 'a', object: 'response', output: [] } });
    await f.upstream({ type: 'response.completed', response: { id: 'b', object: 'response', output: [], usage: { input_tokens: 2, output_tokens: 20 } } });
    await f.upstream({ type: 'response.completed', response: { id: 'a', object: 'response', output: [], usage: { input_tokens: 1, output_tokens: 10 } } });
    await f.create('fifo-first'); await f.create('fifo-second');
    for (const id of ['c', 'd']) {
      await f.upstream({ type: 'response.created', response: { id, object: 'response', output: [] } });
      await f.upstream({ type: 'response.completed', response: { id, object: 'response', output: [], usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    expect(f.results.map(result => [result.model, result.inputTokens])).toEqual([['model-b', 2], ['model-a', 1], ['fifo-first', 0], ['fifo-second', 0]]);
    await f.provider.onDestroy();
  });

  test('duplicate terminals and disconnect never settle a completed response twice; server successors are independent', async () => {
    const f = await fixture(); await f.create(); await f.response('initial');
    for (let i = 0; i < 2; i++) await f.response('initial', 'response.completed', { input_tokens: 10, output_tokens: 2 });
    await f.response('successor'); await f.response('successor', 'response.completed', { input_tokens: 12, output_tokens: 4 });
    await f.close();
    expect(f.results).toHaveLength(2); expect(f.results.map(result => result.inputTokens)).toEqual([10, 12]);
    expect(f.results[0]!.requestId).not.toBe(f.results[1]!.requestId);
    await f.provider.onDestroy();
  });

  test('missing usage and output deltas do not invent complete context or zero counts', async () => {
    const f = await fixture(); await f.create(); await f.response('missing');
    await f.upstream({ type: 'response.output_text.delta', response_id: 'missing', delta: 'generated answer' });
    await f.response('missing', 'response.completed');
    expect(f.results[0]).toMatchObject({ inputTokens: undefined, outputTokens: undefined, inputSource: 'none', outputSource: 'none', complete: false, observationIncomplete: true });
    await f.provider.onDestroy();
  });

  test('partial official usage preserves only the observed side; positive zero and cache subsets are not added twice', async () => {
    const f = await fixture(); await f.create(); await f.response('partial');
    await f.response('partial', 'response.completed', { input_tokens: 8, input_tokens_details: { cached_tokens: 5 } });
    await f.create(); await f.response('zero');
    await f.response('zero', 'response.in_progress', { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } });
    await f.response('zero', 'response.completed', { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } });
    expect(f.results[0]).toMatchObject({ inputTokens: 8, outputTokens: undefined, cacheReadTokens: 5, inputSource: 'official', outputSource: 'none', complete: false });
    expect(f.results[1]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, complete: true });
    await f.provider.onDestroy();
  });

  test('intermediate usage does not prove complete final totals when the terminal usage is missing', async () => {
    const f = await fixture(); await f.create();
    await f.response('intermediate', 'response.in_progress', { input_tokens: 5, output_tokens: 1 });
    await f.response('intermediate', 'response.completed');
    expect(f.results[0]).toMatchObject({ inputTokens: 5, outputTokens: 1, observationIncomplete: true, complete: false, outcome: 'failed' });
    await f.provider.onDestroy();
  });

  test.each(['response.failed', 'response.incomplete'])('%s retains official counts but never becomes a completed settlement', async type => {
    const f = await fixture(); await f.create(); await f.response('failed');
    await f.response('failed', type, { input_tokens: 7, output_tokens: 1 });
    expect(f.results[0]).toMatchObject({ inputTokens: 7, outputTokens: 1, outcome: 'failed', complete: false });
    await f.close(); expect(f.results).toHaveLength(1); await f.provider.onDestroy();
  });

  test('disconnect settles pending creates and active unfinished responses as unknown, exactly once', async () => {
    const f = await fixture(); await f.create(); await f.response('active'); await f.create();
    await f.close(); await f.close();
    expect(f.results).toHaveLength(2);
    for (const result of f.results) expect(result).toMatchObject({ outcome: 'aborted', complete: false, observationIncomplete: true, inputTokens: undefined, outputTokens: undefined });
    expect(f.provider.activeAttempts).toBe(0); await f.provider.onDestroy();
  });

  test('observer incomplete ends admitted responses and prevents later false complete settlements', async () => {
    const f = await fixture(); await f.create(); await f.response('lost');
    await f.send({ phase: 'incomplete', reason: 'observer-timeout' });
    await f.response('lost', 'response.completed', { input_tokens: 100, output_tokens: 20 });
    await f.close();
    expect(f.results).toHaveLength(1); expect(f.results[0]).toMatchObject({ complete: false, observationIncomplete: true, inputTokens: undefined, outputTokens: undefined });
    await f.provider.onDestroy();
  });

  test('binary, unknown JSON and fake terminal envelopes do not create LLM records', async () => {
    const f = await fixture();
    await f.client({ type: 'business.action', input: 'ordinary' });
    await f.upstream({ type: 'response.completed', response: { id: 'fake', usage: { input_tokens: 99, output_tokens: 99 } } });
    await f.upstream({ type: 'response.output_text.delta', response_id: 'unknown', delta: 'ordinary' });
    await f.send({ phase: 'message', direction: 'upstream', message: { kind: 'binary', byteLength: 4, json: () => { throw new Error('binary must not parse'); } } });
    await f.close(); expect(f.results).toHaveLength(0); expect(f.provider.parsedResponses).toBe(0); await f.provider.onDestroy();
  });

  test('failed and slow report subscribers are isolated from healthy statistics', async () => {
    const f = await fixture(); let failures = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.service.subscribe({ onResult: () => gate });
    f.service.subscribe({ required: true, onResult: () => { throw new Error('subscriber failed'); }, onFailure: () => { failures++; } });
    await f.create(); await f.response('healthy', 'response.completed', { input_tokens: 1, output_tokens: 2 });
    expect(f.results).toHaveLength(1); expect(failures).toBe(1);
    release(); await f.close(); await f.provider.onDestroy();
  });

  test('pending capacity settles unfinished observations and disables the overflowing connection', async () => {
    const f = await fixture();
    for (let i = 0; i < 65; i++) await f.create();
    expect(f.results).toHaveLength(64);
    expect(f.results.every(result => result.observationIncomplete && !result.complete)).toBe(true);
    await f.create(); await f.response('late', 'response.completed', { input_tokens: 1, output_tokens: 1 });
    await f.close(); expect(f.results).toHaveLength(64); expect(f.provider.activeAttempts).toBe(0); await f.provider.onDestroy();
  });

  test('changed trusted metadata discards state instead of writing a different identity', async () => {
    const f = await fixture(); await f.create();
    await f.send({ phase: 'incomplete', reason: 'observer-error', keyId: 'other-key' });
    await f.close(); expect(f.results).toHaveLength(0); expect(f.provider.activeAttempts).toBe(0); await f.provider.onDestroy();
  });

  test('old terminal replay cannot consume a new pending create after recent cache rotation',async()=>{
    const f=await fixture();
    for(let i=0;i<257;i++)await f.response(`old-${i}`,'response.completed',{input_tokens:1,output_tokens:1});
    await f.create('pending-new');
    await f.response('old-0','response.completed',{input_tokens:1,output_tokens:1});
    await f.close();
    expect(new Set(f.results.map(result=>result.attemptId)).size).toBe(258);
    expect(f.results.filter(result=>result.outcome==='aborted')).toHaveLength(1);
    expect(f.results.at(-1)).toMatchObject({model:'pending-new',observationIncomplete:true});
    const db=new Database(':memory:');
    initializeTokenStatsTestDatabase(db);
    const storage=createPluginStorageCapability(db,'ws-replay-stats');
    try {
      const stats=new SQLiteTokenStatsMetering(storage.storage.observation!);
      for(const result of f.results)await stats.recordAttempt({attempt_id:result.attemptId,request_id:result.requestId,finished_at_ms:result.finishedAtMs,
        route_id:result.routeId,upstream_id:result.upstreamId,provider:result.provider,outcome:result.outcome,model:result.model ?? 'unknown',
        input_tokens:result.inputTokens ?? null,output_tokens:result.outputTokens ?? null,input_source:result.inputSource==='official'?'usage':'unknown',output_source:result.outputSource==='official'?'usage':'unknown',
        cache_read_tokens:result.cacheReadTokens ?? null,cache_write_tokens:result.cacheWriteTokens ?? null,cost_usd:null,observation_incomplete:result.observationIncomplete});
      expect(await storage.storage.observation!.withDatabase(database=>database.query('SELECT COUNT(*) AS count FROM token_stats_attempts').get())).toEqual({count:258});
      expect(await storage.storage.observation!.withDatabase(database=>database.query("SELECT COUNT(*) AS count FROM token_stats_attempts WHERE outcome='aborted' AND input_tokens IS NULL AND output_tokens IS NULL").get())).toEqual({count:1});
    } finally {storage.revoke();db.close();}
    await f.provider.onDestroy();
  });

  test('bounded recent terminal IDs rotate without disabling long-lived connection metering', async () => {
    const f = await fixture();
    for (let i = 0; i < 255; i++) await f.response(`finished-${i}`, 'response.completed', { input_tokens: 1, output_tokens: 1 });
    await f.create(); await f.response('unfinished');
    await f.response('last', 'response.completed', { input_tokens: 1, output_tokens: 1 });
    expect(f.results).toHaveLength(256);
    await f.response('next', 'response.completed', { input_tokens: 2, output_tokens: 2 });
    expect(f.results).toHaveLength(257);
    const first=f.results[0]!;
    await f.response('finished-0', 'response.completed', { input_tokens: 1, output_tokens: 1 });
    expect(f.results.at(-1)!.attemptId).toBe(first.attemptId);
    expect(f.results.at(-1)!.requestId).toBe(first.requestId);
    await f.close(); expect(f.results).toHaveLength(259);
    expect(f.results.at(-1)).toMatchObject({ complete:false,observationIncomplete:true });
    expect(f.provider.activeAttempts).toBe(0); await f.provider.onDestroy();
  });
});

test('helper checks the delivery lease after await and never retains request input', async () => {
  let active = true; const emitted: AttemptObservationEvent[] = []; const discarded: string[] = [];
  const helper = new ResponsesWebSocketMetering({ hasDemand: () => true, prepareRequest() {}, discardRequest: requestId => { discarded.push(requestId); }, emit: async event => { emitted.push(event); if (event.phase === 'request') active = false; } });
  const base = { connectionId: 'lease', routeId: 'route', upstreamId: 'upstream', upstreamUrl: 'https://api.openai.com/v1/responses', isActive: () => active };
  await helper.observe({ ...base, phase: 'open' });
  await helper.observe({ ...base, phase: 'message', direction: 'client', message: { kind: 'text', byteLength: 1, json: () => ({ type: 'response.create', model: 'gpt-4o', input: 'do not keep this input' }) } });
  expect(emitted.map(event => event.phase)).toEqual(['selected', 'request']);
  const request = emitted.find(event => event.phase === 'request');
  expect(request?.phase === 'request' && request.body).toEqual({ model: 'gpt-4o', stream: true });
  expect(discarded).toHaveLength(1); helper.dispose();
});
