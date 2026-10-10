import { expect, test, describe } from 'bun:test';
import { createProtocolSession, describeProtocolConversion, LLM_PROTOCOLS, type LLMProtocol, type ProtocolSessionContext } from '../src/protocol-session';
import { ResponsesCodecError, ResponsesEventEncoder } from '../src/responses-codec';
const model = 'fixture-model';
const request = (p: LLMProtocol): any => {
  if (p === 'responses')
    return { model, input: [{ role: 'user', content: '  hello\n' }, { type: 'function_call', call_id: 'old', name: 'f', arguments: '{"q":1}' }, { type: 'function_call_output', call_id: 'old', output: '  result\n' }, { role: 'user', content: 'next' }], tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: { q: { type: 'integer', minimum: 1 } }, additionalProperties: false } }], max_output_tokens: 4096 };
  if (p === 'chat_completions')
    return { model, messages: [{ role: 'user', content: '  hello\n' }, { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'f', arguments: '{"q":1}' } }] }, { role: 'tool', tool_call_id: 'old', content: '  result\n' }, { role: 'user', content: 'next' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { q: { type: 'integer', minimum: 1 } }, additionalProperties: false } } }], max_completion_tokens: 4096 };
  if (p === 'anthropic_messages')
    return { model, messages: [{ role: 'user', content: '  hello\n' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'f', input: { q: 1 } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: '  result\n' }, { type: 'text', text: 'next' }] }], tools: [{ name: 'f', input_schema: { type: 'object', properties: { q: { type: 'integer', minimum: 1 } }, additionalProperties: false } }], max_tokens: 4096 };
  return { contents: [{ role: 'user', parts: [{ text: '  hello\n' }] }, { role: 'model', parts: [{ functionCall: { id: 'old', name: 'f', args: { q: 1 } } }] }, { role: 'user', parts: [{ functionResponse: { id: 'old', name: 'f', response: { value: '  result\n' } } }, { text: 'next' }] }], tools: [{ functionDeclarations: [{ name: 'f', parametersJsonSchema: { type: 'object', properties: { q: { type: 'integer', minimum: 1 } }, additionalProperties: false } }] }], generationConfig: { maxOutputTokens: 4096 } };
};
const ctx = (sourceProtocol: LLMProtocol, targetProtocol: LLMProtocol): ProtocolSessionContext => ({ sourceProtocol, targetProtocol, model, capabilities: { maxOutputTokens: 4096, reasoningHistory: true, geminiJsonSchema: true } });
function name(body: any, p: LLMProtocol): string { return p === 'chat_completions' ? body.tools[0].function.name : p === 'anthropic_messages' ? body.tools[0].name : p === 'responses' ? body.tools[0].name : body.tools[0].functionDeclarations[0].name; }
function response(p: LLMProtocol, n: string): any {
  if (p === 'chat_completions')
    return { choices: [{ index: 0, message: { role: 'assistant', content: 'answer', tool_calls: [{ id: 'new', type: 'function', function: { name: n, arguments: '{"q":2}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } };
  if (p === 'anthropic_messages')
    return { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'new', name: n, input: { q: 2 } }], stop_reason: 'tool_use', usage: { input_tokens: 9, cache_read_input_tokens: 3, output_tokens: 7 } };
  if (p === 'gemini_generate_content')
    return { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }, { functionCall: { id: 'new', name: n, args: { q: 2 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, cachedContentTokenCount: 3, totalTokenCount: 19 } };
  return { id: 'resp_fixture', object: 'response', created_at: 1, model, status: 'completed', output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }, { id: 'fc', type: 'function_call', call_id: 'new', name: n, arguments: '{"q":2}', status: 'completed' }], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
function stream(p: LLMProtocol, n: string): any[] {
  if (p === 'chat_completions')
    return [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'new', type: 'function', function: { name: n, arguments: '{"q":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }];
  if (p === 'anthropic_messages')
    return [{ type: 'message_start', message: { usage: { input_tokens: 9, cache_read_input_tokens: 3, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'new', name: n, input: {} } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '2}' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }, { type: 'message_stop' }];
  if (p === 'gemini_generate_content')
    return [{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] }, { candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'new', name: n, args: { q: 2 } } }] }, finishReason: 'STOP' }] }, { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19, cachedContentTokenCount: 3 } }];
  const enc = new ResponsesEventEncoder('chat_completions', model);
  const events = [];
  for (const e of stream('chat_completions', n))
    events.push(...enc.push(e));
  events.push(...enc.finish());
  return events;
}
function code(fn: () => unknown, value: string, param?: string) {
  try {
    fn();
    throw new Error('expected rejection');
  }
  catch (e) {
    expect(e).toBeInstanceOf(ResponsesCodecError);
    expect((e as ResponsesCodecError).code).toBe(value);
    if (param)
      expect((e as ResponsesCodecError).param).toBe(param);
  }
}
describe('pure protocol sessions, local fixtures for the complete declared matrix', () => {
  test('description exposes 4 passthrough, 10 conversions, 2 unsupported pairs', () => { const d = describeProtocolConversion(); expect(d.rulesVersion).toBe('1.0.1'); expect(d.matrix.filter(x => x.mode === 'convert')).toHaveLength(10); expect(d.matrix.filter(x => x.mode === 'passthrough')).toHaveLength(4); expect(d.matrix.filter(x => x.mode === 'unsupported')).toHaveLength(2); });
  for (const source of LLM_PROTOCOLS)
    for (const target of LLM_PROTOCOLS) {
      const pair = describeProtocolConversion().matrix.find(x => x.sourceProtocol === source && x.targetProtocol === target)!;
      if (pair.mode === 'unsupported') {
        test(`${source}→${target}: explicitly rejected`, () => code(() => createProtocolSession(ctx(source, target)), 'unsupported_protocol_pair'));
        continue;
      }
      if (pair.mode === 'passthrough') {
        test(`${source}: request/response/events retain exact object identity`, () => {
          const r = request(source), s = createProtocolSession(ctx(source, target)); expect(s.convertRequest(r).body).toBe(r); const b = response(source, 'f'); expect(s.convertResponse(b)).toBe(b); const streaming = createProtocolSession(ctx(source, target)); streaming.convertRequest(r); for (const event of stream(source, 'f'))
            expect(streaming.push(event)).toEqual([event]); expect(streaming.finish()).toEqual([]);
        });
        continue;
      }
      test(`${source}→${target}: tool history, JSON response and bounded stream terminal`, () => {
        const s = createProtocolSession(ctx(source, target));
        expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
        expect(Object.keys(s)).toEqual(['convertRequest', 'convertResponse', 'push', 'finish', 'dispose']);
        const converted = s.convertRequest(request(source));
        expect(converted.canonicalHistory.some(i => i.call_id === 'old')).toBe(true);
        expect(JSON.stringify(converted.body)).toContain('  hello\\n');
        expect(JSON.stringify(converted.body)).toContain('minimum');
        const n = name(converted.body, target), out = s.convertResponse(response(target, n));
        expect(JSON.stringify(out)).toContain('answer');
        expect(JSON.stringify(out)).toContain('new');
        expect(JSON.stringify(out)).toContain('"f"');
        expect(JSON.stringify(out)).not.toContain('bungee_tool_');
        const streaming = createProtocolSession(ctx(source, target));
        const c = streaming.convertRequest(request(source));
        const events = stream(target, name(c.body, target)).flatMap(e => streaming.push(e));
        events.push(...streaming.finish());
        expect(JSON.stringify(events)).toContain('answer');
        expect(JSON.stringify(events)).toContain('"f"');
        expect(JSON.stringify(events)).toContain('new');
        expect(source === 'responses' ? events.at(-1)?.type === 'response.completed' : source === 'anthropic_messages' ? events.at(-1)?.type === 'message_stop' : source === 'gemini_generate_content' ? JSON.stringify(events.at(-1)).includes('STOP') : JSON.stringify(events.at(-1)).includes('tool_calls')).toBe(true);
        expect(streaming.finish()).toEqual([]);
        code(() => streaming.push(stream(target, n)[0]), 'invalid_stream');
      });
      test(`${source}→${target}: no terminal and unknown request/response content reject`, () => {
        const missing = createProtocolSession(ctx(source, target));
        missing.convertRequest(request(source));
        const first = stream(target, 'bungee_tool_0')[0];
        missing.push(first);
        code(() => missing.finish(), 'missing_terminal');
        const unknown = createProtocolSession(ctx(source, target));
        code(() => unknown.convertRequest({ ...request(source), unexpected_constraint: true }), 'unsupported_request', 'unexpected_constraint');
        const bad = createProtocolSession(ctx(source, target));
        const c = bad.convertRequest(request(source));
        const b = response(target, name(c.body, target));
        if (target === 'responses')
          b.output.push({ type: 'opaque_execution', data: 'secret' });
        else if (target === 'chat_completions')
          b.choices[0].message.audio = { data: 'secret' };
        else if (target === 'anthropic_messages')
          b.content.push({ type: 'opaque_execution', data: 'secret' });
        else
          b.candidates[0].content.parts.push({ executableCode: { code: 'secret' } });
        code(() => bad.convertResponse(b), 'unsupported_content');
      });
    }
});
test('namespace/custom Responses calls and split escape streams restore original bytes', () => {
  for (const target of ['chat_completions', 'anthropic_messages'] as const) {
    const context = ctx('responses', target), s = createProtocolSession(context);
    const c = s.convertRequest({ model, input: 'hello', max_output_tokens: 4096, tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }, { type: 'custom', name: 'shell', format: { type: 'text' } }] });
    const names = [...c.toolNames.keys()], callText = 'echo "你好"\n\\$HOME', args = JSON.stringify({ input: callText });
    let events: any[] = [];
    if (target === 'chat_completions') {
      events.push(...s.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: names[0], arguments: '{}' } }, { index: 1, id: 'b', function: { name: names[1], arguments: args.slice(0, 12) } }] } }] }));
      for (let i = 12; i < args.length; i += 2)
        events.push(...s.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: args.slice(i, i + 2) } }] } }] }));
      events.push(...s.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    }
    else {
      events.push(...s.push({ type: 'message_start', message: {} }));
      for (const [index, name] of names.entries()) {
        events.push(...s.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: index ? 'b' : 'a', name, input: index ? { input: callText } : {} } }));
        events.push(...s.push({ type: 'content_block_stop', index }));
      }
      events.push(...s.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
      events.push(...s.push({ type: 'message_stop' }));
    }
    events.push(...s.finish());
    expect(events.at(-1).response.output).toMatchObject([{ name: 'read', namespace: 'files', arguments: '{}' }, { type: 'custom_tool_call', name: 'shell', input: callText }]);
    expect(events.filter(e => e.type === 'response.custom_tool_call_input.delta').map(e => e.delta).join('')).toBe(callText);
  }
});
test('wire effort mapping is explicit; Anthropic effort and budget are distinct', () => {
  const input = { model, input: 'hello', max_output_tokens: 4096, reasoning: { effort: 'high' } };
  code(() => createProtocolSession({ ...ctx('responses', 'chat_completions'), capabilities: { reasoningEffort: true } }).convertRequest(input), 'unsupported_reasoning', 'reasoning.effort');
  expect(createProtocolSession({ ...ctx('responses', 'chat_completions'), capabilities: { reasoningEffort: true }, reasoningPolicy: { effortMap: { high: 'medium' } } }).convertRequest(input).body.reasoning_effort).toBe('medium');
  const c = createProtocolSession({ ...ctx('responses', 'anthropic_messages'), capabilities: { anthropicEffort: true }, reasoningPolicy: { effortMap: { high: 'high' }, anthropicThinkingMode: 'adaptive' } }).convertRequest(input);
  expect(c.body.output_config).toEqual({ effort: 'high' });
  expect(c.body.thinking).toEqual({ type: 'adaptive' });
  const budget = createProtocolSession({ ...ctx('responses', 'anthropic_messages'), reasoningPolicy: { anthropicThinkingBudget: 2048 } }).convertRequest(input);
  expect(budget.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  expect(budget.body.output_config).toBeUndefined();
});
test('structured schemas retain constraints and require explicit native capabilities', () => {
  const schema = { type: 'object', properties: { x: { type: 'string', minLength: 2 } }, required: ['x'], additionalProperties: false };
  const raw = { ...request('chat_completions'), response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } } };
  const gem = createProtocolSession(ctx('chat_completions', 'gemini_generate_content')).convertRequest(raw);
  expect((gem.body.generationConfig as any).responseJsonSchema).toEqual(schema);
  const anth = createProtocolSession({ ...ctx('chat_completions', 'anthropic_messages'), capabilities: { anthropicStructuredOutput: true } }).convertRequest(raw);
  expect((anth.body.output_config as any).format.schema).toEqual(schema);
  code(() => createProtocolSession(ctx('chat_completions', 'anthropic_messages')).convertRequest(raw), 'unsupported_request', 'text.format');
  code(() => createProtocolSession(ctx('responses', 'chat_completions')).convertRequest({ model, input: 'x', tools: [{ type: 'custom', name: 'x', format: { type: 'grammar', definition: 'source' } }] }), 'unsupported_tool');
});
test('disposal drops retained sessions and errors are sanitized', () => {
  const s = createProtocolSession(ctx('chat_completions', 'anthropic_messages'));
  s.dispose();
  s.dispose();
  code(() => s.convertRequest(request('chat_completions')), 'session_disposed');
  const failed = createProtocolSession(ctx('chat_completions', 'anthropic_messages'));
  expect(failed.convertResponse({ type: 'error', error: { message: 'secret upstream body', code: 'private-key' } })).toEqual({ error: { code: 'upstream_error', type: 'api_error', message: 'Upstream protocol request failed' } });
});

