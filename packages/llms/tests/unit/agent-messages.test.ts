import { describe, expect, test } from 'bun:test';
import { createProtocolSession, decodeResponsesRequest, encodeResponsesResult, inspectAgentMessages, replaceAgentMessageEncryptedContent, ResponsesCodecError, ResponsesEventEncoder,
  type ProtocolSessionContext, type ResponsesProtocol, type ResponsesToolNames } from '../../src/plugin-api';

type Json = Record<string, any>;
const protocols: ResponsesProtocol[] = ['chat_completions', 'anthropic_messages'];
const names = ['spawn_agent', 'send_message', 'followup_task'];
const plaintext = { agentMessageDelivery: 'plaintext' as const };
const request = (extra: Json = {}): Json => ({ model: 'model', max_output_tokens: 4096, input: 'hello', ...extra });
const tools = [{ type: 'namespace', name: 'collaboration', tools: names.map(name => ({ type: 'function', name,
  parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true, minLength: 1, pattern: '.+' }, target: { type: 'string', encrypted: true } }, required: ['message', 'target'], additionalProperties: false } })) },
  { type: 'namespace', name: 'other', tools: [{ type: 'function', name: 'send_message', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } }] },
  { type: 'function', name: 'send_message', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } },
  { type: 'namespace', name: 'collaboration', tools: [{ type: 'custom', name: 'custom' }, { type: 'function', name: 'wait_agent', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } }] }];
