import { expect, test } from 'bun:test';
import { createProtocolSession, type ProtocolSessionContext } from '../../src/protocol-session';

const context: ProtocolSessionContext = {
  sourceProtocol: 'responses', targetProtocol: 'gemini_generate_content', model: 'gemini-fixture',
  agentMessageDelivery: 'plaintext', capabilities: { reasoningHistory: true },
};
// Semantic cases adapted from LiteLLM cfe0100e1fca613e7b1af27dd1fe4807ca4d1d1a:
// tests/unit/llms/vertex_ai/gemini/test_thought_signature_in_tool_call_id.py.
const signature = 'dGVzdF9zaWduYXR1cmU=';
const signedId = `call_first__thought__${signature}`;
const tools = [{ type: 'namespace', name: 'files', tools: [
  { type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { type: 'custom', name: 'shell', format: { type: 'text' } },
] }];
const request = { input: 'inspect files', tools, parallel_tool_calls: true };
const chunk = (parts: unknown[], finishReason?: string) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });

for (const streaming of [false, true]) test(`Gemini signed parallel tools and custom input round trip (${streaming ? 'SSE' : 'JSON'})`, () => {
  const session = createProtocolSession(context);
  const converted = session.convertRequest({ ...request, stream: streaming });
  const declarations = (converted.body.tools as any[])[0].functionDeclarations;
  expect(declarations[0].parametersJsonSchema.required).toEqual(['path']);
  expect(converted.diagnostics).toContainEqual({ param: 'parallel_tool_calls', action: 'omitted', reason: 'gemini_parallel_tool_calls_allowed' });
  expect(converted.body).not.toHaveProperty('parallel_tool_calls');
  expect(converted.body).not.toHaveProperty('stream');
  expect(converted.streaming).toBe(streaming);
  const parts = [
    { text: 'before', thoughtSignature: signature },
    { functionCall: { id: 'call_first', name: declarations[0].name, args: { path: 'a' } }, thoughtSignature: signature },
    { text: 'consider second', thought: true, thoughtSignature: signature },
    { functionCall: { id: 'call_second', name: declarations[0].name, args: { path: 'b' } } },
    { text: 'consider shell', thought: true },
    { functionCall: { id: 'call_shell', name: declarations[1].name, args: { input: 'echo "你好"\n\\' } } },
    { text: 'after' },
    { text: '', thoughtSignature: signature },
    { text: 'final thought', thought: true },
  ];
  const usageMetadata = { promptTokenCount: 10, toolUsePromptTokenCount: 2, candidatesTokenCount: 7, thoughtsTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 21, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }], cacheTokensDetails: null, trafficType: 'ON_DEMAND' };
  let output: any;
  if (streaming) {
    const events = parts.flatMap(part => session.push(chunk([part])));
    events.push(...session.push({ candidates: [{ content: null, finishReason: 'STOP', index: 0 }] }));
    expect(events.some(e => e.type === 'response.completed')).toBe(false);
    events.push(...session.push({ usageMetadata }), ...session.finish());
    output = events.at(-1)!.response;
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
    const carrier = events.find(e => e.type === 'response.output_item.added' && (e.item as any).encrypted_content)!;
    expect(events.find(e => e.type === 'response.output_item.done' && (e.item as any).id === (carrier.item as any).id)?.item).toEqual(carrier.item);
    const added = events.filter(e => e.type === 'response.output_item.added');
    const first = added.find(e => (e.item as any).call_id === signedId)!;
    const delta = events.find(e => e.type === 'response.function_call_arguments.delta' && e.item_id === (first.item as any).id)!;
    expect(delta.delta).toBe('{"path":"a"}');
    expect(events.filter(e => e.type === 'response.custom_tool_call_input.delta').map(e => e.delta).join('')).toBe('echo "你好"\n\\');
  } else output = session.convertResponse({ ...chunk(parts, 'STOP'), usageMetadata });
  expect(output.status).toBe('completed');
  expect(output.output.map((item: any) => item.type)).toEqual(['message', 'function_call', 'reasoning', 'function_call', 'reasoning', 'custom_tool_call', 'message', 'reasoning', 'reasoning']);
  expect(output.output[1]).toMatchObject({ name: 'read', namespace: 'files', call_id: signedId, arguments: '{"path":"a"}' });
  expect(output.output[5]).toMatchObject({ name: 'shell', namespace: 'files', input: 'echo "你好"\n\\' });
  expect(output.usage).toEqual({ input_tokens: 12, output_tokens: 9, total_tokens: 21, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } });
  const next = createProtocolSession(context).convertRequest({ ...request, input: [
    { role: 'user', content: 'inspect files' }, ...output.output,
    { type: 'function_call_output', call_id: 'call_second', output: 'second' },
    { type: 'function_call_output', call_id: signedId, output: 'first' },
    { type: 'custom_tool_call_output', call_id: 'call_shell', output: 'shell' },
  ] });
  const contents = next.body.contents as any[];
  expect(contents.find(c => c.role === 'model').parts).toEqual(parts);
  const calls = contents.flatMap(c => c.parts).filter(p => p.functionCall);
  expect(calls[0]).toEqual({ functionCall: { id: 'call_first', name: declarations[0].name, args: { path: 'a' } }, thoughtSignature: signature });
  expect(calls[1]).not.toHaveProperty('thoughtSignature');
  expect(contents.at(-1).parts.map((p: any) => p.functionResponse)).toEqual([
    { id: 'call_second', name: declarations[0].name, response: { output: 'second' } },
    { id: 'call_first', name: declarations[0].name, response: { output: 'first' } },
    { id: 'call_shell', name: declarations[1].name, response: { output: 'shell' } },
  ]);
  const third = createProtocolSession(context).convertRequest({ ...request, input: [...next.canonicalHistory, { role: 'user', content: 'another round' }] });
  expect((third.body.contents as any[]).find(c => c.role === 'model').parts).toEqual(parts);
  const changed = structuredClone(next.canonicalHistory) as any[];
  changed.find(i => i.type === 'message').content[0].text = 'tampered';
  expect(() => createProtocolSession(context).convertRequest({ ...request, input: changed })).toThrow();
});

