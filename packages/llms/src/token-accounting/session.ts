import type { LLMProvider } from '../core/types';
import { getProviderTokenAccountingCapabilities } from './capabilities';
import {
  asString,
  clampTokens,
  countModelTextTokens,
  countJsonLikeTokens,
  countTextTokens,
  createPartialTokenAccountingEvent,
  finalizeTokenAccountingEvent,
  isRecord,
  readNumber,
  readRecord
} from './helpers';
import type {
  CanonicalTokenAccountingEventV2,
  ProviderTokenAccountingAdapter,
  TokenAccountingSession,
  TokenAccountingSessionInput,
  TokenAccountingSessionState
} from './types';

type JsonRecord = Record<string, unknown>;

const DEFERRED_MEDIA_KEYS = new Set([
  'image_url', 'imageUrl', 'inline_data', 'inlineData', 'file_data', 'fileData',
  'file_uri', 'fileUri', 'file_url', 'fileUrl', 'file_id', 'fileId', 'input_audio', 'inputAudio', 'audio_url', 'audioUrl',
  'input_video', 'inputVideo', 'video_url', 'videoUrl'
]);
const DEFERRED_MEDIA_TYPES = new Set([
  'image', 'input_image', 'image_url', 'input_audio', 'audio', 'input_video', 'video',
  'input_file', 'file'
]);
const DEFERRED_METADATA_KEYS = new Set([
  'model', 'role', 'type', 'status', 'index', 'id', 'mime_type', 'mimeType', 'detail'
]);

// Keep only bounded output fragments while the proxy is forwarding the stream.
// Tokenization is deliberately deferred until finalization (one encode per side).
const MAX_STREAM_ESTIMATE_CHARS = 64 * 1024;
const MAX_STREAM_ESTIMATE_FRAGMENTS = 4096;
const MAX_INPUT_ESTIMATE_NODES = 4096;
const MAX_DEFERRED_MODEL_CHARS = 256;
type StreamEstimateState = TokenAccountingSessionState & {
  estimateFragments?: string[];
  estimateChars?: number;
  estimateTruncated?: boolean;
  requestEstimateTruncated?: boolean;
  deferFinalization?: boolean;
  deferredOutcome?: 'completed' | 'failed';
  estimateMediaSeen?: boolean;
  estimateNodes?: number;
};

function isDeferred(state: TokenAccountingSessionState): boolean {
  return (state as StreamEstimateState).deferFinalization === true;
}

function setSessionModel(state: TokenAccountingSessionState, value: unknown): void {
  const model = asString(value) ?? state.model ?? 'unknown';
  if (isDeferred(state) && model.length > MAX_DEFERRED_MODEL_CHARS) {
    state.model = model.slice(0, MAX_DEFERRED_MODEL_CHARS);
    (state as StreamEstimateState).requestEstimateTruncated = true;
    return;
  }
  state.model = model;
}

function observeOutput(state: TokenAccountingSessionState, value: unknown): void {
  if (state.outputAuthority === 'official') return;
  if (isDeferred(state) && typeof value === 'string' && isMediaDataUri(value)) {
    (state as StreamEstimateState).estimateMediaSeen = true;
    return;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return;
  const estimateState = state as StreamEstimateState;
  const remaining = MAX_STREAM_ESTIMATE_CHARS - (estimateState.estimateChars ?? 0);
  if (remaining <= 0) {
    estimateState.estimateTruncated = true;
    return;
  }
  if ((estimateState.estimateFragments?.length ?? 0) >= MAX_STREAM_ESTIMATE_FRAGMENTS) {
    estimateState.estimateTruncated = true;
    return;
  }
  const fragment = text.slice(0, remaining);
  (estimateState.estimateFragments ??= []).push(fragment);
  estimateState.estimateChars = (estimateState.estimateChars ?? 0) + fragment.length;
  if (fragment.length < text.length) estimateState.estimateTruncated = true;
}

function observeBoundedOutput(state: TokenAccountingSessionState, value: unknown): void {
  if (state.outputAuthority === 'official') return;
  if (!isDeferred(state)) {
    if (typeof value === 'string') {
      observeOutput(state, value);
      return;
    }
    const bounded = boundedRequestSnapshot({ value });
    if (bounded.truncated) (state as StreamEstimateState).estimateTruncated = true;
    observeOutput(state, bounded.value.value);
    return;
  }
  const estimateState = state as StreamEstimateState;
  const nodesLeft = MAX_INPUT_ESTIMATE_NODES - (estimateState.estimateNodes ?? 0);
  if (nodesLeft < 3) {
    estimateState.estimateTruncated = true;
    return;
  }
  const bounded = typeof value === 'string'
    ? { value: { value: value.slice(0, MAX_STREAM_ESTIMATE_CHARS) }, truncated: value.length > MAX_STREAM_ESTIMATE_CHARS, nodesCopied: 0 }
    : boundedRequestSnapshot({ value }, Math.max(1, Math.floor(nodesLeft / 3)));
  estimateState.estimateNodes = (estimateState.estimateNodes ?? 0) + bounded.nodesCopied * 3;
  const filtered = stripDeferredMedia(bounded.value.value);
  if (bounded.truncated) estimateState.estimateTruncated = true;
  if (filtered.sawMedia) estimateState.estimateMediaSeen = true;
  if (filtered.hasContent) observeOutput(state, filtered.value);
}

function isMediaDataUri(value: string): boolean {
  return /^data:(?:image|audio|video)\//i.test(value);
}

function stripDeferredMedia(value: unknown, key = ''): { value: unknown; sawMedia: boolean; hasContent: boolean } {
  if (key === 'tools' || key === 'tool_calls' || key === 'tool_use' || key === 'functionCall'
    || key === 'function_call' || key === 'arguments' || key === 'args') {
    return { value, sawMedia: false, hasContent: Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined };
  }
  if (DEFERRED_MEDIA_KEYS.has(key)) return { value: undefined, sawMedia: true, hasContent: false };
  if (typeof value === 'string') {
    const dataUriPattern = /data:(?:image|audio|video)\/[^\s"'<>)}\]]+/gi;
    const stripped = value.replace(dataUriPattern, '');
    const sawMedia = stripped.length !== value.length;
    return { value: stripped || undefined, sawMedia, hasContent: stripped.length > 0 && !DEFERRED_METADATA_KEYS.has(key) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value, sawMedia: false, hasContent: !DEFERRED_METADATA_KEYS.has(key) };
  }
  if (Array.isArray(value)) {
    let sawMedia = false;
    let hasContent = false;
    const result: unknown[] = [];
    for (const item of value) {
      const filtered = stripDeferredMedia(item);
      sawMedia ||= filtered.sawMedia;
      hasContent ||= filtered.hasContent;
      if (filtered.value !== undefined) result.push(filtered.value);
    }
    return { value: result, sawMedia, hasContent };
  }
  if (!isRecord(value)) return { value, sawMedia: false, hasContent: false };
  if (asString(value.type) === 'tool_use' || asString(value.type) === 'function_call') return { value, sawMedia: false, hasContent: true };
  if (DEFERRED_MEDIA_TYPES.has(asString(value.type) ?? '')) return { value: undefined, sawMedia: true, hasContent: false };
  const result: JsonRecord = {};
  let sawMedia = false;
  let hasContent = false;
  for (const [childKey, child] of Object.entries(value)) {
    const filtered = stripDeferredMedia(child, childKey);
    sawMedia ||= filtered.sawMedia;
    hasContent ||= filtered.hasContent;
    if (filtered.value !== undefined) result[childKey] = filtered.value;
  }
  return { value: result, sawMedia, hasContent };
}

function clearObservedOutput(state: TokenAccountingSessionState): void {
  const estimateState = state as StreamEstimateState;
  estimateState.estimateFragments = undefined;
  estimateState.estimateChars = undefined;
  estimateState.estimateTruncated = false;
  estimateState.estimateMediaSeen = false;
  estimateState.estimateNodes = 0;
}

function estimatedStreamOutput(state: TokenAccountingSessionState): { tokens?: number; authority: 'local' | 'heuristic' | 'partial' | 'none' } {
  const estimateState = state as StreamEstimateState;
  const estimateChars = estimateState.estimateChars ?? 0;
  if (estimateChars === 0) return { authority: 'none' };
  if (isDeferred(state)) {
    const tokens = clampTokens(countTextTokens('x'.repeat(estimateChars)));
    return tokens === undefined
      ? { authority: 'none' }
      : { tokens, authority: estimateState.estimateTruncated || estimateState.estimateMediaSeen ? 'partial' : 'heuristic' };
  }
  const tokens = clampTokens(countModelTextTokens(estimateState.estimateFragments!.join(''), state.model));
  return tokens === undefined
    ? { authority: 'none' }
    : { tokens, authority: estimateState.estimateTruncated ? 'partial' : 'local' };
}

function finalizeMissingStreamOutput(state: TokenAccountingSessionState, interrupted = false): void {
  if (state.outputAuthority === 'official') return;
  const estimate = estimatedStreamOutput(state);
  state.outputTokens = estimate.tokens;
  state.outputAuthority = interrupted && estimate.tokens !== undefined ? 'partial' : estimate.authority;
}

type BoundedRequest = { value: JsonRecord; truncated: boolean; nodesCopied: number };

function boundedRequestSnapshot(body: JsonRecord, maxNodes = MAX_INPUT_ESTIMATE_NODES): BoundedRequest {
  let remaining = MAX_STREAM_ESTIMATE_CHARS;
  let nodes = maxNodes;
  let truncated = false;
  const copy = (value: unknown): unknown => {
    if (nodes <= 0 || remaining <= 0) {
      truncated = true;
      return undefined;
    }
    nodes -= 1;
    if (typeof value === 'string') {
      if (value.length > remaining) {
        truncated = true;
        const clipped = value.slice(0, remaining);
        remaining = 0;
        return clipped;
      }
      remaining -= value.length;
      return value;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (nodes <= 0 || remaining <= 0) {
          truncated = true;
          break;
        }
        result.push(copy(value[index]));
      }
      if (result.length < value.length) truncated = true;
      return result;
    }
    if (!isRecord(value)) return undefined;
    const result: JsonRecord = {};
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (nodes <= 0 || remaining <= key.length) {
        truncated = true;
        break;
      }
      remaining -= key.length;
      result[key] = copy(value[key]);
    }
    return result;
  };
  return { value: copy(body) as JsonRecord, truncated, nodesCopied: maxNodes - nodes };
}

