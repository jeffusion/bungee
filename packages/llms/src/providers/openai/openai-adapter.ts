import type { LLMProtocolAdapter } from '../../core/adapter';
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalRole,
  CanonicalStreamEvent,
  ConversionContext
} from '../../core/types';
import { OpenAIProtocolConversion } from './protocol-conversion';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRole(role: unknown): CanonicalRole {
  if (role === 'system' || role === 'developer' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role;
  }

  return 'user';
}

function toCanonicalMessages(messages: unknown[]): CanonicalMessage[] {
  const canonicalMessages: CanonicalMessage[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    canonicalMessages.push({
      role: normalizeRole(message.role),
      content: message.content,
      toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
      metadata: message
    });
  }

  return canonicalMessages;
}

function toOpenAIMessages(messages: CanonicalMessage[]): JsonRecord[] {
  return messages.map((message) => {
    const mapped: JsonRecord = {
      role: message.role,
      content: message.content
    };

    if (message.toolCallId) {
      mapped.tool_call_id = message.toolCallId;
    }

    return mapped;
  });
}

function applyAnthropicRequestMetadata(openaiBody: JsonRecord, anthropicBody: JsonRecord): void {
  const maxTokens = anthropicBody.max_tokens || anthropicBody.max_tokens_to_sample;
  if (maxTokens !== undefined) {
    openaiBody.max_tokens = maxTokens;
  }

  if (anthropicBody.temperature !== undefined) {
    openaiBody.temperature = anthropicBody.temperature;
  }

  if (anthropicBody.top_p !== undefined) {
    openaiBody.top_p = anthropicBody.top_p;
  }

  if (anthropicBody.stop_sequences !== undefined) {
    openaiBody.stop = Array.isArray(anthropicBody.stop_sequences)
      ? anthropicBody.stop_sequences
      : [anthropicBody.stop_sequences];
  }

  if (anthropicBody.stream !== undefined) {
    openaiBody.stream = anthropicBody.stream;
    if (anthropicBody.stream === true) {
      openaiBody.stream_options = {
        include_usage: true
      };
    }
  }
}

export class OpenAIAdapter implements LLMProtocolAdapter<JsonRecord, JsonRecord, unknown> {
  readonly provider = 'openai' as const;

  constructor(private readonly protocolConversion = new OpenAIProtocolConversion()) {}

  toCanonicalRequest(request: JsonRecord, context: ConversionContext): CanonicalRequest {
    const requestBody = isRecord(request) ? request : {};
    const pathname = typeof context.metadata?.pathname === 'string' ? context.metadata.pathname : '';
    const isResponsesPath = this.protocolConversion.isResponsesPath(pathname);

    const normalizedMessages = isResponsesPath
      ? this.protocolConversion.convertResponsesInputToMessages(requestBody.input)
      : requestBody.messages;

    const messages = Array.isArray(normalizedMessages)
      ? toCanonicalMessages(normalizedMessages)
      : [];

    return {
      model: typeof requestBody.model === 'string' ? requestBody.model : undefined,
      messages,
      tools: Array.isArray(requestBody.tools)
        ? requestBody.tools as CanonicalRequest['tools']
        : undefined,
      toolChoice: requestBody.tool_choice,
      metadata: {
        ...context.metadata,
        openaiRequestBody: requestBody
      }
    };
  }

  fromCanonicalRequest(request: CanonicalRequest): JsonRecord {
    const metadataBody = isRecord(request.metadata?.openaiRequestBody)
      ? request.metadata.openaiRequestBody
      : null;
    if (metadataBody) {
      return metadataBody;
    }

    const anthropicMetadataBody = isRecord(request.metadata?.anthropicRequestBody)
      ? request.metadata.anthropicRequestBody
      : null;

    const openaiBody: JsonRecord = {
      messages: toOpenAIMessages(request.messages)
    };

    if (typeof request.model === 'string') {
      openaiBody.model = request.model;
    }

    if (request.tools) {
      openaiBody.tools = request.tools;
    }

    if (request.toolChoice !== undefined) {
      openaiBody.tool_choice = request.toolChoice;
    }

    if (anthropicMetadataBody) {
      applyAnthropicRequestMetadata(openaiBody, anthropicMetadataBody);
    }

    return openaiBody;
  }

  toCanonicalResponse(response: JsonRecord, context: ConversionContext): CanonicalResponse {
    const responseBody = isRecord(response) ? response : {};
    const firstChoice = Array.isArray(responseBody.choices) && responseBody.choices.length > 0
      ? responseBody.choices[0]
      : undefined;
    const firstMessage = isRecord(firstChoice) && isRecord(firstChoice.message)
      ? firstChoice.message
      : undefined;

    const canonicalResponse: CanonicalResponse = {
      metadata: {
        ...context.metadata,
        openaiResponseBody: responseBody
      }
    };

    if (firstMessage) {
      canonicalResponse.message = {
        role: normalizeRole(firstMessage.role),
        content: firstMessage.content,
        metadata: firstMessage
      };
    }

    return canonicalResponse;
  }

  fromCanonicalResponse(response: CanonicalResponse): JsonRecord {
    const metadataBody = isRecord(response.metadata?.openaiResponseBody)
      ? response.metadata.openaiResponseBody
      : null;
    if (metadataBody) {
      return metadataBody;
    }

    if (response.message) {
      return {
        choices: [
          {
            message: {
              role: response.message.role,
              content: response.message.content
            }
          }
        ]
      };
    }

    if (Array.isArray(response.messages)) {
      return {
        choices: response.messages.map((message) => ({
          message: {
            role: message.role,
            content: message.content
          }
        }))
      };
    }

    return {};
  }

  toCanonicalStreamEvent(event: unknown): CanonicalStreamEvent {
    return {
      type: 'openai.stream',
      payload: event
    };
  }

  fromCanonicalStreamEvent(event: CanonicalStreamEvent): unknown {
    if (event.type === 'openai.stream') {
      return event.payload;
    }

    return event.payload;
  }
}
