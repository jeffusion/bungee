import { describe, expect, test } from 'bun:test';
import * as llmsPluginApi from '@jeffusion/bungee-llms/plugin-api';

type TokenAccountingAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';

type CanonicalTokenAccountingEventV2 = {
  requestId: string;
  attemptId: string;
  routeId: string;
  upstreamId: string;
  provider: 'gemini';
  model: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAuthority: TokenAccountingAuthority;
  outputAuthority: TokenAccountingAuthority;
  final: boolean;
  outcome: string;
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
  provider: 'gemini';
  model: string;
  routeId: string;
  upstreamId: string;
  requestId: string;
  attemptId: string;
  streaming: boolean;
}, options?: { deferFinalization?: boolean }) => TokenAccountingSession;

type ProviderTokenAccountingCapabilities = {
  provider: 'gemini';
  supportsOfficialResponseUsage: boolean;
  supportsStreamingResponseUsage: boolean;
  supportsDedicatedCountEndpoint: boolean;
  supportsLocalTokenizer: boolean;
  supportsHeuristicFallback: boolean;
  countTokens: {
    supported: boolean;
    mode: 'input_estimate_only';
    livePathAuthority: false;
  };
};

type GetProviderTokenAccountingCapabilities = (
  provider: 'gemini'
) => ProviderTokenAccountingCapabilities;

function getAssertCanonicalTokenAccountingEventV2(): AssertCanonicalTokenAccountingEventV2 {
  if (!Reflect.has(llmsPluginApi, 'assertCanonicalTokenAccountingEventV2')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export assertCanonicalTokenAccountingEventV2() for canonical v2 Gemini accounting assertions.'
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
      'Stable facade @jeffusion/bungee-llms/plugin-api must export createTokenAccountingSession() for shared Gemini token accounting sessions.'
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
      'Stable facade @jeffusion/bungee-llms/plugin-api must export getProviderTokenAccountingCapabilities() for Gemini capability lookup.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'getProviderTokenAccountingCapabilities'
  ) as GetProviderTokenAccountingCapabilities;
}

function createGeminiSession(streaming: boolean, deferFinalization = false): TokenAccountingSession {
  const input = {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    routeId: 'gemini-route',
    upstreamId: 'gemini-primary',
    requestId: streaming ? 'req_gemini_stream_1' : 'req_gemini_sync_1',
    attemptId: streaming ? 'attempt_gemini_stream_1' : 'attempt_gemini_sync_1',
    streaming
  } as const;
  const create = getCreateTokenAccountingSession();
  return deferFinalization ? create(input, { deferFinalization: true }) : create(input);
}

function createGeminiRequestBody(imageData: string): Record<string, unknown> {
  return {
    systemInstruction: {
      parts: [{ text: 'You are a multimodal tool-calling assistant.' }]
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Describe the image and then call the summarizer tool.' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: imageData
            }
          }
        ]
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'summarize_image',
              args: {
                format: 'bullet-list',
                language: 'zh-CN'
              }
            }
          }
        ]
      },
      {
        role: 'tool',
        parts: [
          {
            functionResponse: {
              name: 'summarize_image',
              response: {
                summary: 'A yellow bird standing on a branch.'
              }
            }
          }
        ]
      }
    ]
  };
}

function createUsageMetadataResponse(): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'The image shows a yellow bird.' }]
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: {
      promptTokenCount: 111,
      candidatesTokenCount: 29,
      thoughtsTokenCount: 6,
      toolUsePromptTokenCount: 10,
      totalTokenCount: 140,
      cachedContentTokenCount: 13
    }
  };
}

function expectCanonicalEvent(event: unknown): CanonicalTokenAccountingEventV2 {
  const assertCanonicalTokenAccountingEventV2: AssertCanonicalTokenAccountingEventV2 =
    getAssertCanonicalTokenAccountingEventV2();
  const candidate: unknown = event;
  assertCanonicalTokenAccountingEventV2(candidate);
  return candidate;
}

function expectLocalOrHeuristic(authority: TokenAccountingAuthority): void {
  expect(['local', 'heuristic']).toContain(authority);
}