function storeRequestForEstimate(state: TokenAccountingSessionState, body: JsonRecord, fields: string[]): void {
  const relevant: JsonRecord = {};
  if (body.model !== undefined) relevant.model = isDeferred(state) && typeof body.model === 'string'
    ? body.model.slice(0, MAX_DEFERRED_MODEL_CHARS)
    : body.model;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) relevant[field] = body[field];
  }
  const bounded = boundedRequestSnapshot(relevant);
  state.requestBody = bounded.value;
  (state as StreamEstimateState).requestEstimateTruncated = bounded.truncated
    || (typeof body.model === 'string' && isDeferred(state) && body.model.length > MAX_DEFERRED_MODEL_CHARS);
}

function estimateMissingInput(state: TokenAccountingSessionState): void {
  if (state.estimatedInputAuthority === 'official') return;
  const requestBody = state.requestBody;
  if (!requestBody) {
    state.estimatedInputTokens = undefined;
    state.estimatedInputAuthority = 'none';
    return;
  }
  const hasInput = state.provider === 'openai'
    ? requestBody.input !== undefined || requestBody.messages !== undefined
    : state.provider === 'anthropic'
      ? requestBody.system !== undefined || requestBody.messages !== undefined
      : requestBody.contents !== undefined || requestBody.systemInstruction !== undefined;
  if (!hasInput) {
    state.estimatedInputTokens = undefined;
    state.estimatedInputAuthority = 'none';
    return;
  }
  const bounded = isDeferred(state)
    ? { value: requestBody, truncated: false }
    : boundedRequestSnapshot(requestBody);
  if (isDeferred(state)) {
    const filtered = stripDeferredMedia(bounded.value);
    const estimateBody = { ...filtered.value as JsonRecord };
    delete estimateBody.model;
    const hasToolSchema = Array.isArray(estimateBody.tools) && estimateBody.tools.length > 0;
    const hasContent = filtered.hasContent || hasToolSchema;
    if (!hasContent) {
      state.estimatedInputTokens = undefined;
      state.estimatedInputAuthority = 'none';
      return;
    }
    state.estimatedInputTokens = clampTokens(countJsonLikeTokens(estimateBody));
    state.estimatedInputAuthority = bounded.truncated
      || (state as StreamEstimateState).requestEstimateTruncated
      || filtered.sawMedia
      ? 'partial'
      : 'heuristic';
    return;
  }
  const estimate = state.provider === 'openai'
    ? estimateOpenAIInputTokens(bounded.value)
    : state.provider === 'anthropic'
      ? estimateAnthropicInputTokens(bounded.value)
      : estimateGeminiInputTokens(bounded.value);
  state.estimatedInputTokens = estimate;
  state.estimatedInputAuthority = bounded.truncated || (state as StreamEstimateState).requestEstimateTruncated ? 'partial' : 'local';
}
function hasOpenAIOutput(body: JsonRecord): boolean {
  if (Array.isArray(body.output) && body.output.length > 0) return true;
  return Array.isArray(body.choices) && body.choices.some((choice) => {
    if (!isRecord(choice)) return false;
    const message = readRecord(choice, 'message') ?? readRecord(choice, 'delta');
    return !!message && (message.content !== undefined && message.content !== null
      || Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  });
}

function hasAnthropicOutput(body: JsonRecord): boolean {
  return Array.isArray(body.content) && body.content.length > 0;
}

function observeAnthropicOutput(state: TokenAccountingSessionState, body: JsonRecord): void {
  const blocks = Array.isArray(body.content) ? body.content : [];
  for (let index = 0; index < blocks.length && index < MAX_INPUT_ESTIMATE_NODES; index += 1) {
    observeBoundedOutput(state, blocks[index]);
  }
  if (blocks.length > MAX_INPUT_ESTIMATE_NODES && isDeferred(state)) (state as StreamEstimateState).estimateTruncated = true;
}

function hasGeminiOutput(body: JsonRecord): boolean {
  return Array.isArray(body.candidates) && body.candidates.some((candidate) => {
    const parts = readRecord(candidate, 'content')?.parts;
    return Array.isArray(parts) && parts.length > 0;
  });
}

function isErrorResponse(body: JsonRecord): boolean {
  const status = asString(body.status)?.toLowerCase();
  const type = asString(body.type)?.toLowerCase();
  return body.error !== undefined || status === 'error' || status === 'failed'
    || type === 'error' || type?.endsWith('.error') === true || type?.endsWith('.failed') === true;
}

function isDeferredFailure(body: JsonRecord): boolean {
  const status = asString(body.status)?.toLowerCase();
  const type = asString(body.type)?.toLowerCase();
  return isErrorResponse(body) || status === 'incomplete' || type === 'incomplete' || type?.endsWith('.incomplete') === true;
}

function observeOpenAIOutput(
  state: TokenAccountingSessionState,
  chunk: JsonRecord,
  includeResponseSnapshot = true
): void {
  if (state.outputAuthority === 'official') return;
  let nodes = MAX_INPUT_ESTIMATE_NODES;
  const truncated = () => {
    if (isDeferred(state)) (state as StreamEstimateState).estimateTruncated = true;
  };
  const type = asString(chunk.type);
  if (type === 'response.output_text.delta') {
    if (isDeferred(state)) observeBoundedOutput(state, chunk.delta);
    else observeOutput(state, chunk.delta);
  }
  if (type === 'response.function_call_arguments.delta') {
    if (isDeferred(state)) observeBoundedOutput(state, chunk.delta);
    else observeOutput(state, chunk.delta);
  }
  if (includeResponseSnapshot) {
    const response = readRecord(chunk, 'response');
    const responseOutput = Array.isArray(response?.output) ? response.output : Array.isArray(chunk.output) ? chunk.output : undefined;
    if (responseOutput !== undefined) {
      if (isDeferred(state)) {
        const limit = Math.min(responseOutput.length, nodes);
        for (let index = 0; index < limit; index += 1, nodes -= 1) {
          observeBoundedOutput(state, responseOutput[index]);
        }
        if (responseOutput.length > limit) truncated();
      } else observeOutput(state, responseOutput);
    }
  }
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choiceLimit = Math.min(choices.length, nodes);
  for (let index = 0; index < choiceLimit; index += 1, nodes -= 1) {
    const choice = choices[index];
    if (!isRecord(choice)) continue;
    const delta = readRecord(choice, 'delta') ?? (isDeferred(state) ? readRecord(choice, 'message') : undefined);
    if (delta?.content !== undefined) {
      if (isDeferred(state)) observeBoundedOutput(state, delta.content);
      else observeOutput(state, delta.content);
    }
    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    const callLimit = Math.min(calls.length, nodes);
    for (let callIndex = 0; callIndex < callLimit; callIndex += 1, nodes -= 1) {
      const call = calls[callIndex];
      const fn = readRecord(call, 'function');
      if (fn?.arguments !== undefined) {
        if (isDeferred(state)) observeBoundedOutput(state, fn.arguments);
        else observeOutput(state, fn.arguments);
      }
    }
    if (calls.length > callLimit) truncated();
  }
  if (choices.length > choiceLimit) truncated();
}

function replaceObservedOutput(state: TokenAccountingSessionState): void {
  const estimateState = state as StreamEstimateState;
  estimateState.estimateFragments = [];
  estimateState.estimateChars = 0;
  estimateState.estimateTruncated = false;
  estimateState.estimateMediaSeen = false;
  estimateState.estimateNodes = 0;
}

function observeGeminiOutput(state: TokenAccountingSessionState, chunk: JsonRecord): void {
  let nodes = MAX_INPUT_ESTIMATE_NODES;
  const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const candidateLimit = Math.min(candidates.length, nodes);
  for (let candidateIndex = 0; candidateIndex < candidateLimit; candidateIndex += 1, nodes -= 1) {
    const candidate = candidates[candidateIndex];
    const content = readRecord(candidate, 'content');
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const partLimit = Math.min(parts.length, nodes);
    for (let partIndex = 0; partIndex < partLimit; partIndex += 1, nodes -= 1) {
      const part = parts[partIndex];
      if (!isRecord(part)) continue;
      if (isDeferred(state) && (part.inlineData !== undefined || part.inline_data !== undefined || part.fileData !== undefined || part.file_data !== undefined)) {
        (state as StreamEstimateState).estimateMediaSeen = true;
      }
      if (typeof part.text === 'string') {
        if (isDeferred(state)) observeBoundedOutput(state, part.text);
        else observeOutput(state, part.text);
      }
       if (part.functionCall !== undefined) {
         if (isDeferred(state)) observeBoundedOutput(state, part.functionCall);
         else observeOutput(state, part.functionCall);
       }
    }
    if (parts.length > partLimit && isDeferred(state)) (state as StreamEstimateState).estimateTruncated = true;
  }
  if (candidates.length > candidateLimit && isDeferred(state)) (state as StreamEstimateState).estimateTruncated = true;
}

function countOpenAIStringTokens(value: unknown, model: string | undefined): number {
  return countModelTextTokens(asString(value) ?? '', model);
}

function countOpenAIJsonLikeTokens(value: unknown, model: string | undefined): number {
  if (typeof value === 'string') {
    return countOpenAIStringTokens(value, model);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return 1;
  }

  if (value === null || value === undefined) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countOpenAIJsonLikeTokens(item, model), 0);
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce((total, [key, item]) => {
      return total + countOpenAIStringTokens(key, model) + countOpenAIJsonLikeTokens(item, model);
    }, 0);
  }

  return countOpenAIStringTokens(String(value), model);
}

