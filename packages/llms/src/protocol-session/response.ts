import { ResponsesEventEncoder, encodeResponsesResult } from '../responses-codec';
import { argumentObject, fail, list, record, string, serialized, limits, type JsonRecord, type ResponsesToolNames } from '../responses-codec/common';
import { fields, integer } from './validation';
import type { LLMProtocol, ProtocolSessionContext } from './types';
export function safeProtocolError(): JsonRecord { return { code: 'upstream_error', type: 'api_error', message: 'Upstream protocol request failed' }; }
export function validateUsage(raw: unknown, protocol: LLMProtocol): void {
  if (raw === undefined || raw === null)
    return;
  const u = record(raw, 'usage');
  const keys = protocol === 'chat_completions' ? ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'] :
    protocol === 'anthropic_messages' ? ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] :
      ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'];
  fields(u, keys, 'usage', 'unsupported_response');
  for (const [key, value] of Object.entries(u)) {
    if (key.endsWith('_details')) {
      const d = record(value, 'usage details');
      fields(d, key.includes('output') || key.includes('completion') ? ['reasoning_tokens'] : ['cached_tokens', 'cache_creation_tokens'], `usage.${key}`, 'unsupported_response');
      for (const [k, v] of Object.entries(d))
        integer(v, `usage.${key}.${k}`);
    }
    else
      integer(value, `usage.${key}`);
  }
}
export function validateProviderResponse(raw: unknown, protocol: LLMProtocol): JsonRecord {
  const b = record(raw, 'response');
  if (b.error !== undefined || b.type === 'error')
    return b;
  if (protocol === 'chat_completions') {
    fields(b, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'], '', 'unsupported_response');
    for (const rawChoice of list(b.choices, 'choices')) {
      const c = record(rawChoice, 'choice');
      fields(c, ['index', 'message', 'finish_reason', 'logprobs'], 'choices', 'unsupported_response');
      if (c.logprobs != null)
        fail('unsupported_response', 'Log probabilities cannot cross protocols', 'choices.logprobs');
      const m = record(c.message, 'message');
      fields(m, ['role', 'content', 'refusal', 'reasoning_content', 'reasoning', 'tool_calls', 'annotations'], 'message', 'unsupported_content');
      for (const rawCall of m.tool_calls === undefined ? [] : list(m.tool_calls, 'tool_calls')) {
        const call = record(rawCall, 'call');
        fields(call, ['id', 'type', 'function'], 'tool_calls', 'unsupported_tool');
        fields(record(call.function, 'function'), ['name', 'arguments'], 'tool_calls.function', 'unsupported_tool');
      }
    }
    validateUsage(b.usage, protocol);
  }
  else if (protocol === 'anthropic_messages') {
    fields(b, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage'], '', 'unsupported_response');
    if (b.role !== undefined && b.role !== 'assistant')
      fail('unsupported_response', 'Response role must be assistant', 'role');
    for (const rawPart of list(b.content, 'content'))
      validateAnthropicBlock(record(rawPart, 'block'), 'content');
    validateUsage(b.usage, protocol);
  }
  return b;
}
export function validateAnthropicBlock(b: JsonRecord, path: string): void {
  fields(b, b.type === 'text' ? ['type', 'text'] : b.type === 'thinking' ? ['type', 'thinking', 'signature'] : ['type', 'id', 'name', 'input'], path, 'unsupported_content');
  if (b.signature !== undefined)
    fail('unsupported_reasoning', 'Signed provider reasoning cannot cross protocols', `${path}.signature`);
}
export function validateCanonicalResponse(raw: unknown, context: ProtocolSessionContext, itemOnly = false): JsonRecord {
  const b = record(raw, 'response');
  serialized(b, limits(context.capabilities?.limits).maxOutputBytes, 'response');
  fields(b, ['id', 'object', 'created_at', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details', 'metadata', 'parallel_tool_calls', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_output_tokens', 'reasoning', 'text', 'store', 'background', 'truncation', 'previous_response_id', 'instructions', 'service_tier'], '', 'unsupported_response');
  if (!itemOnly) { string(b.id, 'response.id', true); integer(b.created_at, 'response.created_at'); if (b.object !== undefined && b.object !== 'response') fail('unsupported_response', 'Unexpected response object kind', 'object'); }
  if (!['completed', 'incomplete', 'failed'].includes(String(b.status)))
    fail('missing_terminal', 'Response has no explicit supported terminal', 'status');
  if (b.status === 'incomplete') {
    const d = record(b.incomplete_details, 'incomplete_details');
    fields(d, ['reason'], 'incomplete_details', 'unsupported_response');
    if (!['max_output_tokens', 'content_filter'].includes(String(d.reason)))
      fail('unknown_terminal', 'Unknown incomplete reason', 'incomplete_details.reason');
  }
  validateUsage(b.usage, 'responses');
  const ids = new Set<string>();
  const output = list(b.output, 'output');
  if (output.length > limits(context.capabilities?.limits).maxItems)
    fail('resource_limit', 'Too many output items', 'output');
  for (const [i, rawItem] of output.entries()) {
    const t = record(rawItem, 'output item'), path = `output[${i}]`;
    if (t.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(t.status))) fail('unsupported_response', 'Unknown item status', `${path}.status`);
    if (b.status === 'completed' && t.status !== undefined && t.status !== 'completed') fail('invalid_stream', 'Completed response contains an unfinished item', `${path}.status`);
    fields(t, t.type === 'message' ? ['type', 'id', 'role', 'status', 'content'] : t.type === 'reasoning' ? ['type', 'id', 'summary', 'status', 'encrypted_content', 'content'] : t.type === 'function_call' ? ['type', 'id', 'status', 'name', 'namespace', 'call_id', 'arguments'] : ['type', 'id', 'status', 'name', 'namespace', 'call_id', 'input'], path, 'unsupported_content');
    if (t.type === 'message') {
      if (t.role !== 'assistant')
        fail('unsupported_content', 'Output message must be assistant', `${path}.role`);
      for (const [j, rawPart] of list(t.content, 'content').entries()) {
        const p = record(rawPart, 'part');
        fields(p, p.type === 'refusal' ? ['type', 'refusal'] : ['type', 'text', 'annotations'], `${path}.content[${j}]`, 'unsupported_content');
        if (p.type === 'output_text')
          string(p.text, 'text');
        else if (p.type === 'refusal')
          string(p.refusal, 'refusal');
        else
          fail('unsupported_content', 'Unknown output content type', path);
        if (p.annotations !== undefined && list(p.annotations, 'annotations').length)
          fail('unsupported_content', 'Output annotations cannot cross protocols', path);
      }
    }
    else if (t.type === 'reasoning') {
      if (t.encrypted_content != null || t.content != null)
        fail('unsupported_reasoning', 'Opaque or raw reasoning output cannot cross protocols', path);
      for (const rawPart of list(t.summary, 'summary')) {
        const p = record(rawPart, 'summary');
        fields(p, ['type', 'text'], path, 'unsupported_reasoning');
        if (p.type !== 'summary_text')
          fail('unsupported_reasoning', 'Unknown reasoning summary type', path);
        string(p.text, 'summary');
      }
    }
    else if (t.type === 'function_call' || t.type === 'custom_tool_call') {
      const id = string(t.call_id, 'call_id', true);
      if (ids.has(id))
        fail('invalid_tool_arguments', 'Duplicate output tool call id', path);
      ids.add(id);
      string(t.name, 'name', true);
      if (t.namespace !== undefined)
        string(t.namespace, 'namespace', true);
      if (t.type === 'function_call') {
        string(t.arguments, 'arguments');
        if (b.status === 'completed')
          argumentObject(t.arguments as string);
      }
      else
        string(t.input, 'custom input');
    }
    else
      fail('unsupported_content', 'Unknown output item kind', path);
  }
  return b;
}
export function canonicalUsage(raw: unknown): JsonRecord { return raw == null ? {} : record(raw, 'usage'); }
export function wireUsage(raw: unknown, protocol: LLMProtocol): JsonRecord {
  const u = canonicalUsage(raw);
  if (!Object.keys(u).length)
    return {};
  const input = integer(u.input_tokens ?? 0, 'input_tokens'), output = integer(u.output_tokens ?? 0, 'output_tokens'), cached = integer(record(u.input_tokens_details ?? {}, 'input details').cached_tokens ?? 0, 'cached_tokens'), write = integer(record(u.input_tokens_details ?? {}, 'input details').cache_creation_tokens ?? 0, 'cache_creation_tokens'), reasoning = integer(record(u.output_tokens_details ?? {}, 'output details').reasoning_tokens ?? 0, 'reasoning_tokens');
  if (cached + write > input || reasoning > output)
    fail('invalid_usage', 'Usage details exceed total tokens', 'usage');
  if (protocol === 'chat_completions') {
    if (write)
      fail('unsupported_response', 'Chat cannot report cache creation tokens', 'usage.input_tokens_details');
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning } };
  }
  if (protocol === 'anthropic_messages') {
    if (reasoning)
      fail('unsupported_response', 'Anthropic has no separate reasoning usage counter', 'usage.output_tokens_details');
    return { input_tokens: input - cached - write, output_tokens: output, cache_read_input_tokens: cached, ...(write ? { cache_creation_input_tokens: write } : {}) };
  }
  if (protocol === 'gemini_generate_content') {
    if (write)
      fail('unsupported_response', 'Gemini cannot report cache creation tokens', 'usage.input_tokens_details');
    return { promptTokenCount: input, candidatesTokenCount: output - reasoning, totalTokenCount: input + output, cachedContentTokenCount: cached, thoughtsTokenCount: reasoning };
  }
  return u;
}
function stopReason(b: JsonRecord, protocol: LLMProtocol, tools: boolean): string {
  if (b.status === 'completed')
    return protocol === 'chat_completions' ? (tools ? 'tool_calls' : 'stop') : protocol === 'anthropic_messages' ? (tools ? 'tool_use' : 'end_turn') : 'STOP';
  if (b.status === 'failed')
    return 'error';
  const length = record(b.incomplete_details, 'incomplete_details').reason === 'max_output_tokens';
  return protocol === 'chat_completions' ? (length ? 'length' : 'content_filter') : protocol === 'anthropic_messages' ? (length ? 'max_tokens' : 'refusal') : (length ? 'MAX_TOKENS' : 'SAFETY');
}
export function responseFromCanonical(raw: unknown, protocol: LLMProtocol, context: ProtocolSessionContext): JsonRecord {
  const b = validateCanonicalResponse(raw, context), model = context.responseModel ?? context.model;
  if (protocol === 'responses')
    return { ...b, model, ...(b.status === 'failed' ? { error: safeProtocolError() } : {}) };
  if (b.status === 'failed')
    return protocol === 'anthropic_messages' ? { type: 'error', error: safeProtocolError() } : { error: safeProtocolError() };
  const blocks: JsonRecord[] = [], calls: JsonRecord[] = [], texts: string[] = [], thoughts: string[] = [], refusals: string[] = [];
  let toolSeen = false;
  for (const t of b.output as JsonRecord[]) {
    if (t.type === 'function_call' || t.type === 'custom_tool_call') {
      toolSeen = true;
      if (t.namespace !== undefined)
        fail('unsupported_tool', 'Namespace output cannot be represented by this source protocol', 'output.namespace');
      if (t.type === 'custom_tool_call') {
        if (protocol !== 'chat_completions')
          fail('unsupported_tool', 'Custom output cannot be represented by this source protocol', 'output');
        calls.push({ id: t.call_id, type: 'custom', custom: { name: t.name, input: t.input } });
        continue;
      }
      if (protocol === 'chat_completions')
        calls.push({ id: t.call_id, type: 'function', function: { name: t.name, arguments: t.arguments } });
      else {
        if (b.status !== 'completed')
          fail('unsupported_response', 'Partial tool arguments cannot be represented as an executable source tool call', 'output.arguments');
        const args = argumentObject(t.arguments as string);
        blocks.push(protocol === 'anthropic_messages' ? { type: 'tool_use', id: t.call_id, name: t.name, input: args } : { functionCall: { id: t.call_id, name: t.name, args } });
      }
    }
    else if (t.type === 'reasoning') {
      const text = (t.summary as JsonRecord[]).map(p => p.text as string).join('');
      if (protocol === 'chat_completions') {
        if (toolSeen)
          fail('unsupported_response', 'Chat JSON cannot retain reasoning after tool calls', 'output');
        thoughts.push(text);
      }
      else
        blocks.push(protocol === 'anthropic_messages' ? { type: 'thinking', thinking: text } : { text, thought: true });
    }
    else
      for (const p of t.content as JsonRecord[]) {
        if (p.type === 'refusal') {
          if (protocol !== 'chat_completions')
            fail('unsupported_content', 'Refusal content authority cannot be represented', 'output.content');
          refusals.push(p.refusal as string);
        }
        else if (protocol === 'chat_completions') {
          if (toolSeen)
            fail('unsupported_response', 'Chat JSON cannot retain text after tool calls', 'output');
          texts.push(p.text as string);
        }
        else
          blocks.push(protocol === 'anthropic_messages' ? { type: 'text', text: p.text } : { text: p.text });
      }
  }
  const usage = wireUsage(b.usage, protocol), reason = stopReason(b, protocol, toolSeen);
  if (protocol === 'chat_completions')
    return { id: b.id, object: 'chat.completion', created: b.created_at, model, choices: [{ index: 0, message: { role: 'assistant', content: texts.join('') || null, ...(thoughts.length ? { reasoning_content: thoughts.join('') } : {}), ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: reason }], ...(Object.keys(usage).length ? { usage } : {}) };
  if (protocol === 'anthropic_messages')
    return { id: b.id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: reason, stop_sequence: null, usage };
  return { responseId: b.id, modelVersion: model, candidates: [{ index: 0, content: { role: 'model', parts: blocks }, finishReason: reason }], ...(Object.keys(usage).length ? { usageMetadata: usage } : {}) };
}
/** Gemini chunks carry complete function-call objects, never JSON argument deltas. */
export class GeminiCanonicalDecoder {
  private encoder: ResponsesEventEncoder;
  private serial = 0;
  private ended = false;
  private tools = false;
  private ids = new Set<string>();
  constructor(private context: ProtocolSessionContext, names: ResponsesToolNames) { this.encoder = new ResponsesEventEncoder('chat_completions', context.responseModel ?? context.model, names, context.capabilities?.limits, { preserveContentOrder: true }); }
  push(raw: unknown): JsonRecord[] {
    const b = record(raw, 'Gemini response');
    fields(b, ['candidates', 'usageMetadata', 'modelVersion', 'responseId', 'promptFeedback', 'error'], '', 'unsupported_response');
    if (b.error !== undefined)
      return this.encoder.push({ error: safeProtocolError() });
    const events: JsonRecord[] = [];
    if (b.promptFeedback !== undefined) {
      const p = record(b.promptFeedback, 'promptFeedback');
      fields(p, ['blockReason', 'blockReasonMessage', 'safetyRatings'], 'promptFeedback', 'unsupported_response');
      if (p.blockReason !== undefined && p.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
        this.ended = true;
        events.push(...this.encoder.push({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }));
      }
    }
    const candidates = b.candidates === undefined ? [] : list(b.candidates, 'candidates');
    if (candidates.length > 1)
      fail('unsupported_response', 'Multiple Gemini candidates cannot cross protocols', 'candidates');
    if (candidates.length) {
      const c = record(candidates[0], 'candidate');
      fields(c, ['index', 'content', 'finishReason', 'safetyRatings', 'finishMessage'], 'candidates', 'unsupported_response');
      if (c.index !== undefined && c.index !== 0)
        fail('unsupported_response', 'Only candidate index zero is supported', 'candidates.index');
      if (c.content !== undefined) {
        const content = record(c.content, 'content');
        fields(content, ['role', 'parts'], 'candidates.content', 'unsupported_content');
        if (content.role !== undefined && content.role !== 'model')
          fail('unsupported_response', 'Response role must be model', 'candidates.content.role');
        const parts = list(content.parts, 'parts');
        if (this.ended && parts.length)
          fail('invalid_stream', 'Content arrived after Gemini terminal');
        for (const [i, rawPart] of parts.entries()) {
          const p = record(rawPart, 'part');
          fields(p, ['text', 'thought', 'functionCall', 'thoughtSignature'], 'candidates.content.parts', 'unsupported_content');
          if (p.thoughtSignature !== undefined)
            fail('unsupported_reasoning', 'Thought signatures cannot cross protocols', 'candidates.content.parts.thoughtSignature');
          if (p.functionCall !== undefined) {
            if (p.text !== undefined || p.thought !== undefined)
              fail('unsupported_content', 'Mixed Gemini part kinds', 'candidates.content.parts');
            const f = record(p.functionCall, 'functionCall');
            fields(f, ['id', 'name', 'args'], 'functionCall', 'unsupported_tool');
            const index = this.serial++, id = f.id === undefined ? `call_gemini_${index}` : string(f.id, 'functionCall.id', true);
            if (this.ids.has(id))
              fail('invalid_tool_arguments', 'Duplicate Gemini call id', 'functionCall.id');
            this.ids.add(id);
            this.tools = true;
            events.push(...this.encoder.push({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name: string(f.name, 'functionCall.name', true), arguments: JSON.stringify(record(f.args ?? {}, 'functionCall.args')) } }] } }] }));
          }
          else {
            if (p.thought !== undefined && typeof p.thought !== 'boolean')
              fail('invalid_payload', 'Thought flag must be boolean', 'thought');
            events.push(...this.encoder.push({ choices: [{ delta: { [p.thought === true ? 'reasoning_content' : 'content']: string(p.text, `parts[${i}].text`) } }] }));
          }
        }
      }
      if (c.finishReason !== undefined) {
        if (this.ended)
          fail('invalid_stream', 'Duplicate Gemini terminal');
        const reason = c.finishReason;
        const mapped = reason === 'STOP' ? (this.tools ? 'tool_calls' : 'stop') : reason === 'MAX_TOKENS' ? 'length' : ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(String(reason)) ? 'content_filter' : undefined;
        if (!mapped)
          fail('unknown_terminal', 'Unknown Gemini finish reason', 'candidates.finishReason');
        this.ended = true;
        events.push(...this.encoder.push({ choices: [{ delta: {}, finish_reason: mapped }] }));
      }
    }
    if (b.usageMetadata !== undefined) {
      const u = record(b.usageMetadata, 'usageMetadata');
      fields(u, ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount'], 'usageMetadata', 'unsupported_response');
      for (const [k, v] of Object.entries(u))
        integer(v, `usageMetadata.${k}`);
      const input = (u.promptTokenCount ?? 0) as number, thoughts = (u.thoughtsTokenCount ?? 0) as number, output = ((u.candidatesTokenCount ?? 0) as number) + thoughts;
      if (u.totalTokenCount !== undefined && u.totalTokenCount !== input + output)
        fail('invalid_usage', 'Gemini total does not match reported components', 'usageMetadata.totalTokenCount');
      events.push(...this.encoder.push({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount ?? 0 }, completion_tokens_details: { reasoning_tokens: thoughts } } }));
    }
    return events;
  }
  finish(): JsonRecord[] { return this.encoder.finish(); }
}
export function canonicalResponse(raw: unknown, context: ProtocolSessionContext, names: ResponsesToolNames): JsonRecord {
  if (context.targetProtocol === 'responses')
    return validateCanonicalResponse(raw, context);
  if (context.targetProtocol === 'gemini_generate_content') {
    const decoder = new GeminiCanonicalDecoder(context, names);
    const events = [...decoder.push(raw), ...decoder.finish()];
    return record(events.at(-1)?.response, 'response');
  }
  validateProviderResponse(raw, context.targetProtocol);
  const result = encodeResponsesResult(raw, context.targetProtocol, context.responseModel ?? context.model, names, context.capabilities?.limits);
  if (result.status === 'failed')
    result.error = safeProtocolError();
  // Preserve cache-write accounting instead of folding it irreversibly into input_tokens.
  const usage = record(raw, 'response').usage;
  if (context.targetProtocol === 'anthropic_messages' && usage != null) {
    const write = record(usage, 'usage').cache_creation_input_tokens;
    if (write !== undefined)
      record(record(result.usage, 'usage').input_tokens_details, 'input details').cache_creation_tokens = write;
  }
  return result;
}
