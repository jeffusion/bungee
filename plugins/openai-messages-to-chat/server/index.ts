import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type {
  PluginHooks,
  ResponseContext
} from '../../../packages/core/src/hooks';
import {
  AnthropicToOpenAIConverter,
  type JsonRecord,
  type OpenAIMessagesCompatibilityBodyValidationResult,
  OpenAIMessagesCompatibilityNormalizer,
  OpenAIProtocolConversion
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

type ResponsesTerminalEventType = 'response.completed' | 'response.incomplete' | 'response.failed';

interface ResponsesStreamToolCallState {
  id: string;
  name: string;
  arguments: string;
}

interface ResponsesStreamState {
  responseId: string;
  messageId: string;
  createdAt: number;
  model: string;
  messageText: string;
  finishReason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  hasTextContentPart: boolean;
  toolCalls: ResponsesStreamToolCallState[];
  toolCallIndexToId: Map<number, string>;
  terminalEventType: ResponsesTerminalEventType | null;
  terminalReason: string;
}

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
    private readonly responsesStreamConversionRequestIds = new Set<string>();
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

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'openai-messages-to-chat', stage: -10 },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.responsesAdaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.responsesStreamConversionRequestIds.delete(ctx.requestId);
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
          return this.messagesCompatibilityNormalizer.buildBadRequest(error);
        }
      );

      hooks.onResponse.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (response, ctx) => {
          if (this.responsesAdaptedRequestIds.has(ctx.requestId)) {
            const parsedBody = await this.tryParseJsonBody(response);
            if (!isRecord(parsedBody)) {
              return response;
            }

            const converted = this.convertChatCompletionToResponsesPayload(parsedBody);
            if (!converted) {
              return response;
            }

            const responseId = typeof converted.id === 'string'
              ? converted.id
              : this.toResponsesId(parsedBody.id);
            const conversationId = this.responsesRequestConversationIds.get(ctx.requestId);
            const baseMessages = this.responsesRequestMessages.get(ctx.requestId) ?? [];
            const assistantMessage = this.extractAssistantMessageFromChatCompletionPayload(parsedBody);
            const history = assistantMessage
              ? [...baseMessages, assistantMessage]
              : baseMessages;
            this.storeResponsesState(responseId, history, conversationId);

            return new Response(JSON.stringify(converted), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }

          if (!this.adaptedRequestIds.has(ctx.requestId)) {
            return response;
          }

          const parsedBody = await this.tryParseJsonBody(response);
          if (!parsedBody || !this.messagesCompatibilityNormalizer.isOpenAIResponsePayload(parsedBody)) {
            return response;
          }

          const responseContext: ResponseContext = {
            ...ctx,
            response
          };
          const converted = await this.responseConverter.onResponse?.(responseContext);
          const finalized = converted ?? response;
          return this.protocolConversion.ensureAssistantToolUseReasoningContent(finalized);
        }
      );

      hooks.onStreamChunk.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (chunk, ctx) => {
          if (this.responsesAdaptedRequestIds.has(ctx.requestId)) {
            if (!this.messagesCompatibilityNormalizer.isOpenAIStreamChunk(chunk)) {
              return null;
            }

            const converted = this.convertChatCompletionChunkToResponsesEvents(chunk, ctx);
            if (converted.length > 0) {
              this.responsesStreamConversionRequestIds.add(ctx.requestId);
            }
            return converted;
          }

          if (!this.adaptedRequestIds.has(ctx.requestId)) {
            return null;
          }

          if (!this.messagesCompatibilityNormalizer.isOpenAIStreamChunk(chunk)) {
            return null;
          }

          this.streamConversionRequestIds.add(ctx.requestId);
          const converted = await this.responseConverter.processStreamChunk?.(chunk, ctx);
          if (!Array.isArray(converted)) {
            return converted ?? null;
          }

          return this.protocolConversion.ensureMessagesStreamCompatibility(converted, ctx);
        }
      );

      hooks.onFlushStream.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (chunks, ctx) => {
          if (this.responsesStreamConversionRequestIds.has(ctx.requestId)) {
            this.responsesStreamConversionRequestIds.delete(ctx.requestId);
            const completionEvents = this.buildResponsesStreamCompletionEvents(ctx);
            this.persistResponsesStateFromStream(ctx);
            return [...chunks, ...completionEvents];
          }

          if (!this.streamConversionRequestIds.has(ctx.requestId)) {
            return chunks;
          }

          const flushed = await this.responseConverter.flushStream?.(ctx);
          this.streamConversionRequestIds.delete(ctx.requestId);
          const merged = [...chunks, ...(flushed ?? [])];
          return this.protocolConversion.ensureMessagesStreamCompatibility(merged, ctx);
        }
      );

      hooks.onFinally.tap(
        { name: 'openai-messages-to-chat' },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.responsesAdaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.responsesStreamConversionRequestIds.delete(ctx.requestId);
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
      this.responsesStreamConversionRequestIds.clear();
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

    private persistResponsesStateFromStream(ctx: { requestId: string; streamState: Map<string, unknown> }): void {
      const streamState = ctx.streamState.get('responses_stream_state') as ResponsesStreamState | undefined;
      if (!streamState) {
        return;
      }

      const baseMessages = this.responsesRequestMessages.get(ctx.requestId) ?? [];
      const conversationId = this.responsesRequestConversationIds.get(ctx.requestId);

      let history = baseMessages;
      if (streamState.messageText.length > 0 || streamState.toolCalls.length > 0) {
        const assistantMessage: JsonRecord = {
          role: 'assistant',
          content: streamState.messageText.length > 0 ? streamState.messageText : null
        };

        if (streamState.toolCalls.length > 0) {
          assistantMessage.tool_calls = streamState.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments
            }
          }));
        }

        history = [...baseMessages, assistantMessage];
      }

      this.storeResponsesState(streamState.responseId, history, conversationId);
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

    private async tryParseJsonBody(response: Response): Promise<unknown | null> {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return null;
      }

      try {
        return await response.clone().json();
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

    private convertChatCompletionToResponsesPayload(payload: JsonRecord): JsonRecord | null {
      if (payload.object === 'response') {
        return payload;
      }

      if (!Array.isArray(payload.choices)) {
        return null;
      }

      const choices = payload.choices
        .filter((choice): choice is JsonRecord => isRecord(choice) && isRecord(choice.message));
      if (choices.length === 0) {
        return null;
      }

      const responseId = this.toResponsesId(payload.id);
      const createdAt = typeof payload.created === 'number'
        ? payload.created
        : Math.floor(Date.now() / 1000);
      const model = typeof payload.model === 'string' ? payload.model : '';

      const output: JsonRecord[] = [];
      const finishReasons: string[] = [];

      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
        const choice = choices[choiceIndex];
        const message = choice.message as JsonRecord;
        const content = this.normalizeChatMessageContentToResponseOutputText(message.content);
        const messageId = choices.length === 1
          ? `${responseId}_msg`
          : `${responseId}_msg_${choiceIndex}`;
        const messageContent = content
          ? [
            {
              type: 'output_text',
              text: content,
              annotations: []
            }
          ]
          : [];

        output.push({
          id: messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: messageContent
        });

        const toolCalls = this.normalizeToolCalls(message.tool_calls) ?? [];
        for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
          const toolCall = toolCalls[toolCallIndex];
          const toolFunction = isRecord(toolCall.function) ? toolCall.function : undefined;
          const toolCallId = typeof toolCall.id === 'string' && toolCall.id.trim().length > 0
            ? toolCall.id.trim()
            : `${responseId}_choice_${choiceIndex}_call_${toolCallIndex}`;
          const argumentsPayload = typeof toolFunction?.arguments === 'string'
            ? toolFunction.arguments
            : JSON.stringify(toolFunction?.arguments ?? {});

          output.push({
            id: toolCallId,
            type: 'function_call',
            call_id: toolCallId,
            name: typeof toolFunction?.name === 'string' ? toolFunction.name : '',
            arguments: argumentsPayload,
            status: 'completed'
          });
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReasons.push(choice.finish_reason);
        }
      }

      const usage = isRecord(payload.usage) ? payload.usage : {};
      const terminal = this.aggregateTerminalFromFinishReasons(finishReasons);

      const converted: JsonRecord = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        model,
        status: this.terminalStatusFromType(terminal.type),
        output,
        usage: {
          input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
          output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
          total_tokens: typeof usage.total_tokens === 'number'
            ? usage.total_tokens
            : (
              (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0)
              + (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0)
            )
        }
      };

      if (terminal.type === 'response.incomplete') {
        converted.incomplete_details = {
          reason: terminal.reason
        };
      }

      if (terminal.type === 'response.failed') {
        converted.error = {
          code: 'completion_terminated',
          message: terminal.reason
        };
      }

      if (finishReasons.length > 0) {
        converted.metadata = {
          finish_reason: finishReasons[0],
          finish_reasons: finishReasons
        };
      }

      return converted;
    }

    private convertChatCompletionChunkToResponsesEvents(
      chunk: unknown,
      ctx: { streamState: Map<string, unknown> }
    ): JsonRecord[] {
      if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
        return [];
      }

      const state = this.getOrCreateResponsesStreamState(chunk, ctx.streamState);
      const events: JsonRecord[] = [];

      if (ctx.streamState.get('responses_stream_started') !== true) {
        events.push({
          type: 'response.created',
          response: {
            id: state.responseId,
            object: 'response',
            created_at: state.createdAt,
            model: state.model,
            status: 'in_progress',
            output: []
          }
        });
        events.push({
          type: 'response.in_progress',
          response: {
            id: state.responseId,
            object: 'response',
            created_at: state.createdAt,
            model: state.model,
            status: 'in_progress',
            output: []
          }
        });
        events.push({
          type: 'response.output_item.added',
          response_id: state.responseId,
          output_index: 0,
          item: {
            id: state.messageId,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: []
          }
        });
        ctx.streamState.set('responses_stream_started', true);
      }

      for (const choice of chunk.choices) {
        if (!isRecord(choice)) {
          continue;
        }

        const delta = isRecord(choice.delta) ? choice.delta : undefined;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (!state.hasTextContentPart) {
              events.push({
                type: 'response.content_part.added',
                response_id: state.responseId,
                item_id: state.messageId,
                output_index: 0,
                content_index: 0,
                part: {
                  type: 'output_text',
                  text: '',
                  annotations: []
                }
              });
              state.hasTextContentPart = true;
            }

            state.messageText += delta.content;
            events.push({
              type: 'response.output_text.delta',
              response_id: state.responseId,
              item_id: state.messageId,
              output_index: 0,
              content_index: 0,
              delta: delta.content
            });
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const rawToolCall of delta.tool_calls) {
              if (!isRecord(rawToolCall)) {
                continue;
              }

              const toolCallIndex = typeof rawToolCall.index === 'number' ? rawToolCall.index : state.toolCalls.length;
              const functionData = isRecord(rawToolCall.function) ? rawToolCall.function : {};
              const idFromDelta = typeof rawToolCall.id === 'string' && rawToolCall.id.trim().length > 0
                ? rawToolCall.id.trim()
                : undefined;
              const existingId = state.toolCallIndexToId.get(toolCallIndex);
              const toolCallId = existingId
                ?? idFromDelta
                ?? `${state.responseId}_call_${toolCallIndex}`;

              let toolCall = state.toolCalls.find((item) => item.id === toolCallId);
              const firstSeen = !toolCall;
              if (!toolCall) {
                toolCall = {
                  id: toolCallId,
                  name: '',
                  arguments: ''
                };
                state.toolCalls.push(toolCall);
                state.toolCallIndexToId.set(toolCallIndex, toolCallId);
              }

              if (typeof functionData.name === 'string' && functionData.name.length > 0) {
                toolCall.name = functionData.name;
              }

              if (firstSeen) {
                events.push({
                  type: 'response.output_item.added',
                  response_id: state.responseId,
                  output_index: state.toolCalls.length,
                  item: {
                    id: toolCall.id,
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: toolCall.name,
                    arguments: '',
                    status: 'in_progress'
                  }
                });
              }

              if (typeof functionData.arguments === 'string' && functionData.arguments.length > 0) {
                toolCall.arguments += functionData.arguments;
                const toolOutputIndex = state.toolCalls.indexOf(toolCall) + 1;
                events.push({
                  type: 'response.function_call_arguments.delta',
                  response_id: state.responseId,
                  item_id: toolCall.id,
                  output_index: toolOutputIndex,
                  delta: functionData.arguments
                });
              }
            }
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          state.finishReason = choice.finish_reason;
          const terminal = this.mapFinishReasonToTerminalEvent(choice.finish_reason);
          if (terminal) {
            state.terminalEventType = terminal.type;
            state.terminalReason = terminal.reason;
          }
        }
      }

      if (isRecord(chunk.usage)) {
        state.usage = {
          input_tokens: typeof chunk.usage.prompt_tokens === 'number' ? chunk.usage.prompt_tokens : state.usage.input_tokens,
          output_tokens: typeof chunk.usage.completion_tokens === 'number'
            ? chunk.usage.completion_tokens
            : state.usage.output_tokens,
          total_tokens: typeof chunk.usage.total_tokens === 'number'
            ? chunk.usage.total_tokens
            : state.usage.total_tokens
        };
      }

      return events;
    }

    private buildResponsesStreamCompletionEvents(
      ctx: { streamState: Map<string, unknown> }
    ): JsonRecord[] {
      const state = ctx.streamState.get('responses_stream_state') as ResponsesStreamState | undefined;
      if (!state) {
        return [];
      }

      const events: JsonRecord[] = [];
      const output: JsonRecord[] = [];

      const messageContentPart: JsonRecord = {
        type: 'output_text',
        text: state.messageText,
        annotations: []
      };
      const messageContent = state.hasTextContentPart ? [messageContentPart] : [];
      const messageItem: JsonRecord = {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: messageContent
      };

      output.push(messageItem);

      if (state.hasTextContentPart) {
        events.push({
          type: 'response.output_text.done',
          response_id: state.responseId,
          item_id: state.messageId,
          output_index: 0,
          content_index: 0,
          text: state.messageText
        });

        events.push({
          type: 'response.content_part.done',
          response_id: state.responseId,
          item_id: state.messageId,
          output_index: 0,
          content_index: 0,
          part: messageContentPart
        });
      }

      events.push({
        type: 'response.output_item.done',
        response_id: state.responseId,
        output_index: 0,
        item: messageItem
      });

      for (const toolCall of state.toolCalls) {
        const toolOutputIndex = output.length;
        const toolItem: JsonRecord = {
          id: toolCall.id,
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          status: 'completed'
        };

        events.push({
          type: 'response.function_call_arguments.done',
          response_id: state.responseId,
          item_id: toolCall.id,
          output_index: toolOutputIndex,
          arguments: toolCall.arguments
        });

        events.push({
          type: 'response.output_item.done',
          response_id: state.responseId,
          output_index: toolOutputIndex,
          item: toolItem
        });

        output.push(toolItem);
      }

      const normalizedUsage = {
        input_tokens: state.usage.input_tokens,
        output_tokens: state.usage.output_tokens,
        total_tokens: state.usage.total_tokens > 0
          ? state.usage.total_tokens
          : state.usage.input_tokens + state.usage.output_tokens
      };

      const terminal = this.resolveTerminalEvent(state);
      const responsePayload: JsonRecord = {
        id: state.responseId,
        object: 'response',
        created_at: state.createdAt,
        model: state.model,
        status: terminal.status,
        output,
        usage: normalizedUsage,
        metadata: {
          finish_reason: state.finishReason || terminal.reason
        }
      };

      if (terminal.type === 'response.incomplete') {
        responsePayload.incomplete_details = {
          reason: terminal.reason
        };
      }

      if (terminal.type === 'response.failed') {
        responsePayload.error = {
          code: 'stream_terminated',
          message: terminal.reason
        };
      }

      events.push({
        type: terminal.type,
        response: responsePayload
      });

      return events;
    }

    private getOrCreateResponsesStreamState(
      chunk: JsonRecord,
      streamState: Map<string, unknown>
    ): ResponsesStreamState {
      const existing = streamState.get('responses_stream_state') as ResponsesStreamState | undefined;
      if (existing) {
        return existing;
      }

      const responseId = this.toResponsesId(chunk.id);
      const createdAt = typeof chunk.created === 'number'
        ? chunk.created
        : Math.floor(Date.now() / 1000);
      const model = typeof chunk.model === 'string' ? chunk.model : '';

      const created: ResponsesStreamState = {
        responseId,
        messageId: `${responseId}_msg`,
        createdAt,
        model,
        messageText: '',
        finishReason: '',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        },
        hasTextContentPart: false,
        toolCalls: [],
        toolCallIndexToId: new Map<number, string>(),
        terminalEventType: null,
        terminalReason: ''
      };

      streamState.set('responses_stream_state', created);
      return created;
    }

    private resolveTerminalEvent(
      state: ResponsesStreamState
    ): {
      type: ResponsesTerminalEventType;
      status: 'completed' | 'incomplete' | 'failed';
      reason: string;
    } {
      if (state.terminalEventType) {
        return {
          type: state.terminalEventType,
          status: this.terminalStatusFromType(state.terminalEventType),
          reason: state.terminalReason || state.finishReason || (state.terminalEventType === 'response.incomplete' ? 'unknown' : 'stop')
        };
      }

      const mappedByFinishReason = this.mapFinishReasonToTerminalEvent(state.finishReason);
      if (mappedByFinishReason) {
        return {
          type: mappedByFinishReason.type,
          status: this.terminalStatusFromType(mappedByFinishReason.type),
          reason: mappedByFinishReason.reason
        };
      }

      if (state.messageText.length === 0 && state.toolCalls.length === 0) {
        return {
          type: 'response.failed',
          status: 'failed',
          reason: 'empty_stream_output'
        };
      }

      return {
        type: 'response.incomplete',
        status: 'incomplete',
        reason: 'unknown'
      };
    }

    private mapFinishReasonToTerminalEvent(
      finishReason: string
    ): { type: ResponsesTerminalEventType; reason: string } | undefined {
      const normalizedFinishReason = finishReason.trim();
      if (!normalizedFinishReason) {
        return undefined;
      }

      if (normalizedFinishReason === 'stop' || normalizedFinishReason === 'tool_calls') {
        return {
          type: 'response.completed',
          reason: normalizedFinishReason
        };
      }

      if (normalizedFinishReason === 'length') {
        return {
          type: 'response.incomplete',
          reason: 'max_output_tokens'
        };
      }

      if (normalizedFinishReason === 'content_filter') {
        return {
          type: 'response.incomplete',
          reason: 'content_filter'
        };
      }

      if (normalizedFinishReason === 'error') {
        return {
          type: 'response.failed',
          reason: 'upstream_error'
        };
      }

      return {
        type: 'response.completed',
        reason: normalizedFinishReason
      };
    }

    private aggregateTerminalFromFinishReasons(
      finishReasons: string[]
    ): { type: ResponsesTerminalEventType; reason: string } {
      let selectedTerminal: { type: ResponsesTerminalEventType; reason: string } | undefined;
      let selectedPriority = -1;

      for (const finishReason of finishReasons) {
        const mapped = this.mapFinishReasonToTerminalEvent(finishReason);
        if (!mapped) {
          continue;
        }

        const priority = this.terminalPriority(mapped.type);
        if (priority > selectedPriority) {
          selectedTerminal = mapped;
          selectedPriority = priority;
        }
      }

      return selectedTerminal ?? {
        type: 'response.completed',
        reason: 'stop'
      };
    }

    private terminalPriority(type: ResponsesTerminalEventType): number {
      if (type === 'response.failed') {
        return 3;
      }

      if (type === 'response.incomplete') {
        return 2;
      }

      return 1;
    }

    private terminalStatusFromType(type: ResponsesTerminalEventType): 'completed' | 'incomplete' | 'failed' {
      if (type === 'response.completed') {
        return 'completed';
      }

      if (type === 'response.incomplete') {
        return 'incomplete';
      }

      return 'failed';
    }

    private normalizeChatMessageContentToResponseOutputText(content: unknown): string {
      if (typeof content === 'string') {
        return content;
      }

      if (!Array.isArray(content)) {
        return '';
      }

      const textSegments: string[] = [];
      for (const item of content) {
        if (!isRecord(item)) {
          continue;
        }

        if (typeof item.text === 'string') {
          textSegments.push(item.text);
        }
      }

      return textSegments.join('');
    }

    private toResponsesId(rawId: unknown): string {
      if (typeof rawId !== 'string' || rawId.trim().length === 0) {
        return `resp_${Date.now()}`;
      }

      if (rawId.startsWith('resp_')) {
        return rawId;
      }

      return `resp_${rawId}`;
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
