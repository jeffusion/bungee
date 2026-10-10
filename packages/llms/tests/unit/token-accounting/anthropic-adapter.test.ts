import { describe, expect, test } from 'bun:test';
import * as llmsPluginApi from '@jeffusion/bungee-llms/plugin-api';

type TokenAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
type TokenAccountingOutcome = 'completed' | 'aborted' | 'failed';

type CanonicalAnthropicAccountingEvent = {
  requestId: string;
  attemptId: string;
  routeId: string;
  upstreamId: string;
  provider: 'anthropic';
  model: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAuthority: TokenAuthority;
  outputAuthority: TokenAuthority;
  final: boolean;
  outcome: TokenAccountingOutcome;
  countedAt: string;
};

type TokenAccountingSession = {
  consumeRequest(input: { body: Record<string, unknown> }): void;
  consumeResponse(input: { body: Record<string, unknown> }): CanonicalAnthropicAccountingEvent;
  consumeStreamChunk(input: { chunk: Record<string, unknown> }): CanonicalAnthropicAccountingEvent | null;
  finalizeCompletedStream(): CanonicalAnthropicAccountingEvent;
  finalizeAbortedStream(): CanonicalAnthropicAccountingEvent;
};

type CreateTokenAccountingSession = (input: {
  provider: 'anthropic';
  routeId: string;
  upstreamId: string;
  requestId: string;
  attemptId: string;
  streaming: boolean;
}, options?: { deferFinalization?: boolean }) => TokenAccountingSession;

type ProviderTokenAccountingCapabilities = {
  provider: 'anthropic';
  supportsOfficialResponseUsage: true;
  supportsStreamingResponseUsage: true;
  supportsDedicatedCountEndpoint: true;
  supportsLocalTokenizer: true;
  supportsHeuristicFallback: true;
  dedicatedCountEndpoint: {
    supported: true;
    mode: 'input_estimate_only';
    livePathAuthority: false;
    endpoint: '/v1/messages/count_tokens';
  };
};

type GetProviderTokenAccountingCapabilities = (
  provider: 'anthropic'
) => ProviderTokenAccountingCapabilities;

function getCreateTokenAccountingSession(): CreateTokenAccountingSession {
  if (!Reflect.has(llmsPluginApi, 'createTokenAccountingSession')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export createTokenAccountingSession() for Anthropic token accounting sessions.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'createTokenAccountingSession'
  ) as CreateTokenAccountingSession;
}

function getProviderTokenAccountingCapabilities(): GetProviderTokenAccountingCapabilities {
  if (!Reflect.has(llmsPluginApi, 'getProviderTokenAccountingCapabilities')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export getProviderTokenAccountingCapabilities() for Anthropic token accounting capability lookup.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'getProviderTokenAccountingCapabilities'
  ) as GetProviderTokenAccountingCapabilities;
}

function createAnthropicSession(streaming: boolean, deferFinalization = false): TokenAccountingSession {
  const input = {
    provider: 'anthropic',
    routeId: 'anthropic-route',
    upstreamId: 'anthropic-primary',
    requestId: streaming ? 'req_anthropic_stream_1' : 'req_anthropic_sync_1',
    attemptId: 'attempt_anthropic_1',
    streaming
  } as const;
  const create = getCreateTokenAccountingSession();
  return deferFinalization ? create(input, { deferFinalization: true }) : create(input);
}

function createAnthropicRequestBody(): Record<string, unknown> {
  return {
    model: 'claude-3-7-sonnet-20250219',
    system: 'You are concise.',
    messages: [
      {
        role: 'user',
        content: 'Summarize the weather in one sentence and call the weather tool if needed.'
      }
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Look up the weather for a city.',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        }
      }
    ],
    stream: true
  };
}

function createMessageStartChunk(): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg_cache_start',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-7-sonnet-20250219',
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5
      }
    }
  };
}

function expectCanonicalEventShape(
  event: CanonicalAnthropicAccountingEvent | null,
  expected: Omit<CanonicalAnthropicAccountingEvent, 'countedAt'>
): void {
  expect(event).toEqual({
    ...expected,
    countedAt: expect.any(String)
  });
}