describe('Gemini token accounting adapter', () => {
  test('exposes Gemini capabilities and states countTokens is estimate-only, not live-path authority', () => {
    const getCapabilities = getProviderTokenAccountingCapabilities();

    expect(getCapabilities('gemini')).toEqual({
      provider: 'gemini',
      supportsOfficialResponseUsage: true,
      supportsStreamingResponseUsage: true,
      supportsDedicatedCountEndpoint: true,
      supportsLocalTokenizer: true,
      supportsHeuristicFallback: true,
      countTokens: {
        supported: true,
        mode: 'input_estimate_only',
        livePathAuthority: false
      }
    });
  });

  test('maps non-stream usageMetadata into canonical final event and preserves cache tokens distinctly', () => {
    const session = createGeminiSession(false);
    session.consumeRequest({ body: createGeminiRequestBody('ZmFrZS1pbWFnZQ==') });

    const settlement = expectCanonicalEvent(
      session.consumeResponse({ body: createUsageMetadataResponse() })
    );

    expect(settlement).toEqual(
      expect.objectContaining({
        requestId: 'req_gemini_sync_1',
        attemptId: 'attempt_gemini_sync_1',
        routeId: 'gemini-route',
        upstreamId: 'gemini-primary',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        streaming: false,
        inputTokens: 121,
        outputTokens: 35,
        cacheReadTokens: 13,
        inputAuthority: 'official',
        outputAuthority: 'official',
        final: true
      })
    );
    expect(settlement.cacheWriteTokens ?? 0).toBe(0);
    expect(settlement.outcome).toEqual(expect.any(String));
    expect(settlement.countedAt).toEqual(expect.any(String));
  });

  test('treats only the last stream chunk with usageMetadata as authoritative', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });

    const firstChunk = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'The image shows ' }]
              }
            }
          ]
        }
      })
    );

    expect(firstChunk.final).toBe(false);
    expect(firstChunk.streaming).toBe(true);
    expect(firstChunk.cacheReadTokens).toBeUndefined();
    expect(firstChunk.inputAuthority).not.toBe('official');
    expect(firstChunk.outputAuthority).not.toBe('official');

    const usageChunk = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'a yellow bird.' }]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: {
            promptTokenCount: 21,
            candidatesTokenCount: 9,
            thoughtsTokenCount: 3,
            toolUsePromptTokenCount: 7,
            totalTokenCount: 30,
            cachedContentTokenCount: 4
          }
        }
      })
    );

    expect(usageChunk).toEqual(
      expect.objectContaining({
        requestId: 'req_gemini_stream_1',
        attemptId: 'attempt_gemini_stream_1',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        streaming: true,
        inputTokens: 28,
        outputTokens: 12,
        cacheReadTokens: 4,
        inputAuthority: 'official',
        outputAuthority: 'official',
        final: false
      })
    );
    const finalChunk = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(finalChunk).toEqual(expect.objectContaining({ final: true, outcome: 'completed', inputTokens: 28, outputTokens: 12 }));
    expect(session.consumeStreamChunk({ chunk: { type: '[DONE]' } })).toBeNull();
  });

  test('updates official usage after Gemini finishReason and only finalizes at normal EOF', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const finish = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }]
    } }));
    expect(finish.final).toBe(false);
    const laterUsage = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20, toolUsePromptTokenCount: 4, cachedContentTokenCount: 8 }
    } }));
    expect(laterUsage).toEqual(expect.objectContaining({ final: false, inputTokens: 104, outputTokens: 70, cacheReadTokens: 8, inputAuthority: 'official', outputAuthority: 'official' }));
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof).toEqual(expect.objectContaining({ final: true, inputTokens: 104, outputTokens: 70, inputAuthority: 'official', outputAuthority: 'official' }));
  });

  test('preserves cumulative official usage across later text chunks and abort', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });

    const firstUsage = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        cachedContentTokenCount: 3
      }
    } }));
    expect(firstUsage).toEqual(expect.objectContaining({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      inputAuthority: 'official',
      outputAuthority: 'official'
    }));

    const laterText = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      candidates: [{ content: { parts: [{ text: 'more text' }] } }]
    } }));
    expect(laterText).toEqual(expect.objectContaining({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      inputAuthority: 'official',
      outputAuthority: 'official'
    }));

    const aborted = expectCanonicalEvent(session.finalizeAbortedStream());
    expect(aborted).toEqual(expect.objectContaining({
      final: false,
      outcome: 'aborted',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      inputAuthority: 'official',
      outputAuthority: 'official'
    }));
  });

  test('replaces Gemini cumulative usage with the latest official snapshot and keeps it through EOF', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    session.consumeStreamChunk({ chunk: {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 3 }
    } });
    const updatedUsage = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 9, cachedContentTokenCount: 4 }
    } }));
    expect(updatedUsage).toEqual(expect.objectContaining({
      inputTokens: 14,
      outputTokens: 9,
      cacheReadTokens: 4,
      inputAuthority: 'official',
      outputAuthority: 'official'
    }));

    session.consumeStreamChunk({ chunk: {
      candidates: [{ content: { parts: [{ text: 'more text' }] }, finishReason: 'STOP' }]
    } });
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof).toEqual(expect.objectContaining({
      final: true,
      outcome: 'completed',
      inputTokens: 14,
      outputTokens: 9,
      cacheReadTokens: 4,
      inputAuthority: 'official',
      outputAuthority: 'official'
    }));
  });

  test('defers stream estimation until EOF when Gemini usage is absent', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const estimated = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      candidates: [{ content: { parts: [{ text: 'more text' }] } }]
    } }));

    expect(estimated.outputTokens).toBeUndefined();
    expect(estimated.outputAuthority).toBe('none');
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.outputTokens).toBeGreaterThan(0);
    expect(eof.outputAuthority).toBe('local');
  });

  test('finalizes a stream that reaches EOF without usage as completed but estimated', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    session.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } });
    const event = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(event).toEqual(expect.objectContaining({ final: true, outcome: 'completed' }));
    expect(event.inputAuthority).not.toBe('official');
    expect(event.outputAuthority).not.toBe('official');
  });

  test('official Gemini totals are independent of estimated text chunk boundaries', () => {
    const oneChunk = createGeminiSession(true);
    const splitChunks = createGeminiSession(true);
    const request = createGeminiRequestBody('c21hbGw=');
    oneChunk.consumeRequest({ body: request });
    splitChunks.consumeRequest({ body: request });
    oneChunk.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: 'a longer answer' }] } }] } });
    splitChunks.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: 'a longer' }] } }] } });
    splitChunks.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: ' answer' }] } }] } });
    const usage = { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, thoughtsTokenCount: 5, toolUsePromptTokenCount: 2 } };
    oneChunk.consumeStreamChunk({ chunk: usage });
    splitChunks.consumeStreamChunk({ chunk: usage });
    const a = expectCanonicalEvent(oneChunk.finalizeCompletedStream());
    const b = expectCanonicalEvent(splitChunks.finalizeCompletedStream());
    expect([a.inputTokens, a.outputTokens, a.inputAuthority, a.outputAuthority])
      .toEqual([b.inputTokens, b.outputTokens, b.inputAuthority, b.outputAuthority]);
    expect([a.inputTokens, a.outputTokens, a.inputAuthority, a.outputAuthority])
      .toEqual([32, 20, 'official', 'official']);
  });

  test('does not call an overflowing Gemini official usage sum official', () => {
    const session = createGeminiSession(false);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const event = expectCanonicalEvent(session.consumeResponse({ body: { usageMetadata: {
      promptTokenCount: Number.MAX_SAFE_INTEGER, toolUsePromptTokenCount: 1,
      candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1
    } } }));
    expect(event.inputAuthority).not.toBe('official');
    expect(event.outputAuthority).not.toBe('official');
    expect(() => getAssertCanonicalTokenAccountingEventV2()({ ...event, inputTokens: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  test('falls back to local or heuristic accounting for inlineData, functionCall and functionResponse when usageMetadata is absent', () => {
    const textOnlySession = createGeminiSession(false);
    textOnlySession.consumeRequest({
      body: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Describe this image.' }]
          }
        ]
      }
    });
    const textOnlySettlement = expectCanonicalEvent(
      textOnlySession.consumeResponse({
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'I need an image to describe it.' }]
              },
              finishReason: 'STOP'
            }
          ]
        }
      })
    );

    const smallImageSession = createGeminiSession(false);
    smallImageSession.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const smallImageSettlement = expectCanonicalEvent(
      smallImageSession.consumeResponse({
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Yellow bird.' }]
              },
              finishReason: 'STOP'
            }
          ]
        }
      })
    );

    const hugeBase64 = 'A'.repeat(16000);
    const hugeInlineDataPart = {
      inlineData: {
        mimeType: 'image/png',
        data: hugeBase64
      }
    };
    const hugeImageSession = createGeminiSession(false);
    hugeImageSession.consumeRequest({ body: createGeminiRequestBody(hugeBase64) });
    const hugeImageSettlement = expectCanonicalEvent(
      hugeImageSession.consumeResponse({
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Yellow bird.' }]
              },
              finishReason: 'STOP'
            }
          ]
        }
      })
    );

    expectLocalOrHeuristic(textOnlySettlement.inputAuthority);
    expectLocalOrHeuristic(textOnlySettlement.outputAuthority);
    expectLocalOrHeuristic(smallImageSettlement.inputAuthority);
    expectLocalOrHeuristic(smallImageSettlement.outputAuthority);
    expectLocalOrHeuristic(hugeImageSettlement.inputAuthority);
    expectLocalOrHeuristic(hugeImageSettlement.outputAuthority);

    expect(smallImageSettlement.inputTokens).toBeGreaterThan(textOnlySettlement.inputTokens ?? 0);
    expect(hugeImageSettlement.inputTokens).toBeGreaterThan(textOnlySettlement.inputTokens ?? 0);
    expect(Math.abs((hugeImageSettlement.inputTokens ?? 0) - (smallImageSettlement.inputTokens ?? 0))).toBeLessThan(256);
    expect(hugeImageSettlement.inputTokens).toBeLessThan(
      Math.ceil(JSON.stringify(hugeInlineDataPart).length / 4) / 4
    );
  });

  test('downgrades authority when non-stream responses omit usageMetadata', () => {
    const session = createGeminiSession(false);
    session.consumeRequest({ body: createGeminiRequestBody('ZmFrZS1pbWFnZQ==') });

    const settlement = expectCanonicalEvent(
      session.consumeResponse({
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'No authoritative usage metadata was returned.' }]
              },
              finishReason: 'STOP'
            }
          ]
        }
      })
    );

    expect(settlement.final).toBe(true);
    expect(settlement.streaming).toBe(false);
    expectLocalOrHeuristic(settlement.inputAuthority);
    expectLocalOrHeuristic(settlement.outputAuthority);
  });

  test('marks aborted streams without final usageMetadata as non-final and never official', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c29tZS1pbWFnZQ==') });

    const chunkBeforeAbort = expectCanonicalEvent(
      session.consumeStreamChunk({
        chunk: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Partial stream content only.' }]
              }
            }
          ]
        }
      })
    );

    expect(chunkBeforeAbort.final).toBe(false);
    expect(chunkBeforeAbort.outputAuthority).not.toBe('official');

    const abortedSettlement = expectCanonicalEvent(session.finalizeAbortedStream());

    expect(abortedSettlement).toEqual(
      expect.objectContaining({
        requestId: 'req_gemini_stream_1',
        attemptId: 'attempt_gemini_stream_1',
        provider: 'gemini',
        streaming: true,
        final: false
      })
    );
    expect(abortedSettlement.outcome).toEqual(expect.any(String));
    expectLocalOrHeuristic(abortedSettlement.inputAuthority);
    expect(abortedSettlement.outputAuthority).not.toBe('official');
    expect(['partial', 'local', 'heuristic', 'none']).toContain(abortedSettlement.outputAuthority);
  });

  test('does not infer Gemini completion from EOF without a protocol finishReason', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c29tZS1pbWFnZQ==') });
    session.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: 'still generating' }] } }] } });
    const event = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(event.final).toBe(false);
    expect(event.outcome).toBe('failed');
    expect(event.outputAuthority).not.toBe('official');
  });

  test('preserves official Gemini usage and cache detail when a stream aborts', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: createGeminiRequestBody('c29tZS1pbWFnZQ==') });
    session.consumeStreamChunk({ chunk: { usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 30
    } } });

    const aborted = expectCanonicalEvent(session.finalizeAbortedStream());
    expect(aborted).toEqual(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: false,
      outcome: 'aborted'
    }));
  });

  test('defers Gemini request tokenization until EOF when stream input usage is absent', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: { model: 'gemini-2.0-flash', contents: [{ parts: [{ text: 'large request '.repeat(5000) }] }], stream: true } });
    const progress = expectCanonicalEvent(session.consumeStreamChunk({ chunk: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } }));
    expect(progress.inputTokens).toBeUndefined();
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.inputTokens).toBeGreaterThan(0);
    expect(eof.inputAuthority).toBe('partial');
    expect(eof.outputTokens).toBeGreaterThan(0);
    expect(eof.outputAuthority).toBe('local');
  });

  test('does not estimate missing Gemini input when official zero usage arrives', () => {
    const session = createGeminiSession(true);
    session.consumeRequest({ body: { model: 'gemini-2.0-flash', contents: [{ parts: [{ text: 'large request '.repeat(5000) }] }], stream: true } });
    session.consumeStreamChunk({ chunk: { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0, cachedContentTokenCount: 0 } } });
    const eof = expectCanonicalEvent(session.finalizeCompletedStream());
    expect(eof.inputTokens).toBe(0);
    expect(eof.inputAuthority).toBe('official');
    expect(eof.outputTokens).toBe(0);
    expect(eof.outputAuthority).toBe('official');
  });

  test('keeps a Gemini error JSON body unknown instead of estimating its text', () => {
    const session = createGeminiSession(false);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const event = expectCanonicalEvent(session.consumeResponse({ body: { error: { message: 'provider error text' } } }));
    expect(event.outputTokens).toBeUndefined();
    expect(event.outputAuthority).toBe('none');

    const emptySuccess = createGeminiSession(false);
    emptySuccess.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const empty = expectCanonicalEvent(emptySuccess.consumeResponse({ body: { candidates: [] } }));
    expect(empty.outputTokens).toBeUndefined();
    expect(empty.outputAuthority).toBe('none');
  });

  test('deferred JSON delays estimates, preserves official zero, and keeps oversized input partial', () => {
    const session = createGeminiSession(false, true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const observed = expectCanonicalEvent(session.consumeResponse({ body: {
      candidates: [{ content: { parts: [{ text: 'generated answer' }] } }],
      usageMetadata: { promptTokenCount: 0 }
    } }));
    expect(observed).toEqual(expect.objectContaining({ final: false, inputTokens: 0, inputAuthority: 'official' }));
    expect(observed.outputTokens).toBeUndefined();
    expect(session.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: true, inputTokens: 0, inputAuthority: 'official', outputAuthority: 'heuristic' }));

    const huge = createGeminiSession(false, true);
    huge.consumeRequest({ body: { contents: [{ role: 'user', parts: [{ text: 'large request '.repeat(8_000) }] }] } });
    const pending = expectCanonicalEvent(huge.consumeResponse({ body: { candidates: [] } }));
    expect(pending.inputTokens).toBeUndefined();
    expect(huge.finalizeCompletedStream()).toEqual(expect.objectContaining({ inputAuthority: 'partial' }));
  });

  test('deferred Gemini finishReason accepts later usage, while failures and cancellation stay non-completed', () => {
    const session = createGeminiSession(true, true);
    session.consumeRequest({ body: createGeminiRequestBody('c21hbGw=') });
    const terminal = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      candidates: [{ content: { parts: [{ text: 'generated answer' }] }, finishReason: 'STOP' }]
    } }));
    expect(terminal.final).toBe(false);
    expect(terminal.inputTokens).toBeUndefined();
    expect(terminal.outputTokens).toBeUndefined();
    const lateUsage = expectCanonicalEvent(session.consumeStreamChunk({ chunk: {
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0 }
    } }));
    expect(lateUsage).toEqual(expect.objectContaining({ final: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, inputAuthority: 'official', outputAuthority: 'official' }));
    expect(session.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: true, outcome: 'completed', inputTokens: 0, outputTokens: 0 }));

    const errorSession = createGeminiSession(true, true);
    const error = expectCanonicalEvent(errorSession.consumeStreamChunk({ chunk: { error: { message: 'upstream error' } } }));
    expect(error.final).toBe(false);
    expect(error.inputTokens).toBeUndefined();
    expect(error.outputTokens).toBeUndefined();
    expect(errorSession.finalizeCompletedStream()).toEqual(expect.objectContaining({ final: false, outcome: 'failed' }));

    const aborted = createGeminiSession(true, true);
    expect(aborted.finalizeAbortedStream()).toEqual(expect.objectContaining({ final: false, outcome: 'aborted' }));
  });
});
