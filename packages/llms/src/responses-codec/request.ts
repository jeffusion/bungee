import { OpenAIProtocolConversion } from '../providers/openai/protocol-conversion';
import { argumentObject, atParam, bounded, fail, limits, list, record, serialized, string,
  type JsonRecord, type ResponsesCodecCapabilities, type ResponsesConversionDiagnostic, type ResponsesProtocol, type ResponsesToolName, type ResponsesToolNames } from './common';
import { applyResponsesPreferences } from './request-preferences';

const contentNormalizer = new OpenAIProtocolConversion({ trimWhitespace: false });

export interface DecodedResponsesRequest {
  body: JsonRecord;
  toolNames: ResponsesToolNames;
  canonicalInput: JsonRecord[];
  diagnostics: ResponsesConversionDiagnostic[];
}

// Compare JSON definitions independently of object key order; arrays retain their order.
function definitionKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(definitionKey).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${definitionKey((value as JsonRecord)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Converts only self-contained history. Reference resolution belongs to the caller. */
export function decodeResponsesRequest(raw: unknown, protocol: ResponsesProtocol, capabilities: ResponsesCodecCapabilities = {}): DecodedResponsesRequest {
  const body = record(raw, 'Responses request');
  const budget = limits(capabilities.limits);
  serialized(body, budget.maxRequestBytes, 'request');
  const supported = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'reasoning', 'text',
    'stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'max_output_tokens',
    'previous_response_id', 'conversation', 'response_id', 'background', 'n', 'truncation', 'include', 'store', 'prompt_cache_key', 'client_metadata', 'stream_options', 'access_programs']);
  for (const key of Object.keys(body)) if (!supported.has(key)) fail('unsupported_request', 'Unrecognized Responses request field', key);
  if (body.store === true) fail('unsupported_request', 'Stored Responses require caller-owned persistence');
  for (const key of ['previous_response_id', 'conversation', 'response_id']) {
    if (body[key] != null) fail('unresolved_reference', `${key} must be resolved before protocol conversion`);
  }
  if (body.background === true) fail('unsupported_request', 'Background Responses cannot be represented by this codec');
  if (body.n !== undefined && body.n !== 1) fail('unsupported_request', 'Only one response candidate is supported');
  if (body.truncation !== undefined && body.truncation !== 'disabled') fail('unsupported_request', 'Automatic input truncation cannot be represented');
  // This asks for encrypted output if available; it does not supply opaque input history.
  // Converted providers return no encrypted output. Actual encrypted input remains rejected below.
  if (body.include !== undefined && list(body.include, 'include').some(field => field !== 'reasoning.encrypted_content')) fail('unsupported_request', 'Requested extra Responses output fields cannot be represented');
  if (body.prompt_cache_key !== undefined) string(body.prompt_cache_key, 'prompt_cache_key');
  if (body.client_metadata !== undefined) record(body.client_metadata, 'client_metadata');
  const model = string(body.model, 'model', true);
  const diagnostics: ResponsesConversionDiagnostic[] = [];
  const input = atParam('input', () => typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : list(body.input, 'input'));
  if (input.length > budget.maxItems) fail('resource_limit', 'Too many input items', 'input');
  const canonicalInput: JsonRecord[] = [];
  const toolNames = new Map<string, ResponsesToolName>();
  const byOriginal = new Map<string, string>();
  const definitions = new Map<string, string>();
  let examinedTools = 0;
  const tools: JsonRecord[] = [];
  const identity = (name: string, namespace?: string) => JSON.stringify([namespace ?? null, name]);
  const register = (name: string, namespace: string | undefined, custom: boolean): string => {
    const key = identity(name, namespace);
    if (byOriginal.has(key)) fail('tool_name_collision', 'Duplicate tool identity');
    if (toolNames.size >= budget.maxItems) fail('resource_limit', 'Too many tools');
    // Always use short opaque names: arbitrary Unicode/namespace names and collisions are reversible.
    const wire = `bungee_tool_${toolNames.size}`;
    toolNames.set(wire, { name, namespace, custom }); byOriginal.set(key, wire);
    return wire;
  };
  const expandTool = (rawTool: unknown, namespace?: string, path = 'tools'): void => {
    if (++examinedTools > budget.maxItems) fail('resource_limit', 'Too many tool declarations');
    const tool = record(rawTool, 'tool');
    if (namespace === undefined && capabilities.omitOptionalWebSearch && ['web_search','web_search_preview'].includes(String(tool.type))
      && (body.tool_choice === undefined || body.tool_choice === 'auto' || body.tool_choice === 'none')) return;
    const allowed = tool.type === 'namespace' ? ['type','name','description','tools']
      : tool.type === 'custom' ? ['type','name','description','format'] : ['type','name','description','parameters','strict'];
    for (const key of Object.keys(tool)) if (!allowed.includes(key)) fail('unsupported_tool', 'Unsupported tool definition field', `${path}.${key}`);
    if (tool.type === 'namespace') {
      if (namespace !== undefined) fail('unsupported_tool', 'Nested tool namespaces are not supported');
      const name = string(tool.name, 'namespace name', true);
      for (const [index, child] of list(tool.tools, 'namespace tools').entries()) {
        const childPath = `${path}.tools[${index}]`;
        atParam(childPath, () => expandTool(child, name, childPath));
      }
      return;
    }
    if (tool.type !== 'function' && tool.type !== 'custom') fail('unsupported_tool', 'This tool type cannot be executed by Codex through the target protocol');
    serialized(tool, budget.maxArgumentBytes, 'tool definition');
    const name = string(tool.name, 'tool name', true);
    const custom = tool.type === 'custom';
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') fail('invalid_payload', 'Tool strict must be boolean');
    if (protocol === 'anthropic_messages' && tool.strict === true) fail('unsupported_tool', 'Anthropic strict tool enforcement requires an explicit provider capability');
    if (custom && tool.format !== undefined) {
      const format = record(tool.format, 'custom format');
      if (format.type !== 'text' && format.type !== 'grammar') fail('unsupported_tool', 'Unknown custom tool format');
    }
    const key = identity(name, namespace);
    const signature = definitionKey(tool);
    if (definitions.has(key)) {
      if (definitions.get(key) !== signature) fail('tool_name_collision', 'Conflicting definitions for the same tool identity');
      return;
    }
    const wire = register(name, namespace, custom);
    definitions.set(key, signature);
    const parameters = custom
      ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
      : record(tool.parameters ?? { type: 'object', properties: {} }, 'tool parameters');
    const description = tool.description === undefined ? undefined : string(tool.description, 'tool description');
    const customHint = custom ? `Pass the complete original custom tool input verbatim in the input string.${tool.format ? ` Original input format: ${JSON.stringify(tool.format)}` : ''}` : undefined;
    if (protocol === 'chat_completions') {
      tools.push({ type: 'function', function: { name: wire, parameters, ...(description || customHint ? { description: [description, customHint].filter(Boolean).join('\n') } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } });
    } else {
      tools.push({ name: wire, input_schema: parameters, ...(description || customHint ? { description: [description, customHint].filter(Boolean).join('\n') } : {}) });
    }
  };
  if (body.tools !== undefined) atParam('tools', () => {
    for (const [index, tool] of list(body.tools, 'tools').entries()) atParam(`tools[${index}]`, () => expandTool(tool, undefined, `tools[${index}]`));
  });
  // Behavior reference: cc-switch b4a0794 collect_input_declared_tools. Tool carriers
  // are declarations, not messages. Use this codec's existing reversible name authority.
  for (const [index, rawItem] of input.entries()) atParam(`input[${index}]`, () => {
    const item = record(rawItem, 'input item');
    if (item.type !== 'additional_tools') { canonicalInput.push(item); return; }
    if (item.content !== undefined) fail('invalid_payload', 'A tool declaration carrier cannot also contain message content', `input[${index}].content`);
    for (const [toolIndex, tool] of list(item.tools, 'additional tools').entries()) {
      const toolPath = `input[${index}].tools[${toolIndex}]`;
      atParam(toolPath, () => expandTool(tool, undefined, toolPath));
    }
  });
  const resolve = (item: JsonRecord, custom: boolean): string => {
    const name = string(item.name, 'call name', true);
    const namespace = item.namespace === undefined ? undefined : string(item.namespace, 'call namespace', true);
    let wire = byOriginal.get(identity(name, namespace));
    // Historical calls need not appear in today's tool declarations. Preserve them in the same authority.
    if (wire === undefined) wire = register(name, namespace, custom);
    if (toolNames.get(wire)!.custom !== custom) fail('tool_name_collision', 'Historical tool kind conflicts with its current declaration');
    return wire;
  };
  const normalizeContent = (rawContent: unknown, role: string): unknown => {
    if (typeof rawContent === 'string') return rawContent;
    const parts = list(rawContent, 'message content');
    for (const rawPart of parts) {
      const part = record(rawPart, 'content part');
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') string(part.text, 'content text');
      else if (part.type === 'refusal' && role === 'assistant') string(part.refusal,'refusal');
      else if (part.type === 'input_image' && role === 'user') {
        if (protocol !== 'chat_completions') fail('unsupported_content', 'Anthropic image conversion requires provider-specific URL/data support');
        string(part.image_url, 'image_url', true);
        if (part.detail !== undefined && !['auto', 'low', 'high'].includes(String(part.detail))) fail('unsupported_content', 'Unknown image detail');
      } else fail('unsupported_content', 'Unsupported message content type');
      if (part.annotations !== undefined && list(part.annotations, 'annotations').length) fail('unsupported_content', 'Output annotations cannot be represented in input history');
    }
    // Reuse the existing text/image normalizer only after validating every part.
    const normalized = contentNormalizer.normalizeResponsesMessageContent(parts.map(raw=>{const part=raw as JsonRecord;return part.type==='refusal'?{type:'output_text',text:part.refusal}:part;})) as JsonRecord[];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as JsonRecord;
      if (part.type === 'input_image' && part.detail !== undefined) (normalized[i].image_url as JsonRecord).detail = part.detail;
    }
    return normalized;
  };
  const chat: JsonRecord[] = [];
  const messageParams = new WeakMap<JsonRecord, string>();
  let messageParam = 'instructions';
  const callIds = new Set<string>();
  const answered = new Set<string>();
  let pendingReasoning = '';
  const addMessage = (message: JsonRecord): void => {
    if (chat.length >= budget.maxItems) fail('resource_limit', 'Too many input messages');
    chat.push(message);
    messageParams.set(message, messageParam);
  };
  if (body.instructions !== undefined) addMessage({ role: 'system', content: string(body.instructions, 'instructions') });
  for (const [inputIndex, rawItem] of input.entries()) atParam(`input[${inputIndex}]`, () => {
    messageParam = `input[${inputIndex}]`;
    const item = record(rawItem, 'input item');
    if (item.type === 'additional_tools') return;
    if (item.encrypted_content !== undefined || item.type === 'compaction') fail('unsupported_content', 'Encrypted reasoning and compaction cannot be restored');
    if (item.type === 'item_reference') fail('unresolved_reference', 'Input item references must be resolved before conversion');
    if (item.type === 'reasoning') {
      if (protocol !== 'chat_completions' || !capabilities.reasoningEffort) fail('unsupported_reasoning', 'Reasoning history requires an explicit compatible reasoning capability');
      const summary = list(item.summary, 'reasoning summary');
      pendingReasoning += summary.map(part => { const p = record(part, 'reasoning summary'); if (p.type !== 'summary_text') fail('unsupported_reasoning', 'Unknown reasoning summary'); return string(p.text, 'summary text'); }).join('');
      return;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call';
      const id = string(item.call_id, 'call_id', true);
      if (callIds.has(id)) fail('invalid_tool_history', 'Duplicate tool call identifier');
      callIds.add(id);
      const args = custom ? JSON.stringify({ input: string(item.input, 'custom input') }) : string(item.arguments, 'arguments');
      bounded(args, budget.maxArgumentBytes, 'arguments'); argumentObject(args);
      const call = { id, type: 'function', function: { name: resolve(item, custom), arguments: args } };
      const previous = chat.at(-1);
      if (previous?.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls as JsonRecord[] ?? []), call];
        if (pendingReasoning) previous.reasoning_content = pendingReasoning;
      } else addMessage({ role: 'assistant', content: null, tool_calls: [call], ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = '';
      return;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const id = string(item.call_id, 'call_id', true);
      if (!callIds.has(id) || answered.has(id)) fail('invalid_tool_history', 'Unmatched or duplicate tool result');
      answered.add(id);
      const output = typeof item.output === 'string' ? item.output : normalizeContent(item.output, 'tool');
      addMessage({ role: 'tool', tool_call_id: id, content: output, ...(item.is_error === true ? { is_error: true } : {}) });
      return;
    }
    if (item.type !== undefined && item.type !== 'message') fail('unsupported_content', 'Unsupported input item type');
    const role = string(item.role, 'message role', true);
    if (!['user', 'assistant', 'system', 'developer'].includes(role)) fail('unsupported_content', 'Unknown message role');
    const message: JsonRecord = { role, content: normalizeContent(item.content, role) };
    if (pendingReasoning) { if (role !== 'assistant') fail('unsupported_reasoning', 'Reasoning must precede an assistant item'); message.reasoning_content = pendingReasoning; pendingReasoning = ''; }
    addMessage(message);
  });
  if (pendingReasoning) fail('unsupported_reasoning', 'Orphan reasoning history cannot be represented');
  const result: JsonRecord = { model, messages: chat };
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata']) if (body[key] !== undefined) result[key] = body[key];
  if (protocol === 'chat_completions' && body.stream === true) result.stream_options = { include_usage: true };
  const maxTokens = body.max_output_tokens ?? capabilities.maxOutputTokens;
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) fail('invalid_payload', 'max_output_tokens must be a positive integer');
    result[protocol === 'chat_completions' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  }
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) fail('unsupported_tool_choice', `Unsupported tool choice ${choice}`);
      result.tool_choice = protocol === 'chat_completions' ? choice : { type: choice === 'required' ? 'any' : choice };
    } else {
      const c = record(choice, 'tool_choice');
      if (c.type !== 'function' && c.type !== 'custom') fail('unsupported_tool_choice', 'Forced hosted tools are unsupported');
      const wire = byOriginal.get(identity(string(c.name, 'tool choice name', true), c.namespace === undefined ? undefined : string(c.namespace, 'tool choice namespace')));
      if (!wire || !tools.some(t => t.name === wire || (t.function as JsonRecord | undefined)?.name === wire)) fail('unsupported_tool_choice', 'Forced tool is not declared');
      result.tool_choice = protocol === 'chat_completions' ? { type: 'function', function: { name: wire } } : { type: 'tool', name: wire };
    }
  }
  applyResponsesPreferences(body, result, protocol, capabilities, maxTokens, diagnostics);
  if (body.text !== undefined) atParam('text.format', () => {
    const text = record(body.text, 'text');
    if (text.format !== undefined) {
      const format = record(text.format, 'text format');
      const allowed = format.type === 'json_schema' ? ['type','name','schema','strict','description'] : ['type'];
      for (const key of Object.keys(format)) if (!allowed.includes(key)) fail('unsupported_request', 'Unsupported output format field', `text.format.${key}`);
      if (format.type === 'json_schema') {
        atParam('text.format.name', () => string(format.name, 'output schema name', true));
        atParam('text.format.schema', () => record(format.schema, 'output schema'));
        if (format.strict !== undefined && typeof format.strict !== 'boolean') fail('invalid_payload', 'Output schema strict must be boolean', 'text.format.strict');
        if (format.description !== undefined) atParam('text.format.description', () => string(format.description, 'output schema description'));
      }
      if (protocol !== 'chat_completions' && format.type !== 'text') fail('unsupported_request', 'Anthropic structured output requires a separate provider capability');
      if (format.type === 'json_schema') result.response_format = { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}), ...(format.description !== undefined ? { description: format.description } : {}) } };
      else if (format.type === 'json_object' || format.type === 'text') { if (protocol === 'chat_completions') result.response_format = format; }
      else fail('unsupported_request', 'Unknown text format');
    }
  });
  if (protocol === 'anthropic_messages') {
    const system: string[] = [];
    const messages: JsonRecord[] = [];
    const append = (role: string, content: JsonRecord[]): void => {
      const previous = messages.at(-1);
      if (previous?.role === role) (previous.content as JsonRecord[]).push(...content);
      else messages.push({ role, content });
    };
    for (const msg of chat) {
      if (msg.role === 'system' || msg.role === 'developer') {
        if (messages.length) fail('unsupported_content', 'Mid-conversation system instructions cannot be relocated safely', `${messageParams.get(msg)}.role`);
        system.push(typeof msg.content === 'string' ? msg.content : (msg.content as JsonRecord[]).map(p => string(p.text, 'system text')).join(''));
        continue;
      }
      if (msg.role === 'tool') {
        append('user', [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content, ...(msg.is_error ? { is_error: true } : {}) }]);
      } else {
        const content: JsonRecord[] = msg.content == null ? [] : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content as JsonRecord[];
        for (const call of msg.tool_calls as JsonRecord[] ?? []) {
          const fn = call.function as JsonRecord;
          content.push({ type: 'tool_use', id: call.id, name: fn.name, input: argumentObject(fn.arguments as string) });
        }
        append(msg.role as string, content);
      }
    }
    result.messages = messages;
    if (system.length) result.system = system.join('\n');
    if (maxTokens === undefined) fail('missing_capability', 'Anthropic requires max_output_tokens or capabilities.maxOutputTokens');
    if (body.parallel_tool_calls !== undefined) {
      result.tool_choice = { ...record(result.tool_choice ?? { type: 'auto' }, 'tool_choice'), disable_parallel_tool_use: body.parallel_tool_calls === false };
      delete result.parallel_tool_calls;
    }
  }
  return { body: result, toolNames, canonicalInput, diagnostics };
}
