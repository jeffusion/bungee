import { describe, expect, test } from 'bun:test';
import TokenMeteringPlugin from '../server';
import { createPluginHooks, type AttemptObservationEvent } from '../../../packages/core/src/hooks';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { PluginServiceHost, type TokenMeteringService, type TokenMeteringResult, type PluginServices, TOKEN_METERING_SERVICE_ID } from '../../../packages/core/src/plugin-services';

async function fixture() {
  const host = new PluginServiceHost(); const provider = new TokenMeteringPlugin();
  await provider.init({ config: {}, storage: {} as PluginStorage, logger: { debug() {}, info() {}, warn() {}, error() {} }, services: host.createContext('token-metering') });
  host.markReady('token-metering');
  const hooks = createPluginHooks(); provider.register(hooks);
  const contexts = new Map<string, PluginServices>();
  const consumer = (name: string) => {
    const services = host.createContext(name, 'global', { 'token-metering': '^1.0.0' }); contexts.set(name, services); host.markReady(name);
    return services.consume<TokenMeteringService>('token-metering', TOKEN_METERING_SERVICE_ID, 1);
  };
  const send = (phase: Record<string, unknown>, id = 'request') => hooks.onAttemptObservation.promise({ requestId: id, attemptId: `${id}:attempt`, routeId: 'route', upstreamId: 'upstream', isActive: () => true, ...phase } as AttemptObservationEvent);
  const start = async (id = 'request') => {
    await send({ phase: 'selected' }, id);
    await send({ phase: 'request', url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hello' }] } }, id);
  };
  return { host, provider, consumer, contexts, send, start };
}

describe('shared token metering provider', () => {
  test('incomplete ordinary API observations reach required settlement but stay out of optional statistics', async () => {
    const f=await fixture();const stats:TokenMeteringResult[]=[];const required:TokenMeteringResult[]=[];
    f.consumer('stats').subscribe({onResult:result=>{stats.push(result);}});
    f.consumer('budget').subscribe({required:true,onResult:result=>{required.push(result);}});
    await f.send({phase:'selected'});
    await f.send({phase:'request',url:'https://app.example/ordinary',body:{input:'search'}});
    await f.send({phase:'incomplete',direction:'response',reason:'decode-error'});
    await f.send({phase:'end',sent:true,outcome:'completed'});
    expect(stats).toHaveLength(0);expect(required).toHaveLength(1);expect(required[0]).toMatchObject({provider:'unknown',observationIncomplete:true});
    await f.provider.onDestroy();
  });
  test('request observation failure still permits official response usage', async () => {
    const f=await fixture();const results:TokenMeteringResult[]=[];
    f.consumer('stats').subscribe({onResult:result=>{results.push(result);}});
    await f.send({phase:'selected'});
    await f.send({phase:'incomplete',direction:'request',reason:'buffer-limit'});
    await f.send({phase:'response',status:200,protocol:'json',body:{model:'gpt-4o-mini',choices:[{message:{role:'assistant',content:'answer'}}],usage:{prompt_tokens:11,completion_tokens:3}}});
    await f.send({phase:'end',sent:true,outcome:'completed'});
    expect(results[0]).toMatchObject({inputTokens:11,outputTokens:3,inputSource:'official',outputSource:'official',observationIncomplete:true});
    await f.provider.onDestroy();
  });
  test('trusted keyId propagates while absent identity stays null; prepared pricingProvider follows final URL', async () => {
    const f = await fixture(); const results: TokenMeteringResult[] = [];
    const service = f.consumer('stats'); service.subscribe({onResult: result => {results.push(result);}});
    await f.send({phase:'selected',keyId:'trusted-key'});
    const support = service.prepareAttempt({requestId:'request',attemptId:'request:attempt',routeId:'route',upstreamId:'upstream',url:'https://api.x.ai/v1/chat/completions',body:{model:'grok',messages:[{role:'user',content:'hi'}]}});
    expect(support).toMatchObject({supported:true,provider:'openai',model:'grok',pricingProvider:'https://api.x.ai/v1/chat/completions'});
    await f.send({phase:'request',keyId:'trusted-key',url:'https://api.x.ai/v1/chat/completions',body:{model:'grok',messages:[{role:'user',content:'hi'}]}});
    await f.send({phase:'response',status:200,protocol:'json',body:{usage:{prompt_tokens:1,completion_tokens:2}}});
    await f.send({phase:'end',outcome:'completed',sent:true});
    expect(results[0]).toMatchObject({keyId:'trusted-key',pricingProvider:'https://api.x.ai/v1/chat/completions'});
    await f.start('anonymous'); await f.send({phase:'end',outcome:'completed',sent:true},'anonymous');
    expect(results[1]?.keyId).toBeNull();
    await f.provider.onDestroy();
  });

  test('without consumers does not parse request/response or allocate attempt state', async () => {
    const f = await fixture(); await f.start();
    await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 3, completion_tokens: 2 } } });
    expect(f.provider.parsedResponses).toBe(0); expect(f.provider.activeAttempts).toBe(0);
    await f.provider.onDestroy();
  });
  test('two consumers share one parse and preserve official zero and separate sources', async () => {
    const f = await fixture(); const left: TokenMeteringResult[] = []; const right: TokenMeteringResult[] = [];
    f.consumer('stats').subscribe({ onResult: result => { left.push(result); } });
    f.consumer('budget').subscribe({ required: true, requestId: 'request', onResult: result => { right.push(result); } });
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { choices: [{ message: { role: 'assistant', content: 'estimate this answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    expect(f.provider.parsedResponses).toBe(1); expect(left).toHaveLength(1); expect(right).toHaveLength(1);
    expect(left[0]).toMatchObject({ inputTokens: 0, inputSource: 'official', outputSource: 'estimated', settlementVersion: 1 });
    expect(right[0]).toEqual(left[0]); expect(Object.isFrozen(left[0])).toBe(true);
    await f.provider.onDestroy();
  });
  test('slow and failing consumers do not delay another consumer; failure is returned to its owner', async () => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let healthy = 0, failures = 0;
    f.consumer('slow').subscribe({ onResult: () => gate });
    f.consumer('broken').subscribe({ required: true, onResult: () => { throw new Error('consumer failure'); }, onFailure: () => { failures++; } });
    f.consumer('healthy').subscribe({ onResult: () => { healthy++; } });
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    expect(healthy).toBe(1); expect(failures).toBe(1);
    let drained = false; const destroy = f.provider.onDestroy().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); release(); await destroy;
  });
  test('stop preserves old subscription through result settlement and request-end before cleanup/revocation', async () => {
    const f = await fixture(); const service = f.consumer('budget');
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    let delivered = 0, cleaned = false, stopped = false;
    const unsubscribe = service.subscribe({ required: true, requestId: 'request', onResult: async () => { delivered++; await gate; } });
    f.contexts.get('budget')!.onDispose(() => { cleaned = true; unsubscribe(); });
    const release = f.host.acquireLease('budget');
    await f.start(); const stop = f.host.dispose('budget').then(() => { stopped = true; });
    expect(() => f.host.acquireLease('budget')).toThrow('not ready'); expect(cleaned).toBe(false);
    await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    let ended = false; const requestEnd = f.send({ phase: 'request-end' }).then(() => { ended = true; });
    await Promise.resolve(); expect(delivered).toBe(1); expect(ended).toBe(false); expect(stopped).toBe(false); expect(cleaned).toBe(false);
    finish(); await requestEnd; expect(ended).toBe(true); expect(cleaned).toBe(false);
    release(); await stop; expect(cleaned).toBe(true); expect(stopped).toBe(true);
    expect(() => service.prepareRequest('late')).toThrow('revoked'); await f.provider.onDestroy();
  });
  test('request drain waits only its required callbacks, independently of stats and other requests', async () => {
    const f = await fixture(); const budget = f.consumer('budget');
    let finishBudget!: () => void, finishStats!: () => void;
    const budgetGate = new Promise<void>(resolve => { finishBudget = resolve; });
    const statsGate = new Promise<void>(resolve => { finishStats = resolve; });
    let otherResults = 0;
    budget.subscribe({ required: true, onResult: result => result.requestId === 'request' ? budgetGate : void otherResults++ });
    f.consumer('stats').subscribe({ onResult: () => statsGate });
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    let drained = false; const drain = budget.drainRequest('request').then(() => { drained = true; });
    await f.start('other'); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } }, 'other');
    await f.send({ phase: 'end', outcome: 'completed', sent: true }, 'other');
    await f.send({ phase: 'request-end' }, 'other');
    expect(otherResults).toBe(1); expect(drained).toBe(false);
    finishBudget(); await drain; expect(drained).toBe(true);
    // The reporting callback remains pending, yet required request completion has finished.
    finishStats(); await f.provider.onDestroy();
  });
  test('request-end includes asynchronous required failure/recovery notification', async () => {
    const f = await fixture(); let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => { finishRecovery = resolve; }); let recovered = false;
    f.consumer('budget').subscribe({ required: true, onResult: () => { throw new Error('settlement failed'); }, onFailure: async () => { await recoveryGate; recovered = true; } });
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    let ended = false; const requestEnd = f.send({ phase: 'request-end' }).then(() => { ended = true; });
    await Promise.resolve(); expect(ended).toBe(false); expect(recovered).toBe(false);
    finishRecovery(); await requestEnd; expect(recovered).toBe(true); await f.provider.onDestroy();
  });
  test('request-specific preview cancellation and two failover attempts keep fresh required subscriptions', async () => {
    const f = await fixture(); const budget = f.consumer('budget'); const settled: string[] = []; let previewCalls = 0;
    const cancelPreview = budget.subscribe({ required: true, requestId: 'request', onResult: () => { previewCalls++; } });
    budget.prepareRequest('request'); cancelPreview();
    for (const attemptId of ['first', 'retry']) {
      const unsubscribe = budget.subscribe({ required: true, requestId: 'request', onResult: result => { if (result.attemptId === attemptId) settled.push(attemptId); } });
      expect(budget.prepareRequest('request')).toBe(true);
      const send = (phase: Record<string, unknown>) => f.send({ attemptId, ...phase });
      await send({ phase: 'selected' });
      await send({ phase: 'request', url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] } });
      await send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
      await send({ phase: 'end', outcome: 'completed', sent: true }); await budget.drainRequest('request'); unsubscribe();
    }
    await f.send({ phase: 'request-end' });
    expect(settled).toEqual(['first', 'retry']); expect(previewCalls).toBe(0); expect(f.provider.parsedResponses).toBe(2);
    await f.provider.onDestroy();
  });
  test('required demand receives unknown without guessing zero, and unsupported preparation is explicit', async () => {
    const f = await fixture(); const results: TokenMeteringResult[] = [];
    const service = f.consumer('budget');
    service.subscribe({ required: true, requestId: 'unknown', onResult: result => { results.push(result); } });
    expect(service.prepareAttempt({ requestId: 'unknown', attemptId: 'unknown:attempt', routeId: 'route', upstreamId: 'upstream', url: 'https://app.example/messages', body: { message: 'ordinary business request' } })).toMatchObject({ supported: false });
    await f.send({ phase: 'request', url: 'https://app.example/messages', body: { message: 'business request' } }, 'unknown');
    await f.send({ phase: 'end', outcome: 'failed', sent: true }, 'unknown');
    expect(results[0]).toMatchObject({ inputSource: 'none', outputSource: 'none', complete: false });
    expect(results[0]!.inputTokens).toBeUndefined(); await f.provider.onDestroy();
  });
  test('prepared attempt reuses session and consumer retirement preserves admitted demand', async () => {
    const f = await fixture(); const results: TokenMeteringResult[] = [];
    const service = f.consumer('budget');
    const unsubscribe = service.subscribe({ required: true, onResult: result => { results.push(result); } });
    expect(service.prepareAttempt({ requestId: 'request', attemptId: 'request:attempt', routeId: 'route', upstreamId: 'upstream', url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] } })).toMatchObject({ supported: true, provider: 'openai' });
    unsubscribe();
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    expect(results).toHaveLength(1); expect(f.provider.parsedResponses).toBe(1);
    await f.start('new-request'); expect(f.provider.activeAttempts).toBe(0); await f.provider.onDestroy();
  });
  test('complete official usage overrides lost observation for settlement completeness', async () => {
    const f = await fixture(); const results: TokenMeteringResult[] = [];
    f.consumer('budget').subscribe({ required: true, onResult: result => { results.push(result); } });
    await f.start(); await f.send({ phase: 'incomplete', reason: 'frame-truncated' });
    await f.send({ phase: 'response', status: 200, protocol: 'json', body: { usage: { prompt_tokens: 0, completion_tokens: 0 } } });
    await f.send({ phase: 'end', outcome: 'completed', sent: true });
    expect(results[0]).toMatchObject({ complete: true, observationIncomplete: true, outcome: 'completed', inputSource: 'official', outputSource: 'official' });
    await f.provider.onDestroy();
  });
  test('normal cancellation preserves observed partial output for required consumers', async () => {
    const f = await fixture(); const results: TokenMeteringResult[] = [];
    f.consumer('budget').subscribe({ required: true, onResult: result => { results.push(result); } });
    await f.start(); await f.send({ phase: 'response', status: 200, protocol: 'sse', body: { choices: [{ delta: { content: 'observed partial text' }, finish_reason: null }] } });
    await f.send({ phase: 'end', outcome: 'cancelled', sent: true });
    expect(results[0]).toMatchObject({ outcome: 'aborted', outputSource: 'partial', complete: false });
    expect(results[0]!.outputTokens).toBeGreaterThan(0); await f.provider.onDestroy();
  });
});