test('Gemini collaboration calls retain plaintext delivery markers', () => {
  const session = createProtocolSession(context);
  const converted = session.convertRequest({ input: 'delegate', tools: [{ type: 'namespace', name: 'collaboration', tools: [
    { type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } },
  ] }] });
  const name = (converted.body.tools as any[])[0].functionDeclarations[0].name;
  const output = session.convertResponse(chunk([{ functionCall: { name, args: { message: 'task' } }, thoughtSignature: signature }], 'STOP'));
  expect((output.output as any[])[0]).toMatchObject({ namespace: 'collaboration', name: 'spawn_agent', encrypted_function_args: [], call_id: expect.stringMatching(/^call_gemini_[a-f0-9]+__thought__dGVzdF9zaWduYXR1cmU=$/) });
});

test('Gemini rejects malformed, oversized and ambiguous signed call ids', () => {
  for (const value of ['', 'not base64!', 'a', 'a===', 'Zh==']) {
    const session = createProtocolSession(context);
    const name = (session.convertRequest(request).body.tools as any[])[0].functionDeclarations[0].name;
    expect(() => session.convertResponse(chunk([{ functionCall: { name, args: {} }, thoughtSignature: value }], 'STOP'))).toThrow();
    expect(() => createProtocolSession(context).convertRequest({ ...request, input: [{ type: 'function_call', name: 'read', namespace: 'files', call_id: `call__thought__${value}`, arguments: '{}' }] })).toThrow();
  }
  const limited = createProtocolSession({ ...context, capabilities: { limits: { maxArgumentBytes: 8 } } });
  limited.convertRequest({ input: 'hello' });
  expect(() => limited.convertResponse(chunk([{ functionCall: { name: 'f', args: {} }, thoughtSignature: signature }], 'STOP'))).toThrow();
  expect(() => createProtocolSession(context).convertRequest({ ...request, input: [
    { type: 'function_call', name: 'read', namespace: 'files', call_id: signedId, arguments: '{}' },
    { type: 'function_call', name: 'read', namespace: 'files', call_id: 'call_first', arguments: '{}' },
  ] })).toThrow();
  const duplicate = createProtocolSession(context);
  const name = (duplicate.convertRequest(request).body.tools as any[])[0].functionDeclarations[0].name;
  expect(() => duplicate.convertResponse(chunk([
    { functionCall: { id: 'same', name, args: {} }, thoughtSignature: signature },
    { functionCall: { id: 'same', name, args: {} } },
  ], 'STOP'))).toThrow();
});