test('all ten conversion directions keep truncation explicit in JSON and streams', () => {
  for (const pair of describeProtocolConversion().matrix.filter(x => x.mode === 'convert')) {
    const context = ctx(pair.sourceProtocol, pair.targetProtocol), p = pair.targetProtocol;
    const raw = p === 'responses' ? { id: 'resp', created_at: 1, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial', annotations: [] }] }], usage: null } : p === 'chat_completions' ? { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] } : p === 'anthropic_messages' ? { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' } : { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] };
    const output = createProtocolSession(context).convertResponse(raw); expect(JSON.stringify(output)).toContain('partial'); expect(JSON.stringify(output)).toContain(pair.sourceProtocol === 'responses' ? 'incomplete' : pair.sourceProtocol === 'chat_completions' ? 'length' : pair.sourceProtocol === 'anthropic_messages' ? 'max_tokens' : 'MAX_TOKENS');
    const s = createProtocolSession(context); let input: any[];
    if (p === 'responses') { const e = new ResponsesEventEncoder('chat_completions', model); input = [...e.push({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }), ...e.finish()]; }
    else if (p === 'chat_completions') input = [{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }];
    else if (p === 'anthropic_messages') input = [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }];
    else input = [{ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }];
    const events = input.flatMap(e => s.push(e)); events.push(...s.finish()); expect(JSON.stringify(events)).toContain(pair.sourceProtocol === 'responses' ? 'response.incomplete' : pair.sourceProtocol === 'chat_completions' ? 'length' : pair.sourceProtocol === 'anthropic_messages' ? 'max_tokens' : 'MAX_TOKENS');
  }
});
test('Responses stream rejects changed final snapshots, post-done deltas and unknown events', () => {
  const input = stream('responses', 'f');
  const snapshot = createProtocolSession(ctx('chat_completions', 'responses')); for (const e of input.slice(0, -1)) snapshot.push(e); const final = structuredClone(input.at(-1)); final.response.output[0].content[0].text = 'tampered'; code(() => snapshot.push(final), 'invalid_stream');
  const late = createProtocolSession(ctx('chat_completions', 'responses')); const endIndex = input.findIndex(e => e.type === 'response.output_text.done'); for (const e of input.slice(0, endIndex + 1)) late.push(e); const done = input[endIndex]; const delta = { ...done, type: 'response.output_text.delta', sequence_number: done.sequence_number + 1, delta: 'hidden' }; delete delta.text; code(() => late.push(delta), 'invalid_stream');
  const unknown = createProtocolSession(ctx('chat_completions', 'responses')); unknown.push(input[0]); code(() => unknown.push({ type: 'response.opaque_execution', payload: 'secret' }), 'unsupported_response', 'type');
});
test('Gemini text/tool/text preserves block order and Chat JSON rejects its unrepresentable order', () => {
  const context = ctx('anthropic_messages', 'gemini_generate_content'), s = createProtocolSession(context); const c = s.convertRequest(request('anthropic_messages')), n = name(c.body, 'gemini_generate_content');
  const raw = { candidates: [{ content: { role: 'model', parts: [{ text: 'before' }, { functionCall: { id: 'new', name: n, args: { q: 2 } } }, { text: 'after' }] }, finishReason: 'STOP' }] };
  expect((s.convertResponse(raw).content as any[]).map(b => b.type)).toEqual(['text', 'tool_use', 'text']);
  const streamed = createProtocolSession(context); streamed.convertRequest(request('anthropic_messages')); const events = [...streamed.push(raw), ...streamed.finish()]; expect(events.filter(e => e.type === 'content_block_start').map(e => (e.content_block as any).type)).toEqual(['text', 'tool_use', 'text']);
  const chat = createProtocolSession(ctx('chat_completions', 'gemini_generate_content')); chat.convertRequest(request('chat_completions')); code(() => chat.convertResponse(raw), 'unsupported_response', 'output');
});
test('provider signatures, unknown constraints and guessed thinking mappings fail explicitly', () => {
  const signed = createProtocolSession(ctx('chat_completions', 'anthropic_messages')); code(() => signed.convertResponse({ content: [{ type: 'thinking', thinking: 'private', signature: 'authority' }], stop_reason: 'end_turn' }), 'unsupported_reasoning', 'content.signature');
  const schema = { ...request('chat_completions'), response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, unknown_constraint: true } } }; code(() => createProtocolSession({ ...ctx('chat_completions', 'anthropic_messages'), capabilities: { anthropicStructuredOutput: true } }).convertRequest(schema), 'unsupported_request', 'text.format.unknown_constraint');
  const thinking = { ...request('anthropic_messages'), thinking: { type: 'enabled', budget_tokens: 1024 } }; code(() => createProtocolSession({ ...ctx('anthropic_messages', 'chat_completions'), reasoningPolicy: {} }).convertRequest(thinking), 'unsupported_reasoning', 'thinking');
  expect(createProtocolSession({ ...ctx('anthropic_messages', 'chat_completions'), capabilities: { reasoningEffort: true }, reasoningPolicy: { targetEffort: 'medium' } }).convertRequest(thinking).body.reasoning_effort).toBe('medium');
  code(() => createProtocolSession(ctx('responses', 'chat_completions')).convertRequest({ model, input: 'hello', tools: [{ type: 'web_search' }], tool_choice: 'required' }), 'unsupported_tool', 'tools[0].type');
});

