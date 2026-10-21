import { expect, test } from 'bun:test';
import { PluginServiceHost } from '../../../../packages/core/src/plugin-services';
import { createPluginHooks, type AttemptObservationEvent } from '../../../../packages/core/src/hooks';
import type { WebSocketObservationEvent } from '../../../../packages/core/src/gateway/websocket-contracts';
import TokenMeteringPlugin from '../../../token-metering/server';
import LlmTpsPlugin from '../../server';
import { createStorage } from '../helpers/context';

test('HTTP and WebSocket generation reach TPS storage without requiring complete accounting usage', async () => {
  const store = createStorage();
  const host = new PluginServiceHost();
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const provider = new TokenMeteringPlugin();
  const tps = new LlmTpsPlugin();
  try {
    await provider.init({ config: {}, storage: store.storage, logger, services: host.createContext('token-metering') });
    host.markReady('token-metering');
    await tps.init({ config: {}, storage: store.storage, logger, scope: { type: 'route', routeId: 'route-a' },
      services: host.createContext('llm-tps', 'route:route-a', { 'token-metering': '^1.0.0' }) });
    host.markReady('llm-tps', 'route:route-a');
    const hooks = createPluginHooks();
    provider.register(hooks);
    const identity = { requestId: 'http-request', attemptId: 'http-attempt', routeId: 'route-a', upstreamId: 'http-endpoint', isActive: () => true };
    const http = (phase: Record<string, unknown>) => hooks.onAttemptObservation.promise({ ...identity, ...phase } as AttemptObservationEvent);
    await http({ phase: 'selected' });
    await http({ phase: 'request', url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'answer' }] } });
    await http({ phase: 'response', status: 200, protocol: 'sse', observedAtMonotonicMs: 100, body: { choices: [{ index: 0, delta: { content: 'answer' } }] } });
    await http({ phase: 'response', status: 200, protocol: 'sse', observedAtMonotonicMs: 600,
      body: { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 100 } } });
    await http({ phase: 'end', sent: true, outcome: 'completed', observedAtMonotonicMs: 700 });
    await http({ phase: 'request-end' });

    const connection = { connectionId: 'ws', routeId: 'route-a', upstreamId: 'ws-endpoint',
      upstreamUrl: 'https://api.openai.com/v1/responses', isActive: () => true };
    const ws = (phase: Record<string, unknown>) => hooks.onWebSocketObservation.promise({ ...connection, ...phase } as WebSocketObservationEvent);
    const message = (direction: 'client' | 'upstream', body: unknown, at: number) => ws({ phase: 'message', direction,
      observedAtMonotonicMs: at, message: { kind: 'text', byteLength: 1, json: () => body } });
    await ws({ phase: 'open' });
    for (const [id, usage] of [['official', { output_tokens: 10 }], ['estimated', undefined]] as const) {
      await message('client', { type: 'response.create', model: 'gpt-4o', input: 'question' }, 10);
      await message('upstream', { type: 'response.created', response: { id, object: 'response', output: [] } }, 20);
      await message('upstream', { type: 'response.output_text.delta', response_id: id, delta: 'generated answer' }, 100);
      await message('upstream', { type: 'response.completed', response: { id, object: 'response', status: 'completed', error: null, usage,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'generated answer' }] }] } }, 600);
    }
    await provider.onDestroy();
    await tps.onDestroy();
    const stats = await store.adapter.queryStats({ range: '1h', asOfMs: Date.now() });
    expect(stats.total.sampleCount).toBe(3);
    expect(stats.total.estimatedSampleCount).toBe(1);
    expect(stats.total.generationDurationMs).toBe(1500);
    expect(stats.total.outputTokens).toBeGreaterThan(110);
    expect(stats.endpoints.find(endpoint => endpoint.endpointId === 'http-endpoint')).toMatchObject({ sampleCount: 1, tps: 200 });
    expect(await store.storage.get('reporting:incomplete')).toBeNull();
  } finally {
    await provider.onDestroy(); await tps.onDestroy(); store.close();
  }
});
