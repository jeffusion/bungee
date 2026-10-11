import { describe, expect, test } from 'bun:test';
import { getEncoding } from 'js-tiktoken';
import * as llmsPluginApi from '@jeffusion/bungee-llms/plugin-api';

type TokenAccountingAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
type TokenAccountingOutcome = 'completed' | 'aborted' | 'failed';

type CanonicalTokenAccountingEventV2 = {
  requestId: string;
  attemptId: string;
  routeId: string;
  upstreamId: string;
  provider: 'openai';
  model: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAuthority: TokenAccountingAuthority;
  outputAuthority: TokenAccountingAuthority;
  final: boolean;
  outcome: TokenAccountingOutcome;
  countedAt: string;
};

type AssertCanonicalTokenAccountingEventV2 = (
  event: unknown
) => asserts event is CanonicalTokenAccountingEventV2;

type TokenAccountingSession = {
  consumeRequest(input: { body: Record<string, unknown> }): void;
  consumeResponse(input: { body: Record<string, unknown> }): CanonicalTokenAccountingEventV2;
  consumeStreamChunk(input: { chunk: Record<string, unknown> }): CanonicalTokenAccountingEventV2 | null;
  finalizeCompletedStream(): CanonicalTokenAccountingEventV2;
  finalizeAbortedStream(): CanonicalTokenAccountingEventV2;
};

type CreateTokenAccountingSession = (input: {
  provider: 'openai';
  model: string;
  routeId: string;
  upstreamId: string;
  requestId: string;
  attemptId: string;
  streaming: boolean;
}, options?: { deferFinalization?: boolean }) => TokenAccountingSession;

type ProviderTokenAccountingCapabilities = {
  provider: 'openai';
  supportsOfficialResponseUsage: boolean;
  supportsStreamingResponseUsage: boolean;
  supportsDedicatedCountEndpoint: boolean;
  supportsLocalTokenizer: boolean;
  supportsHeuristicFallback: boolean;
  dedicatedCountEndpoint: {
    supported: boolean;
    mode: 'input_estimate_only';
    defaultEnabled: false;
    endpoint: '/responses/input_tokens';
    livePathAuthority: false;
  };
};

type GetProviderTokenAccountingCapabilities = (
  provider: 'openai'
) => ProviderTokenAccountingCapabilities;

function getAssertCanonicalTokenAccountingEventV2(): AssertCanonicalTokenAccountingEventV2 {
  if (!Reflect.has(llmsPluginApi, 'assertCanonicalTokenAccountingEventV2')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export assertCanonicalTokenAccountingEventV2() for canonical v2 OpenAI accounting assertions.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'assertCanonicalTokenAccountingEventV2'
  ) as AssertCanonicalTokenAccountingEventV2;
}

function getCreateTokenAccountingSession(): CreateTokenAccountingSession {
  if (!Reflect.has(llmsPluginApi, 'createTokenAccountingSession')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export createTokenAccountingSession() for shared OpenAI token accounting sessions.'
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
      'Stable facade @jeffusion/bungee-llms/plugin-api must export getProviderTokenAccountingCapabilities() for OpenAI capability lookup.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'getProviderTokenAccountingCapabilities'
  ) as GetProviderTokenAccountingCapabilities;
}

function createOpenAISession(streaming: boolean, deferFinalization = false): TokenAccountingSession {
  const input = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    routeId: 'openai-route',
    upstreamId: 'openai-primary',
    requestId: streaming ? 'req_openai_stream_1' : 'req_openai_sync_1',
    attemptId: streaming ? 'attempt_openai_stream_1' : 'attempt_openai_sync_1',
    streaming
  } as const;
  const create = getCreateTokenAccountingSession();
  return deferFinalization ? create(input, { deferFinalization: true }) : create(input);
}

function expectCanonicalEvent(event: unknown): CanonicalTokenAccountingEventV2 {
  const assertCanonicalTokenAccountingEventV2: AssertCanonicalTokenAccountingEventV2 =
    getAssertCanonicalTokenAccountingEventV2();
  const candidate: unknown = event;
  assertCanonicalTokenAccountingEventV2(candidate);
  return candidate as CanonicalTokenAccountingEventV2;
}

function createTextOnlyRequestBody(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'Summarize the attached item in one sentence.'
      }
    ]
  };
}

function createRichRequestBody(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe what is in this image before calling any tools.'
          },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wdl8AAAAASUVORK5CYII='
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup_weather',
          description: 'Look up current weather for a place.',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
              unit: { type: 'string', enum: ['c', 'f'] }
            },
            required: ['location']
          }
        }
      }
    ]
  };
}

function createOpenAIOfficialUsageResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl_official_usage',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'A concise summary.'
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 18,
      completion_tokens: 7,
      total_tokens: 25,
      prompt_tokens_details: {
        cached_tokens: 11
      }
    }
  };
}

function createOpenAIMixedAuthorityResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl_mixed_authority',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Authority can differ.'
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      completion_tokens: 6,
      total_tokens: 20,
      prompt_tokens_details: {
        cached_tokens: 5
      }
    }
  };
}

function createOpenAIToolCallResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl_tool_calls',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_lookup_weather_1',
              type: 'function',
              function: {
                name: 'lookup_weather',
                arguments: '{"location":"Paris","unit":"c"}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      },
      {
        index: 1,
        message: {
          role: 'tool',
          tool_call_id: 'call_lookup_weather_1',
          content: '{"temp":19,"condition":"clear"}'
        }
      }
    ]
  };
}

function expectLocalOrHeuristic(authority: TokenAccountingAuthority): void {
  expect(['local', 'heuristic']).toContain(authority);
}

describe('OpenAI token accounting facade contract', () => {
  test('exposes OpenAI capabilities and keeps dedicated count endpoint disabled in the default live path', () => {
    const getCapabilities = getProviderTokenAccountingCapabilities();

    expect(getCapabilities('openai')).toEqual({
      provider: 'openai',
      supportsOfficialResponseUsage: true,
      supportsStreamingResponseUsage: true,
      supportsDedicatedCountEndpoint: true,
      supportsLocalTokenizer: true,
      supportsHeuristicFallback: true,
      dedicatedCountEndpoint: {
        supported: true,
        mode: 'input_estimate_only',
        defaultEnabled: false,
        endpoint: '/responses/input_tokens',
        livePathAuthority: false
      }
    });
  });

  test('maps non-stream official usage into canonical final fields and preserves cached prompt tokens as cacheReadTokens', () => {
    const session = createOpenAISession(false);
    session.consumeRequest({ body: createTextOnlyRequestBody() });

    const event = expectCanonicalEvent(
      session.consumeResponse({ body: createOpenAIOfficialUsageResponse() })
    );

    expect(event).toEqual(
      expect.objectContaining({
        requestId: 'req_openai_sync_1',
        attemptId: 'attempt_openai_sync_1',
        routeId: 'openai-route',
        upstreamId: 'openai-primary',
        provider: 'openai',
        model: 'gpt-4o-mini',
        streaming: false,
        inputTokens: 18,
        outputTokens: 7,
        cacheReadTokens: 11,
        inputAuthority: 'official',
        outputAuthority: 'official',
        final: true,
        outcome: 'completed'
      })
    );
    expect(event.cacheWriteTokens ?? 0).toBe(0);
    expect(event.countedAt).toEqual(expect.any(String));
  });

  test('allows inputAuthority and outputAuthority to differ when only completion usage is authoritative', () => {
    const session = createOpenAISession(false);
    session.consumeRequest({ body: createTextOnlyRequestBody() });

    const event = expectCanonicalEvent(
      session.consumeResponse({ body: createOpenAIMixedAuthorityResponse() })
    );

    expect(event.requestId).toBe('req_openai_sync_1');
    expect(event.attemptId).toBe('attempt_openai_sync_1');
    expect(event.outputTokens).toBe(6);
    expect(event.cacheReadTokens).toBe(5);
    expect(['local', 'heuristic']).toContain(event.inputAuthority);
    expect(event.outputAuthority).toBe('official');
    expect(event.inputAuthority).not.toBe(event.outputAuthority);
    expect(event.final).toBe(true);
    expect(event.outcome).toBe('completed');
    expect(event.countedAt).toEqual(expect.any(String));
  });

  test('uses local fallback for multimodal input and tool-call payloads instead of text-only heuristics', () => {
    const plainSession = createOpenAISession(false);
    plainSession.consumeRequest({ body: createTextOnlyRequestBody() });
    const plainEvent = expectCanonicalEvent(
      plainSession.consumeResponse({
        body: {
          id: 'chatcmpl_plain_text',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'done'
              },
              finish_reason: 'stop'
            }
          ]
        }
      })
    );

    const richSession = createOpenAISession(false);
    richSession.consumeRequest({ body: createRichRequestBody() });
    const richEvent = expectCanonicalEvent(
      richSession.consumeResponse({ body: createOpenAIToolCallResponse() })
    );

    expectLocalOrHeuristic(plainEvent.inputAuthority);
    expectLocalOrHeuristic(plainEvent.outputAuthority);
    expectLocalOrHeuristic(richEvent.inputAuthority);
    expectLocalOrHeuristic(richEvent.outputAuthority);
    expect(richEvent.inputTokens).toBeGreaterThan(plainEvent.inputTokens ?? 0);
    expect(richEvent.outputTokens).toBeGreaterThan(plainEvent.outputTokens ?? 0);
    expect(richEvent.final).toBe(true);
    expect(richEvent.outcome).toBe('completed');
  });

  test('keeps finish_reason non-final until EOF while absorbing the later usage-only chunk', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({
      body: {
        ...createTextOnlyRequestBody(),
        stream: true,
        stream_options: {
          include_usage: true
        }
      }
    });

    const firstChunk = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          id: 'chatcmpl_stream_1',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'Hello'
              },
              finish_reason: 'stop'
            }
          ]
        }
      })
    );

    expect(firstChunk).toEqual(
      expect.objectContaining({
        requestId: 'req_openai_stream_1',
        attemptId: 'attempt_openai_stream_1',
        routeId: 'openai-route',
        upstreamId: 'openai-primary',
        provider: 'openai',
        model: 'gpt-4o-mini',
        streaming: true,
        final: false,
        outcome: 'completed'
      })
    );
    expect(firstChunk.inputTokens).toBeUndefined();
    expect(firstChunk.cacheReadTokens).toBeUndefined();
    expect(firstChunk.inputAuthority).not.toBe('official');
    expect(firstChunk.outputAuthority).not.toBe('official');

    const finalChunk = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          id: 'chatcmpl_stream_1',
          object: 'chat.completion.chunk',
          choices: [],
          usage: {
            prompt_tokens: 31,
            completion_tokens: 9,
            total_tokens: 40,
            prompt_tokens_details: {
              cached_tokens: 4
            }
          }
        }
      })
    );

    expect(finalChunk).toEqual(
      expect.objectContaining({
        requestId: 'req_openai_stream_1',
        attemptId: 'attempt_openai_stream_1',
        routeId: 'openai-route',
        upstreamId: 'openai-primary',
        provider: 'openai',
        model: 'gpt-4o-mini',
        streaming: true,
        inputTokens: 31,
        outputTokens: 9,
        cacheReadTokens: 4,
        inputAuthority: 'official',
        outputAuthority: 'official',
        final: false,
        outcome: 'completed'
      })
    );
    expect(finalChunk.cacheWriteTokens ?? 0).toBe(0);
    const settled = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(settled).toEqual(expect.objectContaining({
      inputTokens: 31,
      outputTokens: 9,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: true,
      outcome: 'completed'
    }));
    expect(finalChunk.countedAt).toEqual(expect.any(String));
  });

  test('models an aborted stream with final false and outcome aborted when the final usage-only chunk never arrives', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({
      body: {
        ...createRichRequestBody(),
        stream: true,
        stream_options: {
          include_usage: true
        }
      }
    });

    const chunkBeforeAbort = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          id: 'chatcmpl_stream_abort',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'Partial answer'
              },
              finish_reason: null
            }
          ]
        }
      })
    );

    expect(chunkBeforeAbort.final).toBe(false);
    expect(chunkBeforeAbort.outputAuthority).not.toBe('official');

    session.consumeStreamChunk({
      chunk: {
        id: 'chatcmpl_stream_abort',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: 'call_lookup_weather_2',
                  type: 'function',
                  function: {
                    name: 'lookup_weather',
                    arguments: '{"location":"Tokyo"}'
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      }
    });

    const abortedSettlement = expectCanonicalEvent(session.finalizeAbortedStream());

    expect(abortedSettlement).toEqual(
      expect.objectContaining({
        requestId: 'req_openai_stream_1',
        attemptId: 'attempt_openai_stream_1',
        routeId: 'openai-route',
        upstreamId: 'openai-primary',
        provider: 'openai',
        model: 'gpt-4o-mini',
        streaming: true,
        final: false,
        outcome: 'aborted'
      })
    );
    expect(abortedSettlement.inputTokens).toBeGreaterThan(0);
    expect(abortedSettlement.outputTokens).toBeGreaterThan(0);
    expect(['local', 'heuristic', 'partial']).toContain(abortedSettlement.inputAuthority);
    expect(['local', 'heuristic', 'partial']).toContain(abortedSettlement.outputAuthority);
    expect(abortedSettlement.outputAuthority).not.toBe('official');
    expect(abortedSettlement.countedAt).toEqual(expect.any(String));
  });

  test('accounts for Responses input and completed usage in both response modes', () => {
    const sync = createOpenAISession(false);
    sync.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'user prompt' } });
    const result = expectCanonicalEvent(sync.consumeResponse({ body: {
      id: 'resp_sync', object: 'response', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
      usage: { input_tokens: 15, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }
    } }));
    expect(result).toEqual(expect.objectContaining({ inputTokens: 15, outputTokens: 4, cacheReadTokens: 3, inputAuthority: 'official', outputAuthority: 'official', final: true }));

    const streaming = createOpenAISession(true);
    streaming.consumeRequest({ body: { model: 'gpt-4o-mini', input: [{ role: 'user', content: 'hello' }], stream: true } });
    const terminal = expectCanonicalEvent(streaming.consumeStreamChunk({ chunk: {
      type: 'response.completed',
      response: { id: 'resp_stream', status: 'completed', usage: { input_tokens: 15, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } }
    } }));
    expect(terminal).toEqual(expect.objectContaining({ inputTokens: 15, outputTokens: 4, cacheReadTokens: 3, final: true, outcome: 'completed' }));
    expect(streaming.consumeStreamChunk({ chunk: { data: '[DONE]' } })).toBeNull();
    expect(streaming.consumeStreamChunk({ chunk: { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } } })).toBeNull();
  });

  test('preserves official usage on incomplete Responses without treating it as completed', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'user prompt', stream: true } });
    const delta = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      type: 'response.output_text.delta', delta: 'partial answer'
    } }));
    expect(delta.final).toBe(false);
    expect(delta.outputTokens).toBeUndefined();
    expect(delta.outputAuthority).toBe('none');
    const incomplete = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      type: 'response.incomplete',
      response: { id: 'resp_incomplete', status: 'incomplete', usage: {
        input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 12 }
      } }
    } }));
    expect(incomplete).toEqual(expect.objectContaining({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 12,
      inputAuthority: 'official', outputAuthority: 'official', final: false, outcome: 'failed'
    }));
    expect(session.finalizeCompletedStream()).toBe(incomplete);
    expect(session.consumeStreamChunk({ chunk: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } } })).toBeNull();

    const failedSession = createOpenAISession(true);
    failedSession.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'user prompt', stream: true } });
    const failed = expectCanonicalEvent(failedSession.consumeStreamChunk({ chunk: {
      type: 'response.failed',
      response: { id: 'resp_failed', status: 'failed', usage: { input_tokens: 80, output_tokens: 0 } }
    } }));
    expect(failed).toEqual(expect.objectContaining({ inputTokens: 80, outputTokens: 0, inputAuthority: 'official', outputAuthority: 'official', final: false, outcome: 'failed' }));
  });

  test('estimates OpenAI stream output once at EOF and marks a bounded estimate partial', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'prompt' }], stream: true } });
    const progress = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'word '.repeat(14_000), finish_reason: null } }]
    } }));
    expect(progress.outputTokens).toBeUndefined();
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.outputTokens).toBeGreaterThan(0);
    expect(eof.outputAuthority).toBe('partial');
  });

  test('does not invent output tokens when an OpenAI stream has no observable output', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'prompt', stream: true } });
    session.consumeStreamChunk({ chunk: { type: 'unknown.event', malformed: true } });
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.outputTokens).toBeUndefined();
    expect(eof.outputAuthority).toBe('none');
  });

  test('uses late or same-chunk official usage after finish_reason and preserves official zero', () => {
    const late = createOpenAISession(true);
    late.consumeRequest({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'prompt' }], stream: true, stream_options: { include_usage: false } } });
    const finish = expectCanonicalEvent(late.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }]
    } }));
    expect(finish.final).toBe(false);
    expect(finish.inputTokens).toBeUndefined();
    expect(finish.outputTokens).toBeUndefined();
    late.consumeStreamChunk({ chunk: { choices: [], usage: { prompt_tokens: 17, completion_tokens: 6 } } });
    expect(late.finalizeCompletedStream()).toEqual(expect.objectContaining({ inputTokens: 17, outputTokens: 6, inputAuthority: 'official', outputAuthority: 'official', final: true }));

    const sameChunk = createOpenAISession(true);
    sameChunk.consumeRequest({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'prompt' }], stream: true } });
    const terminal = expectCanonicalEvent(sameChunk.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
    } }));
    expect(terminal.final).toBe(false);
    expect(sameChunk.finalizeCompletedStream()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0, inputAuthority: 'official', outputAuthority: 'official', final: true }));
  });

  test('does not tokenize request content during consumeRequest when official input usage arrives later', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'large request prompt '.repeat(5000) }], stream: true } });
    const progress = expectCanonicalEvent(session.consumeStreamChunk({ chunk: { choices: [{ delta: { content: 'answer' }, finish_reason: null }] } }));
    expect(progress.inputTokens).toBeUndefined();
    session.consumeStreamChunk({ chunk: { choices: [], usage: { prompt_tokens: 0, completion_tokens: 1 } } });
    expect(session.finalizeCompletedStream()).toEqual(expect.objectContaining({ inputTokens: 0, inputAuthority: 'official' }));
  });

  test('estimates both missing sides at EOF after finish_reason without claiming an early final', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'prompt' }], stream: true } });
    const finish = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }]
    } }));
    expect(finish.final).toBe(false);
    expect(finish.inputTokens).toBeUndefined();
    expect(finish.outputTokens).toBeUndefined();
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.final).toBe(true);
    expect(eof.outcome).toBe('completed');
    expect(eof.inputAuthority).toBe('local');
    expect(eof.outputAuthority).toBe('local');
    expect(eof.inputTokens).toBeGreaterThan(0);
    expect(eof.outputTokens).toBeGreaterThan(0);
  });

  test('keeps error JSON text unknown instead of counting it as generated output', () => {
    const session = createOpenAISession(false);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'prompt' } });
    const event = expectCanonicalEvent(session.consumeResponse({ body: { error: { message: 'provider failed with a long error response' } } }));
    expect(event.outputTokens).toBeUndefined();
    expect(event.outputAuthority).toBe('none');

    const emptySuccess = createOpenAISession(false);
    emptySuccess.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'prompt' } });
    const empty = expectCanonicalEvent(emptySuccess.consumeResponse({ body: { status: 'completed', choices: [] } }));
    expect(empty.outputTokens).toBeUndefined();
    expect(empty.outputAuthority).toBe('none');
  });

  test('marks a bounded request-side fallback partial rather than claiming a full count', () => {
    const session = createOpenAISession(true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'word '.repeat(16_000), stream: true } });
    const event = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.inputAuthority).toBe('partial');
  });

  test('deferred JSON accounting does no tokenization until explicit finalization and preserves official zero', () => {
    const session = createOpenAISession(false, true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request prompt' } });
    const observed = expectCanonicalEvent(session.consumeResponse({ body: {
      choices: [{ message: { content: 'generated answer' } }],
      usage: { prompt_tokens: 0 }
    } }));
    expect(observed).toEqual(expect.objectContaining({ final: false, inputTokens: 0, inputAuthority: 'official' }));
    expect(observed.outputTokens).toBeUndefined();
    const finalized = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(finalized).toEqual(expect.objectContaining({ final: true, inputTokens: 0, inputAuthority: 'official', outputAuthority: 'heuristic' }));
  });

  test('deferred SSE keeps finish_reason non-final, accepts late usage, and never falls back over official zero', () => {
    const session = createOpenAISession(true, true);
    session.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request prompt', stream: true } });
    const terminal = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'generated answer' }, finish_reason: 'stop' }]
    } }));
    expect(terminal).toEqual(expect.objectContaining({ final: false }));
    expect(terminal.inputTokens).toBeUndefined();
    expect(terminal.outputTokens).toBeUndefined();
    const lateUsage = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
    } }));
    expect(lateUsage).toEqual(expect.objectContaining({ final: false, inputTokens: 0, outputTokens: 0, inputAuthority: 'official', outputAuthority: 'official' }));
    expect(session.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: true, outcome: 'completed', inputTokens: 0, outputTokens: 0 }));

    const responses = createOpenAISession(true, true);
    responses.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request prompt', stream: true } });
    const completed = expectCanonicalEvent(responses.consumeStreamChunk({ chunk: {
      type: 'response.completed',
      response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'generated answer' }] }] }
    } }));
    expect(completed.final).toBe(false);
    expect(completed.inputTokens).toBeUndefined();
    expect(completed.outputTokens).toBeUndefined();
    responses.consumeStreamChunk({ chunk: { type: 'response.usage', response: { usage: { input_tokens: 0, output_tokens: 0 } } } });
    expect(responses.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: true, inputTokens: 0, outputTokens: 0, inputAuthority: 'official', outputAuthority: 'official' }));
  });

  test('deferred failures remain failed and oversized JSON plus SSE estimates stay partial', () => {
    const failedSession = createOpenAISession(false, true);
    failedSession.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request prompt' } });
    const failedObservation = expectCanonicalEvent(failedSession.consumeResponse({ body: {
      type: 'response.incomplete', status: 'incomplete', usage: { input_tokens: 0 }, output: [{ type: 'message', content: 'partial text' }]
    } }));
    expect(failedObservation.final).toBe(false);
    expect(failedObservation.outputTokens).toBeUndefined();
    expect(failedSession.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: false, outcome: 'failed', inputTokens: 0, inputAuthority: 'official' }));

    const unknown = createOpenAISession(false, true);
    unknown.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request prompt' } });
    const error = expectCanonicalEvent(unknown.consumeResponse({ body: { error: { message: 'not generated output' } } }));
    expect(error.inputTokens).toBeUndefined();
    expect(error.outputTokens).toBeUndefined();
    const unknownFinal = expectCanonicalEvent(unknown.finalizeCompletedStream());
    expect(unknownFinal).toEqual(expect.objectContaining({ final: false, outcome: 'failed', outputTokens: undefined, outputAuthority: 'none' }));

    const hugeJson = createOpenAISession(false, true);
    hugeJson.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request '.repeat(12_000) } });
    const jsonObserved = expectCanonicalEvent(hugeJson.consumeResponse({ body: {
      choices: [{ message: { content: 'response '.repeat(12_000) } }]
    } }));
    expect(jsonObserved.inputTokens).toBeUndefined();
    expect(jsonObserved.outputTokens).toBeUndefined();
    const jsonFinal = expectCanonicalEvent(hugeJson.finalizeCompletedStream());
    expect(jsonFinal.inputAuthority).toBe('partial');
    expect(jsonFinal.outputAuthority).toBe('partial');

    const hugeStream = createOpenAISession(true, true);
    hugeStream.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'request '.repeat(12_000), stream: true } });
    const streamObserved = expectCanonicalEvent(hugeStream.consumeStreamChunk({ chunk: {
      choices: [{ delta: { content: 'response '.repeat(12_000) }, finish_reason: 'stop' }]
    } }));
    expect(streamObserved.inputTokens).toBeUndefined();
    expect(streamObserved.outputTokens).toBeUndefined();
    const streamFinal = expectCanonicalEvent(hugeStream.finalizeCompletedStream());
    expect(streamFinal.inputAuthority).toBe('partial');
    expect(streamFinal.outputAuthority).toBe('partial');
  });

  test('uses one complete Responses terminal snapshot instead of adding it to deltas in either mode', () => {
    const output = [
      { type: 'message', content: [{ type: 'output_text', text: 'The weather is clear.' }] },
      { type: 'function_call', name: 'lookup_weather', arguments: '{"city":"Paris"}' }
    ];
    for (const deferFinalization of [false, true]) {
      const terminalOnly = createOpenAISession(true, deferFinalization);
      terminalOnly.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'weather request', stream: true } });
      const terminalOnlyObservation = expectCanonicalEvent(terminalOnly.consumeStreamChunk({ chunk: {
        type: 'response.completed', response: { status: 'completed', output }
      } }));
      const terminalOnlyFinal = deferFinalization
        ? expectCanonicalEvent(terminalOnly.finalizeCompletedStream())
        : terminalOnlyObservation;

      const withDeltas = createOpenAISession(true, deferFinalization);
      withDeltas.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'weather request', stream: true } });
      withDeltas.consumeStreamChunk({ chunk: { type: 'response.output_text.delta', delta: 'The weather ' } });
      withDeltas.consumeStreamChunk({ chunk: { type: 'response.output_text.delta', delta: 'is clear.' } });
      withDeltas.consumeStreamChunk({ chunk: { type: 'response.function_call_arguments.delta', delta: '{"city":' } });
      withDeltas.consumeStreamChunk({ chunk: { type: 'response.function_call_arguments.delta', delta: '"Paris"}' } });
      const terminalObservation = expectCanonicalEvent(withDeltas.consumeStreamChunk({ chunk: {
        type: 'response.completed', response: { status: 'completed', output }
      } }));
      const withDeltasFinal = deferFinalization
        ? expectCanonicalEvent(withDeltas.finalizeCompletedStream())
        : terminalObservation;

      expect(terminalOnlyFinal).toEqual(expect.objectContaining({
        final: true, outcome: 'completed', outputAuthority: deferFinalization ? 'heuristic' : 'local'
      }));
      expect(withDeltasFinal.outputTokens).toBe(terminalOnlyFinal.outputTokens);
      expect(withDeltasFinal.outputAuthority).toBe(terminalOnlyFinal.outputAuthority);
    }
  });

  test('keeps Responses deltas without a terminal snapshot, accepts late official zero, and estimates only the missing side', () => {
    const lateUsage = createOpenAISession(true, true);
    lateUsage.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'weather request', stream: true } });
    lateUsage.consumeStreamChunk({ chunk: { type: 'response.output_text.delta', delta: 'The weather is clear.' } });
    const terminal = expectCanonicalEvent(lateUsage.consumeStreamChunk({ chunk: {
      type: 'response.completed', response: { status: 'completed' }
    } }));
    expect(terminal.final).toBe(false);
    expect(terminal.outputTokens).toBeUndefined();
    lateUsage.consumeStreamChunk({ chunk: {
      type: 'response.usage', response: { usage: { input_tokens: 0, output_tokens: 0 } }
    } });
    expect(lateUsage.finalizeCompletedStream()).toEqual(expect.objectContaining({
      final: true, outcome: 'completed', inputTokens: 0, outputTokens: 0,
      inputAuthority: 'official', outputAuthority: 'official'
    }));

    const inputOfficial = createOpenAISession(true, true);
    inputOfficial.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'weather request', stream: true } });
    inputOfficial.consumeStreamChunk({ chunk: { type: 'response.output_text.delta', delta: 'The weather is clear.' } });
    inputOfficial.consumeStreamChunk({ chunk: { type: 'response.completed', response: {
      status: 'completed', usage: { input_tokens: 0 }
    } } });
    expect(inputOfficial.finalizeCompletedStream()).toEqual(expect.objectContaining({
      final: true, inputTokens: 0, inputAuthority: 'official', outputAuthority: 'heuristic'
    }));

    const outputOfficial = createOpenAISession(true, true);
    outputOfficial.consumeRequest({ body: { model: 'gpt-4o-mini', input: 'weather request', stream: true } });
    outputOfficial.consumeStreamChunk({ chunk: { type: 'response.output_text.delta', delta: 'discarded by official zero' } });
    outputOfficial.consumeStreamChunk({ chunk: { type: 'response.completed', response: {
      status: 'completed', usage: { output_tokens: 0 }
    } } });
    expect(outputOfficial.finalizeCompletedStream()).toEqual(expect.objectContaining({
      final: true, inputAuthority: 'heuristic', outputTokens: 0, outputAuthority: 'official'
    }));
  });

  test('deferred provider accounting never calls BPE and uses bounded character/structure estimates', () => {
    type AnyCreate = (input: {
      provider: 'openai' | 'anthropic' | 'gemini'; model: string; routeId: string;
      upstreamId: string; requestId: string; attemptId: string; streaming: boolean;
    }, options?: { deferFinalization?: boolean }) => TokenAccountingSession;
    const create = getCreateTokenAccountingSession() as unknown as AnyCreate;
    const prototype = Object.getPrototypeOf(getEncoding('cl100k_base')) as { encode: (...args: unknown[]) => unknown };
    const originalEncode = prototype.encode;
    prototype.encode = () => { throw new Error('deferred accounting must not invoke js-tiktoken encode'); };

    const makeSession = (provider: 'openai' | 'anthropic' | 'gemini', streaming: boolean, suffix: string) => create({
      provider,
      model: provider === 'anthropic' ? 'claude-3-7-sonnet-20250219' : provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini',
      routeId: `${provider}-deferred`,
      upstreamId: `${provider}-deferred-upstream`,
      requestId: `${provider}-${suffix}`,
      attemptId: `${provider}-${suffix}-attempt`,
      streaming
    }, { deferFinalization: true });

    try {
      const providers = [
        { name: 'openai' as const, request: { input: 'Unicode prompt 🧭', tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] }, response: { choices: [{ message: { content: 'Answer 世界' } }] } },
        { name: 'anthropic' as const, request: { system: 'Unicode prompt 🧭', messages: [{ role: 'user', content: 'Question 世界' }] }, response: { content: [{ type: 'text', text: 'Answer 世界' }] } },
        { name: 'gemini' as const, request: { contents: [{ parts: [{ text: 'Unicode prompt 🧭' }] }] }, response: { candidates: [{ content: { parts: [{ text: 'Answer 世界' }] } }] } }
      ];
      for (const [index, provider] of providers.entries()) {
        const json = makeSession(provider.name, false, `spy-json-${index}`);
        json.consumeRequest({ body: provider.request });
        const observed = expectCanonicalEvent(json.consumeResponse({ body: provider.response }));
        expect(observed.final).toBe(false);
        expect(observed.inputTokens).toBeUndefined();
        expect(observed.outputTokens).toBeUndefined();
        const final = expectCanonicalEvent(json.finalizeCompletedStream());
        expect(final.final).toBe(true);
        expect(final.inputAuthority).toBe('heuristic');
        expect(final.outputAuthority).toBe('heuristic');

        const stream = makeSession(provider.name, true, `spy-stream-${index}`);
        stream.consumeRequest({ body: provider.request });
        const chunk = provider.name === 'openai'
          ? { choices: [{ delta: { content: 'Answer 世界' }, finish_reason: 'stop' }] }
          : provider.name === 'anthropic'
            ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer 世界' } }
            : { candidates: [{ content: { parts: [{ text: 'Answer 世界' }] }, finishReason: 'STOP' }] };
        const streamed = expectCanonicalEvent(stream.consumeStreamChunk({ chunk }));
        expect(streamed.final).toBe(false);
        if (provider.name === 'anthropic') stream.consumeStreamChunk({ chunk: { type: 'message_stop' } });
        const streamFinal = expectCanonicalEvent(stream.finalizeCompletedStream());
        expect(streamFinal.final).toBe(true);
        expect(streamFinal.inputAuthority).toBe('heuristic');
        expect(streamFinal.outputAuthority).toBe('heuristic');

        const lateUsage = makeSession(provider.name, true, `spy-late-usage-${index}`);
        lateUsage.consumeRequest({ body: provider.request });
        const terminalChunk = provider.name === 'openai'
          ? { choices: [{ delta: { content: 'ignored by official zero' }, finish_reason: 'stop' }] }
          : provider.name === 'anthropic'
            ? { type: 'message_stop' }
            : { candidates: [{ content: { parts: [{ text: 'ignored by official zero' }] }, finishReason: 'STOP' }] };
        lateUsage.consumeStreamChunk({ chunk: terminalChunk });
        const usageChunk = provider.name === 'openai'
          ? { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }
          : provider.name === 'anthropic'
            ? { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
            : { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0 } };
        lateUsage.consumeStreamChunk({ chunk: usageChunk });
        const officialZeroFinal = expectCanonicalEvent(lateUsage.finalizeCompletedStream());
        expect(officialZeroFinal.inputTokens).toBe(0);
        expect(officialZeroFinal.outputTokens).toBe(0);
        expect(officialZeroFinal.inputAuthority).toBe('official');
        expect(officialZeroFinal.outputAuthority).toBe('official');

        const aborted = makeSession(provider.name, true, `spy-abort-${index}`);
        aborted.consumeRequest({ body: provider.request });
        expect(aborted.finalizeAbortedStream().outcome).toBe('aborted');

        const failed = makeSession(provider.name, false, `spy-error-${index}`);
        failed.consumeRequest({ body: provider.request });
        const errorBody = provider.name === 'anthropic'
          ? { type: 'error', error: { message: 'upstream failure' } }
          : { error: { message: 'upstream failure' } };
        failed.consumeResponse({ body: errorBody });
        expect(failed.finalizeCompletedStream().outcome).toBe('failed');
      }

      const anthropicMedia = makeSession('anthropic', false, 'anthropic-image');
      anthropicMedia.consumeRequest({ body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(128) } }] }] } });
      anthropicMedia.consumeResponse({ body: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(128) } }] } });
      const anthropicMediaFinal = anthropicMedia.finalizeCompletedStream();
      expect(anthropicMediaFinal.inputAuthority).toBe('none');
      expect(anthropicMediaFinal.outputAuthority).toBe('none');

      const geminiMedia = makeSession('gemini', false, 'gemini-inline-image');
      geminiMedia.consumeRequest({ body: { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'C'.repeat(128) } }] }] } });
      geminiMedia.consumeResponse({ body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'D'.repeat(128) } }] } }] } });
      const geminiMediaFinal = geminiMedia.finalizeCompletedStream();
      expect(geminiMediaFinal.inputAuthority).toBe('none');
      expect(geminiMediaFinal.outputAuthority).toBe('none');

      const repeated = makeSession('openai', false, 'repeat-4096');
      repeated.consumeRequest({ body: { input: 'x'.repeat(4096) } });
      repeated.consumeResponse({ body: { choices: [{ message: { content: 'y'.repeat(4096) } }] } });
      const repeatedFinal = repeated.finalizeCompletedStream();
      expect(repeatedFinal.inputTokens).toBeGreaterThan(1000);
      expect(repeatedFinal.inputTokens).toBeLessThan(1100);
      expect(repeatedFinal.outputTokens).toBeGreaterThan(1000);
      expect(repeatedFinal.outputTokens).toBeLessThan(1100);
      expect(repeatedFinal.inputAuthority).toBe('heuristic');
      expect(repeatedFinal.outputAuthority).toBe('heuristic');

      const oversized = makeSession('openai', false, 'repeat-65536');
      oversized.consumeRequest({ body: { input: 'z'.repeat(65_536) } });
      oversized.consumeResponse({ body: { choices: [{ message: { content: 'done' } }] } });
      const oversizedFinal = oversized.finalizeCompletedStream();
      expect(oversizedFinal.inputAuthority).toBe('partial');
      expect(oversizedFinal.inputTokens).toBeLessThanOrEqual(16_385);

      const manyFragments = makeSession('openai', true, 'fragments-4096');
      manyFragments.consumeRequest({ body: { input: 'small prompt' } });
      for (let index = 0; index < 4096; index += 1) {
        manyFragments.consumeStreamChunk({ chunk: { choices: [{ delta: { content: 'x' }, finish_reason: index === 4095 ? 'stop' : null }] } });
      }
      const fragmentFinal = manyFragments.finalizeCompletedStream();
      expect(fragmentFinal.outputTokens).toBe(1024);
      expect(fragmentFinal.outputAuthority).toBe('heuristic');

      const mediaOnly = makeSession('openai', false, 'media-only');
      mediaOnly.consumeRequest({ body: { input: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(128)}` } }] } });
      mediaOnly.consumeResponse({ body: { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'B'.repeat(128)}` } }] } }] } });
      const mediaOnlyFinal = mediaOnly.finalizeCompletedStream();
      expect(mediaOnlyFinal.inputTokens).toBeUndefined();
      expect(mediaOnlyFinal.inputAuthority).toBe('none');
      expect(mediaOnlyFinal.outputTokens).toBeUndefined();
      expect(mediaOnlyFinal.outputAuthority).toBe('none');

      const mixedMedia = makeSession('openai', false, 'media-mixed');
      mixedMedia.consumeRequest({ body: { input: [{ type: 'text', text: 'Hello 世界' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'C'.repeat(128)}` } }] } });
      mixedMedia.consumeResponse({ body: { choices: [{ message: { content: [{ type: 'text', text: 'Hi 🧭' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'D'.repeat(128)}` } }] } }] } });
      const mixedFinal = mixedMedia.finalizeCompletedStream();
      expect(mixedFinal.inputAuthority).toBe('partial');
      expect(mixedFinal.outputAuthority).toBe('partial');
      expect(mixedFinal.outputTokens).toBeGreaterThan(0);
      expect(mixedFinal.outputTokens).toBeLessThan(20);

      const toolArguments = makeSession('openai', false, 'tool-json');
      toolArguments.consumeRequest({ body: {
        input: 'Call the tool.',
        tools: [{ type: 'function', function: { name: 'lookup_weather', description: 'Look up a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
      } });
      toolArguments.consumeResponse({ body: { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } }] } }] } });
      const toolFinal = toolArguments.finalizeCompletedStream();
      expect(toolFinal.inputAuthority).toBe('heuristic');
      expect(toolFinal.outputAuthority).toBe('heuristic');
      expect(toolFinal.outputTokens).toBeGreaterThan(0);
    } finally {
      prototype.encode = originalEncode;
    }
  });
});
