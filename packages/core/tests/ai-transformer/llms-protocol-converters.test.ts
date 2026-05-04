import { describe, expect, test } from 'bun:test';
import {
  AnthropicToGeminiConverter,
  AnthropicToOpenAIConverter,
  GeminiToAnthropicConverter,
  GeminiToOpenAIConverter,
  type MutableRequestContext,
  type ResponseContext,
  OpenAIToAnthropicConverter,
  OpenAIToGeminiConverter,
  ProtocolTransformerRegistry,
  registerDefaultProtocolConverters
} from '@jeffusion/bungee-llms/plugin-api';

function createRequestContext(pathname: string, body: Record<string, unknown>): MutableRequestContext {
  const url = new URL(`https://example.test${pathname}`);
  return {
    method: 'POST',
    originalUrl: new URL(`https://example.test${pathname}`),
    url,
    headers: {},
    body,
    requestId: 'req_1',
    clientIP: '127.0.0.1'
  };
}

describe('llms protocol converters', () => {
  test('registers full O/A/G protocol converter matrix', () => {
    ProtocolTransformerRegistry.clear();
    registerDefaultProtocolConverters();

    expect(ProtocolTransformerRegistry.getAllDirections().sort()).toEqual([
      'anthropic-gemini',
      'anthropic-openai',
      'gemini-anthropic',
      'gemini-openai',
      'openai-anthropic',
      'openai-gemini'
    ]);
  });

  test('anthropic to openai request conversion works from llms package converter', async () => {
    const converter = new AnthropicToOpenAIConverter();
    const ctx = createRequestContext('/v1/messages', {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    await converter.onBeforeRequest?.(ctx);

    const nextUrl = (ctx.url as URL).pathname;
    const nextBody = ctx.body as Record<string, unknown>;
    expect(nextUrl).toBe('/v1/chat/completions');
    expect(Array.isArray(nextBody.messages)).toBe(true);
  });

  test('anthropic to openai runtime conversion falls back without injecting model', async () => {
    const converter = new AnthropicToOpenAIConverter();
    Reflect.set(converter, 'runtime', {
      convertRequest: () => {
        throw new Error('runtime conversion failed');
      }
    });

    const ctx = createRequestContext('/v1/messages', {
      messages: [{ role: 'user', content: 'Hello without model' }]
    });

    await converter.onBeforeRequest?.(ctx);

    const nextUrl = (ctx.url as URL).pathname;
    const nextBody = ctx.body as Record<string, unknown>;
    expect(nextUrl).toBe('/v1/chat/completions');
    expect(nextBody.model).toBeUndefined();
    expect(Array.isArray(nextBody.messages)).toBe(true);
  });

  test('openai to anthropic request conversion works from llms package converter', async () => {
    const converter = new OpenAIToAnthropicConverter();
    const ctx = createRequestContext('/v1/chat/completions', {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    await converter.onBeforeRequest?.(ctx);

    const nextUrl = (ctx.url as URL).pathname;
    const nextBody = ctx.body as Record<string, unknown>;
    expect(nextUrl).toBe('/v1/messages');
    expect(Array.isArray(nextBody.messages)).toBe(true);
  });

  test('openai to gemini request conversion works from llms package converter', async () => {
    const converter = new OpenAIToGeminiConverter();
    const ctx = createRequestContext('/v1/chat/completions', {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1beta/models/gemini-2.0-flash:generateContent');
    expect((ctx.body as Record<string, unknown>).contents).toBeDefined();
  });

  test('gemini to openai request conversion works from llms package converter', async () => {
    const converter = new GeminiToOpenAIConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0-flash:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/chat/completions');
    expect(Array.isArray((ctx.body as Record<string, unknown>).messages)).toBe(true);
    expect((ctx.body as Record<string, unknown>).model).toBe('gemini-2.0-flash');
  });

  test('gemini stream endpoint conversion preserves stream flag for openai target', async () => {
    const converter = new GeminiToOpenAIConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0-flash:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/chat/completions');
    expect((ctx.body as Record<string, unknown>).stream).toBe(true);
  });

  test('gemini slash endpoint conversion works for openai target', async () => {
    const converter = new GeminiToOpenAIConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0-flash/generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      model: 'fallback-model-should-not-win'
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/chat/completions');
    expect((ctx.body as Record<string, unknown>).model).toBe('gemini-2.0-flash');
  });

  test('gemini path model should override body model for openai target', async () => {
    const converter = new GeminiToOpenAIConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-path-model:generateContent', {
      model: 'gemini-body-model',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.body as Record<string, unknown>).model).toBe('gemini-path-model');
  });

  test('gemini url-encoded path model should be decoded for openai target', async () => {
    const converter = new GeminiToOpenAIConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0%2Fflash:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.body as Record<string, unknown>).model).toBe('gemini-2.0/flash');
  });

  test('anthropic to gemini request conversion works from llms package converter', async () => {
    const converter = new AnthropicToGeminiConverter();
    const ctx = createRequestContext('/v1/messages', {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1beta/models/gemini-2.0-flash:generateContent');
    expect((ctx.body as Record<string, unknown>).contents).toBeDefined();
  });

  test('gemini to anthropic request conversion works from llms package converter', async () => {
    const converter = new GeminiToAnthropicConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0-flash:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { maxOutputTokens: 128 }
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/messages');
    expect(Array.isArray((ctx.body as Record<string, unknown>).messages)).toBe(true);
    expect((ctx.body as Record<string, unknown>).model).toBe('gemini-2.0-flash');
  });

  test('gemini stream endpoint conversion preserves stream flag for anthropic target', async () => {
    const converter = new GeminiToAnthropicConverter();
    const ctx = createRequestContext('/v1beta/models/gemini-2.0-flash:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/messages');
    expect((ctx.body as Record<string, unknown>).stream).toBe(true);
  });

  test('gemini slash endpoint conversion works for anthropic target', async () => {
    const converter = new GeminiToAnthropicConverter();
    const ctx = createRequestContext('/v1beta/models/claude-3-5-sonnet-20241022/generateContent', {
      model: 'fallback-model-should-not-win',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.url as URL).pathname).toBe('/v1/messages');
    expect((ctx.body as Record<string, unknown>).model).toBe('claude-3-5-sonnet-20241022');
  });

  test('gemini path model should override body model for anthropic target', async () => {
    const converter = new GeminiToAnthropicConverter();
    const ctx = createRequestContext('/v1beta/models/claude-path-model:generateContent', {
      model: 'claude-body-model',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    });

    await converter.onBeforeRequest?.(ctx);

    expect((ctx.body as Record<string, unknown>).model).toBe('claude-path-model');
  });

  test('gemini to anthropic error response should be transformed to gemini error envelope', async () => {
    const converter = new GeminiToAnthropicConverter();
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Upstream anthropic validation failed'
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBeDefined();
    const body = await transformed!.json();

    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.message).toBe('Upstream anthropic validation failed');
  });

  test('gemini to openai should passthrough non-openai problem+json error bodies', async () => {
    const converter = new GeminiToOpenAIConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not OpenAI schema'
    };
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });

  test('gemini to anthropic should passthrough non-anthropic problem+json error bodies', async () => {
    const converter = new GeminiToAnthropicConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not Anthropic schema'
    };
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });

  test('anthropic to openai should passthrough non-openai problem+json error bodies', async () => {
    const converter = new AnthropicToOpenAIConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not OpenAI schema'
    };
    const ctx: ResponseContext = {
      originalUrl: new URL('https://example.test/v1/messages'),
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });

  test('anthropic to gemini should passthrough non-gemini problem+json error bodies', async () => {
    const converter = new AnthropicToGeminiConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not Gemini schema'
    };
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });

  test('openai to anthropic should passthrough non-anthropic problem+json error bodies', async () => {
    const converter = new OpenAIToAnthropicConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not Anthropic schema'
    };
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });

  test('openai to gemini should passthrough non-gemini problem+json error bodies', async () => {
    const converter = new OpenAIToGeminiConverter();
    const payload = {
      title: 'Gateway Problem',
      detail: 'Not Gemini schema'
    };
    const ctx: ResponseContext = {
      response: new Response(JSON.stringify(payload), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    };

    const transformed = await converter.onResponse?.(ctx);
    expect(transformed).toBe(ctx.response);
    expect(await transformed!.json()).toEqual(payload);
  });
});