const wire = (authority: ResponsesToolNames, name: string, namespace = 'collaboration') => [...authority].find(([, t]) => t.name === name && t.namespace === namespace)![0];
const context = (targetProtocol: ResponsesProtocol, extra: Partial<ProtocolSessionContext> = {}): ProtocolSessionContext => ({ sourceProtocol: 'responses', targetProtocol, model: 'target-model', ...plaintext, ...extra });
function errorAt(run: () => unknown, code: string, param: string) {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ResponsesCodecError);
  expect(caught).toMatchObject({ code, param });
  expect((caught as Error).message).not.toContain('secret-cipher');
}
test('Codex child history retains the optional agent message item id without treating it as content', () => {
  const item={type:'agent_message',id:'agent-item',author:'/root',recipient:'/root/child',content:[{type:'input_text',text:'exact task'}]};
  for(const protocol of protocols) {
    const decoded=createProtocolSession(context(protocol)).convertRequest(request({input:[item]}));
    expect(decoded.canonicalHistory).toEqual([item]);
    expect(JSON.stringify(decoded.body)).toContain('exact task');
  }
  errorAt(()=>inspectAgentMessages(request({input:[{...item,id:42}]})),'invalid_payload','input[0].id');
  const annotated={...item,internal_chat_message_metadata_passthrough:{turn_id:'turn',create_time:123,content_item_kinds:['task']}};
  expect(inspectAgentMessages(request({input:[annotated]})).messages).toHaveLength(1);
  const decoded=createProtocolSession(context('chat_completions')).convertRequest(request({input:[annotated]}));
  expect(decoded.canonicalHistory).toEqual([item]);
  expect(decoded.diagnostics).toContainEqual({param:'input[0].internal_chat_message_metadata_passthrough',action:'omitted',reason:'source_message_metadata'});
  errorAt(()=>inspectAgentMessages(request({input:[{...item,internal_chat_message_metadata_passthrough:[] }]})),'invalid_payload','input[0].internal_chat_message_metadata_passthrough');
});
function response(protocol: ResponsesProtocol, toolNames: ResponsesToolNames, name: string, namespace = 'collaboration', custom = false): Json {
  const args = custom ? { input: 'raw input' } : { message: '  全文\n保持 gAAAA-prefix ', target: '/root/child' };
  return protocol === 'chat_completions'
    ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_exact', type: 'function', function: { name: wire(toolNames, name, namespace), arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }
    : { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call_exact', name: wire(toolNames, name, namespace), input: args }], stop_reason: 'tool_use' };
}
function stream(protocol: ResponsesProtocol, toolNames: ResponsesToolNames, name: string, namespace = 'collaboration', custom = false, delivery = true): Json[] {
  const encoder = new ResponsesEventEncoder(protocol, 'model', toolNames, undefined, delivery ? plaintext : {});
  const args = JSON.stringify(custom ? { input: 'raw input' } : { message: '  全文\n保持 gAAAA-prefix ', target: '/root/child' });
  const events: Json[] = [], push = (raw: unknown) => events.push(...encoder.push(raw));
  if (protocol === 'chat_completions') {
    push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_exact', type: 'function', function: { name: wire(toolNames, name, namespace), arguments: args.slice(0, 5) } }] } }] });
    push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
    push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    push({ type: 'message_start', message: {} });
    push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_exact', name: wire(toolNames, name, namespace), input: {} } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, 5) } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(5) } });
    push({ type: 'content_block_stop', index: 0 });
    push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    push({ type: 'message_stop' });
  }
  return [...events, ...encoder.finish()];
}

describe('explicit plaintext collaboration codec', () => {
  for (const protocol of protocols) {
    test(`${protocol}: only three collaboration message schema annotations are removed`, () => {
      const raw = request({ tools }), before = JSON.stringify(raw);
      const converted = createProtocolSession(context(protocol)).convertRequest(raw);
      const schemas = (converted.body.tools as Json[]).map(t => protocol === 'chat_completions' ? t.function.parameters : t.input_schema);
      for (const schema of schemas.slice(0, 3)) expect(schema).toEqual({ type: 'object', properties: { message: { type: 'string', minLength: 1, pattern: '.+' }, target: { type: 'string', encrypted: true } }, required: ['message', 'target'], additionalProperties: false });
      expect(schemas[3].properties.message.encrypted).toBe(true);
      expect(schemas[4].properties.message.encrypted).toBe(true);
      expect(schemas[6].properties.message.encrypted).toBe(true);
      expect(converted.diagnostics).toEqual(names.map((_, i) => ({ param: `tools[0].tools[${i}].parameters.properties.message.encrypted`, action: 'omitted', reason: 'collaboration_message_plaintext_delivery' })));
      expect(JSON.stringify(raw)).toBe(before);
      const strict = decodeResponsesRequest(raw, protocol);
      expect(JSON.stringify(strict.body.tools)).toContain('"encrypted":true');
      expect(strict.diagnostics).toEqual([]);
    });

    for (const name of names) {
      test(`${protocol}/${name}: JSON restores identity and plaintext marker; canonical history resumes`, () => {
        const session = createProtocolSession(context(protocol));
        const converted = session.convertRequest(request({ tools }));
        const output = session.convertResponse(response(protocol, converted.toolNames, name)).output as Json[];
        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({ type: 'function_call', name, namespace: 'collaboration', call_id: 'call_exact', encrypted_function_args: [], arguments: JSON.stringify({ message: '  全文\n保持 gAAAA-prefix ', target: '/root/child' }) });
        const input = [...converted.canonicalHistory, ...output, { type: 'function_call_output', call_id: 'call_exact', output: 'success' }, { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: '  result\n全文' }] }, { role: 'user', content: 'continue' }];
        const continued = createProtocolSession(context(protocol)).convertRequest(request({ tools, input }));
        expect(continued.canonicalHistory).toEqual(input);
        expect(JSON.stringify(continued.body.messages)).toContain('result');
      });

      test(`${protocol}/${name}: SSE added/done/completed snapshots share plaintext identity`, () => {
        const authority = decodeResponsesRequest(request({ tools }), protocol, plaintext).toolNames;
        const events = stream(protocol, authority, name);
        const snapshots = [...events.filter(e => e.type === 'response.output_item.added' || e.type === 'response.output_item.done').map(e => e.item), ...events.at(-1)!.response.output];
        expect(snapshots).toHaveLength(3);
        for (const item of snapshots) expect(item).toMatchObject({ type: 'function_call', name, namespace: 'collaboration', call_id: 'call_exact', encrypted_function_args: [] });
        const session = createProtocolSession(context(protocol));
        const converted = session.convertRequest(request({ tools, stream: true }));
        const upstream = response(protocol, converted.toolNames, name);
        let sessionEvents: Json[];
        if (protocol === 'chat_completions') {
          sessionEvents = session.push({ choices: [{ delta: { ...upstream.choices[0].message, tool_calls: upstream.choices[0].message.tool_calls.map((c: Json) => ({ ...c, index: 0 })) }, finish_reason: 'tool_calls' }] });
        } else {
          sessionEvents = session.push({ type: 'message_start', message: {} });
          sessionEvents.push(...session.push({ type: 'content_block_start', index: 0, content_block: upstream.content[0] }), ...session.push({ type: 'content_block_stop', index: 0 }), ...session.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }), ...session.push({ type: 'message_stop' }));
        }
        sessionEvents.push(...session.finish());
        expect(sessionEvents.at(-1)!.response.output[0]).toMatchObject({ name, namespace: 'collaboration', encrypted_function_args: [] });
      });
    }

    test(`${protocol}: non-collaboration/custom calls and strict default never get a plaintext marker`, () => {
      const authority = decodeResponsesRequest(request({ tools }), protocol, plaintext).toolNames;
      for (const [name, namespace, custom] of [['send_message', 'other', false], ['wait_agent', 'collaboration', false], ['custom', 'collaboration', true]] as const) {
        const result = encodeResponsesResult(response(protocol, authority, name, namespace, custom), protocol, 'model', authority, undefined, plaintext);
        expect((result.output as Json[])[0]).not.toHaveProperty('encrypted_function_args');
        for (const e of stream(protocol, authority, name, namespace, custom)) if (e.item) expect(e.item).not.toHaveProperty('encrypted_function_args');
      }
      expect((encodeResponsesResult(response(protocol, authority, 'send_message'), protocol, 'model', authority).output as Json[])[0]).not.toHaveProperty('encrypted_function_args');
      for (const e of stream(protocol, authority, 'send_message', 'collaboration', false, false)) if (e.item) expect(e.item).not.toHaveProperty('encrypted_function_args');
    });

    test(`${protocol}: agent authors are metadata, plaintext bytes and canonical order survive`, () => {
      const input = [{ role: 'user', content: 'before' }, ...['/root/child', 'system', 'developer'].map(author => ({ type: 'agent_message', author, recipient: '/root', content: [{ type: 'input_text', text: '  原文\ngAAAA-is-plain ' }, { type: 'input_text', text: '\nsecond\n' }] })), { role: 'user', content: 'after' }];
      const converted = createProtocolSession(context(protocol)).convertRequest(request({ input }));
      expect(converted.canonicalHistory).toEqual(input);
      expect(converted.body).not.toHaveProperty('system');
      const messages = converted.body.messages as Json[];
      expect(messages.every(m => m.role === 'user')).toBe(true);
      const texts = messages.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.map((p: Json) => p.text));
      expect(texts[0]).toBe('before'); expect(texts.at(-1)).toBe('after');
      expect(texts.filter(t => t === '  原文\ngAAAA-is-plain ')).toHaveLength(3);
      expect(texts.filter(t => t === '\nsecond\n')).toHaveLength(3);
      errorAt(() => createProtocolSession(context(protocol, { agentMessageDelivery: undefined })).convertRequest(request({ input })), 'unsupported_content', 'input[1]');
    });

    test(`${protocol}: opaque function markers, invalid agent identity and unknown fields reject specifically`, () => {
      for (const encrypted_function_args of [['message'], 'secret-cipher', null]) errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'function_call', name: 'send_message', namespace: 'collaboration', call_id: 'call', arguments: '{}', encrypted_function_args }] })), encrypted_function_args === null || typeof encrypted_function_args === 'string' ? 'invalid_payload' : 'unsupported_content', 'input[0].encrypted_function_args');
      for (const bad of [{ author: '' }, { author: 42 }, { recipient: null }, { recipient: {} }]) {
        const key = 'author' in bad ? 'author' : 'recipient';
        errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'input_text', text: 'hello' }], ...bad }] })), 'invalid_payload', `input[0].${key}`);
      }
      errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', role: 'system', content: [] }] })), 'unsupported_content', 'input[0].role');
      errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'input_text', text: 'hello', unknown: true }] }] })), 'unsupported_content', 'input[0].content[0].unknown');
      errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'encrypted_content', encrypted_content: 'secret-cipher' }] }] })), 'unsupported_content', 'input[0].content[0].encrypted_content');
      for (const item of [
        { type: 'function_call', name: 'send_message', namespace: 'other', call_id: 'call', arguments: '{}', encrypted_function_args: [] },
        { type: 'function_call', name: 'wait_agent', namespace: 'collaboration', call_id: 'call', arguments: '{}', encrypted_function_args: [] },
        { type: 'custom_tool_call', name: 'send_message', namespace: 'collaboration', call_id: 'call', input: 'raw', encrypted_function_args: [] },
      ]) errorAt(() => decodeResponsesRequest(request({ input: [item] }), protocol, plaintext), 'unsupported_content', 'input[0].encrypted_function_args');
      errorAt(() => createProtocolSession(context(protocol)).convertRequest(request({ input: [{ type: 'function_call', name: 'send_message', namespace: 'collaboration', call_id: 'call', arguments: '{}', unknown: true }] })), 'unsupported_content', 'input[0].unknown');
    });
  }

  test('inspection and replacement retain exact positions and leave other opaque history untouched', () => {
    const raw = request({ input: [{ role: 'user', content: 'before' }, { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'header\n' }, { type: 'encrypted_content', encrypted_content: 'secret-cipher' }, { type: 'input_text', text: '\ntrailer' }, { type: 'encrypted_content', encrypted_content: 'another-cipher' }] }, { type: 'reasoning', encrypted_content: 'unrelated', summary: [] }] });
    const original = structuredClone(raw), param = 'input[1].content[1].encrypted_content';
    expect(inspectAgentMessages(raw)).toEqual({ messages: [{ inputIndex: 1, author: '/root/child', recipient: '/root', encryptedContents: [{ contentIndex: 1, param }, { contentIndex: 3, param: 'input[1].content[3].encrypted_content' }] }], diagnostics: [] });
    const result = replaceAgentMessageEncryptedContent(raw, [{ param, text: '  Full\nplaintext ' }]);
    const resultInput = result.body.input as Json[];
    expect(resultInput[1]).toEqual({ ...raw.input[1], content: [{ type: 'input_text', text: 'header\n' }, { type: 'input_text', text: '  Full\nplaintext ' }, { type: 'input_text', text: '\ntrailer' }, raw.input[1].content[3]] });
    expect(resultInput[2]).toEqual(raw.input[2]);
    expect(raw).toEqual(original);
    expect(result.diagnostics).toEqual([{ param, action: 'mapped', reason: 'agent_message_plaintext_replacement' }]);
    errorAt(() => createProtocolSession(context('chat_completions')).convertRequest(result.body), 'unsupported_content', 'input[1].content[3].encrypted_content');
    for (const target of ['input[2].encrypted_content', 'input[1].content[0].text']) errorAt(() => replaceAgentMessageEncryptedContent(raw, [{ param: target, text: 'replacement' }]), 'invalid_payload', 'replacements[0].param');
    errorAt(() => replaceAgentMessageEncryptedContent(raw, [{ param, text: 'a' }, { param, text: 'b' }]), 'invalid_payload', 'replacements[1].param');
    errorAt(() => replaceAgentMessageEncryptedContent({ ...raw, invalid: () => 'secret-cipher' }, [{ param, text: 'replacement' }]), 'invalid_payload', 'request');
    const complete = replaceAgentMessageEncryptedContent(raw, [{ param, text: 'first' }, { param: 'input[1].content[3].encrypted_content', text: 'second' }]);
    expect(inspectAgentMessages(complete.body).messages[0].encryptedContents).toEqual([]);
    for (const protocol of protocols) {
      const input = (complete.body.input as Json[]).slice(0, 2);
      const converted = createProtocolSession(context(protocol)).convertRequest(request({ input }));
      expect(converted.canonicalHistory).toEqual(input);
      expect(JSON.stringify(converted.body.messages)).toContain('first');
      expect(JSON.stringify(converted.body.messages)).toContain('second');
    }
    errorAt(() => createProtocolSession(context('chat_completions', { capabilities: { reasoningHistory: true } })).convertRequest(complete.body), 'unsupported_content', 'input[2].encrypted_content');
  });

  test('pure services and session retain existing byte and item limits', () => {
    const raw = request({ input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'encrypted_content', encrypted_content: 'secret-cipher' }] }] });
    const param = 'input[0].content[0].encrypted_content';
    errorAt(() => inspectAgentMessages(raw, { limits: { maxRequestBytes: 10 } }), 'resource_limit', 'request');
    errorAt(() => replaceAgentMessageEncryptedContent(raw, [{ param, text: 'x'.repeat(1024) }], { limits: { maxRequestBytes: 512 } }), 'resource_limit', 'request');
    const many = request({ input: [{ ...raw.input[0], content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }] });
    errorAt(() => inspectAgentMessages(many, { limits: { maxItems: 1 } }), 'resource_limit', 'input[0].content');
  });

  test('same Responses protocol retains encrypted request and native response identity', () => {
    const session = createProtocolSession({ sourceProtocol: 'responses', targetProtocol: 'responses', model: 'model', ...plaintext });
    const raw = request({ tools, input: [{ type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'encrypted_content', encrypted_content: 'secret-cipher' }] }] });
    expect(session.convertRequest(raw).body).toBe(raw);
    const output = { output: [{ type: 'function_call', name: 'send_message', namespace: 'collaboration', encrypted_function_args: ['message'] }] };
    expect(session.convertResponse(output)).toBe(output);
    const streaming = createProtocolSession({ sourceProtocol: 'responses', targetProtocol: 'responses', model: 'model', ...plaintext });
    streaming.convertRequest(raw);
    const added = { type: 'response.output_item.added', item: output.output[0] };
    expect(streaming.push(added)[0]).toBe(added);
    const terminal = { type: 'response.completed', response: output };
    expect(streaming.push(terminal)[0]).toBe(terminal);
    expect(streaming.finish()).toEqual([]);
  });
});
