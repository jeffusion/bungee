import { validateAgentMessage, validateEncryptedFunctionArgs } from './agent-messages';
import { OpenAIProtocolConversion } from '../providers/openai/protocol-conversion';
import { isCollaborationFunction, argumentObject, atParam, bounded, fail, limits, list, record, serialized, string,
  type JsonRecord, type ResponsesCodecCapabilities, type ResponsesConversionDiagnostic, type ResponsesProtocol, type ResponsesToolName, type ResponsesToolNames } from './common';
import { applyResponsesPreferences } from './request-preferences';
import { validateWebSearch } from './web-search';

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
export function decodeResponsesRequest(raw: unknown, protocol: ResponsesProtocol, capabilities: ResponsesCodecCapabilities = {}, options: { preserveContentOrder?: boolean; toolOutputImages?: boolean } = {}): DecodedResponsesRequest {
  const body = record(raw, 'Responses request');
  if (capabilities.agentMessageDelivery !== undefined && capabilities.agentMessageDelivery !== 'plaintext') fail('invalid_payload', 'Unknown agent message delivery policy', 'agentMessageDelivery');
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
  const diagnostics: ResponsesConversionDiagnostic[] = [];
  if (body.include !== undefined) atParam('include', () => {
    for (const [index, field] of list(body.include, 'include').entries()) {
      if (field !== 'reasoning.encrypted_content' && field !== 'output.encrypted_content')
        fail('unsupported_request', 'Requested extra Responses output fields cannot be represented', `include[${index}]`);
      diagnostics.push({ param: `include[${index}]`, action: 'omitted', reason: 'target_encrypted_output_unavailable' });
    }
  });
  if (body.prompt_cache_key !== undefined) string(body.prompt_cache_key, 'prompt_cache_key');
  if (body.client_metadata !== undefined) record(body.client_metadata, 'client_metadata');
  const model = string(body.model, 'model', true);
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
  const expandTool = (rawTool: unknown, namespace?: string, path = 'tools', namespaceDescription?: string): void => {
    if (++examinedTools > budget.maxItems) fail('resource_limit', 'Too many tool declarations');
    const tool = record(rawTool, 'tool');
    if (namespace === undefined && (tool.type === 'web_search' || tool.type === 'web_search_preview')) {
      serialized(tool, budget.maxArgumentBytes, 'tool definition');
      validateWebSearch(tool, path);
      if (capabilities.omitOptionalWebSearch && (body.tool_choice === undefined || body.tool_choice === 'auto' || body.tool_choice === 'none')) {
        diagnostics.push({ param: path, action: 'omitted', reason: 'optional_hosted_web_search_unavailable' });
        return;
      }
      fail('unsupported_tool', 'Hosted web search cannot be executed by the target protocol', `${path}.type`);
    }
    const allowed = tool.type === 'namespace' ? ['type','name','description','tools']
      : tool.type === 'custom' ? ['type','name','description','format'] : ['type','name','description','parameters','strict'];
    for (const key of Object.keys(tool)) if (!allowed.includes(key)) fail('unsupported_tool', 'Unsupported tool definition field', `${path}.${key}`);
    if (tool.type === 'namespace') {
      if (namespace !== undefined) fail('unsupported_tool', 'Nested tool namespaces are not supported');
      const name = string(tool.name, 'namespace name', true);
      const description = tool.description === undefined ? undefined : string(tool.description, 'namespace description');
      for (const [index, child] of list(tool.tools, 'namespace tools').entries()) {
        const childPath = `${path}.tools[${index}]`;
        atParam(childPath, () => expandTool(child, name, childPath, description));
      }
      return;
    }
    if (tool.type !== 'function' && tool.type !== 'custom') fail('unsupported_tool', 'This tool type cannot be executed by Codex through the target protocol');
    serialized(tool, budget.maxArgumentBytes, 'tool definition');
    const name = string(tool.name, 'tool name', true);
    const custom = tool.type === 'custom';
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') fail('invalid_payload', 'Tool strict must be boolean');
    if (protocol === 'anthropic_messages' && tool.strict === true && !capabilities.anthropicStrictTools) fail('unsupported_tool', 'Anthropic strict tool enforcement requires an explicit provider capability');
    if (custom && tool.format !== undefined) {
      const format = record(tool.format, 'custom format');
      if (format.type !== 'text' && format.type !== 'grammar') fail('unsupported_tool', 'Unknown custom tool format');
    }
    const key = identity(name, namespace);
    const signature = definitionKey({ ...tool, ...(namespaceDescription !== undefined ? { namespaceDescription } : {}) });
    if (definitions.has(key)) {
      if (definitions.get(key) !== signature) fail('tool_name_collision', 'Conflicting definitions for the same tool identity');
      return;
    }
    const wire = register(name, namespace, custom);
    definitions.set(key, signature);
    let parameters = custom
      ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
      : record(tool.parameters ?? { type: 'object', properties: {} }, 'tool parameters');
    if (capabilities.agentMessageDelivery === 'plaintext' && isCollaborationFunction(name, namespace, custom)) {
      const properties = parameters.properties;
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        const message = (properties as JsonRecord).message;
        if (message && typeof message === 'object' && !Array.isArray(message) && (message as JsonRecord).encrypted === true) {
          const { encrypted: _encrypted, ...plaintext } = message as JsonRecord;
          parameters = { ...parameters, properties: { ...properties, message: plaintext } };
          diagnostics.push({ param: `${path}.parameters.properties.message.encrypted`, action: 'omitted', reason: 'collaboration_message_plaintext_delivery' });
        }
      }
    }
    const declaredDescription = tool.description === undefined ? undefined : string(tool.description, 'tool description');
    const identityHint = capabilities.preserveToolIdentityDescription ? `Original tool identity: ${JSON.stringify({ name, ...(namespace ? { namespace } : {}) })}` : undefined;
    const description = [identityHint, namespaceDescription, declaredDescription].filter(value => value !== undefined).join('\n') || undefined;
    const customHint = custom ? `Pass the complete original custom tool input verbatim in the input string.${tool.format ? ` Original input format: ${JSON.stringify(tool.format)}` : ''}` : undefined;
    if (protocol === 'chat_completions') {
      tools.push({ type: 'function', function: { name: wire, parameters, ...(description || customHint ? { description: [description, customHint].filter(Boolean).join('\n') } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } });
    } else {
      tools.push({ name: wire, input_schema: parameters, ...(description || customHint ? { description: [description, customHint].filter(Boolean).join('\n') } : {}), ...(tool.strict !== undefined && capabilities.anthropicStrictTools ? {strict:tool.strict} : {}) });
    }
  };
  if (body.tools !== undefined) atParam('tools', () => {
    for (const [index, tool] of list(body.tools, 'tools').entries()) atParam(`tools[${index}]`, () => expandTool(tool, undefined, `tools[${index}]`));
  });
  // Behavior reference: cc-switch b4a0794 collect_input_declared_tools. Tool carriers
  // are declarations, not messages. Use this codec's existing reversible name authority.
  for (const [index, rawItem] of input.entries()) atParam(`input[${index}]`, () => {
    const item = record(rawItem, 'input item');
    if (item.type !== 'additional_tools') {
      if(item.internal_chat_message_metadata_passthrough!==undefined) {
        record(item.internal_chat_message_metadata_passthrough,'message metadata');
        const {internal_chat_message_metadata_passthrough: _metadata,...message}=item;
        canonicalInput.push(message);
        diagnostics.push({param:`input[${index}].internal_chat_message_metadata_passthrough`,action:'omitted',reason:'source_message_metadata'});
      } else canonicalInput.push(item);
      return;
    }
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
  const normalizeContent = (rawContent: unknown, role: string, path: string): unknown => {
    if (typeof rawContent === 'string') return rawContent;
    const parts = list(rawContent, 'message content');
    for (const [index, rawPart] of parts.entries()) {
      const partPath = `${path}[${index}]`;
      atParam(partPath, () => {
        const part = record(rawPart, 'content part');
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') string(part.text, 'content text');
        else if (part.type === 'refusal' && role === 'assistant') {
          string(part.refusal,'refusal');
          if (capabilities.preserveRefusalContent && protocol !== 'chat_completions') fail('unsupported_content','Target protocol cannot preserve refusal history authority');
        }
        else if (part.type === 'input_image' && (role === 'user' || role === 'tool')) {
          if (protocol !== 'chat_completions') fail('unsupported_content', 'Anthropic image conversion requires provider-specific URL/data support');
          for (const key of Object.keys(part)) if (!['type', 'image_url', 'detail'].includes(key)) fail('unsupported_content', 'Unsupported image field', `${partPath}.${key}`);
          string(part.image_url, 'image_url', true);
          if (part.detail !== undefined && (typeof part.detail !== 'string' || !['auto', 'low', 'high'].includes(part.detail))) fail('unsupported_content', 'Unknown image detail', `${partPath}.detail`);
        } else fail('unsupported_content', 'Unsupported message content type');
        if (part.annotations !== undefined && list(part.annotations, 'annotations').length) fail('unsupported_content', 'Output annotations cannot be represented in input history');
      });
    }
    // Reuse the existing text/image normalizer only after validating every part.
    const normalized = contentNormalizer.normalizeResponsesMessageContent(parts.map(raw=>{const part=raw as JsonRecord;return part.type==='refusal'?{type:'output_text',text:part.refusal}:part;})) as JsonRecord[];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as JsonRecord;
      if (part.type === 'input_image' && part.detail !== undefined) (normalized[i].image_url as JsonRecord).detail = part.detail;
      if (part.type === 'refusal' && capabilities.preserveRefusalContent) normalized[i] = {type:'refusal',refusal:part.refusal};
    }
    return normalized;
  };
  const appendAssistantContent = (previous: unknown, next: unknown): unknown => {
    if (previous == null) return next;
    if (next == null) return previous;
    if (typeof previous === 'string' && typeof next === 'string') return previous + next;
    const parts = (value: unknown): JsonRecord[] => typeof value === 'string'
      ? [{ type: 'text', text: value }]
      : Array.isArray(value) ? value as JsonRecord[] : [value as JsonRecord];
    return [...parts(previous), ...parts(next)];
  };
  const chat: JsonRecord[] = [];
  const messageParams = new WeakMap<JsonRecord, string>();
  let messageParam = 'instructions';
  const callIds = new Set<string>();
  const callToolNames = new Map<string, string>();
  const answered = new Set<string>();
  const projectedToolImages: { callId: string; name: string; images: JsonRecord[] }[] = [];
  let pendingReasoning = '';
  const addMessage = (message: JsonRecord): void => {
    if (chat.length >= budget.maxItems) fail('resource_limit', 'Too many input messages');
    chat.push(message);
    messageParams.set(message, messageParam);
  };
  const flushToolImages = (force = false): void => {
    if (!force && [...callIds].some(id => !answered.has(id))) return;
    for (const { callId, name, images } of projectedToolImages)
      addMessage({ role: 'user', content: [{ type: 'text', text: `Images returned by tool ${JSON.stringify(name)} (call ${JSON.stringify(callId)}):` }, ...images] });
    projectedToolImages.length = 0;
  };
  if (body.instructions !== undefined) addMessage({ role: 'system', content: string(body.instructions, 'instructions') });
  for (const [inputIndex, rawItem] of input.entries()) atParam(`input[${inputIndex}]`, () => {
    messageParam = `input[${inputIndex}]`;
    const item = record(rawItem, 'input item');
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') flushToolImages();
    if (item.type === 'additional_tools') return;
    if (item.type === 'agent_message') {
      validateAgentMessage(item, messageParam, capabilities.limits);
      if (capabilities.agentMessageDelivery !== 'plaintext') fail('unsupported_content', 'Agent messages require explicit plaintext delivery', messageParam);
      if (pendingReasoning) fail('unsupported_reasoning', 'Reasoning must precede an assistant item', messageParam);
      addMessage({ role: 'user', content: [{ type: 'text', text: `[Agent message metadata: ${JSON.stringify({ author: item.author, recipient: item.recipient })}]\n` }, ...(item.content as JsonRecord[]).map(part => ({ type: 'text', text: part.text }))] });
      diagnostics.push({ param: messageParam, action: 'mapped', reason: 'agent_message_plaintext_delivery' });
      return;
    }
    if (item.encrypted_content != null) fail('unsupported_content', 'Encrypted content cannot cross protocols', `${messageParam}.encrypted_content`);
    if (item.type === 'compaction') fail('unsupported_content', 'Encrypted reasoning and compaction cannot be restored');
    if (item.type === 'item_reference') fail('unresolved_reference', 'Input item references must be resolved before conversion');
    if (item.type === 'reasoning') {
      if (protocol !== 'chat_completions' || !(capabilities.reasoningHistory || capabilities.reasoningEffort)) fail('unsupported_reasoning', 'Reasoning history requires an explicit compatible reasoning capability');
      if (item.content != null) fail('unsupported_reasoning', 'Reasoning content requires an explicit history mapping', `${messageParam}.content`);
      const summary = list(item.summary, 'reasoning summary');
      const text = summary.map(part => { const p = record(part, 'reasoning summary'); if (p.type !== 'summary_text') fail('unsupported_reasoning', 'Unknown reasoning summary'); return string(p.text, 'summary text'); }).join('');
      if (options.preserveContentOrder) addMessage({ role: 'assistant', content: null, reasoning_content: text, ...(item.id === undefined ? {} : { id: string(item.id, 'item.id', true) }) });
      else pendingReasoning += text;
      return;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call';
      validateEncryptedFunctionArgs(item, capabilities.agentMessageDelivery, messageParam);
      const id = string(item.call_id, 'call_id', true);
      if (callIds.has(id)) fail('invalid_tool_history', 'Duplicate tool call identifier');
      callIds.add(id);
      const args = custom ? JSON.stringify({ input: string(item.input, 'custom input') }) : string(item.arguments, 'arguments');
      bounded(args, budget.maxArgumentBytes, 'arguments'); argumentObject(args);
      const call = { id, type: 'function', function: { name: resolve(item, custom), arguments: args } };
      callToolNames.set(id, String(item.name));
      const previous = chat.at(-1);
      if (previous?.role === 'assistant' && !options.preserveContentOrder) {
        previous.tool_calls = [...(previous.tool_calls as JsonRecord[] ?? []), call];
        if (pendingReasoning)
          previous.reasoning_content = previous.reasoning_content === undefined ? pendingReasoning : `${previous.reasoning_content}${pendingReasoning}`;
      } else addMessage({ role: 'assistant', content: null, tool_calls: [call], ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = '';
      return;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const id = string(item.call_id, 'call_id', true);
      if (!callIds.has(id) || answered.has(id)) fail('invalid_tool_history', 'Unmatched or duplicate tool result');
      answered.add(id);
      if (Array.isArray(item.output) && item.output.length > budget.maxItems
        && item.output.some(part => part && typeof part === 'object' && (part as JsonRecord).type === 'input_image'))
        fail('resource_limit', 'Too many tool output content parts', `${messageParam}.output`);
      let output = typeof item.output === 'string' ? item.output : normalizeContent(item.output, 'tool', `${messageParam}.output`);
      if (protocol === 'chat_completions' && !options.toolOutputImages && Array.isArray(output)) {
        const images = output.filter(part => part.type === 'image_url');
        if (images.length) {
          output.forEach((part, index) => {
            if (part.type === 'image_url')
              diagnostics.push({ param: `${messageParam}.output[${index}]`, action: 'mapped', reason: 'chat_tool_image_projected_to_user_message' });
          });
          const text = output.filter(part => part.type !== 'image_url');
          projectedToolImages.push({ callId: id, name: callToolNames.get(id) ?? id, images });
          output = text.length ? text : 'Tool output contained only images; see the following images.';
        }
      }
      addMessage({ role: 'tool', tool_call_id: id, content: output, ...(item.is_error === true ? { is_error: true } : {}) });
      return;
    }
    if (item.type !== undefined && item.type !== 'message') fail('unsupported_content', 'Unsupported input item type');
    const role = string(item.role, 'message role', true);
    if (!['user', 'assistant', 'system', 'developer'].includes(role)) fail('unsupported_content', 'Unknown message role');
    const message: JsonRecord = { role, content: normalizeContent(item.content, role, `${messageParam}.content`) };
    if (options.preserveContentOrder && item.id !== undefined) message.id = string(item.id, 'item.id', true);
    if (pendingReasoning) { if (role !== 'assistant') fail('unsupported_reasoning', 'Reasoning must precede an assistant item'); message.reasoning_content = pendingReasoning; pendingReasoning = ''; }
    if (protocol === 'chat_completions' && !options.preserveContentOrder && role === 'assistant') {
      const previous = chat.at(-1);
      if (previous?.role === 'assistant') {
        previous.content = appendAssistantContent(previous.content, message.content);
        if (message.reasoning_content !== undefined)
          previous.reasoning_content = previous.reasoning_content === undefined ? message.reasoning_content : `${previous.reasoning_content}${message.reasoning_content}`;
        return;
      }
    }
    addMessage(message);
  });
  if (pendingReasoning) fail('unsupported_reasoning', 'Orphan reasoning history cannot be represented');
  flushToolImages(true);
  const result: JsonRecord = { model, messages: chat };
  const omittedAllTools = !tools.length && diagnostics.some(item => item.reason === 'optional_hosted_web_search_unavailable');
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata'])
    if (body[key] !== undefined && !(omittedAllTools && key === 'parallel_tool_calls')) result[key] = body[key];
  if (protocol === 'chat_completions' && body.stream === true) result.stream_options = { include_usage: true };
  const maxTokens = body.max_output_tokens ?? capabilities.maxOutputTokens;
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) fail('invalid_payload', 'max_output_tokens must be a positive integer');
    result[protocol === 'chat_completions' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  }
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined && !omittedAllTools) {
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
    if (body.parallel_tool_calls !== undefined && !omittedAllTools) {
      result.tool_choice = { ...record(result.tool_choice ?? { type: 'auto' }, 'tool_choice'), disable_parallel_tool_use: body.parallel_tool_calls === false };
      delete result.parallel_tool_calls;
    }
  }
  return { body: result, toolNames, canonicalInput, diagnostics };
}
