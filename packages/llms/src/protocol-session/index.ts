import { ResponsesEventEncoder, ResponsesCodecError } from '../responses-codec';
import { fail, record, serialized, limits, type JsonRecord, type ResponsesToolNames } from '../responses-codec/common';
import { convertProtocolRequest } from './request';
import { canonicalResponse, responseFromCanonical, GeminiCanonicalDecoder, validateAnthropicBlock, validateUsage } from './response';
import { CanonicalStreamRenderer, CanonicalStreamValidator } from './stream';
import { fields } from './validation';
import { LLM_PROTOCOLS, type LLMProtocol, type ProtocolSession, type ProtocolSessionContext } from './types';
export * from './types';
export const PROTOCOL_CONVERSION_RULES_VERSION = '1.0.0';
export function describeProtocolConversion() {
  return {
    rulesVersion: PROTOCOL_CONVERSION_RULES_VERSION, protocols: [...LLM_PROTOCOLS], matrix: LLM_PROTOCOLS.flatMap(sourceProtocol => LLM_PROTOCOLS.map(targetProtocol => ({
      sourceProtocol, targetProtocol,
      mode: sourceProtocol === targetProtocol ? 'passthrough' : (sourceProtocol === 'responses' && targetProtocol === 'gemini_generate_content') || (sourceProtocol === 'gemini_generate_content' && targetProtocol === 'responses') ? 'unsupported' : 'convert'
    } as const)))
  };
}
/** One request/attempt, bounded retained state, plain own-property functions for local service facades. */
export function createProtocolSession(context: ProtocolSessionContext): ProtocolSession {
  context = {
    ...context, capabilities: context.capabilities ? { ...context.capabilities, limits: context.capabilities.limits ? { ...context.capabilities.limits } : undefined } : undefined,
    reasoningPolicy: context.reasoningPolicy ? { ...context.reasoningPolicy, effortMap: context.reasoningPolicy.effortMap ? { ...context.reasoningPolicy.effortMap } : undefined } : undefined
  };
  if (!LLM_PROTOCOLS.includes(context.sourceProtocol) || !LLM_PROTOCOLS.includes(context.targetProtocol))
    fail('unsupported_protocol', 'Unknown protocol');
  if (typeof context.model !== 'string' || !context.model)
    fail('invalid_payload', 'Target model is required', 'model');
  const unsupported = (context.sourceProtocol === 'responses' && context.targetProtocol === 'gemini_generate_content') || (context.sourceProtocol === 'gemini_generate_content' && context.targetProtocol === 'responses');
  if (unsupported)
    fail('unsupported_protocol_pair', 'Responses and Gemini direct conversion is not supported');
  const same = context.sourceProtocol === context.targetProtocol;
  let disposed = false, poisoned = false, requested = false, mode: 'json' | 'stream' | undefined, finished = false, passTerminal = false, passAnthropicStopped = false;
  let names: ResponsesToolNames = new Map();
  let encoder: ResponsesEventEncoder | GeminiCanonicalDecoder | CanonicalStreamValidator | undefined;
  let validator: CanonicalStreamValidator | undefined;
  let renderer: CanonicalStreamRenderer | undefined;
  const guard = () => {
    if (disposed)
      fail('session_disposed', 'Protocol session has been disposed'); if (poisoned)
      fail('invalid_session', 'Protocol session cannot continue after conversion failure');
  };
  const run = <T>(fn: () => T): T => {
    guard();
    try {
      return fn();
    }
    catch (error) {
      poisoned = true;
      if (error instanceof ResponsesCodecError)
        throw new ResponsesCodecError(error.code, error.code.startsWith('unsupported') || error.code.startsWith('unknown') ? 'Protocol payload cannot be represented faithfully' : 'Protocol payload or session state is invalid', error.param);
      throw new ResponsesCodecError('invalid_payload', 'Protocol payload must be valid JSON');
    }
  };
  const initialize = () => {
    if (encoder)
      return;
    if (context.targetProtocol === 'responses')
      encoder = new CanonicalStreamValidator(context);
    else if (context.targetProtocol === 'gemini_generate_content')
      encoder = new GeminiCanonicalDecoder(context, names);
    else
      encoder = new ResponsesEventEncoder(context.targetProtocol, context.responseModel ?? context.model, names, context.capabilities?.limits, { preserveContentOrder: true });
    validator = context.targetProtocol === 'responses' ? undefined : new CanonicalStreamValidator(context);
    renderer = new CanonicalStreamRenderer(context.sourceProtocol, context);
  };
  const checkTool = (item: JsonRecord) => {
    if (!requested || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) return;
    if (![...names.values()].some(t => t.name === item.name && t.namespace === item.namespace && t.custom === (item.type === 'custom_tool_call')))
      fail('unknown_tool', 'Returned tool has no request authority', 'output.name');
  };
  const render = (events: JsonRecord[]) => {
    const checked: JsonRecord[] = []; for (const e of events) {
      if (e.type === 'response.output_item.added') checkTool(record(e.item, 'item'));
      checked.push(...(validator ? validator.push(e) : [e]));
    }
    return renderer!.push(checked);
  };
  return {
    convertRequest(raw) {
      return run(() => {
        if (requested || mode !== undefined)
          fail('invalid_session', 'Request conversion must occur once before response conversion');
        requested = true;
        serialized(record(raw, 'request'), limits(context.capabilities?.limits).maxRequestBytes, 'request');
        if (same) {
          const body = record(raw, 'request');
          serialized(body, limits(context.capabilities?.limits).maxRequestBytes, 'request');
          return { body, canonicalHistory: [], diagnostics: [], toolNames: names,streaming:context.streaming??body.stream===true };
        }
        const result = convertProtocolRequest(raw, context);
        names = result.toolNames;
        return result;
      });
    },
    convertResponse(raw) {
      return run(() => {
        if (mode !== undefined)
          fail('invalid_session', 'A session can convert one JSON response or one stream');
        mode = 'json';
        finished = true;
        if (same) {
          const body = record(raw, 'response');
          serialized(body, limits(context.capabilities?.limits).maxOutputBytes, 'response');
          return body;
        }
        const canonical = canonicalResponse(raw, context, names); for (const item of canonical.output as JsonRecord[]) checkTool(item);
        return responseFromCanonical(canonical, context.sourceProtocol, context);
      });
    },
    push(raw) {
      return run(() => {
        if (finished || mode === 'json')
          fail('invalid_stream', 'Event arrived after session completion');
        mode = 'stream';
        if (same) {
          const e = record(raw, 'event');
          serialized(e, limits(context.capabilities?.limits).maxOutputBytes, 'event');
          if (context.targetProtocol === 'anthropic_messages') {
            if (passAnthropicStopped)
              fail('invalid_stream', 'Event arrived after message_stop');
            if (e.type === 'message_delta' && record(e.delta, 'delta').stop_reason != null)
              passTerminal = true;
            if (e.type === 'message_stop') {
              if (!passTerminal)
                fail('missing_terminal', 'message_stop requires stop reason');
              passAnthropicStopped = true;
            }
          }
          else if (context.targetProtocol === 'responses') {
            if (passTerminal)
              fail('invalid_stream', 'Event arrived after Responses terminal');
            if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(e.type)))
              passTerminal = true;
          }
          else if (context.targetProtocol === 'chat_completions') {
            if (Array.isArray(e.choices))
              for (const rawChoice of e.choices) {
                const c = record(rawChoice, 'choice');
                if (passTerminal && c.delta !== undefined && Object.keys(record(c.delta, 'delta')).length)
                  fail('invalid_stream', 'Content arrived after terminal');
                if (c.finish_reason != null)
                  passTerminal = true;
              }
          }
          else if (Array.isArray(e.candidates))
            for (const rawCandidate of e.candidates) {
              const c = record(rawCandidate, 'candidate');
              if (passTerminal && c.content !== undefined)
                fail('invalid_stream', 'Content arrived after terminal');
              if (c.finishReason != null)
                passTerminal = true;
            }
          if (e.error !== undefined || e.type === 'error') {
            passTerminal = true;
            passAnthropicStopped = true;
          }
          return [e];
        }
        validateStreamEnvelope(raw, context.targetProtocol);
        initialize();
        return render(encoder!.push(raw));
      });
    },
    finish() {
      return run(() => {
        if (finished)
          return [];
        mode = 'stream';
        if (same) {
          if (!passTerminal || (context.targetProtocol === 'anthropic_messages' && !passAnthropicStopped))
            fail('missing_terminal', 'Stream ended without an explicit terminal');
          finished = true;
          return [];
        }
        initialize();
        const events = render(encoder!.finish());
        validator?.finish();
        finished = true;
        return events;
      });
    },
    dispose() { disposed = true; names = new Map(); encoder = undefined; validator = undefined; renderer = undefined; }
  };
}
function validateStreamEnvelope(raw: unknown, protocol: LLMProtocol): void {
  if (protocol === 'responses' || protocol === 'gemini_generate_content')
    return;
  const e = record(raw, 'stream event');
  if (e.error !== undefined || e.type === 'error')
    return;
  if (protocol === 'chat_completions') {
    fields(e, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'], '', 'unsupported_response');
    if (Array.isArray(e.choices))
      for (const rawChoice of e.choices) {
        const c = record(rawChoice, 'choice');
        fields(c, ['index', 'delta', 'finish_reason', 'logprobs'], 'choices', 'unsupported_response');
        if (c.logprobs != null)
          fail('unsupported_response', 'Log probabilities cannot cross protocols', 'choices.logprobs');
        const d = record(c.delta ?? {}, 'delta');
        if (Array.isArray(d.tool_calls))
          for (const rawCall of d.tool_calls) {
            const t = record(rawCall, 'tool call');
            fields(t, ['index', 'id', 'type', 'function'], 'tool_calls', 'unsupported_tool');
            if (t.function !== undefined)
              fields(record(t.function, 'function'), ['name', 'arguments'], 'tool_calls.function', 'unsupported_tool');
          }
      }
    validateUsage(e.usage, protocol);
  }
  else {
    const allowed = e.type === 'message_start' ? ['type', 'message'] : e.type === 'message_delta' ? ['type', 'delta', 'usage'] : e.type === 'content_block_start' ? ['type', 'index', 'content_block'] : e.type === 'content_block_delta' ? ['type', 'index', 'delta'] : e.type === 'content_block_stop' ? ['type', 'index'] : ['type'];
    fields(e, allowed, '', 'unsupported_response');
    if (e.type === 'content_block_start')
      validateAnthropicBlock(record(e.content_block, 'block'), 'content_block');
    if (e.type === 'content_block_delta') {
      const d = record(e.delta, 'delta');
      fields(d, d.type === 'text_delta' ? ['type', 'text'] : d.type === 'thinking_delta' ? ['type', 'thinking'] : d.type === 'signature_delta' ? ['type', 'signature'] : ['type', 'partial_json'], 'delta', 'unsupported_content');
      if (d.type === 'signature_delta' || d.signature !== undefined)
        fail('unsupported_reasoning', 'Signed provider reasoning cannot cross protocols', 'delta.signature');
    }
    if (e.type === 'message_delta')
      fields(record(e.delta, 'delta'), ['stop_reason', 'stop_sequence'], 'delta', 'unsupported_response');
    if (e.type === 'message_start') {
      const m = record(e.message, 'message');
      fields(m, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage'], 'message', 'unsupported_response');
      validateUsage(m.usage, protocol);
      if (m.content !== undefined && (!Array.isArray(m.content) || m.content.length))
        fail('unsupported_content', 'Initial stream message content must be empty', 'message.content');
      if (m.role !== undefined && m.role !== 'assistant')
        fail('unsupported_response', 'Stream role must be assistant', 'message.role');
    }
    validateUsage(e.usage, protocol);
  }
}
