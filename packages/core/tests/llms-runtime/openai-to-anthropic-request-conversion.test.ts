import { describe, expect, test } from 'bun:test';
import { OpenAIToAnthropicRequestConversion } from '@jeffusion/bungee-llms';

describe('OpenAIToAnthropicRequestConversion', () => {
  const conversion = new OpenAIToAnthropicRequestConversion();

  test('converts chat completions request to anthropic messages request', () => {
    const result = conversion.convert('/v1/chat/completions', {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'system', content: 'You are strict.' },
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 100,
      temperature: 0.2,
      stop: ['END']
    });

    expect(result).not.toBeNull();
    expect(result?.pathname).toBe('/v1/messages');
    expect(result?.body).toEqual({
      model: 'claude-3-opus-20240229',
      system: 'You are strict.',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      temperature: 0.2,
      stop_sequences: ['END']
    });
  });

  test('converts responses input payload into anthropic message sequence', () => {
    const result = conversion.convert('/v1/responses', {
      model: 'claude-3-opus-20240229',
      instructions: 'Answer in one sentence.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is in this image?' },
            { type: 'input_image', image_url: 'https://example.com/city.png' }
          ]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: { city: 'Shanghai' }
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'output_text', text: 'Sunny' }]
        }
      ],
      max_output_tokens: 128
    });

    expect(result).not.toBeNull();
    expect(result?.body.system).toBe('Answer in one sentence.');
    expect(result?.body.max_tokens).toBe(128);

    const messages = result?.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.com/city.png'
          }
        },
        { type: 'text', text: 'What is in this image?' }
      ]
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_weather',
          input: { city: 'Shanghai' }
        }
      ]
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'Sunny'
        }
      ]
    });
  });

  test('cleans unmatched assistant tool_use blocks', () => {
    const result = conversion.convert('/v1/chat/completions', {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_unmatched', name: 'lookup', input: { query: 'x' } }
          ]
        }
      ]
    });

    expect(result?.body.messages).toEqual([
      { role: 'user', content: 'hello' }
    ]);
  });
});