function estimateOpenAIImageTokens(part: JsonRecord): number {
  const imageUrl = readRecord(part, 'image_url');
  const detail = asString(part.detail) ?? asString(imageUrl?.detail);
  if (detail === 'low') {
    return 85;
  }

  return 170;
}

function estimateOpenAIToolCallTokens(toolCall: unknown, model: string | undefined): number {
  if (!isRecord(toolCall)) {
    return countOpenAIJsonLikeTokens(toolCall, model);
  }

  const toolFunction = readRecord(toolCall, 'function');
  return 12
    + countOpenAIStringTokens(toolCall.id, model)
    + countOpenAIStringTokens(toolCall.type, model)
    + countOpenAIStringTokens(toolFunction?.name, model)
    + countOpenAIStringTokens(toolFunction?.arguments, model)
    + countOpenAIJsonLikeTokens(toolCall, model);
}

function estimateOpenAIMessageTokens(message: unknown, model: string | undefined): number {
  if (!isRecord(message)) {
    return countOpenAIJsonLikeTokens(message, model);
  }

  const content = message.content;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return 4
    + countOpenAIStringTokens(message.role, model)
    + countOpenAIStringTokens(message.name, model)
    + countOpenAIStringTokens(message.tool_call_id, model)
    + estimateOpenAIMessageContent(content, model)
    + toolCalls.reduce((total, toolCall) => total + estimateOpenAIToolCallTokens(toolCall, model), 0);
}

