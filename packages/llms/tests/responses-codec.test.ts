import { describe, expect, test } from 'bun:test';
import { decodeResponsesRequest, encodeResponsesResult, ResponsesCodecError, ResponsesEventEncoder,
  type ResponsesProtocol, type ResponsesToolNames } from '../src/responses-codec';

const protocols: ResponsesProtocol[] = ['chat_completions', 'anthropic_messages'];
const declarations = [
  { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] },
  { type: 'namespace', name: 'memory', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] },
  { type: 'custom', name: 'shell', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
];
const request = (extra: Record<string, unknown> = {}) => ({ model: 'fixture-model', max_output_tokens: 4096, store: false, input: 'hello', ...extra });
function wire(names: ResponsesToolNames, name: string, namespace?: string): string {
  return [...names].find(([, original]) => original.name === name && original.namespace === namespace)![0];
}
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ResponsesCodecError);
  expect((caught as ResponsesCodecError).code).toBe(code);
}
function jsonResult(protocol: ResponsesProtocol, names: ResponsesToolNames, args = '{"path":"x"}') {
  return protocol === 'chat_completions'
    ? { choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'reason', content: 'answer', tool_calls: [
      { id: 'call_a', type: 'function', function: { name: wire(names, 'read', 'files'), arguments: args } },
      { id: 'call_b', type: 'function', function: { name: wire(names, 'shell'), arguments: JSON.stringify({ input: 'echo "你好"\n\\$HOME' }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } } }
    : { type: 'message', content: [
      { type: 'thinking', thinking: 'reason', signature: 'provider-bound' }, { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call_a', name: wire(names, 'read', 'files'), input: JSON.parse(args) },
      { type: 'tool_use', id: 'call_b', name: wire(names, 'shell'), input: { input: 'echo "你好"\n\\$HOME' } },
    ], stop_reason: 'tool_use', usage: { input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 7 } };
}
function stream(protocol: ResponsesProtocol, names: ResponsesToolNames) {
  const encoder = new ResponsesEventEncoder(protocol, 'fixture-model', names);
  const events: Record<string, unknown>[] = [];
  const push = (event: unknown) => events.push(...encoder.push(event));
  if (protocol === 'chat_completions') {
    push({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'why' } }] });
    push({ choices: [{ delta: { content: 'hello' } }] });
    push({ choices: [{ delta: { content: ' world', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: wire(names, 'read', 'files'), arguments: '{"path":' } }] } }] });
    push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] });
    const args = JSON.stringify({ input: 'echo "你好"\n\\$HOME' });
    push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: wire(names, 'shell'), arguments: args.slice(0, 12) } }] } }] });
    for (const part of [args.slice(12, 15), args.slice(15, 19), args.slice(19)]) push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: part } }] } }] });
    push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    push({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } } });
  } else {
    push({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 0 } } });
    push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why' } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'provider-bound' } });
    push({ type: 'content_block_stop', index: 0 });
    push({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello world' } });
    push({ type: 'content_block_stop', index: 1 });
    push({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_a', name: wire(names, 'read', 'files'), input: {} } });
    push({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    push({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } });
    push({ type: 'content_block_stop', index: 2 });
    push({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_b', name: wire(names, 'shell'), input: {} } });
    const args = JSON.stringify({ input: 'echo "你好"\n\\$HOME' });
    for (let offset = 0; offset < args.length; offset += 3) push({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: args.slice(offset, offset + 3) } });
    push({ type: 'content_block_stop', index: 3 });
    push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
    push({ type: 'message_stop' });
  }
  events.push(...encoder.finish());
  return { encoder, events };
}

describe('Responses strict shared codec (mock protocol fixtures)', () => {
  for (const protocol of protocols) {
    test(`${protocol}: multi-round namespace/custom history preserves original names and bytes`, () => {
      const input = [
        { role: 'user', content: [{ type: 'input_text', text: '  original \n' }] },
        { type: 'function_call', call_id: 'a', name: 'read', namespace: 'files', arguments: '{"path":"x"}' },
        { type: 'function_call', call_id: 'b', name: 'read', namespace: 'memory', arguments: '{}' },
        { type: 'function_call_output', call_id: 'a', output: 'file result' },
        { type: 'function_call_output', call_id: 'b', output: 'memory result' },
        { role: 'assistant', content: 'next' },
        { type: 'custom_tool_call', call_id: 'c', name: 'shell', input: 'echo "你好"\n\\$HOME' },
        { type: 'custom_tool_call_output', call_id: 'c', output: 'success' },
        { role: 'user', content: 'continue' },
      ];
      const decoded = decodeResponsesRequest(request({ tools: declarations, input, tool_choice: { type: 'function', name: 'read', namespace: 'memory' } }), protocol);
      expect(wire(decoded.toolNames, 'read', 'files')).not.toBe(wire(decoded.toolNames, 'read', 'memory'));
      expect(decoded.body.tools).toHaveLength(3);
      expect(JSON.stringify(decoded.body)).toContain('  original \\n');
      const result = encodeResponsesResult(jsonResult(protocol, decoded.toolNames), protocol, 'public-model', decoded.toolNames);
      expect(result.status).toBe('completed');
      expect(result.model).toBe('public-model');
      const output = result.output as Record<string, unknown>[];
      expect(output.some(i => i.type === 'reasoning')).toBe(true);
      expect(output.find(i => i.call_id === 'call_a')).toMatchObject({ type: 'function_call', name: 'read', namespace: 'files', arguments: '{"path":"x"}' });
      expect(output.find(i => i.call_id === 'call_b')).toMatchObject({ type: 'custom_tool_call', name: 'shell', input: 'echo "你好"\n\\$HOME' });
      expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 5 } });
    });

    test(`${protocol}: SSE added → delta → done → completed, custom escapes and usage`, () => {
      const { toolNames } = decodeResponsesRequest(request({ tools: declarations }), protocol);
      const { encoder, events } = stream(protocol, toolNames);
      expect(events[0].type).toBe('response.created');
      expect(events.at(-1)!.type).toBe('response.completed');
      expect(events.map(e => e.sequence_number)).toEqual(events.map((_, index) => index));
      const added = events.filter(e => e.type === 'response.output_item.added');
      expect(added).toHaveLength(4);
      for (const event of added) {
        const index = event.output_index;
        const same = events.filter(e => e.output_index === index);
        expect(same[0].type).toBe('response.output_item.added');
        expect(same.at(-1)!.type).toBe('response.output_item.done');
        expect(same.some(e => String(e.type).endsWith('.delta'))).toBe(true);
      }
      expect(events.filter(e => e.type === 'response.custom_tool_call_input.delta').map(e => e.delta).join('')).toBe('echo "你好"\n\\$HOME');
      const response = events.at(-1)!.response as Record<string, unknown>;
      expect(response.usage).toMatchObject({ input_tokens: 12, output_tokens: 7, total_tokens: 19 });
      expect((response.output as Record<string, unknown>[])[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] });
      expect(encoder.finish()).toEqual([]);
      expectCode(() => encoder.push({}), 'invalid_stream');
    });

    test(`${protocol}: explicit truncation is incomplete; absent/unknown terminal never succeeds`, () => {
      const raw = protocol === 'chat_completions'
        ? { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] }
        : { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' };
      expect(encodeResponsesResult(raw, protocol, 'm')).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
      const noTerminal = protocol === 'chat_completions'
        ? { choices: [{ message: { role: 'assistant', content: 'partial' } }] }
        : { content: [{ type: 'text', text: 'partial' }] };
      expectCode(() => encodeResponsesResult(noTerminal, protocol, 'm'), 'missing_terminal');
      const encoder = new ResponsesEventEncoder(protocol, 'm');
      if (protocol === 'chat_completions') encoder.push({ choices: [{ delta: { content: 'partial' } }] });
      else { encoder.push({ type: 'message_start', message: {} }); encoder.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }); }
      expectCode(() => encoder.finish(), 'missing_terminal');
    });

    test(`${protocol}: errors preserve failed terminal and cannot become successful`, () => {
      const upstream = { type: 'error', error: { code: 'overloaded', message: 'try later' } };
      expect(encodeResponsesResult(upstream, protocol, 'm')).toMatchObject({ status: 'failed', error: upstream.error });
      const encoder = new ResponsesEventEncoder(protocol, 'm');
      const events = encoder.push(upstream);
      expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: upstream.error } });
      expect(encoder.finish()).toEqual([]);
    });

    test(`${protocol}: request references, encryption, compaction, hosted tools fail explicitly`, () => {
      expectCode(() => decodeResponsesRequest(request({ previous_response_id: 'resp_old' }), protocol), 'unresolved_reference');
      expectCode(() => decodeResponsesRequest(request({ input: [{ type: 'item_reference', id: 'x' }] }), protocol), 'unresolved_reference');
      for (const item of [{ type: 'reasoning', encrypted_content: 'sealed' }, { type: 'compaction', encrypted_content: 'sealed' }]) expectCode(() => decodeResponsesRequest(request({ input: [item] }), protocol), 'unsupported_content');
      expectCode(() => decodeResponsesRequest(request({ tools: [{ type: 'web_search' }], tool_choice: 'required' }), protocol), 'unsupported_tool');
      expectCode(() => decodeResponsesRequest(request({ tool_choice: { type: 'web_search' } }), protocol), 'unsupported_tool_choice');
      expectCode(() => decodeResponsesRequest(request({ input: [{ type: 'function_call_output', call_id: 'missing', output: 'x' }] }), protocol), 'invalid_tool_history');
      expectCode(() => decodeResponsesRequest(request({ tools: [{ type: 'function', name: 'x' }, { type: 'custom', name: 'x' }] }), protocol), 'tool_name_collision');
    });
  }

  test('capability-approved reasoning effort and Anthropic thinking budgets are explicit', () => {
    expectCode(() => decodeResponsesRequest(request({ reasoning: { effort: 'high' } }), 'chat_completions'), 'unsupported_reasoning');
    expect(decodeResponsesRequest(request({ reasoning: { effort: 'high' } }), 'chat_completions', { reasoningEffort: true }).body.reasoning_effort).toBe('high');
    expect(decodeResponsesRequest(request({ reasoning: { effort: 'high' } }), 'anthropic_messages', { anthropicThinkingBudget: 2048 }).body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expectCode(() => decodeResponsesRequest(request({ reasoning: { effort: 'high' } }), 'anthropic_messages', { anthropicThinkingBudget: 4096 }), 'unsupported_reasoning');
    expectCode(() => decodeResponsesRequest({ model: 'm', input: 'x' }, 'anthropic_messages'), 'missing_capability');
    expect(decodeResponsesRequest({ model: 'm', input: 'x' }, 'anthropic_messages', { maxOutputTokens: 100 }).body.max_tokens).toBe(100);
  });

  test('opaque wire aliases handle dotted names and collisions without guessing namespace', () => {
    const { toolNames } = decodeResponsesRequest(request({ tools: [{ type: 'function', name: 'files.read' }, ...declarations] }), 'chat_completions');
    expect(new Set(toolNames.keys()).size).toBe(4);
    expect(wire(toolNames, 'files.read')).not.toBe(wire(toolNames, 'read', 'files'));
  });

  test('name fragments buffer metadata until authority resolves; argument fragments preserve duplicates', () => {
    const { toolNames } = decodeResponsesRequest(request({ tools: declarations }), 'chat_completions');
    const encoder = new ResponsesEventEncoder('chat_completions', 'm', toolNames);
    const name = wire(toolNames, 'read', 'files');
    const first = encoder.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: name.slice(0, 5), arguments: '{"s":"' } }] } }] });
    expect(first.some(e => e.type === 'response.output_item.added')).toBe(false);
    const second = encoder.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: name.slice(5), arguments: 'aa' } }] } }] });
    expect(second[0].type).toBe('response.output_item.added');
    encoder.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'aa"}' } }] }, finish_reason: 'tool_calls' }] });
    expect(((encoder.finish().at(-1)!.response as Record<string, unknown>).output as Record<string, unknown>[])[0].arguments).toBe('{"s":"aaaa"}');
  });

  test('bounds cover request, output accumulation, tool argument and item counts', () => {
    expectCode(() => decodeResponsesRequest(request(), 'chat_completions', { limits: { maxRequestBytes: 20 } }), 'resource_limit');
    const encoder = new ResponsesEventEncoder('chat_completions', 'm', new Map(), { maxOutputBytes: 200 });
    for (let i = 0; i < 4; i++) encoder.push({ choices: [{ delta: { content: 'x'.repeat(50) } }] });
    expectCode(() => encoder.push({ choices: [{ delta: { content: 'x' } }] }), 'resource_limit');
    const args = new ResponsesEventEncoder('chat_completions', 'm', new Map(), { maxArgumentBytes: 4 });
    expectCode(() => args.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":1}' } }] } }] }), 'resource_limit');
    const items = new ResponsesEventEncoder('chat_completions', 'm', new Map(), { maxItems: 1 });
    items.push({ choices: [{ delta: { content: 'x' } }] });
    expectCode(() => items.push({ choices: [{ delta: { reasoning_content: 'y' } }] }), 'resource_limit');
  });

  test('invalid custom JSON, undeclared tools and malformed successful arguments are rejected', () => {
    const { toolNames } = decodeResponsesRequest(request({ tools: declarations }), 'chat_completions');
    const malformed = jsonResult('chat_completions', toolNames, '{"unfinished":');
    expectCode(() => encodeResponsesResult(malformed, 'chat_completions', 'm', toolNames), 'invalid_tool_arguments');
    const custom = { choices: [{ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: wire(toolNames, 'shell'), arguments: '{"input":"x","extra":1}' } }] }, finish_reason: 'tool_calls' }] };
    expectCode(() => encodeResponsesResult(custom, 'chat_completions', 'm', toolNames), 'invalid_tool_arguments');
    expectCode(() => encodeResponsesResult({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'unknown', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'chat_completions', 'm', toolNames), 'unknown_tool');
    expectCode(() => encodeResponsesResult({ choices: [{ message: { content: 'x' }, finish_reason: 'mystery' }] }, 'chat_completions', 'm'), 'unknown_terminal');
  });

  test('incomplete tool arguments stay partial and never become executable successful calls', () => {
    const encoder = new ResponsesEventEncoder('chat_completions', 'm');
    encoder.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":' } }] }, finish_reason: 'length' }] });
    const events = encoder.finish();
    expect(events.at(-1)!.type).toBe('response.incomplete');
    expect((events.at(-1)!.response as Record<string, unknown>).output).toMatchObject([{ status: 'incomplete', arguments: '{"x":' }]);
  });

  test('Anthropic requires block stop before message stop and rejects deltas after stop', () => {
    const encoder = new ResponsesEventEncoder('anthropic_messages', 'm');
    encoder.push({ type: 'message_start', message: {} });
    encoder.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } });
    encoder.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    expectCode(() => encoder.push({ type: 'message_stop' }), 'invalid_stream');
    expectCode(() => encoder.finish(), 'invalid_stream');
  });

  test('Chat refusal events and JSON schema formatting preserve Responses types', () => {
    const encoder = new ResponsesEventEncoder('chat_completions', 'm');
    const events = encoder.push({ choices: [{ delta: { refusal: 'cannot' }, finish_reason: 'stop' }] });
    events.push(...encoder.finish());
    expect(events.some(e => e.type === 'response.refusal.delta')).toBe(true);
    expect(((events.at(-1)!.response as Record<string, unknown>).output as Record<string, unknown>[])[0].content).toEqual([{ type: 'refusal', refusal: 'cannot' }]);
    expect(decodeResponsesRequest(request({ text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } }), 'chat_completions').body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } });
  });

  test('capability hints with no faithful mapping and unknown content are explicit errors', () => {
    expectCode(() => decodeResponsesRequest(request({ reasoning: { summary: 'auto' } }), 'chat_completions', { reasoningEffort: true }), 'unsupported_reasoning');
    expectCode(() => decodeResponsesRequest(request({ text: { verbosity: 'low' } }), 'chat_completions'), 'unsupported_request');
    expectCode(() => decodeResponsesRequest(request({ include: ['web_search_call.action.sources'] }), 'chat_completions'), 'unsupported_request');
    expectCode(() => decodeResponsesRequest(request({ store: true }), 'chat_completions'), 'unsupported_request');
    expectCode(() => decodeResponsesRequest(request({ unknown_parameter: true }), 'chat_completions'), 'unsupported_request');
    expectCode(() => decodeResponsesRequest(request({ tools: [{ type: 'function', name: 'strict', strict: true }] }), 'anthropic_messages'), 'unsupported_tool');
    expectCode(() => decodeResponsesRequest(request({ input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }), 'chat_completions'), 'unsupported_content');
    expectCode(() => encodeResponsesResult({ content: [{ type: 'redacted_thinking', data: 'sealed' }], stop_reason: 'end_turn' }, 'anthropic_messages', 'm'), 'unsupported_content');
    expectCode(() => encodeResponsesResult({ choices: [{ message: { content: 'x', audio: { id: 'a' } }, finish_reason: 'stop' }] }, 'chat_completions', 'm'), 'unsupported_content');
  });

  test('Chat image detail and plain reasoning history retain validated payloads', () => {
    const decoded = decodeResponsesRequest(request({ input: [
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image.png', detail: 'high' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      { role: 'assistant', content: 'answer' },
    ] }), 'chat_completions', { reasoningEffort: true });
    expect(decoded.body.messages).toMatchObject([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'high' } }] },
      { role: 'assistant', reasoning_content: 'thought', content: 'answer' },
    ]);
    expectCode(() => decodeResponsesRequest(request({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/i.png' }] }] }), 'anthropic_messages'), 'unsupported_content');
  });

  test('multiple candidates, negative usage and post-terminal deltas are never hidden', () => {
    expectCode(() => encodeResponsesResult({ choices: [{ message: {} }, { message: {} }] }, 'chat_completions', 'm'), 'unsupported_response');
    expectCode(() => encodeResponsesResult({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: -1 } }, 'chat_completions', 'm'), 'invalid_usage');
    const encoder = new ResponsesEventEncoder('chat_completions', 'm');
    encoder.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] });
    expectCode(() => encoder.push({ choices: [{ delta: { content: 'y' } }] }), 'invalid_stream');
    expectCode(() => encoder.finish(), 'invalid_stream');
  });

  test('Anthropic cache creation and stop sequence preserve completion and usage', () => {
    const result = encodeResponsesResult({ content: [{ type: 'text', text: 'x' }], stop_reason: 'stop_sequence', usage: { input_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 4 } }, 'anthropic_messages', 'm');
    expect(result.status).toBe('completed');
    expect(result.usage).toMatchObject({ input_tokens: 15, output_tokens: 4, total_tokens: 19, input_tokens_details: { cached_tokens: 5 } });
  });

  test('provider error closes existing partial items before failed response', () => {
    const encoder = new ResponsesEventEncoder('chat_completions', 'm');
    encoder.push({ choices: [{ delta: { content: 'partial' } }] });
    const events = encoder.push({ error: { code: 'upstream_error', message: 'reset' } });
    expect(events.map(e => e.type)).toEqual(['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.failed']);
    expect(events[2].item).toMatchObject({ status: 'incomplete' });
  });
});

