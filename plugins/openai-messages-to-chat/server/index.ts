import { protocolSSEOutput } from '@jeffusion/bungee-core/plugin';
import type { Plugin } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type {
  PluginHooks
} from '@jeffusion/bungee-core/plugin';
import {
  AnthropicToOpenAIConverter,
  type JsonRecord,
  type OpenAIMessagesCompatibilityBodyValidationResult,
  OpenAIMessagesCompatibilityNormalizer,
  OpenAIProtocolConversion,
  encodeResponsesResult,
  ResponsesEventEncoder
} from '@jeffusion/bungee-llms/plugin-api';

interface OpenAIMessagesToChatOptions {
  strictValidation?: boolean;
  allowShortPathAlias?: boolean;
  trimWhitespace?: boolean;
}

const RESPONSE_STATE_REFERENCE_FIELDS = [
  'previous_response_id',
  'conversation',
  'response_id'
] as const;

interface ResponsesStateReference {
  hasStateFields: boolean;
  previousResponseId?: string;
  responseId?: string;
  conversationId?: string;
}

const MAX_RESPONSES_STATE_ENTRIES = 500;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const OpenAIMessagesToChatPlugin = definePlugin(
class implements Plugin {
    static readonly name = 'openai-messages-to-chat';
    static readonly version = '1.0.0';

    private readonly validationErrors = new Map<string, string>();
    private readonly adaptedRequestIds = new Set<string>();
    private readonly responsesAdaptedRequestIds = new Set<string>();
    private readonly streamConversionRequestIds = new Set<string>();
    private readonly responsesRequestModels = new Map<string, string>();
    private readonly responsesRequestMessages = new Map<string, JsonRecord[]>();
    private readonly responsesRequestConversationIds = new Map<string, string>();
    private readonly responsesHistoryByResponseId = new Map<string, JsonRecord[]>();
    private readonly responsesConversationToResponseId = new Map<string, string>();
    private readonly responsesStateOrder: string[] = [];
    private readonly responseConverter = new AnthropicToOpenAIConverter();
    private readonly protocolConversion: OpenAIProtocolConversion;
    private readonly messagesCompatibilityNormalizer: OpenAIMessagesCompatibilityNormalizer;
    private readonly allowShortPathAlias: boolean;
    private readonly trimWhitespace: boolean;
    private readonly strictValidation: boolean;

    constructor(options?: OpenAIMessagesToChatOptions) {
      this.strictValidation = options?.strictValidation !== false;
      this.allowShortPathAlias = options?.allowShortPathAlias !== false;
      this.trimWhitespace = options?.trimWhitespace !== false;
      this.protocolConversion = new OpenAIProtocolConversion({
        trimWhitespace: options?.trimWhitespace
      });
      this.messagesCompatibilityNormalizer = new OpenAIMessagesCompatibilityNormalizer(options);
    }

    bodyRequirements(context: import('@jeffusion/bungee-core/plugin').PluginBodyRequirementContext): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements {
      const matched = this.messagesCompatibilityNormalizer.shouldHandleRequest(context) || this.shouldHandleResponsesRequest(context);
      return matched ? { request: 'json-write', response: ['json', 'sse-json'] } : { request: 'none' };
    }

  register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'openai-messages-to-chat', stage: -10 },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.responsesAdaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.responsesRequestModels.delete(ctx.requestId);
          this.responsesRequestMessages.delete(ctx.requestId);
          this.responsesRequestConversationIds.delete(ctx.requestId);
          this.validationErrors.delete(ctx.requestId);

          if (this.messagesCompatibilityNormalizer.shouldHandleRequest(ctx)) {
            const prepared = this.preNormalizeToolCallsForValidation(ctx.body);
            if (prepared.error) {
              this.validationErrors.set(ctx.requestId, prepared.error);
              return ctx;
            }

            const validation = this.messagesCompatibilityNormalizer.validateAndNormalizeBody(prepared.body);
            if (!validation.ok) {
              this.validationErrors.set(ctx.requestId, validation.message);
              return ctx;
            }

            ctx.url.pathname = '/v1/chat/completions';
            ctx.body = this.normalizeAssistantToolCallReasoningContent(validation.body);
            this.adaptedRequestIds.add(ctx.requestId);
            return ctx;
          }

          if (this.shouldHandleResponsesRequest(ctx)) {
            const stateReference = isRecord(ctx.body)
              ? this.extractResponsesStateReference(ctx.body)
              : { hasStateFields: false };
            const validation = this.validateAndNormalizeResponsesBody(ctx.body);
            if (!validation.ok) {
              this.validationErrors.set(ctx.requestId, validation.message);
              return ctx;
            }

            ctx.url.pathname = '/v1/chat/completions';
            ctx.body = this.normalizeAssistantToolCallReasoningContent(validation.body);
            this.responsesAdaptedRequestIds.add(ctx.requestId);
            this.responsesRequestModels.set(ctx.requestId, String(validation.body.model));
            this.responsesRequestMessages.set(
              ctx.requestId,
              this.extractMessagesFromDowngradedBody(validation.body)
            );
            if (stateReference.conversationId) {
              this.responsesRequestConversationIds.set(ctx.requestId, stateReference.conversationId);
            }
          }

          const unsupportedResponsesPathError = this.getUnsupportedResponsesPathError(ctx);
          if (unsupportedResponsesPathError) {
            this.validationErrors.set(ctx.requestId, unsupportedResponsesPathError);
            return ctx;
          }

          return ctx;
        }
      );

      hooks.onInterceptRequest.tap(
        { name: 'openai-messages-to-chat', stage: -10 },
        (ctx) => {
          const error = this.validationErrors.get(ctx.requestId);
          if (!error) {
            return undefined;
          }

          this.validationErrors.delete(ctx.requestId);
          return {
            action: 'respond',
            response: this.messagesCompatibilityNormalizer.buildBadRequest(error),
          };
        }
      );

      hooks.onResponse.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (response, ctx) => {
          if (this.responsesAdaptedRequestIds.has(ctx.requestId)) {
            const parsedBody = await this.tryParseJsonBody(response, ctx.bodyHandle!);
            if (!isRecord(parsedBody)) {
              return response;
            }

            const converted = this.convertChatCompletionToResponsesPayload(parsedBody, this.responsesRequestModels.get(ctx.requestId) ?? '');
            if (converted.status !== 'failed') {
              const conversationId = this.responsesRequestConversationIds.get(ctx.requestId);
              const baseMessages = this.responsesRequestMessages.get(ctx.requestId) ?? [];
              const assistantMessage = this.extractAssistantMessageFromChatCompletionPayload(parsedBody);
              const history = assistantMessage ? [...baseMessages, assistantMessage] : baseMessages;
              this.storeResponsesState(String(converted.id), history, conversationId);
            }

            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(JSON.stringify(converted), {
              status: response.status,
              statusText: response.statusText,
              headers
            });
          }

          if (!this.adaptedRequestIds.has(ctx.requestId)) {
            return response;
          }

          const parsedBody = await this.tryParseJsonBody(response, ctx.bodyHandle!);
          if (!parsedBody || !this.messagesCompatibilityNormalizer.isOpenAIResponsePayload(parsedBody)) {
            return response;
          }

          const responseContext = {
            ...ctx,
            response,
            bodyHandle: ctx.bodyHandle!
          };
          const converted = await this.responseConverter.onResponse?.(responseContext);
          return converted ?? response;
        }
      );

      hooks.onStreamChunk.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (envelope, ctx) => {
          const chunk = structuredClone(envelope.json);
          const converterContext = { ...ctx, sseEvent: envelope };
          if (this.responsesAdaptedRequestIds.has(ctx.requestId)) {
            if (envelope.data === '[DONE]') return [];
            const encoder = this.getResponsesEncoder(ctx, isRecord(chunk) ? chunk.model : undefined);
            // Legacy clients expect an assistant item even when the response only calls tools.
            // This normalization delegates all output indexing and terminal semantics to the codec.
            let normalized = chunk;
            if (!ctx.streamState.has('responses_legacy_message') && isRecord(chunk)
              && Array.isArray(chunk.choices) && chunk.choices.length === 1 && isRecord(chunk.choices[0])) {
              const choice = chunk.choices[0];
              const delta = isRecord(choice.delta) ? choice.delta : {};
              normalized = { ...chunk, choices: [{ ...choice, delta: { ...delta, content: delta.content ?? '' } }] };
              ctx.streamState.set('responses_legacy_message', true);
            }
            return protocolSSEOutput(encoder.push(normalized), 'responses', envelope);
          }

          if (chunk === undefined || !this.adaptedRequestIds.has(ctx.requestId)) {
            return null;
          }

          if (!this.messagesCompatibilityNormalizer.isOpenAIStreamChunk(chunk)) {
            return null;
          }

          this.streamConversionRequestIds.add(ctx.requestId);
          const converted = await this.responseConverter.processStreamChunk?.(chunk, converterContext);
          if (!Array.isArray(converted)) {
            return converted ?? null;
          }

          return protocolSSEOutput(this.protocolConversion.ensureMessagesStreamCompatibility(converted, ctx), 'anthropic', envelope);
        }
      );

      hooks.onFlushStream.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (chunks, ctx) => {
          if (this.responsesAdaptedRequestIds.has(ctx.requestId)) {
            const completionEvents = this.getResponsesEncoder(ctx).finish();
            for (const event of completionEvents) {
              if (isRecord(event.response) && event.response.status !== 'failed') {
                this.persistResponsesStateFromResult(ctx.requestId, event.response);
              }
            }
            return [...chunks, ...protocolSSEOutput(completionEvents, 'responses')];
          }

          if (!this.streamConversionRequestIds.has(ctx.requestId)) {
            return chunks;
          }

          const flushed = await this.responseConverter.flushStream?.(ctx);
          this.streamConversionRequestIds.delete(ctx.requestId);
          const converted = this.protocolConversion.ensureMessagesStreamCompatibility(flushed ?? [], ctx);
          return [...chunks, ...protocolSSEOutput(converted, 'anthropic')];
        }
      );

      hooks.onFinally.tap(
        { name: 'openai-messages-to-chat' },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.responsesAdaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.responsesRequestModels.delete(ctx.requestId);
          this.responsesRequestMessages.delete(ctx.requestId);
          this.responsesRequestConversationIds.delete(ctx.requestId);
          this.validationErrors.delete(ctx.requestId);
        }
      );
    }

    async reset(): Promise<void> {
      this.adaptedRequestIds.clear();
      this.responsesAdaptedRequestIds.clear();
      this.streamConversionRequestIds.clear();
      this.responsesRequestModels.clear();
      this.responsesRequestMessages.clear();
      this.responsesRequestConversationIds.clear();
      this.responsesHistoryByResponseId.clear();
      this.responsesConversationToResponseId.clear();
      this.responsesStateOrder.length = 0;
      this.validationErrors.clear();
    }

    private shouldHandleResponsesRequest(ctx: { method: string; url: { pathname: string } }): boolean {
      if (ctx.method.toUpperCase() !== 'POST') {
        return false;
      }

      const normalizedPath = this.normalizePathname(ctx.url.pathname);
      return this.isResponsesRootPath(normalizedPath);
    }

    private getUnsupportedResponsesPathError(
      ctx: { method: string; url: { pathname: string } }
    ): string | undefined {
      const normalizedPath = this.normalizePathname(ctx.url.pathname);
      const method = ctx.method.toUpperCase();

      if (this.isResponsesRootPath(normalizedPath) && method !== 'POST') {
        return `responses compatibility route only supports POST on "${normalizedPath}".`;
      }

      if (this.isResponsesResourcePath(normalizedPath)) {
        return `responses resource endpoint "${normalizedPath}" is not supported by chat-completions downgrade adapter.`;
      }

      return undefined;
    }

    private isResponsesRootPath(normalizedPath: string): boolean {
      if (normalizedPath === '/v1/responses') {
        return true;
      }

      return this.allowShortPathAlias && normalizedPath === '/responses';
    }

    private isResponsesResourcePath(normalizedPath: string): boolean {
      if (/^\/v1\/responses\/.+/.test(normalizedPath)) {
        return true;
      }

      return this.allowShortPathAlias && /^\/responses\/.+/.test(normalizedPath);
    }

    private normalizePathname(pathname: string): string {
      if (pathname.length > 1 && pathname.endsWith('/')) {
        return pathname.slice(0, -1);
      }

      return pathname;
    }

    // Compatibility boundary: keep legacy input/messages fallbacks, thinking normalization,
    // and local reference resolution. Codex uses the stricter shared request decoder instead.
    private validateAndNormalizeResponsesBody(rawBody: unknown): OpenAIMessagesCompatibilityBodyValidationResult {
      if (!isRecord(rawBody)) {
        return {
          ok: false,
          message: 'responses compatibility route requires a JSON object body.'
        };
      }

      const model = typeof rawBody.model === 'string' ? rawBody.model.trim() : '';
      if (!model) {
        return {
          ok: false,
          message: 'responses compatibility route requires a non-empty "model" field.'
        };
      }

      const stateReference = this.extractResponsesStateReference(rawBody);
      const referencedMessages = this.resolveResponsesReferencedMessages(stateReference);

      let normalizedResponsesBody = rawBody;
      if (this.protocolConversion.isReasoningContext(rawBody)) {
        normalizedResponsesBody = this.protocolConversion.normalizeResponsesReasoningBody(rawBody);
      }

      let messages = this.convertResponsesInputToChatMessages(normalizedResponsesBody.input);
      if (messages.length === 0 && Array.isArray(normalizedResponsesBody.messages)) {
        messages = normalizedResponsesBody.messages as JsonRecord[];
      }

      const instructions = typeof normalizedResponsesBody.instructions === 'string'
        ? normalizedResponsesBody.instructions.trim()
        : '';
      if (instructions) {
        messages = [{ role: 'system', content: instructions }, ...messages];
      }

      const mergedMessages = referencedMessages.length > 0
        ? [...referencedMessages, ...messages]
        : messages;

      if (mergedMessages.length === 0) {
        if (stateReference.hasStateFields) {
          return {
            ok: false,
            message: `responses compatibility route requires non-empty "input" or "messages" data. Stateful references (${RESPONSE_STATE_REFERENCE_FIELDS.join(', ')}) can only be used when this gateway can resolve them from local compatibility cache.`
          };
        }

        return {
          ok: false,
          message: 'responses compatibility route requires non-empty "input" or "messages" data.'
        };
      }

      const downgradedBody: JsonRecord = {
        ...normalizedResponsesBody,
        model,
        messages: mergedMessages
      };

      if (typeof normalizedResponsesBody.max_output_tokens === 'number' && downgradedBody.max_tokens === undefined) {
        downgradedBody.max_tokens = normalizedResponsesBody.max_output_tokens;
      }

      if (isRecord(normalizedResponsesBody.text)
        && isRecord(normalizedResponsesBody.text.format)
        && downgradedBody.response_format === undefined) {
        downgradedBody.response_format = normalizedResponsesBody.text.format;
      }

      for (const field of [
        'input',
        'instructions',
        'max_output_tokens',
        'previous_response_id',
        'conversation',
        'response_id',
        'reasoning',
        'reasoning_effort',
        'enable_thinking',
        'thinking',
        'text',
        'n'
      ] as const) {
        delete downgradedBody[field];
      }

      const prepared = this.preNormalizeToolCallsForValidation(downgradedBody);
      if (prepared.error) {
        return {
          ok: false,
          message: prepared.error
        };
      }

      return this.messagesCompatibilityNormalizer.validateAndNormalizeBody(prepared.body);
    }

    private extractResponsesStateReference(rawBody: JsonRecord): ResponsesStateReference {
      const previousResponseId = this.normalizeNonEmptyString(rawBody.previous_response_id);
      const responseId = this.normalizeNonEmptyString(rawBody.response_id);
      const conversationId = this.extractConversationId(rawBody.conversation);

      return {
        hasStateFields: RESPONSE_STATE_REFERENCE_FIELDS.some((field) => rawBody[field] !== undefined),
        previousResponseId,
        responseId,
        conversationId
      };
    }

    private normalizeNonEmptyString(value: unknown): string | undefined {
      if (typeof value !== 'string') {
        return undefined;
      }

      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    private extractConversationId(value: unknown): string | undefined {
      const direct = this.normalizeNonEmptyString(value);
      if (direct) {
        return direct;
      }

      if (!isRecord(value)) {
        return undefined;
      }

      return this.normalizeNonEmptyString(value.id);
    }

    private resolveResponsesReferencedMessages(reference: ResponsesStateReference): JsonRecord[] {
      const candidateResponseIds: string[] = [];
      const pushUnique = (value: string | undefined): void => {
        if (!value || candidateResponseIds.includes(value)) {
          return;
        }

        candidateResponseIds.push(value);
      };

      if (reference.conversationId) {
        pushUnique(this.responsesConversationToResponseId.get(reference.conversationId));
      }

      pushUnique(reference.previousResponseId);
      pushUnique(reference.responseId);

      for (const responseId of candidateResponseIds) {
        const history = this.responsesHistoryByResponseId.get(responseId);
        if (!history || history.length === 0) {
          continue;
        }

        return this.cloneJsonRecords(history);
      }

      return [];
    }

    private extractMessagesFromDowngradedBody(body: JsonRecord): JsonRecord[] {
      if (!Array.isArray(body.messages)) {
        return [];
      }

      return body.messages
        .filter((message): message is JsonRecord => isRecord(message))
        .map((message) => this.cloneJsonRecord(message));
    }

    private cloneJsonRecord(record: JsonRecord): JsonRecord {
      return JSON.parse(JSON.stringify(record)) as JsonRecord;
    }

    private cloneJsonRecords(records: JsonRecord[]): JsonRecord[] {
      return records.map((record) => this.cloneJsonRecord(record));
    }

    private extractAssistantMessageFromChatCompletionPayload(payload: JsonRecord): JsonRecord | null {
      if (!Array.isArray(payload.choices)) {
        return null;
      }

      for (const choice of payload.choices) {
        if (!isRecord(choice) || !isRecord(choice.message)) {
          continue;
        }

        const message: JsonRecord = {
          ...choice.message,
          role: typeof choice.message.role === 'string' ? choice.message.role : 'assistant'
        };

        const normalizedToolCalls = this.normalizeToolCalls(message.tool_calls);
        if (normalizedToolCalls !== undefined) {
          message.tool_calls = normalizedToolCalls;
        }

        return this.cloneJsonRecord(message);
      }

      return null;
    }

    private persistResponsesStateFromResult(requestId: string, response: JsonRecord): void {
      if (response.status === 'failed' || !Array.isArray(response.output)) return;
      const assistant: JsonRecord = { role: 'assistant', content: null };
      const text: string[] = [];
      const reasoning: string[] = [];
      const tools: JsonRecord[] = [];
      for (const item of response.output) {
        if (!isRecord(item)) continue;
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
            if (isRecord(part) && part.type === 'refusal' && typeof part.refusal === 'string') assistant.refusal = part.refusal;
          }
        } else if (item.type === 'function_call') {
          tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
        } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
          for (const part of item.summary) if (isRecord(part) && typeof part.text === 'string') reasoning.push(part.text);
        }
      }
      if (text.length) assistant.content = text.join('');
      if (tools.length) assistant.tool_calls = tools;
      if (reasoning.length) assistant.reasoning_content = reasoning.join('');
      const base = this.responsesRequestMessages.get(requestId) ?? [];
      const history = text.length || tools.length || reasoning.length || assistant.refusal ? [...base, assistant] : base;
      this.storeResponsesState(String(response.id), history, this.responsesRequestConversationIds.get(requestId));
    }

    private storeResponsesState(responseId: string, history: JsonRecord[], conversationId?: string): void {
      const normalizedResponseId = this.normalizeNonEmptyString(responseId);
      if (!normalizedResponseId) {
        return;
      }

      this.responsesHistoryByResponseId.set(normalizedResponseId, this.cloneJsonRecords(history));
      this.touchResponsesStateOrder(normalizedResponseId);

      if (conversationId) {
        this.responsesConversationToResponseId.set(conversationId, normalizedResponseId);
      }

      this.trimResponsesStateCache();
    }

    private touchResponsesStateOrder(responseId: string): void {
      const existingIndex = this.responsesStateOrder.indexOf(responseId);
      if (existingIndex >= 0) {
        this.responsesStateOrder.splice(existingIndex, 1);
      }

      this.responsesStateOrder.push(responseId);
    }

    private trimResponsesStateCache(): void {
      while (this.responsesStateOrder.length > MAX_RESPONSES_STATE_ENTRIES) {
        const evictedResponseId = this.responsesStateOrder.shift();
        if (!evictedResponseId) {
          break;
        }

        this.responsesHistoryByResponseId.delete(evictedResponseId);

        for (const [conversationId, mappedResponseId] of this.responsesConversationToResponseId.entries()) {
          if (mappedResponseId === evictedResponseId) {
            this.responsesConversationToResponseId.delete(conversationId);
          }
        }
      }
    }

    private convertResponsesInputToChatMessages(input: unknown): JsonRecord[] {
      if (!Array.isArray(input)) {
        return this.protocolConversion.convertResponsesInputToMessages(input);
      }

      const messages: JsonRecord[] = [];
      for (const item of input) {
        if (isRecord(item) && typeof item.role === 'string') {
          const message: JsonRecord = { ...item };
          delete message.type;
          delete message.message;
          messages.push(message);
          continue;
        }

        if (isRecord(item)
          && item.type === 'message'
          && isRecord(item.message)
          && typeof item.message.role === 'string') {
          messages.push(item.message);
          continue;
        }

        const fallbackMessages = this.protocolConversion.convertResponsesInputToMessages([item]);
        if (fallbackMessages.length > 0) {
          messages.push(...fallbackMessages);
        }
      }

      return messages;
    }

    private async tryParseJsonBody(response: Response, bodyHandle: { json(): Promise<unknown> }): Promise<unknown | null> {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return null;
      }

      try {
        return await bodyHandle.json();
      } catch {
        return null;
      }
    }

    private preNormalizeToolCallsForValidation(rawBody: unknown): { body: unknown; error?: string } {
      if (!isRecord(rawBody)) {
        return { body: rawBody };
      }

      if (!Array.isArray(rawBody.messages)) {
        return { body: rawBody };
      }

      let changed = false;
      const normalizedMessages: unknown[] = [];

      for (let index = 0; index < rawBody.messages.length; index += 1) {
        const normalized = this.preNormalizeToolCallsInMessage(rawBody.messages[index], index);
        if (normalized.error) {
          return {
            body: rawBody,
            error: normalized.error
          };
        }

        if (normalized.changed) {
          changed = true;
        }

        normalizedMessages.push(normalized.message);
      }

      if (!changed) {
        return { body: rawBody };
      }

      return {
        body: {
          ...rawBody,
          messages: normalizedMessages
        }
      };
    }

    private preNormalizeToolCallsInMessage(
      rawMessage: unknown,
      messageIndex: number
    ): { message: unknown; changed: boolean; error?: string } {
      if (!isRecord(rawMessage) || rawMessage.role !== 'assistant') {
        return { message: rawMessage, changed: false };
      }

      const normalizedToolCalls = this.normalizeToolCalls(rawMessage.tool_calls);
      if (normalizedToolCalls !== undefined) {
        if (rawMessage.tool_calls === normalizedToolCalls) {
          return { message: rawMessage, changed: false };
        }

        return {
          message: {
            ...rawMessage,
            tool_calls: normalizedToolCalls
          },
          changed: true
        };
      }

      if (
        this.strictValidation
        && typeof rawMessage.tool_calls === 'string'
        && rawMessage.tool_calls.trim().length > 0
      ) {
        return {
          message: rawMessage,
          changed: false,
          error: `messages[${messageIndex + 1}].tool_calls string is not valid JSON array/object.`
        };
      }

      return { message: rawMessage, changed: false };
    }

    private convertChatCompletionToResponsesPayload(payload: JsonRecord, requestModel: string): JsonRecord {
      if (payload.object === 'response') return payload;
      const model = typeof payload.model === 'string' ? payload.model : requestModel;
      if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
        return encodeResponsesResult(payload, 'chat_completions', model);
      }
      // Preserve the old JSON multi-choice envelope through per-candidate shared encoding.
      // Each candidate is independently validated; no output or terminal state machine lives here.
      const candidates = payload.choices.map((rawChoice) => {
        if (!isRecord(rawChoice) || !isRecord(rawChoice.message)) {
          return encodeResponsesResult({ ...payload, choices: [rawChoice] }, 'chat_completions', model);
        }
        const message: JsonRecord = { ...rawChoice.message, content: rawChoice.message.content ?? '' };
        const toolCalls = this.normalizeToolCalls(message.tool_calls);
        if (toolCalls !== undefined) message.tool_calls = toolCalls;
        return encodeResponsesResult({ ...payload, choices: [{ ...rawChoice, index: 0, message }] }, 'chat_completions', model);
      });
      const priority = (status: unknown): number => status === 'failed' ? 3 : status === 'incomplete' ? 2 : 1;
      const terminal = candidates.reduce((selected, candidate) => priority(candidate.status) > priority(selected.status) ? candidate : selected);
      const converted: JsonRecord = { ...terminal, id: candidates[0].id, output: candidates.flatMap((candidate) => candidate.output as JsonRecord[]) };
      const finishReasons = payload.choices.filter(isRecord).map((choice) => choice.finish_reason);
      converted.metadata = { finish_reason: finishReasons[0], finish_reasons: finishReasons };
      if (converted.status === 'failed' && isRecord(converted.error)) {
        converted.error = { ...converted.error, code: 'completion_terminated' };
      }
      return converted;
    }

    private getResponsesEncoder(
      ctx: { requestId: string; streamState: Map<string, unknown> },
      upstreamModel?: unknown
    ): ResponsesEventEncoder {
      const existing = ctx.streamState.get('responses_shared_encoder') as ResponsesEventEncoder | undefined;
      if (existing) return existing;
      const model = typeof upstreamModel === 'string' ? upstreamModel : this.responsesRequestModels.get(ctx.requestId) ?? '';
      const encoder = new ResponsesEventEncoder('chat_completions', model);
      ctx.streamState.set('responses_shared_encoder', encoder);
      return encoder;
    }

    private normalizeAssistantToolCallReasoningContent(body: JsonRecord): JsonRecord {
      const rawMessages = body.messages;
      if (!Array.isArray(rawMessages)) {
        return body;
      }

      const normalizedMessages = rawMessages.map((message) => {
        if (!isRecord(message) || message.role !== 'assistant') {
          return message;
        }

        const normalizedToolCalls = this.normalizeToolCalls(message.tool_calls);
        const hasToolCalls = normalizedToolCalls !== undefined
          ? normalizedToolCalls.length > 0
          : this.hasToolCalls(message.tool_calls);

        if (!hasToolCalls) {
          return message;
        }

        const normalizedMessage: JsonRecord = { ...message };
        if (normalizedToolCalls !== undefined) {
          normalizedMessage.tool_calls = normalizedToolCalls;
        }

        const reasoningContent = normalizedMessage.reasoning_content;
        if (typeof reasoningContent === 'string') {
          normalizedMessage.reasoning_content = this.trimWhitespace ? reasoningContent.trim() : reasoningContent;
          return normalizedMessage;
        }

        normalizedMessage.reasoning_content = '';
        return normalizedMessage;
      });

      return {
        ...body,
        messages: normalizedMessages
      };
    }

    private hasToolCalls(value: unknown): boolean {
      if (Array.isArray(value)) {
        return value.length > 0;
      }

      if (isRecord(value)) {
        return Object.keys(value).length > 0;
      }

      if (typeof value !== 'string') {
        return false;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return false;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.length > 0;
        }

        return isRecord(parsed);
      } catch {
        return true;
      }
    }

    private normalizeToolCalls(rawToolCalls: unknown): JsonRecord[] | undefined {
      if (rawToolCalls === undefined || rawToolCalls === null) {
        return undefined;
      }

      if (Array.isArray(rawToolCalls)) {
        const normalized = rawToolCalls
          .map((toolCall) => this.normalizeSingleToolCall(toolCall))
          .filter((toolCall): toolCall is JsonRecord => toolCall !== undefined);
        return normalized;
      }

      if (isRecord(rawToolCalls)) {
        return [rawToolCalls];
      }

      if (typeof rawToolCalls === 'string') {
        const trimmed = rawToolCalls.trim();
        if (!trimmed) {
          return [];
        }

        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) {
            const normalized = parsed
              .map((toolCall) => this.normalizeSingleToolCall(toolCall))
              .filter((toolCall): toolCall is JsonRecord => toolCall !== undefined);
            return normalized;
          }

          if (isRecord(parsed)) {
            return [parsed];
          }

          return undefined;
        } catch {
          return undefined;
        }
      }

      return undefined;
    }

    private normalizeSingleToolCall(rawToolCall: unknown): JsonRecord | undefined {
      if (isRecord(rawToolCall)) {
        return rawToolCall;
      }

      if (typeof rawToolCall !== 'string') {
        return undefined;
      }

      const trimmed = rawToolCall.trim();
      if (!trimmed) {
        return undefined;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
);

export default OpenAIMessagesToChatPlugin;
