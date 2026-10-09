export type ResponsesProtocol = 'chat_completions' | 'anthropic_messages';
export type JsonRecord = Record<string, unknown>;
export interface ResponsesToolName { name: string; namespace?: string; custom: boolean }
/** Per-request wire-name authority; never infer namespaces by splitting a provider name. */
export type ResponsesToolNames = ReadonlyMap<string, ResponsesToolName>;
export interface ResponsesCodecLimits {
  maxRequestBytes: number;
  maxOutputBytes: number;
  maxArgumentBytes: number;
  maxItems: number;
}
export const DEFAULT_RESPONSES_CODEC_LIMITS: Readonly<ResponsesCodecLimits> = Object.freeze({
  maxRequestBytes: 8 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxArgumentBytes: 1024 * 1024,
  maxItems: 1024,
});
export interface ResponsesCodecCapabilities {
  reasoningEffort?: boolean;
  /** Plain reasoning history support is independent of effort parameter mapping. */
  reasoningHistory?: boolean;
  /** Codex declares optional hosted search even when the selected model has no search backend. */
  omitOptionalWebSearch?: boolean;
  /** Explicit provider-approved thinking budget; do not guess budgets from effort labels. */
  anthropicThinkingBudget?: number;
  maxOutputTokens?: number;
  limits?: Partial<ResponsesCodecLimits>;
}
export interface ResponsesConversionDiagnostic {
  param: string;
  action: 'mapped' | 'omitted';
  reason: string;
}
export class ResponsesCodecError extends Error {
  constructor(readonly code: string, message: string, readonly param?: string) { super(message); this.name = 'ResponsesCodecError'; }
}
export function fail(code: string, message: string, param?: string): never { throw new ResponsesCodecError(code, message, param); }
export function atParam<T>(param: string, run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof ResponsesCodecError && error.param === undefined) throw new ResponsesCodecError(error.code, error.message, param);
    throw error;
  }
}
export function record(value: unknown, where: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_payload', `${where} must be an object`);
  return value as JsonRecord;
}
export function string(value: unknown, where: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value)) fail('invalid_payload', `${where} must be a${nonempty ? ' non-empty' : ''} string`);
  return value;
}
export function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail('invalid_payload', `${where} must be an array`);
  return value;
}
export function limits(overrides?: Partial<ResponsesCodecLimits>): ResponsesCodecLimits {
  const result = { ...DEFAULT_RESPONSES_CODEC_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_limit', `${key} must be a positive integer`);
  }
  return result;
}
export function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function bounded(value: string, max: number, where: string): string {
  if (bytes(value) > max) fail('resource_limit', `${where} exceeds ${max} bytes`);
  return value;
}
export function serialized(value: unknown, max: number, where: string): string {
  let result: string | undefined;
  try { result = JSON.stringify(value); } catch { fail('invalid_payload', `${where} must be serializable JSON`); }
  if (result === undefined) fail('invalid_payload', `${where} must be serializable JSON`);
  return bounded(result, max, where);
}
export function argumentObject(text: string): JsonRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('invalid_tool_arguments', 'Tool arguments must be complete JSON'); }
  return record(value, 'tool arguments');
}
export function restoreTool(name: string, names: ResponsesToolNames): ResponsesToolName {
  const result = names.get(name);
  if (result) return result;
  if (names.size) fail('unknown_tool', `Provider returned undeclared tool ${name}`);
  return { name, custom: false };
}
export function customInput(text: string): string {
  const value = argumentObject(text);
  if (Object.keys(value).length !== 1 || typeof value.input !== 'string') {
    fail('invalid_tool_arguments', 'Custom tools require exactly one string input property');
  }
  return value.input;
}
/** Decode only complete JSON-string characters. A split escape remains buffered. */
export function customInputPrefix(text: string): string {
  const prefix = /^\s*\{\s*"input"\s*:\s*"/.exec(text);
  if (!prefix) return '';
  let result = '';
  for (let i = prefix[0].length; i < text.length;) {
    const char = text[i];
    if (char === '"') break;
    if (char !== '\\') { if (char.charCodeAt(0) < 32) fail('invalid_tool_arguments', 'Invalid JSON string character'); result += char; i++; continue; }
    const escape = text[i + 1];
    if (escape === undefined) break;
    const size = escape === 'u' ? 6 : 2;
    if (i + size > text.length) break;
    try { result += JSON.parse(`"${text.slice(i, i + size)}"`); } catch { fail('invalid_tool_arguments', 'Invalid JSON string escape'); }
    i += size;
  }
  return result;
}
export interface Terminal { status: 'completed' | 'incomplete' | 'failed'; reason: string }
export function terminal(reason: unknown, protocol: ResponsesProtocol): Terminal {
  if (typeof reason !== 'string' || !reason) fail('missing_terminal', 'Upstream has no explicit completion reason');
  const completed = protocol === 'chat_completions' ? ['stop', 'tool_calls', 'function_call'] : ['end_turn', 'tool_use', 'stop_sequence'];
  if (completed.includes(reason)) return { status: 'completed', reason };
  if (reason === 'length' || reason === 'max_tokens' || reason === 'model_context_window_exceeded') return { status: 'incomplete', reason: 'max_output_tokens' };
  if (reason === 'content_filter' || reason === 'refusal') return { status: 'incomplete', reason: 'content_filter' };
  if (reason === 'error') return { status: 'failed', reason: 'upstream_error' };
  fail('unknown_terminal', `Unsupported upstream completion reason: ${reason}`);
}
function tokens(value: unknown, where: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('invalid_usage', `${where} must be a non-negative integer`);
  return value as number;
}
export function normalizeUsage(raw: unknown, protocol: ResponsesProtocol, prior: JsonRecord = {}): JsonRecord {
  if (raw === undefined || raw === null) return prior;
  const usage = record(raw, 'usage');
  const chat = protocol === 'chat_completions';
  const input = tokens(usage[chat ? 'prompt_tokens' : 'input_tokens'] ?? prior.input_tokens, 'input_tokens');
  const output = tokens(usage[chat ? 'completion_tokens' : 'output_tokens'] ?? prior.output_tokens, 'output_tokens');
  const details = chat ? usage.prompt_tokens_details : undefined;
  const cached = chat ? (details ? record(details, 'prompt_tokens_details').cached_tokens : undefined) : usage.cache_read_input_tokens;
  // Anthropic input_tokens excludes both cache classes; Responses input_tokens includes them.
  const cacheRead = tokens(cached ?? (prior.input_tokens_details as JsonRecord | undefined)?.cached_tokens, 'cached_tokens');
  const cacheWrite = chat ? 0 : tokens(usage.cache_creation_input_tokens, 'cache_creation_input_tokens');
  const totalInput = chat ? input : (usage.input_tokens === undefined ? input : input + cacheRead + cacheWrite);
  const reasoning = chat && usage.completion_tokens_details ? record(usage.completion_tokens_details, 'completion_tokens_details').reasoning_tokens : undefined;
  return { input_tokens: totalInput, output_tokens: output, total_tokens: totalInput + output,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens_details: { reasoning_tokens: tokens(reasoning ?? (prior.output_tokens_details as JsonRecord | undefined)?.reasoning_tokens, 'reasoning_tokens') } };
}
export function toolItem(id: string, name: string, args: string, names: ResponsesToolNames, status = 'completed'): JsonRecord {
  const original = restoreTool(name, names);
  const item: JsonRecord = { id: `fc_${id}`, type: original.custom ? 'custom_tool_call' : 'function_call', call_id: id, name: original.name, status };
  if (original.namespace) item.namespace = original.namespace;
  if (original.custom) item.input = customInput(args); else { argumentObject(args); item.arguments = args; }
  return item;
}
export function responsePayload(id: string, model: string, output: JsonRecord[], end: Terminal, usage: JsonRecord, error?: unknown, createdAt = Math.floor(Date.now() / 1000)): JsonRecord {
  const result: JsonRecord = { id, object: 'response', created_at: createdAt, model, status: end.status, output, usage: Object.keys(usage).length ? usage : null };
  if (end.status === 'incomplete') result.incomplete_details = { reason: end.reason };
  if (end.status === 'failed') result.error = error ?? { code: end.reason, message: end.reason };
  return result;
}