function safeTokenSum(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function estimateGeminiInlineDataTokens(inlineData: JsonRecord): number {
  const mimeType = asString(inlineData.mimeType)?.toLowerCase() ?? '';

  if (mimeType.startsWith('image/')) {
    return 224;
  }

  if (mimeType.startsWith('video/')) {
    return 384;
  }

  if (mimeType.startsWith('audio/')) {
    return 128;
  }

  return 96;
}

function estimateGeminiFunctionCallTokens(functionCall: JsonRecord): number {
  return 12
    + countTextTokens(asString(functionCall.name) ?? '')
    + countJsonLikeTokens(functionCall.args);
}

function estimateGeminiFunctionResponseTokens(functionResponse: JsonRecord): number {
  return 12
    + countTextTokens(asString(functionResponse.name) ?? '')
    + countJsonLikeTokens(functionResponse.response);
}

function buildAnthropicStreamingEvent(
  state: TokenAccountingSessionState,
  overrides: Partial<CanonicalTokenAccountingEventV2> = {}
): CanonicalTokenAccountingEventV2 {
  return createPartialTokenAccountingEvent(state, {
    inputTokens: state.estimatedInputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    inputAuthority: state.estimatedInputAuthority ?? 'none',
    outputAuthority: state.outputAuthority ?? 'none',
    ...overrides
  });
}

function estimateOpenAIMessageContent(content: unknown, model: string | undefined): number {
  if (typeof content === 'string') {
    return countModelTextTokens(content, model);
  }

  if (!Array.isArray(content)) {
    return countOpenAIJsonLikeTokens(content, model);
  }

  return content.reduce((total, part) => {
    if (!isRecord(part)) {
      return total + countOpenAIJsonLikeTokens(part, model);
    }

    const type = asString(part.type);
    if (type === 'text') {
      return total + countOpenAIStringTokens(part.text, model);
    }

    if (type === 'image_url' || type === 'image') {
      return total + estimateOpenAIImageTokens(part);
    }

    return total + countOpenAIJsonLikeTokens(part, model);
  }, 0);
}

function estimateOpenAIInputTokens(body: JsonRecord): number {
  const model = asString(body.model);
  if (body.input !== undefined) {
    return clampTokens(countOpenAIJsonLikeTokens(body.input, model) + 8) ?? 0;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const messageTokens = messages.reduce((total, message) => total + estimateOpenAIMessageTokens(message, model), 0);

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolTokens = tools.reduce((total, tool) => total + 16 + countOpenAIJsonLikeTokens(tool, model), 0);
  return clampTokens(messageTokens + toolTokens + 8) ?? 0;
}

function estimateOpenAIResponseOutputTokens(body: JsonRecord, model?: string): number {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  return clampTokens(choices.reduce((total, choice) => {
    if (!isRecord(choice)) {
      return total + countOpenAIJsonLikeTokens(choice, model);
    }

    const message = readRecord(choice, 'message');
    const delta = readRecord(choice, 'delta');
    const toolCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : Array.isArray(delta?.tool_calls)
        ? delta.tool_calls
        : [];

    return total
      + countOpenAIStringTokens(message?.role ?? delta?.role, model)
      + countOpenAIStringTokens(message?.tool_call_id, model)
      + estimateOpenAIMessageContent(message?.content ?? delta?.content, model)
      + toolCalls.reduce((toolTotal, toolCall) => toolTotal + estimateOpenAIToolCallTokens(toolCall, model), 0)
      + (asString(choice.finish_reason) === 'tool_calls' ? 4 : 0);
  }, 0)) ?? 0;
}

function openAIUsage(body: JsonRecord): JsonRecord | undefined {
  return readRecord(readRecord(body, 'response'), 'usage') ?? readRecord(body, 'usage');
}

function estimateOpenAIResponsesOutputTokens(response: JsonRecord, model?: string): number {
  const output = Array.isArray(response.output) ? response.output : [];
  return clampTokens(output.reduce((total, item) => {
    if (!isRecord(item)) return total + countOpenAIJsonLikeTokens(item, model);
    const content = Array.isArray(item.content) ? item.content : [];
    return total + content.reduce((contentTotal, part) => {
      if (isRecord(part) && typeof part.text === 'string') return contentTotal + countOpenAIStringTokens(part.text, model);
      return contentTotal + countOpenAIJsonLikeTokens(part, model);
    }, 0) + countOpenAIStringTokens(item.arguments, model);
  }, 0)) ?? 0;
}

function isDoneSentinel(chunk: JsonRecord): boolean {
  return chunk.data === '[DONE]' || chunk.type === '[DONE]';
}

function estimateAnthropicInputTokens(body: JsonRecord): number {
  const system = asString(body.system) ?? '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return clampTokens(
    countTextTokens(system)
      + messages.reduce((total, message) => total + countJsonLikeTokens(message), 0)
      + tools.reduce((total, tool) => total + 16 + countJsonLikeTokens(tool), 0)
      + 8
  ) ?? 0;
}

function estimateAnthropicOutputTokens(body: JsonRecord): number {
  const content = Array.isArray(body.content) ? body.content : [];
  return clampTokens(content.reduce((total, block) => total + countJsonLikeTokens(block), 0)) ?? 0;
}

function estimateGeminiPartTokens(part: unknown): number {
  if (!isRecord(part)) {
    return countJsonLikeTokens(part);
  }

  if (typeof part.text === 'string') {
    return countTextTokens(part.text);
  }

  if (isRecord(part.inlineData)) {
    return estimateGeminiInlineDataTokens(part.inlineData);
  }

  if (isRecord(part.functionCall)) {
    return estimateGeminiFunctionCallTokens(part.functionCall);
  }

  if (isRecord(part.functionResponse)) {
    return estimateGeminiFunctionResponseTokens(part.functionResponse);
  }

  return countJsonLikeTokens(part);
}

function estimateGeminiInputTokens(body: JsonRecord): number {
  const systemInstruction = readRecord(body, 'systemInstruction');
  const systemParts = Array.isArray(systemInstruction?.parts) ? systemInstruction.parts : [];
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return clampTokens(
    systemParts.reduce((total, part) => total + estimateGeminiPartTokens(part), 0)
      + contents.reduce((total, item) => {
        if (!isRecord(item)) {
          return total + countJsonLikeTokens(item);
        }

        const parts = Array.isArray(item.parts) ? item.parts : [];
        return total + parts.reduce((partTotal, part) => partTotal + estimateGeminiPartTokens(part), 0);
      }, 0)
      + 8
  ) ?? 0;
}

function estimateGeminiOutputTokens(body: JsonRecord): number {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  return clampTokens(candidates.reduce((total, candidate) => {
    if (!isRecord(candidate)) {
      return total + countJsonLikeTokens(candidate);
    }

    const content = readRecord(candidate, 'content');
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return total + parts.reduce((partTotal, part) => partTotal + estimateGeminiPartTokens(part), 0);
  }, 0)) ?? 0;
}

function createOpenAIAdapter(): ProviderTokenAccountingAdapter {
  return {
    provider: 'openai',
    capabilities: getProviderTokenAccountingCapabilities('openai'),
    consumeRequest(state, body) {
      storeRequestForEstimate(state, body, ['input', 'messages', 'tools']);
      setSessionModel(state, body.model);
    },
    consumeResponse(state, body) {
      const usage = openAIUsage(body);
      const promptTokens = readNumber(usage, 'prompt_tokens') ?? readNumber(usage, 'input_tokens');
      const completionTokens = readNumber(usage, 'completion_tokens') ?? readNumber(usage, 'output_tokens');
      const responseStatus = asString(readRecord(body, 'response')?.status) ?? asString(body.status);
      const isIncomplete = responseStatus === 'incomplete' || asString(body.type) === 'response.incomplete';
      const isFailed = responseStatus === 'failed' || asString(body.type) === 'response.failed';
      const promptDetails = readRecord(usage, 'prompt_tokens_details') ?? readRecord(usage, 'input_tokens_details');
      const cacheReadTokens = readNumber(promptDetails, 'cached_tokens');
      if (isDeferred(state)) {
        if (promptTokens !== undefined) {
          state.estimatedInputTokens = promptTokens;
          state.estimatedInputAuthority = 'official';
        }
        if (completionTokens !== undefined) {
          state.outputTokens = completionTokens;
          state.outputAuthority = 'official';
          clearObservedOutput(state);
        }
        if (cacheReadTokens !== undefined) state.cacheReadTokens = cacheReadTokens;
        if (!isIncomplete && !isFailed && !isErrorResponse(body)) observeOpenAIOutput(state, body);
        state.protocolTerminalSeen = true;
        (state as StreamEstimateState).deferredOutcome = isIncomplete || isFailed || isErrorResponse(body) ? 'failed' : 'completed';
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (promptTokens === undefined) estimateMissingInput(state);
      const responseHasOutput = hasOpenAIOutput(body) && !isIncomplete && !isFailed && !isErrorResponse(body);
      const estimatedOutput = completionTokens === undefined && responseHasOutput
        ? (Array.isArray(body.output) ? estimateOpenAIResponsesOutputTokens(body, state.model) : estimateOpenAIResponseOutputTokens(body, state.model))
        : undefined;

      if (promptTokens !== undefined || completionTokens !== undefined) {
        state.finalReceived = true;
        return finalizeTokenAccountingEvent(state, {
          inputTokens: promptTokens ?? state.estimatedInputTokens,
          outputTokens: completionTokens ?? estimatedOutput,
          cacheReadTokens,
          cacheWriteTokens: undefined,
          inputAuthority: promptTokens !== undefined ? 'official' : (state.estimatedInputAuthority ?? 'heuristic'),
          outputAuthority: completionTokens !== undefined ? 'official' : estimatedOutput === undefined ? 'none' : 'local'
        }, isIncomplete || isFailed ? 'failed' : 'completed');
      }

      const outputTokens = estimatedOutput;
      state.finalReceived = true;
      state.outputTokens = outputTokens;
      state.outputAuthority = outputTokens === undefined ? 'none' : 'local';
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority
      }, isIncomplete || isFailed ? 'failed' : 'completed');
    },
    consumeStreamChunk(state, chunk) {
      if (state.finalReceived || isDoneSentinel(chunk)) return null;
      const response = readRecord(chunk, 'response');
      const usage = openAIUsage(chunk);
      const promptTokens = readNumber(usage, 'prompt_tokens') ?? readNumber(usage, 'input_tokens');
      const completionTokens = readNumber(usage, 'completion_tokens') ?? readNumber(usage, 'output_tokens');
      const promptDetails = readRecord(usage, 'prompt_tokens_details') ?? readRecord(usage, 'input_tokens_details');
      if (promptTokens !== undefined) {
        state.estimatedInputTokens = promptTokens;
        state.estimatedInputAuthority = 'official';
      }
      if (completionTokens !== undefined) {
        state.outputTokens = completionTokens;
        state.outputAuthority = 'official';
        clearObservedOutput(state);
      }
      const reportedCache = readNumber(promptDetails, 'cached_tokens');
      if (reportedCache !== undefined) state.cacheReadTokens = reportedCache;
      const responseType = asString(chunk.type);
      const responseStatus = asString(response?.status);
      const responseCompleted = responseType === 'response.completed' || responseStatus === 'completed';
      observeOpenAIOutput(state, chunk, !responseCompleted);
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (choices.some((choice) => isRecord(choice) && asString(choice.finish_reason) !== undefined && choice.finish_reason !== null)) {
        state.protocolTerminalSeen = true;
        if (isDeferred(state)) (state as StreamEstimateState).deferredOutcome = 'completed';
      }
      if (isDeferred(state)) {
        if (responseCompleted) {
          (state as StreamEstimateState).deferredOutcome = 'completed';
          state.protocolTerminalSeen = true;
          if (completionTokens === undefined && state.outputAuthority !== 'official' && Array.isArray(response?.output)) {
            replaceObservedOutput(state);
            observeOpenAIOutput(state, { response });
          }
        } else if (responseType === 'response.incomplete' || responseType === 'response.failed'
          || responseStatus === 'incomplete' || responseStatus === 'failed') {
          (state as StreamEstimateState).deferredOutcome = 'failed';
          state.protocolTerminalSeen = true;
        }
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (responseCompleted) {
        if (completionTokens === undefined && state.outputAuthority !== 'official' && Array.isArray(response?.output)) {
          replaceObservedOutput(state);
          observeOpenAIOutput(state, { response });
        }
        if (completionTokens === undefined) finalizeMissingStreamOutput(state);
        if (promptTokens === undefined) estimateMissingInput(state);
        state.finalReceived = true;
        return finalizeTokenAccountingEvent(state, {
          inputTokens: promptTokens ?? state.estimatedInputTokens,
          outputTokens: completionTokens ?? state.outputTokens,
          cacheReadTokens: readNumber(readRecord(usage, 'input_tokens_details') ?? readRecord(usage, 'prompt_tokens_details'), 'cached_tokens') ?? state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: promptTokens !== undefined ? 'official' : (state.estimatedInputAuthority ?? 'heuristic'),
          outputAuthority: completionTokens !== undefined ? 'official' : (state.outputAuthority ?? 'none')
        });
      }
      if (responseType === 'response.incomplete' || responseType === 'response.failed'
        || responseStatus === 'incomplete' || responseStatus === 'failed') {
        state.finalReceived = true;
        const promptDetails = readRecord(usage, 'input_tokens_details') ?? readRecord(usage, 'prompt_tokens_details');
        const input = promptTokens === undefined ? undefined : promptTokens;
        const output = completionTokens;
        state.estimatedInputTokens = input ?? state.estimatedInputTokens;
        state.outputTokens = output ?? state.outputTokens;
        state.cacheReadTokens = readNumber(promptDetails, 'cached_tokens') ?? state.cacheReadTokens;
        if (output === undefined) finalizeMissingStreamOutput(state);
        if (input === undefined) estimateMissingInput(state);
        return finalizeTokenAccountingEvent(state, {
          inputTokens: input ?? state.estimatedInputTokens,
          outputTokens: output ?? state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: input !== undefined ? 'official' : (state.estimatedInputAuthority ?? 'heuristic'),
          outputAuthority: output !== undefined ? 'official' : (state.outputAuthority ?? 'none')
        }, 'failed');
      }
      return createPartialTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority ?? 'none'
      });
    },
    finalizeAbortedStream(state) {
      finalizeMissingStreamOutput(state, true);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority ?? 'none'
      }, 'aborted');
    },
    finalizeCompletedStream(state) {
      if (state.finalReceived) return createPartialTokenAccountingEvent(state);
      state.finalReceived = true;
      finalizeMissingStreamOutput(state);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority ?? 'none'
      }, (state as StreamEstimateState).deferredOutcome ?? (state.protocolTerminalSeen ? 'completed' : 'failed'));
    }
  };
}