test('Codex cached search declaration is omitted with a safe diagnostic across converted targets', () => {
  const functions = Array.from({ length: 28 }, (_, i) => ({ type: 'function', name: `fixture_${i}`, parameters: { type: 'object', properties: {} } }));
  const raw = { model, input: 'hello', tools: [...functions, { type: 'web_search', external_web_access: false }], tool_choice: 'auto' };
  for (const target of ['chat_completions', 'anthropic_messages'] as const) {
    const converted = createProtocolSession(ctx('responses', target)).convertRequest(raw);
    expect(converted.body.tools).toHaveLength(28);
    expect(converted.diagnostics).toContainEqual({ param: 'tools[28]', action: 'omitted', reason: 'optional_hosted_web_search_unavailable' });
    expect(JSON.stringify(converted.body)).not.toContain('web_search');
    for (const tool_choice of ['required', { type: 'web_search' }])
      code(() => createProtocolSession(ctx('responses', target)).convertRequest({ ...raw, tool_choice }), 'unsupported_tool', 'tools[28].type');
    code(() => createProtocolSession(ctx('responses', target)).convertRequest({ ...raw, tools: [{ type: 'web_search', external_web_access: 'false' }] }), 'invalid_payload', 'tools[0].external_web_access');
    code(() => createProtocolSession(ctx('responses', target)).convertRequest({ ...raw, tools: [{ type: 'web_search', unknown_search_constraint: true }] }), 'unsupported_tool', 'tools[0].unknown_search_constraint');
  }
  const same = createProtocolSession(ctx('responses', 'responses')).convertRequest(raw);
  expect(same.body.tools).toEqual(raw.tools);
  expect(same.diagnostics).toEqual([]);
});