test('refusal output can be replayed as assistant history for either target protocol',()=>{
  const result=encodeResponsesResult({choices:[{message:{role:'assistant',content:null,refusal:'I cannot help with that.'},finish_reason:'stop'}]},'chat_completions','m');
  for(const protocol of ['chat_completions','anthropic_messages'] as const){
    const next=decodeResponsesRequest({model:'m',input:[{role:'user',content:'old question'},...result.output,{role:'user',content:'new question'}]},protocol,{maxOutputTokens:4096});
    expect(JSON.stringify(next.body.messages[1])).toContain('I cannot help with that.');
    expect(next.body.messages.at(-1).role).toBe('user');
  }
});

test('real CLI optional encrypted-output and metadata preferences remain compatible without opaque history', () => {
  for (const protocol of protocols) {
    const raw = request({prompt_cache_key:'fixture-cache',client_metadata:{client:'codex'},include:['reasoning.encrypted_content'],
      tools:[{type:'web_search'},...declarations],tool_choice:'auto',reasoning:{effort:'none'},store:false});
    const decoded = decodeResponsesRequest(raw,protocol,{omitOptionalWebSearch:true});
    expect(decoded.body.tools).toHaveLength(3);
    expect(decoded.body).not.toHaveProperty('client_metadata');
    expect(decoded.body).not.toHaveProperty('include');
    expectCode(() => decodeResponsesRequest({...raw,tool_choice:'required'},protocol,{omitOptionalWebSearch:true}),'unsupported_tool');
    expectCode(() => decodeResponsesRequest({...raw,tool_choice:{type:'web_search'}},protocol,{omitOptionalWebSearch:true}),'unsupported_tool');
    expectCode(() => decodeResponsesRequest({...raw,input:[{type:'reasoning',encrypted_content:'sealed'}]},protocol,{omitOptionalWebSearch:true}),'unsupported_content');
  }
});