test('Gemini opaque history and reverse conversion remain rejected', () => {
  for (const encrypted_content of ['native-private', 'bungee_gemini:!!', 'bungee_gemini:e30'])
    expect(() => createProtocolSession(context).convertRequest({ input: [{ type: 'reasoning', id: 'opaque', summary: [], encrypted_content }] })).toThrow();
  const other = createProtocolSession({ ...context, sourceProtocol: 'chat_completions' });
  other.convertRequest({ messages: [{ role: 'user', content: 'hello' }] });
  expect(() => other.convertResponse(chunk([{ text: 'answer', thoughtSignature: signature }], 'STOP'))).toThrow();
  expect(() => createProtocolSession({ ...context, sourceProtocol: 'gemini_generate_content', targetProtocol: 'responses' })).toThrow();
});

test('Gemini consolidates Codex instructions and expresses serial calls as a prompt preference', () => {
  const input = [
    { type: 'additional_tools', role: 'developer', tools },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'leading rule' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'workspace context' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'permissions' }, { type: 'input_text', text: 'runtime rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect files' }] },
  ];
  for (const stream of [false, true]) {
    const converted = createProtocolSession({ ...context, reasoningPolicy: { effortMap: { high: 'high' } } }).convertRequest({
      input, instructions: 'system rule', parallel_tool_calls: false, stream, reasoning: { effort: 'high', context: 'all_turns' },
    });
    expect(converted.body.systemInstruction).toEqual({ parts: [
      { text: 'system rule' }, { text: 'leading rule' }, { text: 'permissions' }, { text: 'runtime rules' }, { text: 'Call at most one tool per response.' },
    ] });
    expect(converted.body.contents).toEqual([{ role: 'user', parts: [{ text: 'workspace context' }, { text: 'inspect files' }] }]);
    expect(converted.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'high' } });
    expect(converted.body).not.toHaveProperty('parallel_tool_calls');
    expect(converted.canonicalHistory).toEqual(input.slice(1));
    expect(converted.diagnostics).toContainEqual({ param: 'input', action: 'mapped', reason: 'gemini_mid_conversation_instructions_consolidated' });
    expect(converted.diagnostics).toContainEqual({ param: 'parallel_tool_calls', action: 'mapped', reason: 'gemini_serial_tool_calls_prompt_only' });
    expect(converted.streaming).toBe(stream);
  }
  expect(() => createProtocolSession(context).convertRequest({ ...request, parallel_tool_calls: 'false' })).toThrow();
  expect(() => createProtocolSession({ ...context, sourceProtocol: 'chat_completions' }).convertRequest({ messages: [{ role: 'user', content: 'hello' }], parallel_tool_calls: false })).toThrow();
});

test('Gemini signed empty Parts and adjacent signatures survive JSON/SSE replay', () => {
  const parts = [{ text: 'a' }, { text: 'b' }, { text: 'c', thoughtSignature: signature }, { thoughtSignature: signature }, { text: 'd', thoughtSignature: signature }];
  for (const streaming of [false, true]) {
    const session = createProtocolSession(context); session.convertRequest({ input: 'hello' });
    const response = streaming ? [...parts.flatMap(p => session.push(chunk([p]))), ...session.push(chunk([], 'STOP')), ...session.finish()].at(-1)!.response as any : session.convertResponse(chunk(parts, 'STOP'));
    const restored = createProtocolSession(context).convertRequest({ input: response.output }).body.contents as any[];
    expect(restored[0].parts).toEqual(streaming ? [{ text: 'ab' }, ...parts.slice(2)] : parts);
    const missing = structuredClone(response.output); delete missing[0].id;
    expect(() => createProtocolSession(context).convertRequest({ input: missing })).toThrow();
  }
});