function createAnthropicAdapter(): ProviderTokenAccountingAdapter {
  return {
    provider: 'anthropic',
    capabilities: getProviderTokenAccountingCapabilities('anthropic'),
    consumeRequest(state, body) {
      storeRequestForEstimate(state, body, ['system', 'messages', 'tools']);
      setSessionModel(state, body.model);
    },
    consumeResponse(state, body) {
      const usage = readRecord(body, 'usage');
      const inputTokens = readNumber(usage, 'input_tokens');
      const outputTokens = readNumber(usage, 'output_tokens');
      const cacheWriteTokens = readNumber(usage, 'cache_creation_input_tokens');
      const cacheReadTokens = readNumber(usage, 'cache_read_input_tokens');
      const totalInputTokens = inputTokens === undefined ? undefined : safeTokenSum(inputTokens, cacheWriteTokens ?? 0, cacheReadTokens ?? 0);
      if (isDeferred(state)) {
        if (totalInputTokens !== undefined) {
          state.estimatedInputTokens = totalInputTokens;
          state.estimatedInputAuthority = 'official';
        }
        if (outputTokens !== undefined) {
          state.outputTokens = outputTokens;
          state.outputAuthority = 'official';
          clearObservedOutput(state);
        }
        if (cacheReadTokens !== undefined) state.cacheReadTokens = cacheReadTokens;
        if (cacheWriteTokens !== undefined) state.cacheWriteTokens = cacheWriteTokens;
        const failed = isDeferredFailure(body);
        if (!failed) observeAnthropicOutput(state, body);
        state.protocolTerminalSeen = true;
        (state as StreamEstimateState).deferredOutcome = failed ? 'failed' : 'completed';
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (totalInputTokens === undefined) estimateMissingInput(state);
      const estimatedOutput = outputTokens === undefined && hasAnthropicOutput(body) && !isErrorResponse(body) ? estimateAnthropicOutputTokens(body) : undefined;

      if (usage && (inputTokens !== undefined || outputTokens !== undefined
        || readNumber(usage, 'cache_creation_input_tokens') !== undefined
        || readNumber(usage, 'cache_read_input_tokens') !== undefined)) {
        state.finalReceived = true;
        return finalizeTokenAccountingEvent(state, {
          inputTokens: totalInputTokens ?? state.estimatedInputTokens,
          outputTokens: outputTokens ?? estimatedOutput,
          cacheReadTokens,
          cacheWriteTokens,
          inputAuthority: totalInputTokens !== undefined ? 'official' : (state.estimatedInputAuthority ?? 'heuristic'),
          outputAuthority: outputTokens !== undefined ? 'official' : estimatedOutput === undefined ? 'none' : 'local'
        });
      }

      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: estimatedOutput,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: estimatedOutput === undefined ? 'none' : 'local'
      });
    },
    consumeStreamChunk(state, chunk) {
      if (state.finalReceived || isDoneSentinel(chunk)) return null;
      const type = asString(chunk.type);
      if (isDeferred(state) && type === 'error') {
        state.protocolTerminalSeen = true;
        (state as StreamEstimateState).deferredOutcome = 'failed';
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (type === 'message_start') {
        const message = readRecord(chunk, 'message');
        const usage = readRecord(message, 'usage');
        setSessionModel(state, message?.model);
        state.cacheWriteTokens = readNumber(usage, 'cache_creation_input_tokens') ?? state.cacheWriteTokens;
        state.cacheReadTokens = readNumber(usage, 'cache_read_input_tokens') ?? state.cacheReadTokens;
        const rawInputTokens = readNumber(usage, 'input_tokens');
        const totalInputTokens = rawInputTokens === undefined
          ? undefined
          : safeTokenSum(rawInputTokens, state.cacheWriteTokens ?? 0, state.cacheReadTokens ?? 0);
        state.estimatedInputTokens = totalInputTokens ?? state.estimatedInputTokens;
        if (totalInputTokens !== undefined) state.estimatedInputAuthority = 'official';

        const initialOutputTokens = readNumber(usage, 'output_tokens');
        state.outputTokens = initialOutputTokens ?? state.outputTokens;
        state.outputAuthority = initialOutputTokens !== undefined ? 'official' : 'none';
        if (initialOutputTokens !== undefined) clearObservedOutput(state);
        return buildAnthropicStreamingEvent(state, {
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority
        });
      }

      if (type === 'content_block_start') {
        const contentBlock = readRecord(chunk, 'content_block');
        if (contentBlock?.text !== undefined) {
          if (isDeferred(state)) observeBoundedOutput(state, contentBlock.text);
          else observeOutput(state, contentBlock.text);
        }
        return buildAnthropicStreamingEvent(state);
      }

      if (type === 'content_block_delta') {
        const delta = readRecord(chunk, 'delta');
        const deltaType = asString(delta?.type);
        if (deltaType === 'text_delta') {
          if (isDeferred(state)) observeBoundedOutput(state, delta?.text);
          else observeOutput(state, delta?.text);
        }
        if (deltaType === 'input_json_delta') observeOutput(state, delta?.partial_json);
        return buildAnthropicStreamingEvent(state);
      }

      if (type === 'content_block_stop') {
        return buildAnthropicStreamingEvent(state);
      }

      if (type === 'message_delta') {
        const usage = readRecord(chunk, 'usage');
        const outputTokens = readNumber(usage, 'output_tokens');
        const rawInputTokens = readNumber(usage, 'input_tokens');
        if (rawInputTokens !== undefined) {
          state.cacheWriteTokens = readNumber(usage, 'cache_creation_input_tokens') ?? state.cacheWriteTokens;
          state.cacheReadTokens = readNumber(usage, 'cache_read_input_tokens') ?? state.cacheReadTokens;
          const totalInput = safeTokenSum(rawInputTokens, state.cacheWriteTokens ?? 0, state.cacheReadTokens ?? 0);
          state.estimatedInputTokens = totalInput ?? state.estimatedInputTokens;
          if (totalInput !== undefined) state.estimatedInputAuthority = 'official';
        }
        if (outputTokens !== undefined) {
          state.outputTokens = outputTokens;
          state.outputAuthority = 'official';
          clearObservedOutput(state);
        }
        state.cacheWriteTokens = readNumber(usage, 'cache_creation_input_tokens') ?? state.cacheWriteTokens;
        state.cacheReadTokens = readNumber(usage, 'cache_read_input_tokens') ?? state.cacheReadTokens;

        return buildAnthropicStreamingEvent(state, {
          outputAuthority: state.outputTokens !== undefined ? (state.outputAuthority ?? 'none') : 'none'
        });
      }

      if (type === 'message_stop') {
        if (state.finalReceived) {
          return null;
        }

        state.protocolTerminalSeen = true;
        if (isDeferred(state)) {
          (state as StreamEstimateState).deferredOutcome ??= 'completed';
          return createPartialTokenAccountingEvent(state, {
            inputTokens: state.estimatedInputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
            cacheWriteTokens: state.cacheWriteTokens,
            inputAuthority: state.estimatedInputAuthority ?? 'none',
            outputAuthority: state.outputAuthority ?? 'none'
          });
        }
        state.finalReceived = true;
        finalizeMissingStreamOutput(state);
        estimateMissingInput(state);
        return finalizeTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }

      return null;
    },
    finalizeAbortedStream(state) {
      finalizeMissingStreamOutput(state, true);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputTokens !== undefined ? (state.outputAuthority ?? 'partial') : 'none'
      }, 'aborted');
    },
    finalizeCompletedStream(state) {
      if (state.finalReceived) return buildAnthropicStreamingEvent(state);
      state.finalReceived = true;
      finalizeMissingStreamOutput(state);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputTokens !== undefined ? (state.outputAuthority ?? 'partial') : 'none'
      }, (state as StreamEstimateState).deferredOutcome ?? (state.protocolTerminalSeen ? 'completed' : 'failed'));
    }
  };
}

