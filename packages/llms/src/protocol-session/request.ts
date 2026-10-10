import { decodeResponsesRequest } from '../responses-codec';
import { argumentObject, fail, list, record, string, type JsonRecord } from '../responses-codec/common';
import { fields, integer, bool, textParts } from './validation';
import { geminiSchemaToJson } from './schema';
import type { LLMProtocol, ProtocolSessionContext, ProtocolRequestConversion } from './types';
function message(input: JsonRecord[], role: string, content: unknown, style: 'chat' | 'anthropic' | 'gemini', path: string): void {
  if (!['system', 'developer', 'user', 'assistant'].includes(role))
    fail('unsupported_content', 'Unknown message role', `${path}.role`);
  input.push({ role, content: textParts(content, `${path}.content`, style, role) });
}
function toolDefinition(raw: unknown, style: 'chat' | 'anthropic' | 'gemini', path: string): JsonRecord {
  const t = record(raw, path);
  if (style === 'chat') {
    fields(t, t.type === 'custom' ? ['type', 'custom'] : ['type', 'function'], path, 'unsupported_tool');
    if (t.type === 'custom') {
      const custom = record(t.custom, `${path}.custom`); fields(custom, ['name', 'description', 'format'], `${path}.custom`, 'unsupported_tool');
      return { type: 'custom', ...custom };
    }
    if (t.type !== 'function')
      fail('unsupported_tool', 'Unsupported tool kind', `${path}.type`);
    const fn = record(t.function, path);
    fields(fn, ['name', 'description', 'parameters', 'strict'], `${path}.function`, 'unsupported_tool');
    return { type: 'function', ...fn };
  }
  fields(t, style === 'anthropic' ? ['name', 'description', 'input_schema', 'strict'] : ['name', 'description', 'parametersJsonSchema', 'parameters'], path, 'unsupported_tool');
  if (t.parameters !== undefined && t.parametersJsonSchema !== undefined)
    fail('unsupported_tool', 'Ambiguous schema dialect', path);
  return {
    type: 'function', name: t.name, ...(t.description !== undefined ? { description: t.description } : {}),
    parameters: style === 'anthropic' ? t.input_schema : t.parametersJsonSchema ?? (t.parameters === undefined ? undefined : geminiSchemaToJson(t.parameters, `${path}.parameters`, 'unsupported_tool')),
    ...(t.strict !== undefined ? { strict: t.strict } : {})
  };
}
/** The normative history is Responses items, not a provider plugin conversion chain. */
export function canonicalRequest(raw: unknown, protocol: LLMProtocol, model: string): JsonRecord {
  const b = record(raw, 'request');
  if (protocol === 'responses')
    return { ...b, model };
  const input: JsonRecord[] = [], out: JsonRecord = { model, input };
  const copy = (mapping: Record<string, string>) => {
    for (const [from, to] of Object.entries(mapping))
      if (b[from] !== undefined)
        out[to] = b[from];
  };
  if (protocol === 'chat_completions') {
    const callKinds = new Map<string, boolean>();
    fields(b, ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'metadata', 'response_format', 'reasoning_effort', 'stop', 'n'], '');
    if (b.max_tokens !== undefined && b.max_completion_tokens !== undefined)
      fail('unsupported_request', 'Ambiguous token limits', 'max_tokens');
    copy({ stream: 'stream', stream_options: 'stream_options', temperature: 'temperature', top_p: 'top_p', max_tokens: 'max_output_tokens', max_completion_tokens: 'max_output_tokens', metadata: 'metadata', parallel_tool_calls: 'parallel_tool_calls', n: 'n', stop: 'stop' });
    for (const [index, rawMessage] of list(b.messages, 'messages').entries()) {
      const m = record(rawMessage, 'message'), path = `messages[${index}]`;
      fields(m, ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning', 'refusal', 'name'], path, 'unsupported_content');
      if (m.name !== undefined)
        fail('unsupported_content', 'Named messages cannot be represented faithfully', `${path}.name`);
      const role = string(m.role, 'role', true);
      if (role === 'tool') {
        if (m.tool_calls !== undefined || m.reasoning_content !== undefined || m.refusal !== undefined)
          fail('unsupported_content', 'Invalid tool result fields', path);
        const callId = string(m.tool_call_id, 'tool_call_id', true);
        input.push({ type: callKinds.get(callId) ? 'custom_tool_call_output' : 'function_call_output', call_id: callId, output: typeof m.content === 'string' ? m.content : textParts(m.content, `${path}.content`, 'chat', 'tool') });
        continue;
      }
      if (m.tool_call_id !== undefined)
        fail('invalid_tool_history', 'Only tool results may carry a call id', path);
      const reasoning = m.reasoning_content ?? m.reasoning;
      if (m.reasoning_content !== undefined && m.reasoning !== undefined)
        fail('unsupported_reasoning', 'Ambiguous reasoning history', path);
      if (reasoning !== undefined) {
        if (role !== 'assistant')
          fail('unsupported_reasoning', 'Reasoning requires assistant role', path);
        input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: string(reasoning, path) }] });
      }
      if (m.content != null)
        message(input, role, m.content, 'chat', path);
      else if (role !== 'assistant' || (m.tool_calls === undefined && m.refusal === undefined))
        fail('invalid_payload', 'Message content is required', `${path}.content`);
      if (m.refusal !== undefined && m.refusal !== null) {
        if (role !== 'assistant')
          fail('unsupported_content', 'Refusal requires assistant role', path);
        input.push({ role: 'assistant', content: [{ type: 'refusal', refusal: string(m.refusal, path) }] });
      }
      if (m.tool_calls !== undefined) {
        if (role !== 'assistant')
          fail('invalid_tool_history', 'Tool calls require assistant role', path);
        for (const [j, rawCall] of list(m.tool_calls, 'tool_calls').entries()) {
          const c = record(rawCall, 'tool call'), at = `${path}.tool_calls[${j}]`;
          fields(c, ['id', 'type', 'function', 'custom'], at, 'unsupported_tool');
          const custom = c.type === 'custom';
          if (!custom && c.type !== 'function')
            fail('unsupported_tool', 'Unknown call type', at);
          const fn = record(custom ? c.custom : c.function, 'tool call');
          fields(fn, custom ? ['name', 'input'] : ['name', 'arguments'], at, 'unsupported_tool');
          callKinds.set(string(c.id, 'id', true), custom);
          input.push({
            type: custom ? 'custom_tool_call' : 'function_call', call_id: string(c.id, 'id', true), name: string(fn.name, 'name', true),
            ...(custom ? { input: string(fn.input, 'input') } : { arguments: string(fn.arguments, 'arguments') })
          });
        }
      }
    }
    if (b.tools !== undefined)
      out.tools = list(b.tools, 'tools').map((t, i) => toolDefinition(t, 'chat', `tools[${i}]`));
    if (b.tool_choice !== undefined) {
      const c = b.tool_choice;
      if (typeof c === 'string')
        out.tool_choice = c;
      else {
        const choice = record(c, 'tool_choice');
        fields(choice, ['type', 'function', 'custom'], 'tool_choice');
        const fn = record(choice.function ?? choice.custom, 'tool_choice');
        fields(fn, ['name'], 'tool_choice.function');
        out.tool_choice = { type: choice.type, name: fn.name };
      }
    }
    if (b.reasoning_effort !== undefined)
      out.reasoning = { effort: b.reasoning_effort };
    if (b.response_format !== undefined) {
      const format = record(b.response_format, 'response_format');
      fields(format, ['type', 'json_schema'], 'response_format');
      out.text = { format: format.type === 'json_schema' ? { type: 'json_schema', ...record(format.json_schema, 'json_schema') } : format };
    }
    return out;
  }
  if (protocol === 'anthropic_messages') {
    fields(b, ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'temperature', 'top_p', 'max_tokens', 'metadata', 'stop_sequences', 'thinking', 'output_config'], '');
    copy({ stream: 'stream', temperature: 'temperature', top_p: 'top_p', max_tokens: 'max_output_tokens', metadata: 'metadata', stop_sequences: 'stop' });
    if (b.system !== undefined)
      message(input, 'system', b.system, 'anthropic', 'system');
    for (const [index, rawMessage] of list(b.messages, 'messages').entries()) {
      const m = record(rawMessage, 'message'), path = `messages[${index}]`;
      fields(m, ['role', 'content'], path, 'unsupported_content');
      if (m.role !== 'user' && m.role !== 'assistant')
        fail('unsupported_content', 'Anthropic messages require user or assistant role', `${path}.role`);
      if (typeof m.content === 'string') {
        message(input, m.role, m.content, 'anthropic', path);
        continue;
      }
      for (const [j, rawPart] of list(m.content, 'content').entries()) {
        const p = record(rawPart, 'block'), at = `${path}.content[${j}]`;
        if (p.type === 'tool_use') {
          if (m.role !== 'assistant')
            fail('invalid_tool_history', 'Tool calls require assistant role', at);
          fields(p, ['type', 'id', 'name', 'input'], at, 'unsupported_content');
          input.push({ type: 'function_call', call_id: string(p.id, at, true), name: string(p.name, at, true), arguments: JSON.stringify(record(p.input, at)) });
        }
        else if (p.type === 'tool_result') {
          if (m.role !== 'user')
            fail('invalid_tool_history', 'Tool results require user role', at);
          fields(p, ['type', 'tool_use_id', 'content', 'is_error'], at, 'unsupported_content');
          input.push({ type: 'function_call_output', call_id: string(p.tool_use_id, at, true), output: typeof p.content === 'string' ? p.content : textParts(p.content, at, 'anthropic', 'tool'), ...(p.is_error !== undefined ? { is_error: bool(p.is_error, at) } : {}) });
        }
        else if (p.type === 'thinking') {
          fields(p, ['type', 'thinking', 'signature'], at, 'unsupported_reasoning');
          if (p.signature != null)
            fail('unsupported_reasoning', 'Provider-bound reasoning signatures cannot cross protocols', `${at}.signature`);
          if (m.role !== 'assistant')
            fail('unsupported_reasoning', 'Reasoning requires assistant role', at);
          input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: string(p.thinking, at) }] });
        }
        else
          message(input, m.role, [p], 'anthropic', at);
      }
    }
    if (b.tools !== undefined)
      out.tools = list(b.tools, 'tools').map((t, i) => toolDefinition(t, 'anthropic', `tools[${i}]`));
    if (b.tool_choice !== undefined) {
      const c = record(b.tool_choice, 'tool_choice');
      fields(c, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
      if (c.type === 'tool')
        out.tool_choice = { type: 'function', name: c.name };
      else if (['auto', 'none', 'any'].includes(String(c.type)))
        out.tool_choice = c.type === 'any' ? 'required' : c.type;
      else
        fail('unsupported_tool_choice', 'Unknown tool choice', 'tool_choice.type');
      if (c.disable_parallel_tool_use !== undefined)
        out.parallel_tool_calls = !bool(c.disable_parallel_tool_use, 'tool_choice.disable_parallel_tool_use');
    }
    if (b.thinking !== undefined) {
      const t = record(b.thinking, 'thinking');
      fields(t, ['type', 'budget_tokens'], 'thinking', 'unsupported_reasoning');
      if (!['enabled', 'adaptive', 'disabled'].includes(String(t.type)))
        fail('unsupported_reasoning', 'Unknown thinking mode', 'thinking.type');
      if (t.type === 'enabled')
        integer(t.budget_tokens, 'thinking.budget_tokens', 1024);
      else if (t.budget_tokens !== undefined)
        fail('unsupported_reasoning', 'Only enabled thinking may declare a budget', 'thinking.budget_tokens');
      out.sourceThinking = t;
    }
    if (b.output_config !== undefined) {
      const c = record(b.output_config, 'output_config');
      fields(c, ['effort', 'format'], 'output_config');
      if (c.effort !== undefined)
        out.reasoning = { effort: c.effort };
      if (c.format !== undefined) {
        const f = record(c.format, 'format');
        fields(f, ['type', 'schema'], 'output_config.format');
        if (f.type !== 'json_schema')
          fail('unsupported_request', 'Unknown structured output type', 'output_config.format.type');
        out.text = { format: { type: 'json_schema', name: 'response', schema: f.schema } };
      }
    }
    return out;
  }
  fields(b, ['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig', 'model', 'stream'], '');
  if (b.stream !== undefined)
    out.stream = b.stream;
  if (b.systemInstruction !== undefined) {
    const s = record(b.systemInstruction, 'systemInstruction');
    fields(s, ['role', 'parts'], 'systemInstruction');
    if (s.role !== undefined && s.role !== 'system')
      fail('unsupported_content', 'Invalid system role', 'systemInstruction.role');
    message(input, 'system', s.parts, 'gemini', 'systemInstruction');
  }
  const calls = new Map<string, {
    id: string;
    name: string;
  }>();
  let serial = 0;
  for (const [index, rawContent] of list(b.contents, 'contents').entries()) {
    const original = record(rawContent, 'content'), path = `contents[${index}]`;
    const c: JsonRecord = { ...original, role: original.role ?? 'user' };
    fields(c, ['role', 'parts'], path, 'unsupported_content');
    if (c.role !== 'user' && c.role !== 'model')
      fail('unsupported_content', 'Gemini contents require user or model role', `${path}.role`);
    for (const [j, rawPart] of list(c.parts, 'parts').entries()) {
      const p = record(rawPart, 'part'), at = `${path}.parts[${j}]`;
      fields(p, ['text', 'thought', 'functionCall', 'functionResponse', 'thoughtSignature'], at, 'unsupported_content');
      if (p.thoughtSignature !== undefined)
        fail('unsupported_reasoning', 'Provider-bound thought signatures cannot cross protocols', `${at}.thoughtSignature`);
      if ([p.text, p.functionCall, p.functionResponse].filter(v => v !== undefined).length !== 1)
        fail('unsupported_content', 'Part must contain exactly one content kind', at);
      if (p.functionCall !== undefined) {
        if (c.role !== 'model')
          fail('invalid_tool_history', 'Function calls require model role', at);
        const f = record(p.functionCall, at);
        fields(f, ['name', 'args', 'id'], `${at}.functionCall`, 'unsupported_tool');
        const name = string(f.name, at, true), id = f.id === undefined ? `call_gemini_${serial++}` : string(f.id, at, true);
        if (calls.has(id))
          fail('invalid_tool_history', 'Duplicate tool call id', at);
        calls.set(id, { id, name });
        input.push({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(record(f.args ?? {}, at)) });
      }
      else if (p.functionResponse !== undefined) {
        if (c.role !== 'user')
          fail('invalid_tool_history', 'Function results require user role', at);
        const f = record(p.functionResponse, at);
        fields(f, ['name', 'response', 'id'], `${at}.functionResponse`, 'unsupported_tool');
        const matches = [...calls.values()].filter(v => v.name === f.name);
        const id = f.id === undefined ? (matches.length === 1 ? matches[0]!.id : fail('invalid_tool_history', 'Function result requires an unambiguous call id', at)) : string(f.id, at, true);
        if (calls.get(id)?.name !== f.name)
          fail('invalid_tool_history', 'Function result name does not match its call', at);
        calls.delete(id);
        input.push({ type: 'function_call_output', call_id: id, output: JSON.stringify(record(f.response, at)) });
      }
      else if (p.thought === true) {
        if (c.role !== 'model')
          fail('unsupported_reasoning', 'Thoughts require model role', at);
        input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: string(p.text, at) }] });
      }
      else
        message(input, c.role === 'model' ? 'assistant' : 'user', [p], 'gemini', at);
    }
  }
  if (b.tools !== undefined) {
    const tools: JsonRecord[] = [];
    for (const [i, rawTool] of list(b.tools, 'tools').entries()) {
      const t = record(rawTool, 'tool');
      fields(t, ['functionDeclarations'], `tools[${i}]`, 'unsupported_tool');
      for (const [j, f] of list(t.functionDeclarations, 'functionDeclarations').entries())
        tools.push(toolDefinition(f, 'gemini', `tools[${i}].functionDeclarations[${j}]`));
    }
    out.tools = tools;
  }
  if (b.toolConfig !== undefined) {
    const config = record(b.toolConfig, 'toolConfig');
    fields(config, ['functionCallingConfig'], 'toolConfig');
    const c = record(config.functionCallingConfig, 'functionCallingConfig');
    fields(c, ['mode', 'allowedFunctionNames'], 'toolConfig.functionCallingConfig');
    if (!['AUTO', 'NONE', 'ANY'].includes(String(c.mode)))
      fail('unsupported_tool_choice', 'Unknown function calling mode', 'toolConfig.functionCallingConfig.mode');
    if (c.allowedFunctionNames !== undefined) {
      const names = list(c.allowedFunctionNames, 'allowedFunctionNames');
      if (c.mode !== 'ANY' || names.length !== 1)
        fail('unsupported_tool_choice', 'Allowed function subset cannot be represented', 'toolConfig.functionCallingConfig.allowedFunctionNames');
      out.tool_choice = { type: 'function', name: names[0] };
    }
    else
      out.tool_choice = c.mode === 'AUTO' ? 'auto' : c.mode === 'NONE' ? 'none' : 'required';
  }
  if (b.generationConfig !== undefined) {
    const c = record(b.generationConfig, 'generationConfig');
    fields(c, ['temperature', 'topP', 'maxOutputTokens', 'stopSequences', 'candidateCount', 'responseMimeType', 'responseJsonSchema', 'responseSchema', 'thinkingConfig'], 'generationConfig');
    for (const [from, to] of Object.entries({ temperature: 'temperature', topP: 'top_p', maxOutputTokens: 'max_output_tokens', stopSequences: 'stop', candidateCount: 'n' }))
      if (c[from] !== undefined)
        out[to] = c[from];
    if (c.responseSchema !== undefined && c.responseJsonSchema !== undefined) fail('unsupported_request', 'Ambiguous output schema dialect', 'generationConfig.responseSchema');
    if (c.responseJsonSchema !== undefined || c.responseSchema !== undefined) {
      if (c.responseMimeType !== 'application/json')
        fail('unsupported_request', 'JSON schema requires JSON MIME type', 'generationConfig.responseMimeType');
      out.text = { format: { type: 'json_schema', name: 'response', schema: c.responseJsonSchema ?? geminiSchemaToJson(c.responseSchema, 'generationConfig.responseSchema') } };
    }
    else if (c.responseMimeType !== undefined) {
      if (c.responseMimeType === 'application/json')
        out.text = { format: { type: 'json_object' } };
      else if (c.responseMimeType !== 'text/plain')
        fail('unsupported_request', 'Unsupported response MIME type', 'generationConfig.responseMimeType');
    }
    if (c.thinkingConfig !== undefined) {
      const t = record(c.thinkingConfig, 'thinkingConfig');
      fields(t, ['thinkingBudget', 'thinkingLevel', 'includeThoughts'], 'generationConfig.thinkingConfig', 'unsupported_reasoning');
      if (t.thinkingBudget !== undefined)
        integer(t.thinkingBudget, 'generationConfig.thinkingConfig.thinkingBudget', -1);
      if (t.thinkingLevel !== undefined)
        string(t.thinkingLevel, 'thinkingLevel', true);
      if (t.includeThoughts !== undefined)
        bool(t.includeThoughts, 'includeThoughts');
      out.sourceThinking = t;
    }
  }
  return out;
}
function validateCanonical(b: JsonRecord): void {
  for (const key of ['stream', 'parallel_tool_calls', 'store', 'background'])
    if (b[key] !== undefined)
      bool(b[key], key);
  for (const key of ['temperature', 'top_p'])
    if (b[key] !== undefined && (typeof b[key] !== 'number' || !Number.isFinite(b[key])))
      fail('invalid_payload', 'Sampling value must be finite', key);
  if (b.tool_choice !== undefined && typeof b.tool_choice !== 'string')
    fields(record(b.tool_choice, 'tool_choice'), ['type', 'name', 'namespace'], 'tool_choice', 'unsupported_tool_choice');
  if (b.text !== undefined) {
    const text = record(b.text, 'text');
    fields(text, ['format', 'verbosity'], 'text');
    if (text.format !== undefined) {
      const f = record(text.format, 'text.format');
      fields(f, f.type === 'json_schema' ? ['type', 'name', 'schema', 'strict', 'description'] : ['type'], 'text.format');
      if (!['text', 'json_object', 'json_schema'].includes(String(f.type)))
        fail('unsupported_request', 'Unknown structured output format', 'text.format.type');
      if (f.type === 'json_schema') {
        string(f.name, 'text.format.name', true);
        record(f.schema, 'text.format.schema');
        if (f.strict !== undefined)
          bool(f.strict, 'text.format.strict');
        if (f.description !== undefined)
          string(f.description, 'text.format.description');
      }
    }
  }
  const input = typeof b.input === 'string' ? [] : list(b.input, 'input');
  for (const [i, raw] of input.entries()) {
    const t = record(raw, 'input item'), p = `input[${i}]`;
    const allowed = t.type === 'function_call' ? ['type', 'id', 'status', 'call_id', 'name', 'namespace', 'arguments'] : t.type === 'custom_tool_call' ? ['type', 'id', 'status', 'call_id', 'name', 'namespace', 'input'] :
      t.type === 'function_call_output' || t.type === 'custom_tool_call_output' ? ['type', 'id', 'call_id', 'output', 'is_error'] : t.type === 'reasoning' ? ['type', 'id', 'status', 'summary', 'content', 'encrypted_content', 'internal_chat_message_metadata_passthrough'] :
        t.type === 'additional_tools' ? ['type', 'id', 'role', 'tools'] : ['type', 'id', 'status', 'role', 'content', 'internal_chat_message_metadata_passthrough'];
    fields(t, [...allowed,'internal_chat_message_metadata_passthrough'], p, 'unsupported_content');
    if (t.is_error !== undefined)
      bool(t.is_error, `${p}.is_error`);
    if (t.type === 'reasoning')
      for (const [j, part] of list(t.summary, 'summary').entries())
        fields(record(part, 'summary'), ['type', 'text'], `${p}.summary[${j}]`, 'unsupported_reasoning');
    if (Array.isArray(t.content))
      for (const [j, part] of t.content.entries()) {
        const c = record(part, 'part');
        fields(c, c.type === 'input_image' ? ['type', 'image_url', 'detail'] : c.type === 'refusal' ? ['type', 'refusal'] : ['type', 'text', 'annotations'], `${p}.content[${j}]`, 'unsupported_content');
      }
  }
  const inspectTool = (raw: unknown, path: string, nested = false): void => {
    const t = record(raw, 'tool');
    if (t.type === 'namespace') {
      if (nested) fail('unsupported_tool', 'Nested tool namespaces cannot be represented', path);
      for (const [i, child] of list(t.tools, 'namespace tools').entries())
        inspectTool(child, `${path}.tools[${i}]`, true);
    }
    if (t.type === 'custom' && t.format !== undefined) {
      const f = record(t.format, 'custom format');
      // Codex executes custom tools locally. The mature codec wraps their raw
      // input as one string; it never claims native upstream grammar execution.
      fields(f, f.type==='grammar'?['type','syntax','definition']:['type'], `${path}.format`, 'unsupported_tool');
      if (!['text','grammar'].includes(String(f.type)))fail('unsupported_tool','Unknown custom tool format',`${path}.format.type`);
      if(f.type==='grammar') {
        if(!['lark','regex'].includes(String(f.syntax)))fail('unsupported_tool','Unknown grammar syntax',`${path}.format.syntax`);
        string(f.definition,`${path}.format.definition`,true);
      }
    }
  };
  for (const [i, raw] of (b.tools === undefined ? [] : list(b.tools, 'tools')).entries())
    inspectTool(raw, `tools[${i}]`);
  for (const [i, raw] of input.entries()) {
    const t = record(raw, 'input');
    if (t.type === 'additional_tools')
      for (const [j, tool] of list(t.tools, 'tools').entries())
        inspectTool(tool, `input[${i}].tools[${j}]`);
  }
}
export function convertProtocolRequest(raw: unknown, context: ProtocolSessionContext): ProtocolRequestConversion {
  const b = canonicalRequest(raw, context.sourceProtocol, context.model);
  if(context.streaming!==undefined){bool(context.streaming,'context.streaming');if(b.stream!==undefined&&b.stream!==context.streaming)fail('invalid_payload','Request stream mode disagrees with transport context','stream');b.stream=context.streaming;}
  validateCanonical(b);
  const cap = { ...context.capabilities, omitOptionalWebSearch: false, preserveToolIdentityDescription: true, preserveRefusalContent: true }, policy = context.reasoningPolicy;
  const reasoning = b.reasoning === undefined ? undefined : record(b.reasoning, 'reasoning');
  const sourceThinking = b.sourceThinking;
  delete b.sourceThinking;
  const stop = b.stop;
  delete b.stop;
  if (stop !== undefined) {
    const values = typeof stop === 'string' ? [stop] : list(stop, 'stop');
    if (!values.length || values.some(v => typeof v !== 'string' || !v.length))
      fail('invalid_payload', 'Stop sequences must be nonempty strings', 'stop');
  }
  if (sourceThinking !== undefined && !policy)
    fail('unsupported_reasoning', 'Thinking mode requires an explicit target wire policy', 'thinking');
  let mappedEffort: string | undefined;
  if (reasoning?.effort !== undefined) {
    const effort = string(reasoning.effort, 'reasoning.effort', true);
    mappedEffort = policy?.effortMap?.[effort];
    if (mappedEffort === undefined && policy?.anthropicThinkingBudget === undefined && policy?.geminiThinkingBudget === undefined && policy?.geminiThinkingLevel === undefined)
      fail('unsupported_reasoning', 'Reasoning effort requires an explicit verified wire mapping', 'reasoning.effort');
    if (mappedEffort !== undefined)
      string(mappedEffort, 'reasoningPolicy.effortMap', true);
  }
  if (sourceThinking !== undefined && reasoning?.effort === undefined && policy?.targetEffort !== undefined)
    mappedEffort = string(policy.targetEffort, 'reasoningPolicy.targetEffort', true);
  const target = context.targetProtocol;
  if (target === 'gemini_generate_content' && reasoning?.effort !== undefined && policy?.geminiThinkingBudget === undefined && policy?.geminiThinkingLevel === undefined)
    fail('unsupported_reasoning', 'Gemini requires an explicit thinking budget or level', 'reasoning.effort');
  if (sourceThinking !== undefined) {
    const represented = target === 'responses' || target === 'chat_completions' ? mappedEffort !== undefined : target === 'anthropic_messages' ? mappedEffort !== undefined || policy?.anthropicThinkingMode !== undefined || policy?.anthropicThinkingBudget !== undefined : policy?.geminiThinkingBudget !== undefined || policy?.geminiThinkingLevel !== undefined;
    if (!represented)
      fail('unsupported_reasoning', 'Source thinking mode needs an explicit target wire policy', 'thinking');
  }
  if (target === 'responses') {
    // Validate canonical tools/history with the mature strict decoder; its wire body is discarded.
    const validation = decodeResponsesRequest({ ...b, reasoning: reasoning ? { ...reasoning, effort: undefined } : undefined }, 'chat_completions', { ...cap, reasoningHistory: true });
    if (mappedEffort !== undefined)
      b.reasoning = { ...reasoning, effort: mappedEffort };
    else if (reasoning?.effort !== undefined)
      fail('unsupported_reasoning', 'Responses requires an effort mapping', 'reasoning.effort');
    if (sourceThinking !== undefined && mappedEffort === undefined)
      fail('unsupported_reasoning', 'Source thinking cannot be represented without effort mapping', 'thinking');
    if (stop !== undefined)
      fail('unsupported_request', 'Responses has no stop-sequence request field', 'stop');
    for (const item of typeof b.input === 'string' ? [] : b.input as JsonRecord[])
      if (item.is_error === true)
        fail('unsupported_content', 'Responses tool results cannot preserve error authority', 'input');
    const identity = new Map<string, {
      name: string;
      custom: boolean;
    }>();
    for (const [, t] of validation.toolNames)
      identity.set(t.name, { name: t.name, custom: t.custom });
    return { body: b, canonicalHistory: validation.canonicalInput, diagnostics: validation.diagnostics, toolNames: identity,streaming:b.stream===true };
  }
  const format = b.text === undefined ? undefined : record(b.text, 'text').format;
  if (target === 'anthropic_messages') {
    if (format !== undefined && record(format, 'format').type !== 'text') {
      if (!cap.anthropicStructuredOutput)
        fail('unsupported_request', 'Target structured output capability is required', 'text.format');
      if (record(format, 'format').type !== 'json_schema')
        fail('unsupported_request', 'Anthropic requires an explicit JSON schema', 'text.format');
      if (record(format, 'format').strict === false)
        fail('unsupported_request', 'Non-strict output semantics cannot be represented', 'text.format.strict');
      b.text = { ...record(b.text, 'text'), format: { type: 'text' } };
    }
    if (b.metadata !== undefined) {
      const metadata = record(b.metadata, 'metadata');
      fields(metadata, ['user_id'], 'metadata');
      if (metadata.user_id !== undefined)
        string(metadata.user_id, 'metadata.user_id');
    }
    if (reasoning?.effort !== undefined) {
      if (mappedEffort !== undefined && !cap.anthropicEffort)
        fail('unsupported_reasoning', 'Target effort capability is required', 'reasoning.effort');
      b.reasoning = { ...reasoning, effort: undefined };
    }
  }
  else if (target === 'chat_completions') {
    if (reasoning?.effort !== undefined || mappedEffort !== undefined) {
      if (!cap.reasoningEffort)
        fail('unsupported_reasoning', 'Target effort capability is required', 'reasoning.effort');
      b.reasoning = { ...reasoning, effort: mappedEffort };
      if (mappedEffort === undefined)
        fail('unsupported_reasoning', 'Chat requires a target effort mapping', 'reasoning.effort');
    }
    for (const item of typeof b.input === 'string' ? [] : b.input as JsonRecord[])
      if (item.is_error === true)
        fail('unsupported_content', 'Chat tool results cannot preserve error authority', 'input');
  }
  const decodingTarget = target === 'gemini_generate_content' ? 'chat_completions' : target;
  if (target === 'gemini_generate_content' && reasoning)
    b.reasoning = { ...reasoning, effort: undefined };
  const decoded = decodeResponsesRequest(b, decodingTarget, { ...cap, reasoningHistory: target !== 'anthropic_messages' && cap.reasoningHistory === true, reasoningEffort: target === 'chat_completions' && cap.reasoningEffort === true, anthropicThinkingBudget: undefined });
  const diagnostics = decoded.diagnostics;
  const body = target === 'gemini_generate_content' ? renderGemini(decoded.body, cap.geminiJsonSchema === true) : decoded.body;
  if (stop !== undefined)
    body[target === 'chat_completions' ? 'stop' : target === 'anthropic_messages' ? 'stop_sequences' : 'generationConfig'] = target === 'gemini_generate_content' ? { ...record(body.generationConfig ?? {}, 'generationConfig'), stopSequences: typeof stop === 'string' ? [stop] : stop } : typeof stop === 'string' ? [stop] : stop;
  if (target === 'anthropic_messages') {
    if (format !== undefined && record(format, 'format').type === 'json_schema')
      body.output_config = { format: { type: 'json_schema', schema: record(format, 'format').schema } };
    if (mappedEffort !== undefined) {
      if (!cap.anthropicEffort)
        fail('unsupported_reasoning', 'Target effort capability is required', 'reasoning.effort');
      body.output_config = { ...record(body.output_config ?? {}, 'output_config'), effort: mappedEffort };
    }
    if (policy?.anthropicThinkingMode !== undefined)
      body.thinking = { type: policy.anthropicThinkingMode };
    if (policy?.anthropicThinkingBudget !== undefined) {
      const budget = integer(policy.anthropicThinkingBudget, 'reasoningPolicy.anthropicThinkingBudget', 1024);
      if (typeof body.max_tokens !== 'number' || budget >= body.max_tokens)
        fail('unsupported_reasoning', 'Thinking budget must be below max tokens', 'reasoningPolicy.anthropicThinkingBudget');
      if (policy.anthropicThinkingMode !== undefined && policy.anthropicThinkingMode !== 'enabled')
        fail('unsupported_reasoning', 'Budget requires enabled thinking', 'reasoningPolicy.anthropicThinkingMode');
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  if (target === 'gemini_generate_content' && (policy?.geminiThinkingBudget !== undefined || policy?.geminiThinkingLevel !== undefined)) {
    if (policy.geminiThinkingBudget !== undefined && policy.geminiThinkingLevel !== undefined)
      fail('unsupported_reasoning', 'Choose one Gemini thinking policy', 'reasoningPolicy');
    const thinkingConfig = policy.geminiThinkingBudget !== undefined ? { thinkingBudget: integer(policy.geminiThinkingBudget, 'reasoningPolicy.geminiThinkingBudget', -1) } : { thinkingLevel: string(policy.geminiThinkingLevel, 'reasoningPolicy.geminiThinkingLevel', true) };
    body.generationConfig = { ...record(body.generationConfig ?? {}, 'generationConfig'), thinkingConfig };
  }
  if (mappedEffort !== undefined || sourceThinking !== undefined || policy?.anthropicThinkingBudget !== undefined)
    diagnostics.push({ param: 'reasoning', action: 'mapped', reason: 'explicit_verified_wire_policy' });
  return { body, canonicalHistory: decoded.canonicalInput, diagnostics, toolNames: decoded.toolNames,streaming:b.stream===true };
}
function renderGemini(chat: JsonRecord, jsonSchema: boolean): JsonRecord {
  const result: JsonRecord = { contents: [] }, contents = result.contents as JsonRecord[], system: JsonRecord[] = [], calls = new Map<string, string>();
  const append = (role: string, parts: JsonRecord[]) => {
    const prev = contents.at(-1); if (prev?.role === role)
      (prev.parts as JsonRecord[]).push(...parts);
    else
      contents.push({ role, parts });
  };
  for (const m of chat.messages as JsonRecord[]) {
    const parts: JsonRecord[] = m.content == null ? [] : typeof m.content === 'string' ? [{ text: m.content }] : (m.content as JsonRecord[]).map(p => {
      if (p.type !== 'text')
        fail('unsupported_content', 'This content cannot cross to Gemini', 'input'); return { text: p.text };
    });
    if (m.role === 'system' || m.role === 'developer') {
      if (contents.length)
        fail('unsupported_content', 'Mid-conversation instructions cannot be relocated', 'input');
      system.push(...parts);
      continue;
    }
    if (m.role === 'tool') {
      const name = calls.get(string(m.tool_call_id, 'tool_call_id'));
      if (!name)
        fail('invalid_tool_history', 'Unknown tool result', 'input');
      if (m.is_error === true)
        fail('unsupported_content', 'Tool error authority cannot be represented by Gemini', 'input');
      append('user', [{ functionResponse: { id: m.tool_call_id, name, response: { output: m.content } } }]);
      continue;
    }
    if (m.reasoning_content !== undefined)
      parts.unshift({ text: m.reasoning_content, thought: true });
    for (const c of m.tool_calls as JsonRecord[] ?? []) {
      const fn = record(c.function, 'function');
      calls.set(c.id as string, fn.name as string);
      parts.push({ functionCall: { id: c.id, name: fn.name, args: argumentObject(fn.arguments as string) } });
    }
    append(m.role === 'assistant' ? 'model' : 'user', parts);
  }
  if (system.length)
    result.systemInstruction = { parts: system };
  const generation: JsonRecord = {};
  for (const [from, to] of Object.entries({ temperature: 'temperature', top_p: 'topP', max_completion_tokens: 'maxOutputTokens' }))
    if (chat[from] !== undefined)
      generation[to] = chat[from];
  if (chat.metadata !== undefined)
    fail('unsupported_request', 'Gemini has no compatible request metadata', 'metadata');
  if (chat.parallel_tool_calls !== undefined)
    fail('unsupported_request', 'Gemini cannot enforce parallel tool preference', 'parallel_tool_calls');
  if (chat.response_format !== undefined) {
    const f = record(chat.response_format, 'format');
    if (f.type === 'json_schema') {
      if (!jsonSchema)
        fail('unsupported_request', 'Target JSON schema capability is required', 'text.format');
      const s = record(f.json_schema, 'schema');
      if (s.strict === false)
        fail('unsupported_request', 'Gemini cannot request non-strict schema generation', 'text.format.strict');
      generation.responseMimeType = 'application/json';
      generation.responseJsonSchema = s.schema;
    }
    else if (f.type === 'json_object')
      generation.responseMimeType = 'application/json';
    else if (f.type !== 'text')
      fail('unsupported_request', 'Unknown output format', 'text.format');
  }
  if (Object.keys(generation).length)
    result.generationConfig = generation;
  if (chat.tools !== undefined) {
    const definitions = (chat.tools as JsonRecord[]).map(t => {
      const f = record(t.function, 'tool'); if (f.strict === true)
        fail('unsupported_tool', 'Gemini cannot enforce strict tool schema', 'tools'); return { name: f.name, parametersJsonSchema: f.parameters, ...(f.description !== undefined ? { description: f.description } : {}) };
    });
    result.tools = [{ functionDeclarations: definitions }];
  }
  if (chat.tool_choice !== undefined) {
    const c = chat.tool_choice;
    result.toolConfig = { functionCallingConfig: typeof c === 'string' ? { mode: c === 'auto' ? 'AUTO' : c === 'none' ? 'NONE' : 'ANY' } : { mode: 'ANY', allowedFunctionNames: [record(record(c, 'choice').function, 'function').name] } };
  }
  // Streaming is a URL operation for Gemini; transport caller owns the URL.
  return result;
}
