import { fail, list, record, serialized, limits, responsePayload, type JsonRecord, type ResponsesCodecLimits, type ResponsesProtocol, type ResponsesToolNames } from './common';
import { ResponsesEventEncoder } from './events';

/** JSON and SSE share the same validation and item/terminal semantics. */
export function encodeResponsesResult(raw: unknown, protocol: ResponsesProtocol, model: string,
  toolNames: ResponsesToolNames = new Map(), configuredLimits?: Partial<ResponsesCodecLimits>): JsonRecord {
  const body = record(raw, 'upstream response');
  const budget = limits(configuredLimits);
  serialized(body, budget.maxOutputBytes, 'upstream response');
  if (body.error !== undefined || body.type === 'error') return responsePayload(`resp_${crypto.randomUUID().replaceAll('-', '')}`, model, [], { status: 'failed', reason: 'upstream_error' }, {}, record(body.error, 'upstream error'));
  const encoder = new ResponsesEventEncoder(protocol, model, toolNames, configuredLimits);
  if (protocol === 'chat_completions') {
    const choices = list(body.choices, 'choices');
    if (choices.length !== 1) fail('unsupported_response', 'Exactly one response choice is required');
    const choice = record(choices[0], 'choice');
    const message = record(choice.message, 'message');
    const delta: JsonRecord = { ...message };
    if (message.tool_calls !== undefined) delta.tool_calls = list(message.tool_calls, 'tool_calls').map((tool, index) => ({ ...record(tool, 'tool call'), index }));
    encoder.push({ choices: [{ index: choice.index ?? 0, delta, finish_reason: choice.finish_reason }], usage: body.usage });
  } else {
    encoder.push({ type: 'message_start', message: { usage: body.usage } });
    for (const [index, rawBlock] of list(body.content, 'content').entries()) {
      const block = record(rawBlock, 'content block');
      encoder.push({ type: 'content_block_start', index, content_block: block });
      encoder.push({ type: 'content_block_stop', index });
    }
    encoder.push({ type: 'message_delta', delta: { stop_reason: body.stop_reason } });
    encoder.push({ type: 'message_stop' });
  }
  const end = encoder.finish().at(-1);
  if (!end) fail('missing_terminal', 'JSON response has no terminal result');
  return record(end.response, 'Responses result');
}