function createGeminiAdapter(): ProviderTokenAccountingAdapter {
  return {
    provider: 'gemini',
    capabilities: getProviderTokenAccountingCapabilities('gemini'),
    consumeRequest(state, body) {
      storeRequestForEstimate(state, body, ['contents', 'systemInstruction']);
      setSessionModel(state, body.model);
    },
    consumeResponse(state, body) {
      const usageMetadata = readRecord(body, 'usageMetadata');
      const promptTokenCount = readNumber(usageMetadata, 'promptTokenCount');
      const candidatesTokenCount = readNumber(usageMetadata, 'candidatesTokenCount');
      const thoughtsTokenCount = readNumber(usageMetadata, 'thoughtsTokenCount') ?? 0;
      const toolUsePromptTokenCount = readNumber(usageMetadata, 'toolUsePromptTokenCount') ?? 0;
      const cachedContentTokenCount = readNumber(usageMetadata, 'cachedContentTokenCount');
      if (isDeferred(state)) {
        const input = promptTokenCount === undefined ? undefined : safeTokenSum(promptTokenCount, toolUsePromptTokenCount);
        const output = candidatesTokenCount === undefined ? undefined : safeTokenSum(candidatesTokenCount, thoughtsTokenCount);
        if (input !== undefined) {
          state.estimatedInputTokens = input;
          state.estimatedInputAuthority = 'official';
        }
        if (output !== undefined) {
          state.outputTokens = output;
          state.outputAuthority = 'official';
          clearObservedOutput(state);
        }
        if (cachedContentTokenCount !== undefined) state.cacheReadTokens = cachedContentTokenCount;
        const failed = isDeferredFailure(body);
        if (!failed) observeGeminiOutput(state, body);
        state.protocolTerminalSeen = true;
        (state as StreamEstimateState).deferredOutcome = failed ? 'failed' : 'completed';
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: undefined,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (promptTokenCount === undefined) estimateMissingInput(state);
      const estimatedOutput = candidatesTokenCount === undefined && hasGeminiOutput(body) && !isErrorResponse(body) ? estimateGeminiOutputTokens(body) : undefined;

      if (promptTokenCount !== undefined || candidatesTokenCount !== undefined) {
        state.finalReceived = true;
        return finalizeTokenAccountingEvent(state, {
          inputTokens: promptTokenCount === undefined ? state.estimatedInputTokens : safeTokenSum(promptTokenCount, toolUsePromptTokenCount) ?? state.estimatedInputTokens,
          outputTokens: candidatesTokenCount === undefined ? estimatedOutput : safeTokenSum(candidatesTokenCount, thoughtsTokenCount) ?? estimatedOutput,
          cacheReadTokens: cachedContentTokenCount,
          cacheWriteTokens: undefined,
          inputAuthority: promptTokenCount !== undefined && safeTokenSum(promptTokenCount, toolUsePromptTokenCount) !== undefined ? 'official' : (state.estimatedInputAuthority ?? 'heuristic'),
          outputAuthority: candidatesTokenCount !== undefined && safeTokenSum(candidatesTokenCount, thoughtsTokenCount) !== undefined ? 'official' : estimatedOutput === undefined ? 'none' : 'local'
        });
      }

      const outputTokens = estimatedOutput;
      state.finalReceived = true;
      state.outputTokens = outputTokens;
      state.outputAuthority = outputTokens === undefined ? 'none' : 'local';
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority
      });
    },
    consumeStreamChunk(state, chunk) {
      if (state.finalReceived || isDoneSentinel(chunk)) return null;
      observeGeminiOutput(state, chunk);
      const usageMetadata = readRecord(chunk, 'usageMetadata');
      const promptTokenCount = readNumber(usageMetadata, 'promptTokenCount');
      const candidatesTokenCount = readNumber(usageMetadata, 'candidatesTokenCount');
      const thoughtsTokenCount = readNumber(usageMetadata, 'thoughtsTokenCount') ?? 0;
      const toolUsePromptTokenCount = readNumber(usageMetadata, 'toolUsePromptTokenCount') ?? 0;
      const reportedCacheRead = readNumber(usageMetadata, 'cachedContentTokenCount');
      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      if (candidates.some((candidate) => isRecord(candidate) && asString(candidate.finishReason) !== undefined)) {
        state.protocolTerminalSeen = true;
        if (isDeferred(state)) (state as StreamEstimateState).deferredOutcome ??= 'completed';
      }
      if (isDeferred(state) && isDeferredFailure(chunk)) {
        state.protocolTerminalSeen = true;
        (state as StreamEstimateState).deferredOutcome = 'failed';
      }
      if (isDeferred(state) && reportedCacheRead !== undefined && promptTokenCount === undefined && candidatesTokenCount === undefined) {
        state.cacheReadTokens = reportedCacheRead;
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: undefined,
          inputAuthority: state.estimatedInputAuthority ?? 'none',
          outputAuthority: state.outputAuthority ?? 'none'
        });
      }
      if (promptTokenCount !== undefined || candidatesTokenCount !== undefined) {
        const input = promptTokenCount === undefined ? undefined : safeTokenSum(promptTokenCount, toolUsePromptTokenCount);
        const output = candidatesTokenCount === undefined ? undefined : safeTokenSum(candidatesTokenCount, thoughtsTokenCount);
        state.estimatedInputTokens = input ?? state.estimatedInputTokens;
        if (input !== undefined) state.estimatedInputAuthority = 'official';
        state.outputTokens = output ?? state.outputTokens;
        if (output !== undefined) {
          state.outputAuthority = 'official';
          clearObservedOutput(state);
        }
        const cacheRead = readNumber(usageMetadata, 'cachedContentTokenCount');
        if (cacheRead !== undefined) state.cacheReadTokens = cacheRead;
        return createPartialTokenAccountingEvent(state, {
          inputTokens: state.estimatedInputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: undefined,
          inputAuthority: state.estimatedInputAuthority ?? 'heuristic',
          outputAuthority: state.outputAuthority ?? 'partial'
        });
      }

      return createPartialTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'heuristic',
        outputAuthority: state.outputAuthority ?? (state.outputTokens !== undefined ? 'partial' : 'none')
      });
    },
    finalizeAbortedStream(state) {
      finalizeMissingStreamOutput(state, true);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority ?? (state.outputTokens !== undefined ? 'partial' : 'none')
      }, 'aborted');
    },
    finalizeCompletedStream(state) {
      if (state.finalReceived) return createPartialTokenAccountingEvent(state);
      state.finalReceived = true;
      finalizeMissingStreamOutput(state);
      estimateMissingInput(state);
      return finalizeTokenAccountingEvent(state, {
        inputTokens: state.estimatedInputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputAuthority: state.estimatedInputAuthority ?? 'none',
        outputAuthority: state.outputAuthority ?? (state.outputTokens !== undefined ? 'partial' : 'none')
      }, (state as StreamEstimateState).deferredOutcome ?? (state.protocolTerminalSeen ? 'completed' : 'failed'));
    }
  };
}

