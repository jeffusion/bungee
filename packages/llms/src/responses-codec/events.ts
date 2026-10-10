import { argumentObject, bounded, bytes, customInput, customInputPrefix, fail, limits, list, normalizeUsage, record, responsePayload, restoreTool, serialized, string, terminal, toolItem,
  type JsonRecord, type ResponsesCodecLimits, type ResponsesProtocol, type ResponsesToolName, type ResponsesToolNames, type Terminal } from './common';

interface OutputState {
  key: string; index: number; kind: 'text' | 'reasoning' | 'tool' | 'refusal'; id: string;
  text: string; name: string; callId: string; args: string; emittedInput: string;
  original?: ResponsesToolName; added: boolean; closed: boolean;
}

/** Incremental payload codec. SSE framing and transport cancellation remain caller-owned.
 * Chat terminal is deferred until finish() so trailing usage-only chunks are retained.
 * Anthropic additionally requires message_stop, not merely a stop_reason in message_delta.
 */
export class ResponsesEventEncoder {
  private readonly budget: ResponsesCodecLimits;
  private readonly id = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly output: OutputState[] = [];
  private readonly states = new Map<string, OutputState>();
  private readonly anthropicBlocks = new Map<number, OutputState>();
  private usage: JsonRecord = {};
  private end?: Terminal;
  private error?: unknown;
  private started = false;
  private anthropicStarted = false;
  private anthropicStopped = false;
  private finalized = false;
  private poisoned = false;
  private sequence = 0;
  private retained = 0;
  private lastKind?: OutputState['kind'];
  private contentSerial = 0;

  constructor(readonly protocol: ResponsesProtocol, readonly model: string,
    readonly toolNames: ResponsesToolNames = new Map(), configuredLimits?: Partial<ResponsesCodecLimits>,
    private readonly options: { preserveContentOrder?: boolean } = {}) {
    this.budget = limits(configuredLimits);
  }
  private contentState(kind: 'text' | 'reasoning' | 'refusal'): OutputState {
    if (!this.options.preserveContentOrder) return this.state(kind, kind);
    if (this.lastKind !== kind) this.contentSerial++;
    this.lastKind = kind;
    return this.state(`${kind}:${this.contentSerial}`, kind);
  }

