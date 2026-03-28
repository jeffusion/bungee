import { describe, expect, test } from 'bun:test';
import { OpenAIProtocolConversion } from '@jeffusion/bungee-llms/plugin-api';

describe('OpenAIProtocolConversion', () => {
  const conversion = new OpenAIProtocolConversion();

  test('normalizes responses reasoning body for assistant tool calls', () => {
    const normalized = conversion.normalizeResponsesReasoningBody({
      model: 'gpt-5.4',
      reasoning: { effort: 'high' },
      input: [
        {
          role: 'assistant',
          content: '<thinking>Need to call weather tool.</thinking>',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
          }]
        }
      ]
    });

    const input = normalized.input as Array<Record<string, unknown>>;
    expect(input[0].reasoning_content).toBe('Need to call weather tool.');
  });

  test('converts chat messages to responses input items', () => {
    const converted = conversion.convertChatMessagesToResponsesInput([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'Calling tool',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_time', arguments: '{}' }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"timezone":"Asia/Shanghai"}'
      }
    ]);

    expect(converted.instructions).toBe('Be concise.');
    expect(converted.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Calling tool' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"timezone":"Asia/Shanghai"}' }
    ]);
  });

  test('converts responses input items to chat messages', () => {
    const converted = conversion.convertResponsesInputToMessages([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'call_2', name: 'search_docs', arguments: '{"q":"bungee"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"result":"ok"}' }
    ]);

    expect(converted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'search_docs', arguments: '{"q":"bungee"}' }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '{"result":"ok"}',
        is_error: false
      }
    ]);
  });

  test('patches assistant tool_use response with reasoning_content', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to call a tool first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Hangzhou' } }
        ]
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const patched = await conversion.ensureAssistantToolUseReasoningContent(response);
    const body = await patched.json() as Record<string, unknown>;

    expect(body.reasoning_content).toBe('Need to call a tool first.');
  });

  test('normalizes messages stream usage and reasoning_content', () => {
    const events = conversion.ensureMessagesStreamCompatibility(
      [
        {
          type: 'message_start',
          message: { role: 'assistant', content: [] }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' }
        }
      ],
      { streamState: new Map<string, unknown>() }
    );

    const messageStart = events[0] as { message: Record<string, unknown> };
    const messageDelta = events[1] as { usage: Record<string, unknown> };

    expect(messageStart.message.reasoning_content).toBe('');
    expect(messageDelta.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
