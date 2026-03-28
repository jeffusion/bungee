import { describe, expect, test } from 'bun:test';
import {
  AnthropicAdapter,
  LLMSRuntime,
  OpenAIAdapter
} from '@jeffusion/bungee-llms';

describe('LLMSRuntime adapters', () => {
  test('converts OpenAI chat request to Anthropic request through runtime adapters', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const converted = runtime.convertRequest<Record<string, unknown>>(
      'openai',
      'anthropic',
      {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'Hello' }
        ],
        max_tokens: 128
      },
      { pathname: '/v1/chat/completions' }
    );

    expect(converted.model).toBe('claude-3-5-sonnet-20241022');
    expect(converted.system).toBe('You are concise.');
    expect(converted.max_tokens).toBe(128);
    expect(converted.messages).toEqual([
      { role: 'user', content: 'Hello' }
    ]);
  });

  test('converts OpenAI responses request to Anthropic request through runtime adapters', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const converted = runtime.convertRequest<Record<string, unknown>>(
      'openai',
      'anthropic',
      {
        model: 'claude-3-5-sonnet-20241022',
        instructions: 'Use short answers',
        input: [
          {
            role: 'user',
            type: 'message',
            content: [{ type: 'input_text', text: 'Summarize this.' }]
          }
        ],
        max_output_tokens: 64
      },
      { pathname: '/v1/responses' }
    );

    expect(converted.system).toBe('Use short answers');
    expect(converted.max_tokens).toBe(64);
    expect(converted.messages).toEqual([
      { role: 'user', content: 'Summarize this.' }
    ]);
  });

  test('converts Anthropic response to OpenAI response through runtime adapters', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const converted = runtime.convertResponse<Record<string, unknown>>(
      'anthropic',
      'openai',
      {
        id: 'msg_123',
        role: 'assistant',
        content: 'Done'
      }
    );

    expect(converted.choices).toEqual([
      {
        message: {
          role: 'assistant',
          content: 'Done'
        }
      }
    ]);
  });

  test('converts Anthropic request to OpenAI request through runtime adapters', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const converted = runtime.convertRequest<Record<string, unknown>>(
      'anthropic',
      'openai',
      {
        model: 'gpt-4.1',
        system: 'You are concise.',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ]
      },
      { pathname: '/v1/messages' }
    );

    expect(converted.model).toBe('gpt-4.1');
    expect(converted.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' }
    ]);
  });

  test('maps anthropic sampling and stream fields into openai request through runtime adapters', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const converted = runtime.convertRequest<Record<string, unknown>>(
      'anthropic',
      'openai',
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: 'Hello' }
        ],
        max_tokens_to_sample: 256,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: 'DONE',
        stream: true
      },
      { pathname: '/v1/messages' }
    );

    expect(converted.max_tokens).toBe(256);
    expect(converted.temperature).toBe(0.2);
    expect(converted.top_p).toBe(0.9);
    expect(converted.stop).toEqual(['DONE']);
    expect(converted.stream).toBe(true);
    expect(converted.stream_options).toEqual({ include_usage: true });
  });

  test('throws when target provider adapter is missing during anthropic to openai request conversion', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new AnthropicAdapter());

    expect(() => runtime.convertRequest<Record<string, unknown>>(
      'anthropic',
      'openai',
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hello' }]
      },
      { pathname: '/v1/messages' }
    )).toThrow('No protocol adapter registered for provider: openai');
  });

  test('exposes registered providers from runtime catalog', () => {
    const runtime = new LLMSRuntime();
    runtime.registerAdapter(new OpenAIAdapter());
    runtime.registerAdapter(new AnthropicAdapter());

    const providers = runtime.listProviders().map((provider) => provider.provider).sort();
    expect(providers).toEqual(['anthropic', 'openai']);
  });
});