  private event(type: string, fields: JsonRecord = {}): JsonRecord {
    return { type, sequence_number: this.sequence++, ...fields };
  }
  private start(events: JsonRecord[]): void {
    if (this.started) return;
    this.started = true;
    const payload = { id: this.id, object: 'response', created_at: this.createdAt, model: this.model, status: 'in_progress', output: [], usage: null };
    events.push(this.event('response.created', { response: payload }), this.event('response.in_progress', { response: { ...payload } }));
  }
  private retain(text: string): void {
    this.retained += bytes(text);
    if (this.retained > this.budget.maxOutputBytes) fail('resource_limit', 'Accumulated response output exceeds maxOutputBytes');
  }
  private state(key: string, kind: OutputState['kind']): OutputState {
    const existing = this.states.get(key);
    if (existing) { if (existing.kind !== kind) fail('invalid_stream', 'Output item changed kind'); return existing; }
    if (this.output.length >= this.budget.maxItems) fail('resource_limit', 'Too many output items');
    const state: OutputState = { key, index: this.output.length, kind, id: `${this.id}_item_${this.output.length}`, text: '', name: '', callId: '', args: '', emittedInput: '', added: false, closed: false };
    this.states.set(key, state); this.output.push(state); return state;
  }
  private fields(state: OutputState): JsonRecord {
    return { response_id: this.id, item_id: state.id, output_index: state.index };
  }
  private item(state: OutputState, status: string, strict = false): JsonRecord {
    if (state.kind === 'tool') {
      if (strict) return { ...toolItem(state.callId, state.name, state.args || '{}', this.toolNames, status), id: state.id };
      const original = state.original ?? restoreTool(state.name, this.toolNames);
      return { id: state.id, type: original.custom ? 'custom_tool_call' : 'function_call', call_id: state.callId,
        name: original.name, ...(original.namespace ? { namespace: original.namespace } : {}), status,
        ...(original.custom ? { input: state.emittedInput } : { arguments: state.args }) };
    }
    if (state.kind === 'reasoning') return { id: state.id, type: 'reasoning', summary: status === 'in_progress' ? [] : [{ type: 'summary_text', text: state.text }] };
    return { id: state.id, type: 'message', role: 'assistant', status,
      content: status === 'in_progress' ? [] : [this.part(state)] };
  }
  private part(state: OutputState): JsonRecord {
    return state.kind === 'refusal' ? { type: 'refusal', refusal: state.text }
      : state.kind === 'reasoning' ? { type: 'summary_text', text: state.text }
      : { type: 'output_text', text: state.text, annotations: [] };
  }
  private add(state: OutputState, events: JsonRecord[], final = false): void {
    if (state.added) return;
    if (state.kind === 'tool') {
      // Names may arrive in fragments; wait until the exact authority name resolves.
      if (!state.callId || !state.name || (this.toolNames.size && !this.toolNames.has(state.name))) return;
      if (!final && !state.args && [...this.toolNames.keys()].some(name => name !== state.name && name.startsWith(state.name))) return;
      state.original = restoreTool(state.name, this.toolNames);
    }
    state.added = true;
    const initial = this.item(state, 'in_progress');
    if (state.kind === 'tool') { if (state.original?.custom) initial.input = ''; else initial.arguments = ''; }
    events.push(this.event('response.output_item.added', { response_id: this.id, output_index: state.index, item: initial }));
    if (state.kind !== 'tool') {
      const part = state.kind === 'reasoning' ? { type: 'summary_text', text: '' } : state.kind === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
      events.push(this.event(state.kind === 'reasoning' ? 'response.reasoning_summary_part.added' : 'response.content_part.added',
        { ...this.fields(state), [state.kind === 'reasoning' ? 'summary_index' : 'content_index']: 0, part }));
    }
  }
  private appendText(state: OutputState, delta: string, events: JsonRecord[]): void {
    if (state.closed) fail('invalid_stream', 'Delta arrived after content block stop');
    this.retain(delta); state.text += delta; this.add(state, events);
    const type = state.kind === 'reasoning' ? 'response.reasoning_summary_text.delta' : state.kind === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta';
    if (delta) events.push(this.event(type, { ...this.fields(state), [state.kind === 'reasoning' ? 'summary_index' : 'content_index']: 0, delta }));
  }
  private emitArgs(state: OutputState, events: JsonRecord[], fragment = '', first = false): void {
    if (!state.added) return;
    if (state.original?.custom) {
      const prefix = customInputPrefix(state.args);
      if (!prefix.startsWith(state.emittedInput)) fail('invalid_tool_arguments', 'Custom input prefix changed');
      const delta = prefix.slice(state.emittedInput.length);
      state.emittedInput = prefix;
      if (delta) events.push(this.event('response.custom_tool_call_input.delta', { ...this.fields(state), delta }));
    } else {
      const delta = first ? state.args : fragment;
      if (delta) events.push(this.event('response.function_call_arguments.delta', { ...this.fields(state), delta }));
    }
  }
  private toolDelta(state: OutputState, raw: JsonRecord, events: JsonRecord[]): void {
    if (state.closed) fail('invalid_stream', 'Tool delta arrived after content block stop');
    if (raw.id !== undefined) {
      const id = string(raw.id, 'tool call id', true);
      if (state.callId && state.callId !== id) fail('invalid_stream', 'Tool call id changed');
      if (!state.callId) this.retain(id);
      state.callId = id;
    }
    const fn = raw.function === undefined ? {} : record(raw.function, 'tool function');
    if (fn.name !== undefined) {
      const name = string(fn.name, 'tool name');
      if (state.added && name) fail('invalid_stream', 'Tool name changed after output_item.added');
      this.retain(name); state.name += name;
    }
    const args = fn.arguments === undefined ? '' : string(fn.arguments, 'tool arguments delta');
    this.retain(args); state.args = bounded(state.args + args, this.budget.maxArgumentBytes, 'tool arguments');
    const wasAdded = state.added;
    this.add(state, events); this.emitArgs(state, events, args, !wasAdded);
  }