const PROVIDER_ADAPTERS = {
  openai: createOpenAIAdapter(),
  anthropic: createAnthropicAdapter(),
  gemini: createGeminiAdapter()
} as const satisfies Record<string, ProviderTokenAccountingAdapter>;

function normalizeProvider(provider: LLMProvider): keyof typeof PROVIDER_ADAPTERS {
  return String(provider).trim().toLowerCase() as keyof typeof PROVIDER_ADAPTERS;
}

function getProviderAdapter(provider: LLMProvider): ProviderTokenAccountingAdapter {
  const adapter = PROVIDER_ADAPTERS[normalizeProvider(provider)];
  if (!adapter) {
    throw new Error(`Unsupported token accounting provider: ${provider}`);
  }

  return adapter;
}

export function createTokenAccountingSession(
  input: TokenAccountingSessionInput,
  options: { deferFinalization?: boolean } = {}
): TokenAccountingSession {
  const adapter = getProviderAdapter(input.provider);
  let terminalEvent: CanonicalTokenAccountingEventV2 | undefined;
  const state: TokenAccountingSessionState & StreamEstimateState = {
    provider: adapter.provider,
    routeId: input.routeId,
    upstreamId: input.upstreamId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    streaming: input.streaming,
    model: input.model,
    finalReceived: false,
    deferFinalization: options.deferFinalization === true
  };

  return {
    consumeRequest({ body }) {
      adapter.consumeRequest(state, body);
    },
    consumeResponse({ body }): CanonicalTokenAccountingEventV2 {
      const event = adapter.consumeResponse(state, body);
      if (event.final || event.outcome !== 'completed') terminalEvent = event;
      return event;
    },
    consumeStreamChunk({ chunk }): CanonicalTokenAccountingEventV2 | null {
      const event = adapter.consumeStreamChunk(state, chunk);
      if (event && (event.final || event.outcome !== 'completed')) terminalEvent = event;
      return event;
    },
    finalizeCompletedStream(): CanonicalTokenAccountingEventV2 {
      if (terminalEvent) return terminalEvent;
      const event = adapter.finalizeCompletedStream(state);
      terminalEvent = event;
      return event;
    },
    finalizeAbortedStream(): CanonicalTokenAccountingEventV2 {
      if (terminalEvent) return terminalEvent;
      const event = adapter.finalizeAbortedStream(state);
      terminalEvent = event;
      return event;
    }
  };
}