describe('Anthropic token accounting facade contract', () => {
  test('exposes Anthropic capabilities through the shared plugin-api facade', () => {
    const getCapabilities = getProviderTokenAccountingCapabilities();

    expect(getCapabilities('anthropic')).toEqual({
      provider: 'anthropic',
      supportsOfficialResponseUsage: true,
      supportsStreamingResponseUsage: true,
      supportsDedicatedCountEndpoint: true,
      supportsLocalTokenizer: true,
      supportsHeuristicFallback: true,
      dedicatedCountEndpoint: {
        supported: true,
        mode: 'input_estimate_only',
        livePathAuthority: false,
        endpoint: '/v1/messages/count_tokens'
      }
    });
  });

  test('maps message_start into the task-1 canonical event fields and preserves cache read/write tokens separately', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: createAnthropicRequestBody() });

    const snapshot = session.consumeStreamChunk({
      chunk: createMessageStartChunk()
    });

    expectCanonicalEventShape(snapshot, {
      requestId: 'req_anthropic_stream_1',
      attemptId: 'attempt_anthropic_1',
      routeId: 'anthropic-route',
      upstreamId: 'anthropic-primary',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-20250219',
      streaming: true,
      inputTokens: 24,
      outputTokens: 0,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: false,
      outcome: 'completed'
    });
  });

  test('treats message_delta usage as cumulative and reaches a final canonical event only at message_stop', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: createAnthropicRequestBody() });

    session.consumeStreamChunk({ chunk: createMessageStartChunk() });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_weather_1',
          name: 'get_weather'
        }
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"location":"'
        }
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: 'NYC"}'
        }
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_stop',
        index: 0
      }
    });

    const firstDelta = session.consumeStreamChunk({
      chunk: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 4 }
      }
    });
    const secondDelta = session.consumeStreamChunk({
      chunk: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 9 }
      }
    });
    const finalEvent = session.consumeStreamChunk({
      chunk: {
        type: 'message_stop'
      }
    });

    expectCanonicalEventShape(firstDelta, {
      requestId: 'req_anthropic_stream_1',
      attemptId: 'attempt_anthropic_1',
      routeId: 'anthropic-route',
      upstreamId: 'anthropic-primary',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-20250219',
      streaming: true,
      inputTokens: 24,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: false,
      outcome: 'completed'
    });
    expectCanonicalEventShape(secondDelta, {
      requestId: 'req_anthropic_stream_1',
      attemptId: 'attempt_anthropic_1',
      routeId: 'anthropic-route',
      upstreamId: 'anthropic-primary',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-20250219',
      streaming: true,
      inputTokens: 24,
      outputTokens: 9,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: false,
      outcome: 'completed'
    });
    expect(secondDelta?.outputTokens).toBe(9);
    expect(secondDelta?.outputTokens).not.toBe(13);
    expectCanonicalEventShape(finalEvent, {
      requestId: 'req_anthropic_stream_1',
      attemptId: 'attempt_anthropic_1',
      routeId: 'anthropic-route',
      upstreamId: 'anthropic-primary',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-20250219',
      streaming: true,
      inputTokens: 24,
      outputTokens: 9,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: true,
      outcome: 'completed'
    });
  });

  test('finalizes aborted streams with final=false and preserves official output usage and cache details', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    session.consumeStreamChunk({ chunk: createMessageStartChunk() });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: ''
        }
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'partial answer'
        }
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'content_block_stop',
        index: 0
      }
    });
    session.consumeStreamChunk({
      chunk: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 }
      }
    });

    const abortedEvent = session.finalizeAbortedStream();

    expectCanonicalEventShape(abortedEvent, {
      requestId: 'req_anthropic_stream_1',
      attemptId: 'attempt_anthropic_1',
      routeId: 'anthropic-route',
      upstreamId: 'anthropic-primary',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-20250219',
      streaming: true,
      inputTokens: 24,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: false,
      outcome: 'aborted'
    });
    expect(abortedEvent.outputAuthority).toBe('official');
  });

  test('does not saturate an overflowing Anthropic input/cache sum into official usage', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    const snapshot = session.consumeStreamChunk({ chunk: {
      type: 'message_start',
      message: { model: 'claude-3-7-sonnet-20250219', usage: {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 0,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 0
      } }
    } });
    expect(snapshot?.inputAuthority).not.toBe('official');
    expect(snapshot?.inputTokens).not.toBe(Number.MAX_SAFE_INTEGER);
    const aborted = session.finalizeAbortedStream();
    expect(aborted.inputAuthority).not.toBe('official');
    expect(aborted.inputTokens).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  test('keeps missing Anthropic stream usage non-official after EOF without message_stop', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    session.consumeStreamChunk({ chunk: createMessageStartChunk() });
    const event = session.finalizeCompletedStream();
    expect(event.final).toBe(false);
    expect(event.outcome).toBe('failed');
    expect(event.inputAuthority).toBe('official');
    expect(event.outputAuthority).toBe('official');
  });

  test('does not label estimated usage official when the response omits usage', () => {
    const session = createAnthropicSession(false);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    const event = session.consumeResponse({ body: { content: [{ type: 'text', text: 'hello' }] } });
    expect(event.inputAuthority).not.toBe('official');
    expect(event.outputAuthority).not.toBe('official');
  });

  test('defers request tokenization until EOF when stream input usage is absent', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: { ...createAnthropicRequestBody(), system: 'large prompt '.repeat(5000) } });
    const delta = session.consumeStreamChunk({ chunk: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } } });
    expect(delta?.inputTokens).toBeUndefined();
    const eof = session.finalizeCompletedStream();
    expect(eof.inputTokens).toBeGreaterThan(0);
    expect(eof.inputAuthority).toBe('local');
    expect(eof.outputTokens).toBeGreaterThan(0);
    expect(eof.outputAuthority).toBe('local');
  });

  test('does not estimate missing input when official zero usage arrives', () => {
    const session = createAnthropicSession(true);
    session.consumeRequest({ body: { ...createAnthropicRequestBody(), system: 'large prompt '.repeat(5000) } });
    session.consumeStreamChunk({ chunk: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } });
    const eof = session.finalizeCompletedStream();
    expect(eof.inputTokens).toBe(0);
    expect(eof.inputAuthority).toBe('official');
    expect(eof.outputTokens).toBe(0);
    expect(eof.outputAuthority).toBe('official');
  });

  test('keeps an Anthropic error JSON body unknown instead of estimating its text', () => {
    const session = createAnthropicSession(false);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    const event = session.consumeResponse({ body: { type: 'error', error: { message: 'provider error text' } } });
    expect(event.outputTokens).toBeUndefined();
    expect(event.outputAuthority).toBe('none');

    const emptySuccess = createAnthropicSession(false);
    emptySuccess.consumeRequest({ body: createAnthropicRequestBody() });
    const empty = emptySuccess.consumeResponse({ body: { content: [] } });
    expect(empty.outputTokens).toBeUndefined();
    expect(empty.outputAuthority).toBe('none');
  });

  test('deferred JSON waits for explicit finalization, preserving official zero and estimating only the missing side', () => {
    const session = createAnthropicSession(false, true);
    session.consumeRequest({ body: createAnthropicRequestBody() });
    const observed = session.consumeResponse({ body: {
      content: [{ type: 'text', text: 'generated answer' }],
      usage: { input_tokens: 0 }
    } });
    expect(observed).toEqual(expect.objectContaining({ final: false, inputTokens: 0, inputAuthority: 'official' }));
    expect(observed.outputTokens).toBeUndefined();
    const finalized = session.finalizeCompletedStream();
    expect(finalized).toEqual(expect.objectContaining({ final: true, inputTokens: 0, inputAuthority: 'official', outputAuthority: 'heuristic' }));
  });

  test('deferred Anthropic terminal continues accepting late usage; explicit abort stays aborted', () => {
    const session = createAnthropicSession(true, true);
    session.consumeRequest({ body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'prompt' }], stream: true } });
    const stop = session.consumeStreamChunk({ chunk: { type: 'message_stop' } });
    if (!stop) throw new Error('Expected message_stop observation.');
    expect(stop.final).toBe(false);
    expect(stop.inputTokens).toBeUndefined();
    const lateUsage = session.consumeStreamChunk({ chunk: {
      type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    } });
    if (!lateUsage) throw new Error('Expected late usage observation.');
    expect(lateUsage).toEqual(expect.objectContaining({ final: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, inputAuthority: 'official', outputAuthority: 'official' }));
    expect(session.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: true, inputTokens: 0, outputTokens: 0 }));

    const failed = createAnthropicSession(true, true);
    const error = failed.consumeStreamChunk({ chunk: { type: 'error', error: { message: 'upstream failed' } } });
    if (!error) throw new Error('Expected error observation.');
    expect(error.final).toBe(false);
    expect(error.inputTokens).toBeUndefined();
    expect(error.outputTokens).toBeUndefined();
    expect(failed.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: false, outcome: 'failed' }));

    const aborted = createAnthropicSession(true, true);
    aborted.consumeRequest({ body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'prompt' }], stream: true } });
    expect(aborted.finalizeAbortedStream()).toEqual(expect.objectContaining({ final: false, outcome: 'aborted' }));
  });
});
