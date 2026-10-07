import { describe, expect, test } from 'bun:test';
import { classifyRequest, classifyResponse } from '../server/classifier';

const chat = { model: 'custom-model', messages: [{ role: 'user', content: 'hello' }] };

describe('LLM request classification', () => {
  test('recognizes supported protocols without relying on provider hostnames or model names', () => {
    for (const [path, body, provider] of [
      ['/v1/chat/completions', chat, 'openai'],
      ['/backend-api/codex/responses', { model: 'any-model', input: [{ role: 'user', content: 'hello' }] }, 'openai'],
      ['/relay', { model: 'any-model', input: 'hello' }, 'openai'],
      ['/v1/completions', { model: 'any-model', prompt: 'hello' }, 'openai'],
      ['/v1/messages', chat, 'anthropic'],
      ['/relay', { ...chat, anthropic_version: '2023-06-01' }, 'anthropic'],
      ['/v1beta/models/custom-model:generateContent', { contents: [{ parts: [{ text: 'hello' }] }] }, 'gemini'],
      ['/v1beta/models/custom-model:streamGenerateContent', { contents: [{ parts: [{ text: 'hello' }] }] }, 'gemini'],
    ] as const) {
      expect(classifyRequest(new URL(path, 'https://relay.example'), body)).toEqual({ llm: true, provider });
    }
  });

  test('does not guess a wire protocol from shared chat messages or max_tokens', () => {
    expect(classifyRequest(new URL('https://relay.example/custom'), { ...chat, max_tokens: 16 })).toEqual({ llm: true });
  });

  test('rejects ordinary APIs even when they reuse endpoint names and isolated LLM field names', () => {
    for (const path of ['/api', '/messages', '/responses', '/completions', '/models/test:generateContent']) {
      for (const body of [
        {}, { input: 'search terms' }, { prompt: 'form label' }, { model: 'product' },
        { messages: ['notification'] }, { model: 'product', messages: [{ sender: 'user', text: 'hello' }] },
        { generationConfig: {} }, { contents: ['document'] }, { max_tokens: 32 },
      ]) {
        expect(classifyRequest(new URL(path, 'https://app.example'), body).llm).toBe(false);
      }
    }
  });
});

describe('LLM response classification', () => {
  test('reads SSE metadata separately and does not treat payload _event as metadata', () => {
    expect(classifyResponse({ delta: 'hello' }, false, 'response.output_text.delta')).toBe('openai');
    expect(classifyResponse({ _event: 'response.output_text.delta', delta: 'hello' }, false)).toBeUndefined();
  });

  test('usage fields, SSE, and generic choices do not prove a normal request is an LLM call', () => {
    for (const body of [
      { usage: { input_tokens: 1, output_tokens: 2 } },
      { usage: { prompt_tokens: 1, completion_tokens: 2 } },
      { usageMetadata: { promptTokenCount: 1 } },
      { choices: ['A', 'B'] }, { candidates: [] }, { type: 'message', content: 'notification' },
      { choices: [{ message: { text: 'notification' } }] }, { choices: [{ delta: { price: 3 } }] },
      { type: 'response.updated', status: 'ok' }, { _event: 'message_stop' },
    ]) expect(classifyResponse(body, false)).toBeUndefined();
  });

  test('recognizes JSON and SSE generation envelopes on custom relay paths', () => {
    for (const [body, provider] of [
      [{ object: 'chat.completion', choices: [], usage: { prompt_tokens: 0 } }, 'openai'],
      [{ choices: [{ delta: { content: 'hello' } }] }, 'openai'],
      [{ object: 'response', model: 'custom-model', output: [] }, 'openai'],
      [{ type: 'response.completed', response: { model: 'custom-model', usage: { input_tokens: 3 } } }, 'openai'],
      [{ type: 'response.output_text.delta', delta: 'hello' }, 'openai'],
      [{ type: 'message', role: 'assistant', content: [] }, 'anthropic'],
      [{ type: 'message_start', message: { type: 'message', content: [] } }, 'anthropic'],
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }, 'anthropic'],
      [{ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }, 'gemini'],
    ] as const) expect(classifyResponse(body, false)).toBe(provider);
  });
});