test('Gemini rejects accumulated signature metadata during push before retaining an oversized replay carrier', () => {
  const session = createProtocolSession({ ...context, capabilities: { limits: { maxArgumentBytes: 512, maxOutputBytes: 4096, maxItems: 64 } } });
  session.convertRequest({ input: 'hello' });
  const signature = Buffer.alloc(75, 1).toString('base64');
  session.push(chunk([{ text: '', thoughtSignature: signature }]));
  let error: unknown;
  try { session.push(chunk([{ text: '', thoughtSignature: signature }])); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'resource_limit' });
});

test('Gemini errors, blocking, missing terminals and late content never become successful completions', () => {
  const emptyTerminal = createProtocolSession(context);
  emptyTerminal.convertRequest({ input: 'hello' });
  emptyTerminal.push(chunk([{ text: 'answer' }]));
  emptyTerminal.push({ candidates: [{ content: { role: 'model' }, finishReason: 'STOP', index: 0 }] });
  expect((emptyTerminal.finish().at(-1)?.response as any).status).toBe('completed');
  const blocked = createProtocolSession(context);
  blocked.convertRequest({ input: 'hello' });
  const events = [...blocked.push({ promptFeedback: { blockReason: 'SAFETY' } }), ...blocked.finish()];
  expect(events.at(-1)).toMatchObject({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } });
  const failed = createProtocolSession(context);
  failed.convertRequest({ input: 'hello' });
  const failure = [...failed.push({ error: { message: 'private upstream detail' } }), ...failed.finish()];
  expect(failure.at(-1)?.type).toBe('response.failed');
  expect(JSON.stringify(failure)).not.toContain('private upstream detail');
  const missing = createProtocolSession(context);
  missing.convertRequest({ input: 'hello' });
  missing.push(chunk([{ text: 'partial' }]));
  expect(() => missing.finish()).toThrow();
  const ended = createProtocolSession(context);
  ended.convertRequest({ input: 'hello' });
  ended.push(chunk([{ text: 'answer' }], 'STOP'));
  expect(() => ended.push(chunk([{ text: 'late' }]))).toThrow();
});

test('Gemini native thinking levels require explicit mappings and preserve the upstream default', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high']) {
    const session = createProtocolSession({ ...context, reasoningPolicy: { effortMap: { [effort]: effort } } });
    expect(session.convertRequest({ input: 'hello', reasoning: { effort } }).body).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: effort } } });
  }
  expect(createProtocolSession(context).convertRequest({ input: 'hello' }).body).not.toHaveProperty('generationConfig');
  expect(() => createProtocolSession(context).convertRequest({ input: 'hello', reasoning: { effort: 'high' } })).toThrow();
  expect(() => createProtocolSession({ ...context, reasoningPolicy: { effortMap: { max: 'max' } } }).convertRequest({ input: 'hello', reasoning: { effort: 'max' } })).toThrow();
});

// Gemini may omit native IDs on every round; locally assigned IDs must survive full-history replay.
test('Gemini calls without native IDs remain distinct across generations', () => {
  const history: any[] = [{ role: 'user', content: 'inspect files' }];
  const ids = new Set<string>();
  for (let turn = 0; turn < 3; turn++) {
    const session = createProtocolSession(context);
    const body = session.convertRequest({ ...request, input: history }).body;
    const name = (body.tools as any[])[0].functionDeclarations[0].name;
    const response = session.convertResponse(chunk([{ functionCall: { name, args: { path: 'a' } }, thoughtSignature: signature }], 'STOP'));
    const call = (response.output as any[])[0];
    expect(ids.has(call.call_id)).toBe(false);
    ids.add(call.call_id);
    history.push(call, { type: 'function_call_output', call_id: call.call_id, output: 'done' });
  }
  expect(createProtocolSession(context).convertRequest({ ...request, input: history }).body.contents).toBeDefined();
});