  push(raw: unknown): JsonRecord[] {
    if (this.poisoned) fail('invalid_stream', 'Encoder cannot continue after a codec error');
    if (this.finalized) fail('invalid_stream', 'Event arrived after response terminal');
    try {
      const chunk = record(raw, 'stream event');
      serialized(chunk, this.budget.maxOutputBytes, 'stream event');
      const events: JsonRecord[] = [];
      this.start(events);
      if (chunk.error !== undefined || chunk.type === 'error') {
        this.error = record(chunk.error, 'upstream error');
        this.end = { status: 'failed', reason: 'upstream_error' };
        this.anthropicStopped = true;
        return [...events, ...this.complete()];
      }
      if (this.protocol === 'chat_completions') this.chat(chunk, events); else this.anthropic(chunk, events);
      return events;
    } catch (error) { this.poisoned = true; throw error; }
  }
  private chat(chunk: JsonRecord, events: JsonRecord[]): void {
    const choices = list(chunk.choices, 'choices');
    if (choices.length > 1) fail('unsupported_response', 'Multiple response candidates are not supported');
    if (choices.length) {
      const choice = record(choices[0], 'choice');
      if (choice.index !== undefined && choice.index !== 0) fail('unsupported_response', 'Only choice index 0 is supported');
      const delta = record(choice.delta ?? {}, 'choice delta');
      for (const key of Object.keys(delta)) if (!['role', 'content', 'refusal', 'reasoning_content', 'reasoning', 'tool_calls', 'function_call', 'annotations'].includes(key)) fail('unsupported_content', `Unsupported Chat output field ${key}`);
      if (delta.annotations !== undefined && list(delta.annotations, 'annotations').length) fail('unsupported_content', 'Chat output annotations cannot be faithfully converted');
      if (delta.role !== undefined && delta.role !== 'assistant') fail('unsupported_response', 'Response role must be assistant');
      if (this.end && Object.values(delta).some(v => v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length))) fail('invalid_stream', 'Output arrived after finish_reason');
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning !== undefined && reasoning !== null) this.appendText(this.contentState('reasoning'), string(reasoning, 'reasoning delta'), events);
      if (delta.content !== undefined && delta.content !== null) this.appendText(this.contentState('text'), string(delta.content, 'text delta'), events);
      if (delta.refusal !== undefined && delta.refusal !== null) this.appendText(this.contentState('refusal'), string(delta.refusal, 'refusal delta'), events);
      if (delta.tool_calls !== undefined) {
        if (list(delta.tool_calls, 'tool_calls').length) this.lastKind = 'tool';
        for (const rawTool of list(delta.tool_calls, 'tool_calls')) {
          const tool = record(rawTool, 'tool call');
          if (!Number.isSafeInteger(tool.index) || (tool.index as number) < 0) fail('invalid_stream', 'Streamed tool requires a non-negative integer index');
          if (tool.type !== undefined && tool.type !== 'function') fail('unsupported_tool', 'Unknown upstream tool call type');
          this.toolDelta(this.state(`tool:${tool.index}`, 'tool'), tool, events);
        }
      }
      if (delta.function_call !== undefined) fail('unsupported_response', 'Legacy function_call lacks a stable call_id');
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const next = terminal(choice.finish_reason, this.protocol);
        if (this.end && (this.end.status !== next.status || this.end.reason !== next.reason)) fail('invalid_stream', 'Conflicting finish reasons');
        this.end = next;
      }
    }
    this.usage = normalizeUsage(chunk.usage, this.protocol, this.usage);
  }
  private anthropic(chunk: JsonRecord, events: JsonRecord[]): void {
    if (chunk.type === 'ping') return;
    if (this.anthropicStopped) fail('invalid_stream', 'Event arrived after message_stop');
    if (chunk.type === 'message_start') {
      if (this.anthropicStarted) fail('invalid_stream', 'Duplicate message_start');
      const message = record(chunk.message, 'message');
      this.anthropicStarted = true;
      this.usage = normalizeUsage(message.usage, this.protocol, this.usage); return;
    }
    if (!this.anthropicStarted) fail('invalid_stream', 'Anthropic event arrived before message_start');
    if (chunk.type === 'message_delta') {
      const delta = record(chunk.delta, 'message delta');
      if (delta.stop_reason != null) {
        const next = terminal(delta.stop_reason, this.protocol);
        if (this.end && (this.end.status !== next.status || this.end.reason !== next.reason)) fail('invalid_stream', 'Conflicting stop reasons');
        this.end = next;
      }
      this.usage = normalizeUsage(chunk.usage, this.protocol, this.usage); return;
    }
    if (chunk.type === 'message_stop') {
      if (!this.end) fail('missing_terminal', 'message_stop has no preceding stop_reason');
      if ([...this.anthropicBlocks.values()].some(s => !s.closed)) fail('invalid_stream', 'message_stop arrived before content_block_stop');
      this.anthropicStopped = true; return;
    }
    if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0) fail('invalid_stream', 'Anthropic content requires a non-negative integer index');
    const index = chunk.index as number;
    if (this.end) fail('invalid_stream', 'Content arrived after stop_reason');
    if (chunk.type === 'content_block_start') {
      if (this.anthropicBlocks.has(index)) fail('invalid_stream', 'Duplicate content_block_start');
      const block = record(chunk.content_block, 'content block');
      const kind = block.type === 'tool_use' ? 'tool' : block.type === 'text' ? 'text' : block.type === 'thinking' ? 'reasoning' : undefined;
      if (!kind) fail('unsupported_content', `Unsupported Anthropic block ${String(block.type)}`);
      const state = this.state(`block:${index}`, kind); this.anthropicBlocks.set(index, state);
      if (kind === 'tool') {
        const input = record(block.input ?? {}, 'tool input');
        this.toolDelta(state, { id: block.id, function: { name: block.name, ...(Object.keys(input).length ? { arguments: serialized(input, this.budget.maxArgumentBytes, 'tool input') } : {}) } }, events);
      } else this.appendText(state, string(block[kind === 'text' ? 'text' : 'thinking'] ?? '', 'block text'), events);
      return;
    }
    const state = this.anthropicBlocks.get(index);
    if (!state || state.closed) fail('invalid_stream', 'Content event has no open block');
    if (chunk.type === 'content_block_stop') { state.closed = true; return; }
    if (chunk.type !== 'content_block_delta') fail('unsupported_response', `Unknown Anthropic event ${String(chunk.type)}`);
    const delta = record(chunk.delta, 'content delta');
    if (delta.type === 'input_json_delta' && state.kind === 'tool') this.toolDelta(state, { function: { arguments: delta.partial_json } }, events);
    else if (delta.type === 'text_delta' && state.kind === 'text') this.appendText(state, string(delta.text, 'text delta'), events);
    else if (delta.type === 'thinking_delta' && state.kind === 'reasoning') this.appendText(state, string(delta.thinking, 'thinking delta'), events);
    else if (delta.type === 'signature_delta' && state.kind === 'reasoning') {
      // Signature is provider-bound replay authority: exposing plain summaries cannot preserve it.
      bounded(string(delta.signature, 'signature'), this.budget.maxArgumentBytes, 'signature');
    } else fail('unsupported_content', `Unsupported content delta ${String(delta.type)}`);
  }

  private complete(): JsonRecord[] {
    if (!this.end) fail('missing_terminal', 'Stream ended without an explicit upstream terminal');
    const events: JsonRecord[] = [];
    const items: JsonRecord[] = [];
    const callIds = new Set<string>();
    for (const state of this.output) {
      const strict = this.end.status === 'completed';
      if (state.kind === 'tool') {
        if (!state.callId || !state.name) fail('invalid_tool_arguments', 'Tool call is missing id or name');
        if (callIds.has(state.callId)) fail('invalid_tool_arguments', 'Duplicate provider call_id');
        callIds.add(state.callId);
        state.original ??= restoreTool(state.name, this.toolNames);
        this.add(state, events, true);
        if (!state.added) fail('unknown_tool', `Unknown tool ${state.name}`);
        if (strict && !state.args) { state.args = '{}'; this.emitArgs(state, events, '{}'); }
        if (strict) {
          argumentObject(state.args || '{}');
          if (state.original.custom) {
            const text = customInput(state.args);
            if (!text.startsWith(state.emittedInput)) fail('invalid_tool_arguments', 'Custom tool input changed');
            if (text.length > state.emittedInput.length) events.push(this.event('response.custom_tool_call_input.delta', { ...this.fields(state), delta: text.slice(state.emittedInput.length) }));
            state.emittedInput = text;
          }
        }
      }
      const item = this.item(state, this.end.status === 'completed' ? 'completed' : 'incomplete', strict);
      const fields = this.fields(state);
      if (state.kind === 'tool') {
        const custom = state.original!.custom;
        events.push(this.event(custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done',
          { ...fields, [custom ? 'input' : 'arguments']: custom ? item.input : item.arguments }));
      } else {
        const reasoning = state.kind === 'reasoning';
        const textField = state.kind === 'refusal' ? 'refusal' : 'text';
        events.push(this.event(reasoning ? 'response.reasoning_summary_text.done' : state.kind === 'refusal' ? 'response.refusal.done' : 'response.output_text.done',
          { ...fields, [reasoning ? 'summary_index' : 'content_index']: 0, [textField]: state.text }));
        events.push(this.event(reasoning ? 'response.reasoning_summary_part.done' : 'response.content_part.done',
          { ...fields, [reasoning ? 'summary_index' : 'content_index']: 0, part: this.part(state) }));
      }
      events.push(this.event('response.output_item.done', { response_id: this.id, output_index: state.index, item }));
      items.push(item);
    }
    const response = responsePayload(this.id, this.model, items, this.end, this.usage, this.error, this.createdAt);
    serialized(response, this.budget.maxOutputBytes, 'final response');
    events.push(this.event(`response.${this.end.status}`, { response }));
    this.finalized = true;
    return events;
  }
  finish(): JsonRecord[] {
    if (this.poisoned) fail('invalid_stream', 'Encoder cannot finish after a codec error');
    if (this.finalized) return [];
    try {
      if (this.protocol === 'anthropic_messages' && !this.anthropicStopped) fail('missing_terminal', 'Anthropic stream ended before message_stop');
      return this.complete();
    } catch (error) { this.poisoned = true; throw error; }
  }
}