test('optional hosted search is validated, bounded, and remains distinct from tool execution history', () => {
  const convert = (tool: any, extra: any = {}) => createProtocolSession(ctx('responses', 'chat_completions')).convertRequest({ model, input: 'hello', tools: [tool], ...extra });
  const tool = { type: 'web_search', external_web_access: false, indexed_web_access: true, search_context_size: 'low', search_content_types: ['text', 'image'],
    filters: { allowed_domains: ['example.invalid'], blocked_domains: [] }, user_location: { type: 'approximate', country: 'US', timezone: 'UTC' } };
  for (const tool_choice of [undefined, 'auto', 'none']) {
    const result = convert(tool, { tool_choice });
    expect(result.body).not.toHaveProperty('tools');
    expect(result.diagnostics).toEqual([{ param: 'tools[0]', action: 'omitted', reason: 'optional_hosted_web_search_unavailable' }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('example.invalid');
    for (const target of ['chat_completions', 'anthropic_messages'] as const) {
      const noTools = createProtocolSession(ctx('responses', target)).convertRequest({ model, input: 'hello', tools: [tool], tool_choice, parallel_tool_calls: true });
      expect(noTools.body).not.toHaveProperty('tools');
      expect(noTools.body).not.toHaveProperty('tool_choice');
      expect(noTools.body).not.toHaveProperty('parallel_tool_calls');
    }
  }
  for (const [option, param] of [
    [{ search_context_size: ['low'] }, 'search_context_size'], [{ indexed_web_access: null }, 'indexed_web_access'],
    [{ filters: { allowed_domains: 'example.invalid' } }, 'filters.allowed_domains'],
    [{ user_location: { type: 'precise' } }, 'user_location.type'], [{ search_content_types: ['audio'] }, 'search_content_types'],
  ] as const) code(() => convert({ ...tool, ...option }), 'invalid_payload', `tools[0].${param}`);
  code(() => convert({ ...tool, filters: { unknown: true } }), 'unsupported_tool', 'tools[0].filters.unknown');
  code(() => convert({ type: ['web_search'] }), 'unsupported_tool', 'tools[0]');
  const carrier = createProtocolSession(ctx('responses', 'chat_completions')).convertRequest({ model, input: [{type: 'additional_tools', tools: [tool]}, {role: 'user', content: 'hello'}] });
  expect(carrier.canonicalHistory).toEqual([{ role: 'user', content: 'hello' }]);
  expect(carrier.diagnostics).toContainEqual({ param: 'input[0].tools[0]', action: 'omitted', reason: 'optional_hosted_web_search_unavailable' });
  code(() => convert(tool, {input: [{type: 'web_search_call', id: 'hosted_history', status: 'completed'}]}), 'unsupported_content');
  code(() => createProtocolSession({...ctx('responses', 'chat_completions'), capabilities: {limits: {maxItems: 1}}}).convertRequest({model, input: 'hello', tools: [tool, tool]}), 'resource_limit');
});
test('request/output limits and undeclared returned tools remain bounded and fail closed', () => {
  code(() => createProtocolSession({ ...ctx('chat_completions', 'anthropic_messages'), capabilities: { limits: { maxRequestBytes: 50 } } }).convertRequest(request('chat_completions')), 'resource_limit');
  const s = createProtocolSession(ctx('chat_completions', 'responses')); s.convertRequest(request('chat_completions')); code(() => s.convertResponse(response('responses', 'undeclared-secret')), 'unknown_tool', 'output.name');
  const limited = createProtocolSession({ ...ctx('responses', 'chat_completions'), capabilities: { limits: { maxOutputBytes: 1000 } } }); for (let i = 0; i < 8; i++)limited.push({ choices: [{ delta: { content: 'x'.repeat(100) } }] }); code(() => limited.push({ choices: [{ delta: { content: 'x'.repeat(300) } }] }), 'resource_limit');
});
test('plain reasoning history preserves portable blocks and never fabricates Anthropic replay authority', () => {
  const raw = { model, max_completion_tokens: 4096, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', reasoning_content: 'thinking', content: 'answer' }] };
  code(()=>createProtocolSession(ctx('chat_completions','anthropic_messages')).convertRequest(raw),'unsupported_reasoning');
  const gemini = createProtocolSession(ctx('chat_completions', 'gemini_generate_content')).convertRequest(raw); expect((gemini.body.contents as any[])[1].parts).toEqual([{ text: 'thinking', thought: true }, { text: 'answer' }]);
  expect((gemini.body.generationConfig as any).thinkingConfig).toBeUndefined();
});
test('Gemini OpenAPI tool and output schemas convert their dialect without deleting constraints', () => {
  const raw = { ...request('gemini_generate_content'), tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'OBJECT', properties: { q: { type: 'INTEGER', minimum: 1 }, label: { type: 'STRING', minLength: 2, nullable: true } }, required: ['q'] } }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING', minLength: 2 } }, required: ['answer'] } } };
  const c = createProtocolSession(ctx('gemini_generate_content', 'chat_completions')).convertRequest(raw); expect((c.body.tools as any[])[0].function.parameters).toMatchObject({ type: 'object', properties: { q: { type: 'integer', minimum: 1 }, label: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }] } }, required: ['q'] }); expect((c.body.response_format as any).json_schema.schema.properties.answer).toEqual({ type: 'string', minLength: 2 });
  raw.tools[0].functionDeclarations[0].parameters = { type: 'OBJECT', propertyOrdering: ['q'] } as any; code(() => createProtocolSession(ctx('gemini_generate_content', 'chat_completions')).convertRequest(raw), 'unsupported_tool');
});
test('refusal history retains authority where expressible and fails where it is not', () => {
  const raw = { model, input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot' }] }], max_output_tokens: 4096 };
  expect((createProtocolSession(ctx('responses', 'chat_completions')).convertRequest(raw).body.messages as any[])[0].content).toEqual([{ type: 'refusal', refusal: 'cannot' }]);
  code(() => createProtocolSession(ctx('responses', 'anthropic_messages')).convertRequest(raw), 'unsupported_content');
  const chat = { model, messages: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot' }] }] }; expect((createProtocolSession(ctx('chat_completions', 'responses')).convertRequest(chat).body.input as any[])[0].content).toEqual([{ type: 'refusal', refusal: 'cannot' }]);
});
test('native Chat custom tools preserve custom call/result identity and exact input', () => {
  const raw = { model, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'custom', custom: { name: 'shell', input: 'echo "你好"\n' } }] }, { role: 'tool', tool_call_id: 'old', content: 'done' }, { role: 'user', content: 'next' }], tools: [{ type: 'custom', custom: { name: 'shell', format: { type: 'text' } } }] };
  const s = createProtocolSession(ctx('chat_completions', 'responses')), c = s.convertRequest(raw); expect((c.body.input as any[]).map(i => i.type)).toEqual(['custom_tool_call', 'custom_tool_call_output', undefined]); expect((c.body.tools as any[])[0]).toEqual({ type: 'custom', name: 'shell', format: { type: 'text' } });
  const out = s.convertResponse({ id: 'resp', created_at: 1, status: 'completed', output: [{ id: 'custom', type: 'custom_tool_call', call_id: 'new', name: 'shell', input: 'echo "你好"\n', status: 'completed' }], usage: null }); expect((out.choices as any[])[0].message.tool_calls[0]).toEqual({ id: 'new', type: 'custom', custom: { name: 'shell', input: 'echo "你好"\n' } });
});
test('Gemini transport streaming mode is explicit and never becomes an unsupported wire field',()=>{
  const incoming=createProtocolSession({...ctx('gemini_generate_content','chat_completions'),streaming:true}).convertRequest(request('gemini_generate_content'));expect(incoming.streaming).toBe(true);expect(incoming.body.stream).toBe(true);expect(incoming.body.stream_options).toEqual({include_usage:true});
  const outgoing=createProtocolSession({...ctx('chat_completions','gemini_generate_content'),streaming:true}).convertRequest({...request('chat_completions'),stream:true});expect(outgoing.streaming).toBe(true);expect(outgoing.body.stream).toBeUndefined();
  code(()=>createProtocolSession({...ctx('chat_completions','gemini_generate_content'),streaming:false}).convertRequest({...request('chat_completions'),stream:true}),'invalid_payload','stream');
});

test('Codex metadata on calls/results is diagnosed and removed without losing history or current instructions',()=>{
 const metadata={turn_id:'fixture-turn'};
 const session=createProtocolSession(ctx('responses','chat_completions'));
 const input=[{role:'user',content:'hello',internal_chat_message_metadata_passthrough:metadata},{type:'function_call',name:'f',call_id:'call',arguments:'{}',internal_chat_message_metadata_passthrough:metadata},{type:'function_call_output',call_id:'call',output:'done',internal_chat_message_metadata_passthrough:metadata}];
 const result=session.convertRequest({input,instructions:'this turn only',tools:[{type:'function',name:'f',parameters:{type:'object',properties:{}}}]});
 expect(result.canonicalHistory).toHaveLength(3);expect(result.canonicalHistory.every(item=>!Object.hasOwn(item,'internal_chat_message_metadata_passthrough'))).toBe(true);expect(result.diagnostics.filter(item=>item.reason==='source_message_metadata')).toHaveLength(3);
 expect(result.body.messages).toMatchObject([{role:'system',content:'this turn only'},{role:'user'},{role:'assistant',tool_calls:[{id:'call'}]},{role:'tool',tool_call_id:'call',content:'done'}]);
});
