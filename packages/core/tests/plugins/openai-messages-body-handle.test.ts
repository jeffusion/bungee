import { expect, test } from 'bun:test';
import { createPluginHooks } from '@jeffusion/bungee-core/plugin';
import OpenAIMessagesToChatPlugin from '../../../../plugins/openai-messages-to-chat/server';

function frozen(value: any): any {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test('messages conversion reads frozen JSON from the handle with metadata-only response', async () => {
  const hooks = createPluginHooks();
  new OpenAIMessagesToChatPlugin().register(hooks);
  const request = { requestId: 'handle-messages', method: 'POST', url: new URL('https://example.test/v1/messages'), headers: {}, body: { model: 'model', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] } } as any;
  await hooks.onBeforeRequest.promise(request);
  const payload = frozen({ id: 'chatcmpl-1', model: 'model', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: {} });
  const response = new Response(null, { headers: { 'content-type': 'application/json' } });
  const result = await hooks.onResponse.promise(response, { ...request, response, bodyHandle: { json: async () => payload } } as any);
  expect(await result.json()).toMatchObject({ type: 'message', reasoning_content: '', content: [{ type: 'tool_use', name: 'tool' }] });
  expect(payload.choices[0].message).not.toHaveProperty('reasoning_content');
});

test('responses compatibility reads shared JSON and converts a frozen SSE view', async () => {
  const hooks = createPluginHooks();
  new OpenAIMessagesToChatPlugin().register(hooks);
  const request = { requestId: 'handle-responses', method: 'POST', url: new URL('https://example.test/v1/responses'), headers: {}, body: { model: 'model', input: 'hello' } } as any;
  await hooks.onBeforeRequest.promise(request);
  const payload = frozen({ id: 'chatcmpl-1', model: 'model', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: {} });
  const response = new Response(null, { headers: { 'content-type': 'application/json' } });
  const result = await hooks.onResponse.promise(response, { ...request, response, bodyHandle: { json: async () => payload } } as any);
  expect(await result.json()).toMatchObject({ object: 'response', status: 'completed' });
  const json = frozen({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] });
  const envelope = Object.freeze({ json, data: JSON.stringify(json) });
  const events = await hooks.onStreamChunk.promise(envelope, { ...request, streamState: new Map() } as any);
  expect(events!.some(event => (event.json as any)?.type === 'response.output_text.delta')).toBe(true);
  expect(json.choices[0].delta.content).toBe('hello');
});
