import { describe, expect, test } from 'bun:test';
import { createPluginHooks } from '@jeffusion/bungee-core/plugin';
import OpenAIMessagesToChatPlugin from '../server';

async function fixture() {
  const hooks = createPluginHooks();
  new OpenAIMessagesToChatPlugin().register(hooks);
  const request = {
    requestId: crypto.randomUUID(), method: 'POST', url: new URL('https://fixture.test/v1/responses'),
    headers: {}, body: { model: 'legacy-model', input: 'hello' },
  } as any;
  await hooks.onBeforeRequest.promise(request);
  const context = { ...request, streamState: new Map(), strict: true } as any;
  return {
    hooks, context,
    push: (json: unknown) => hooks.onStreamChunk.promise({ data: JSON.stringify(json), json } as any, context),
    finish: () => hooks.onFlushStream.promise([], context),
    json: async (payload: unknown) => {
      const response = new Response(null, { headers: {
        'content-type': 'application/json', 'content-length': '100', 'content-encoding': 'gzip',
      } });
      return hooks.onResponse.promise(response, { ...request, response, bodyHandle: { json: async () => payload } } as any);
    },
  };
}

const choice = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const events = (envelopes: any[]) => envelopes.map(envelope => envelope.json as Record<string, any>);
const hasCompleted = (envelopes: any[]) => events(envelopes).some(event => event.type === 'response.completed');

describe('legacy Responses bridge uses the shared codec', () => {
  test('retains trailing usage, reasoning/refusal fields and removes upstream framing headers', async () => {
    const f = await fixture();
    const converted = await f.json({ choices: [{ message: {
      role: 'assistant', content: 'answer', reasoning_content: 'reason', refusal: 'refusal',
    }, finish_reason: 'stop' }], usage: {
      prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    } });
    const body = await converted.json();
    expect(body.output.some((item: any) => item.type === 'reasoning')).toBe(true);
    expect(body.output.some((item: any) => item.content?.some((part: any) => part.type === 'refusal'))).toBe(true);
    expect(body.usage).toMatchObject({ input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } });
    expect(converted.headers.has('content-length')).toBe(false);
    expect(converted.headers.has('content-encoding')).toBe(false);

    await f.push(choice({ content: 'answer' }, 'stop'));
    await f.push({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const terminal = events(await f.finish()).at(-1)!;
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.usage).toMatchObject({ input_tokens: 9, output_tokens: 3 });
    expect(await f.finish()).toEqual([]);
  });

  test('truncated text and an empty stream never complete', async () => {
    const f = await fixture();
    const output = await f.push(choice({ content: 'partial' }));
    expect(hasCompleted(output)).toBe(false);
    await expect(f.finish()).rejects.toMatchObject({ code: 'missing_terminal' });
    const empty = await fixture();
    await expect(empty.finish()).rejects.toMatchObject({ code: 'missing_terminal' });
  });

  test('DONE alone is framing and cannot manufacture a terminal', async () => {
    const f = await fixture();
    expect(await f.hooks.onStreamChunk.promise({ data: '[DONE]' } as any, f.context)).toEqual([]);
    await expect(f.finish()).rejects.toMatchObject({ code: 'missing_terminal' });
  });

  test('provider errors are failed Responses events and do not enter reference history', async () => {
    const f = await fixture();
    await f.push(choice({ content: 'partial' }));
    const output = events(await f.push({ error: { code: 'overloaded', message: 'reset' } }));
    const terminal = output.at(-1)!;
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('overloaded');
    expect(output.some(event => event.type === 'response.completed')).toBe(false);
    expect(await f.finish()).toEqual([]);
    const next = { ...f.context, requestId: 'failed-follow-up', url: new URL('https://fixture.test/v1/responses'), body: {
      model: 'legacy-model', previous_response_id: terminal.response.id,
    } };
    await f.hooks.onBeforeRequest.promise(next);
    const interception = await f.hooks.onInterceptRequest.promise(next);
    expect(interception?.action).toBe('respond');
  });

  test('unfinished tool JSON cannot become a successful JSON or stream result', async () => {
    const f = await fixture();
    const tool = { id: 'call', type: 'function', function: { name: 'weather', arguments: '{"city":' } };
    await expect(f.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [tool] }, finish_reason: 'tool_calls' }] })).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
    const output = await f.push(choice({ tool_calls: [{ ...tool, index: 0 }] }, 'tool_calls'));
    expect(hasCompleted(output)).toBe(false);
    await expect(f.finish()).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
  });

  test('length preserves partial tools as incomplete instead of executable completed calls', async () => {
    const f = await fixture();
    await f.push(choice({ tool_calls: [{ index: 0, id: 'call', function: { name: 'weather', arguments: '{"city":' } }] }, 'length'));
    const terminal = events(await f.finish()).at(-1)!;
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.output[1]).toMatchObject({ type: 'function_call', status: 'incomplete', arguments: '{"city":' });
  });

  test('unknown JSON terminal reasons and unsupported output content are explicit errors', async () => {
    const f = await fixture();
    await expect(f.json({ choices: [{ message: { content: 'answer' }, finish_reason: 'mystery' }] })).rejects.toMatchObject({ code: 'unknown_terminal' });
    await expect(f.json({ choices: [{ message: { content: 'answer', audio: { id: 'audio' } }, finish_reason: 'stop' }] })).rejects.toMatchObject({ code: 'unsupported_content' });
  });

  test('invalid or multi-candidate SSE poisons the encoder even under legacy resilient hooks', async () => {
    const f = await fixture();
    f.context.strict = false;
    await f.push({ choices: [{ index: 0, delta: { content: 'one' } }, { index: 1, delta: { content: 'two' } }] });
    // The legacy map hook may preserve the rejected envelope; finish must still fail closed.
    await expect(f.finish()).rejects.toMatchObject({ code: 'invalid_stream' });
    const malformed = await fixture();
    await expect(malformed.hooks.onStreamChunk.promise({ data: 'not-json' } as any, malformed.context)).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(malformed.finish()).rejects.toMatchObject({ code: 'invalid_stream' });
  });

  test('shared terminal output supplies local stream history with original tool call ids', async () => {
    const f = await fixture();
    await f.push(choice({ tool_calls: [{ index: 0, id: 'original-call-id', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] }, 'tool_calls'));
    const terminal = events(await f.finish()).at(-1)!;
    const next = { ...f.context, requestId: 'tool-follow-up', url: new URL('https://fixture.test/v1/responses'), body: {
      model: 'legacy-model', previous_response_id: terminal.response.id, input: 'continue',
    } };
    await f.hooks.onBeforeRequest.promise(next);
    expect(next.body.messages[1]).toMatchObject({ role: 'assistant', tool_calls: [{
      id: 'original-call-id', function: { name: 'weather', arguments: '{"city":"Shanghai"}' },
    }] });
    expect(next.body.messages[2]).toMatchObject({ role: 'user', content: 'continue' });
  });
});
