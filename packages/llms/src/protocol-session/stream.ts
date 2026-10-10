import { argumentObject, fail, record, string, serialized, limits, type JsonRecord } from '../responses-codec/common';
import { fields, integer } from './validation';
import { safeProtocolError, validateCanonicalResponse, wireUsage } from './response';
import type { LLMProtocol, ProtocolSessionContext } from './types';
interface ItemState {
  item: JsonRecord;
  done: boolean;
  parts: Map<number, {
    kind: string;
    text: string;
    done: boolean;
    textDone: boolean;
  }>;
  args: string;
  argsDone: boolean;
}
function definition(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(definition).join(',')}]`; if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${definition((value as JsonRecord)[k])}`).join(',')}}`; return JSON.stringify(value);
}
/** Validate Responses event ordering and final snapshots before rendering another wire protocol. */
export class CanonicalStreamValidator {
  private items = new Map<number, ItemState>();
  private started = false;
  private ended = false;
  private sequence = -1;
  private retained = 0;
  private partCount = 0;
  private responseId?: string;
  constructor(private context: ProtocolSessionContext) { }
  push(raw: unknown): JsonRecord[] {
    if (this.ended)
      fail('invalid_stream', 'Event arrived after terminal');
    const e = record(raw, 'event');
    serialized(e, limits(this.context.capabilities?.limits).maxOutputBytes, 'event');
    const type = string(e.type, 'event type', true);
    const common = ['type', 'sequence_number'];
    if (e.sequence_number !== undefined) {
      const n = integer(e.sequence_number, 'sequence_number');
      if (n <= this.sequence)
        fail('invalid_stream', 'Event sequence is not increasing', 'sequence_number');
      this.sequence = n;
    }
    if (['response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      fields(e, [...common, 'response'], '', 'unsupported_response');
      const r = record(e.response, 'response');
      const id = string(r.id, 'response.id', true);
      if (this.responseId !== undefined && this.responseId !== id)
        fail('invalid_stream', 'Response id changed', 'response.id');
      this.responseId = id;
      if (type === 'response.created') {
        if (this.started)
          fail('invalid_stream', 'Duplicate response.created');
        this.started = true;
        if (r.output !== undefined && (!Array.isArray(r.output) || r.output.length)) fail('invalid_stream', 'Initial response output must be empty', 'response.output');
        return [e];
      }
      if (!this.started)
        fail('invalid_stream', 'Event arrived before response.created');
      if (type === 'response.in_progress')
        return [e];
      validateCanonicalResponse(r, this.context);
      if (type !== `response.${r.status}`)
        fail('invalid_stream', 'Terminal event and status disagree', 'response.status');
      if ([...this.items.values()].some(s => !s.done))
        fail('invalid_stream', 'Terminal arrived before output_item.done');
      const output = r.output as JsonRecord[];
      if (output.length !== this.items.size)
        fail('invalid_stream', 'Terminal output does not match streamed items', 'response.output');
      for (const [index, state] of this.items) {
        if (definition(output[index]) !== definition(state.item))
          fail('invalid_stream', 'Terminal output changed completed item', 'response.output');
      }
      this.ended = true;
      return [e];
    }
    if (!this.started)
      fail('invalid_stream', 'Event arrived before response.created');
    const itemEvent = type === 'response.output_item.added' || type === 'response.output_item.done';
    const delta = type.endsWith('.delta'), done = type.endsWith('.done'), part = type.includes('_part.');
    const known = ['response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done'];
    if (!known.includes(type))
      fail('unsupported_response', 'Unknown Responses stream event', 'type');
    fields(e, [...common, 'response_id', 'output_index', ...(itemEvent ? ['item'] : ['item_id', ...(type.includes('reasoning_summary') ? ['summary_index'] : type.includes('function_call') || type.includes('custom_tool') ? [] : ['content_index']), part ? 'part' : delta ? 'delta' : type.includes('function_call') ? 'arguments' : type.includes('custom_tool') ? 'input' : type.includes('refusal') ? 'refusal' : 'text'])], '', 'unsupported_response');
    if (e.response_id !== undefined && e.response_id !== this.responseId)
      fail('invalid_stream', 'Event response id changed', 'response_id');
    const index = integer(e.output_index, 'output_index');
    if (type === 'response.output_item.added') {
      if (this.items.has(index) || index !== this.items.size)
        fail('invalid_stream', 'Output item indices must be unique and ordered', 'output_index');
      if (this.items.size >= limits(this.context.capabilities?.limits).maxItems)
        fail('resource_limit', 'Too many stream items');
      const item = record(e.item, 'item');
      string(item.id, 'item.id', true);
      if (!['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(String(item.type)))
        fail('unsupported_content', 'Unsupported stream item kind', 'item.type');
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        string(item.call_id, 'call_id', true);
        string(item.name, 'name', true);
      }
      validateCanonicalResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item], usage: null }, this.context, true);
      if ([...this.items.values()].some(s => s.item.id === item.id)) fail('invalid_stream', 'Duplicate output item id', 'item.id');
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && [...this.items.values()].some(s => s.item.call_id === item.call_id))
        fail('invalid_tool_arguments', 'Duplicate tool call id', 'item.call_id');
      this.retain(serialized(item, limits(this.context.capabilities?.limits).maxOutputBytes, 'item'));
      if (item.type === 'function_call' || item.type === 'custom_tool_call') { if (item[item.type === 'function_call' ? 'arguments' : 'input'] !== '') fail('invalid_stream', 'Initial tool arguments must be empty', 'item'); }
      this.items.set(index, { item: structuredClone(item), done: false, parts: new Map(), args: '', argsDone: false });
      return [e];
    }
    const state = this.items.get(index);
    if (!state || state.done)
      fail('invalid_stream', 'Event has no open output item', 'output_index');
    if (e.item_id !== undefined && e.item_id !== state.item.id)
      fail('invalid_stream', 'Event item id changed', 'item_id');
    if (type === 'response.output_item.done') {
      const item = record(e.item, 'item');
      validateCanonicalResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item], usage: null }, this.context, true);
      if (item.id !== state.item.id || item.type !== state.item.type)
        fail('invalid_stream', 'Completed item identity changed', 'item');
      if (state.item.type === 'function_call' || state.item.type === 'custom_tool_call') {
        if (!state.argsDone) fail('invalid_stream', 'Tool item done before arguments done', 'item');
        const key = state.item.type === 'function_call' ? 'arguments' : 'input';
        if (item[key] !== state.args || item.call_id !== state.item.call_id || item.name !== state.item.name || item.namespace !== state.item.namespace)
          fail('invalid_stream', 'Completed tool differs from deltas', 'item');
      }
      else {
        if ([...state.parts.values()].some(p => !p.done))
          fail('invalid_stream', 'Item done before content part done', 'item');
        const parts = state.item.type === 'reasoning' ? item.summary : item.content;
        if (!Array.isArray(parts) || parts.length !== state.parts.size)
          fail('invalid_stream', 'Completed content differs from streamed parts', 'item');
        for (const [j, p] of state.parts) {
          const v = record(parts[j], 'part');
          if (v[p.kind === 'refusal' ? 'refusal' : 'text'] !== p.text)
            fail('invalid_stream', 'Completed content changed deltas', 'item');
        }
      }
      state.item = structuredClone(item);
      state.done = true;
      return [e];
    }
    if (type.includes('function_call') || type.includes('custom_tool')) {
      if (state.argsDone) fail('invalid_stream', 'Tool event arrived after arguments done');
      const expected = type.includes('custom_tool') ? 'custom_tool_call' : 'function_call';
      if (state.item.type !== expected)
        fail('invalid_stream', 'Tool delta type differs from item');
      if (delta) {
        const value = string(e.delta, 'delta');
        state.args += value;
        this.retain(value);
        if (new TextEncoder().encode(state.args).byteLength > limits(this.context.capabilities?.limits).maxArgumentBytes)
          fail('resource_limit', 'Tool arguments exceed limit');
      }
      else {
        if (e[type.includes('custom_tool') ? 'input' : 'arguments'] !== state.args)
          fail('invalid_stream', 'Tool done changed arguments');
        state.argsDone = true;
      }
      return [e];
    }
    const summary = type.includes('reasoning_summary'), partIndex = integer(e[summary ? 'summary_index' : 'content_index'], summary ? 'summary_index' : 'content_index');
    if ((state.item.type === 'reasoning') !== summary)
      fail('invalid_stream', 'Content delta type differs from item');
    if (type.endsWith('_part.added')) {
      if (++this.partCount > limits(this.context.capabilities?.limits).maxItems) fail('resource_limit', 'Too many content parts');
      if (state.parts.has(partIndex) || partIndex !== state.parts.size)
        fail('invalid_stream', 'Content parts must be unique and ordered');
      const p = record(e.part, 'part');
      if (!['output_text', 'refusal', 'summary_text'].includes(String(p.type)))
        fail('unsupported_content', 'Unknown content part type', 'part.type');
      if (summary ? (p.type !== 'summary_text') : (p.type === 'summary_text')) fail('invalid_stream', 'Part kind differs from its output item', 'part.type');
      fields(p, p.type === 'refusal' ? ['type', 'refusal'] : ['type', 'text', 'annotations'], 'part', 'unsupported_content');
      if (p.annotations !== undefined && Array.isArray(p.annotations) && p.annotations.length)
        fail('unsupported_content', 'Annotations cannot cross protocols', 'part.annotations');
      const initial = string(p[p.type === 'refusal' ? 'refusal' : 'text'], 'part text');
      if (initial)
        fail('invalid_stream', 'Initial content part must be empty');
      state.parts.set(partIndex, { kind: p.type as string, text: '', done: false, textDone: false });
      return [e];
    }
    const p = state.parts.get(partIndex);
    if (!p || p.done)
      fail('invalid_stream', 'Event has no open content part');
    const expected = summary ? 'summary_text' : type.includes('refusal') ? 'refusal' : 'output_text';
    if (!part && p.kind !== expected)
      fail('invalid_stream', 'Text event type differs from its content part');
    if (delta) {
      if (p.textDone) fail('invalid_stream', 'Text delta arrived after text done');
      const text = string(e.delta, 'delta');
      p.text += text;
      this.retain(text);
    }
    else if (part) {
      if (!p.textDone) fail('invalid_stream', 'Part done before text done');
      const v = record(e.part, 'part');
      fields(v, p.kind === 'refusal' ? ['type', 'refusal'] : ['type', 'text', 'annotations'], 'part', 'unsupported_content');
      if (v.annotations !== undefined && (!Array.isArray(v.annotations) || v.annotations.length)) fail('unsupported_content', 'Annotations cannot cross protocols', 'part.annotations');
      if (v.type !== p.kind || v[p.kind === 'refusal' ? 'refusal' : 'text'] !== p.text)
        fail('invalid_stream', 'Part done changed deltas');
      p.done = true;
    }
    else if (done) {
      if (p.textDone) fail('invalid_stream', 'Duplicate text done');
      if (e[p.kind === 'refusal' ? 'refusal' : 'text'] !== p.text)
        fail('invalid_stream', 'Text done changed deltas');
      p.textDone = true;
    }
    return [e];
  }
  private retain(value: string): void {
    this.retained += new TextEncoder().encode(value).byteLength; if (this.retained > limits(this.context.capabilities?.limits).maxOutputBytes)
      fail('resource_limit', 'Accumulated output exceeds limit');
  }
  finish(): JsonRecord[] {
    if (!this.ended)
      fail('missing_terminal', 'Stream ended without explicit Responses terminal'); return [];
  }
}
export class CanonicalStreamRenderer {
  private id = '';
  private created = 0;
  private toolCount = 0;
  private started = false;
  private items = new Map<number, JsonRecord>();
  private blocks = new Map<string, number>();
  private nextBlock = 0;
  private toolIndexes = new Map<number, number>();
  constructor(private protocol: LLMProtocol, private context: ProtocolSessionContext) { }
  push(events: JsonRecord[]): JsonRecord[] {
    const result: JsonRecord[] = []; for (const event of events)
      result.push(...this.render(event)); return result;
  }
  private chat(delta: JsonRecord, finish_reason: unknown = null, usage?: JsonRecord): JsonRecord { return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.context.responseModel ?? this.context.model, choices: [{ index: 0, delta, finish_reason }], ...(usage && Object.keys(usage).length ? { usage } : {}) }; }
  private gemini(parts: JsonRecord[], finishReason?: string, usageMetadata?: JsonRecord): JsonRecord { return { responseId: this.id, modelVersion: this.context.responseModel ?? this.context.model, candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata && Object.keys(usageMetadata).length ? { usageMetadata } : {}) }; }
  private blockKey(e: JsonRecord): string { return `${e.output_index}:${e.content_index ?? e.summary_index ?? 'tool'}`; }
  private render(e: JsonRecord): JsonRecord[] {
    if (this.protocol === 'responses')
      return [e];
    const type = e.type as string;
    if (type === 'response.created') {
      const r = record(e.response, 'response');
      this.id = string(r.id, 'id');
      this.created = integer(r.created_at ?? 0, 'created_at');
      this.started = true;
      if (this.protocol === 'chat_completions')
        return [this.chat({ role: 'assistant' })];
      if (this.protocol === 'anthropic_messages')
        return [{ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.context.responseModel ?? this.context.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }];
      return [];
    }
    if (!this.started)
      fail('invalid_stream', 'Canonical output arrived before response.created');
    if (type === 'response.output_item.added') {
      const item = record(e.item, 'item'), index = e.output_index as number;
      this.items.set(index, item);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        if (item.namespace !== undefined)
          fail('unsupported_tool', 'Namespace output cannot be represented by source protocol', 'output.namespace');
        this.toolIndexes.set(index, this.toolCount++);
        if (this.protocol === 'chat_completions')
          return [this.chat({ tool_calls: [{ index: this.toolIndexes.get(index), id: item.call_id, type: item.type === 'custom_tool_call' ? 'custom' : 'function', ...(item.type === 'custom_tool_call' ? { custom: { name: item.name, input: '' } } : { function: { name: item.name, arguments: '' } }) }] })];
        if (item.type === 'custom_tool_call')
          fail('unsupported_tool', 'Custom output cannot be represented by source protocol', 'output');
        if (this.protocol === 'anthropic_messages') {
          const block = this.nextBlock++;
          this.blocks.set(this.blockKey(e), block);
          return [{ type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: item.call_id, name: item.name, input: {} } }];
        }
      }
      return [];
    }
    if (type === 'response.content_part.added' || type === 'response.reasoning_summary_part.added') {
      const p = record(e.part, 'part');
      if (p.type === 'refusal' && this.protocol !== 'chat_completions')
        fail('unsupported_content', 'Refusal content cannot be represented by source protocol', 'output.content');
      if (this.protocol === 'anthropic_messages') {
        const index = this.nextBlock++;
        this.blocks.set(this.blockKey(e), index);
        return [{ type: 'content_block_start', index, content_block: p.type === 'summary_text' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } }];
      }
      return [];
    }
    if (type.endsWith('.delta')) {
      const delta = string(e.delta, 'delta'), tool = type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta', reasoning = type === 'response.reasoning_summary_text.delta';
      if (this.protocol === 'chat_completions') {
        if (tool)
          return [this.chat({ tool_calls: [{ index: this.toolIndexes.get(e.output_index as number), ...(type.includes('custom') ? { custom: { input: delta } } : { function: { arguments: delta } }) }] })];
        return [this.chat({ [reasoning ? 'reasoning_content' : type === 'response.refusal.delta' ? 'refusal' : 'content']: delta })];
      }
      if (this.protocol === 'anthropic_messages') {
        const index = this.blocks.get(this.blockKey(e));
        if (index === undefined)
          fail('invalid_stream', 'Canonical delta has no open source block');
        return [{ type: 'content_block_delta', index, delta: tool ? { type: 'input_json_delta', partial_json: delta } : reasoning ? { type: 'thinking_delta', thinking: delta } : { type: 'text_delta', text: delta } }];
      }
      if (tool)
        return [];
      return [this.gemini([{ text: delta, ...(reasoning ? { thought: true } : {}) }])];
    }
    if (type === 'response.content_part.done' || type === 'response.reasoning_summary_part.done' || type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
      if (this.protocol === 'anthropic_messages') {
        const index = this.blocks.get(this.blockKey(e));
        if (index === undefined)
          fail('invalid_stream', 'Canonical done has no source block');
        return [{ type: 'content_block_stop', index }];
      }
      if (this.protocol === 'gemini_generate_content' && type === 'response.function_call_arguments.done') {
        const item = this.items.get(e.output_index as number)!;
        return [this.gemini([{ functionCall: { id: item.call_id, name: item.name, args: argumentObject(string(e.arguments, 'arguments')) } }])];
      }
      return [];
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const r = record(e.response, 'response');
      if (type === 'response.failed')
        return this.protocol === 'anthropic_messages' ? [{ type: 'error', error: safeProtocolError() }] : [{ error: safeProtocolError() }];
      // JSON rendering additionally validates all terminal content and usage semantics.
      // Chat can stream interleaving that its single JSON message cannot represent.
      const usage = wireUsage(r.usage, this.protocol);
      const incomplete = r.status === 'incomplete', length = incomplete && record(r.incomplete_details, 'details').reason === 'max_output_tokens';
      if (this.protocol === 'chat_completions')
        return [this.chat({}, incomplete ? (length ? 'length' : 'content_filter') : this.toolCount ? 'tool_calls' : 'stop', usage)];
      if (this.protocol === 'anthropic_messages')
        return [{ type: 'message_delta', delta: { stop_reason: incomplete ? (length ? 'max_tokens' : 'refusal') : this.toolCount ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }, { type: 'message_stop' }];
      return [this.gemini([], incomplete ? (length ? 'MAX_TOKENS' : 'SAFETY') : 'STOP', usage)];
    }
    return [];
  }
}
