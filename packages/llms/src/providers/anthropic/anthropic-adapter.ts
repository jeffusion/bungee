import type { LLMProtocolAdapter } from '../../core/adapter';
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalRole,
  CanonicalStreamEvent,
  ConversionContext
} from '../../core/types';
import { OpenAIToAnthropicRequestConversion } from '../openai-anthropic/request-conversion';

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
  const result: CanonicalMessage[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    result.push({
      role: normalizeRole(message.role),
      content: message.content,
      metadata: message
    });
  }

  return result;
}

function toAnthropicMessages(messages: CanonicalMessage[]): JsonRecord[] {
  return messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => {
      const role = message.role === 'tool' ? 'user' : message.role;
      return {
        role,
        content: message.content
      };
    });
}

export class AnthropicAdapter implements LLMProtocolAdapter<JsonRecord, JsonRecord, unknown> {
  readonly provider = 'anthropic' as const;

  constructor(private readonly openAIToAnthropic = new OpenAIToAnthropicRequestConversion()) {}

  toCanonicalRequest(request: JsonRecord, context: ConversionContext): CanonicalRequest {
    const requestBody = isRecord(request) ? request : {};
    const canonicalMessages: CanonicalMessage[] = [];

    if (typeof requestBody.system === 'string' && requestBody.system.trim()) {
      canonicalMessages.push({
        role: 'system',
        content: requestBody.system
      });
    }

    if (Array.isArray(requestBody.messages)) {
      canonicalMessages.push(...toCanonicalMessages(requestBody.messages));
    }

    return {
      model: typeof requestBody.model === 'string' ? requestBody.model : undefined,
      messages: canonicalMessages,
      tools: Array.isArray(requestBody.tools)
        ? requestBody.tools as CanonicalRequest['tools']
        : undefined,
      toolChoice: requestBody.tool_choice,
      metadata: {
        ...context.metadata,
        anthropicRequestBody: requestBody
      }
    };
  }

  fromCanonicalRequest(request: CanonicalRequest, context: ConversionContext): JsonRecord {
    const openAIBody = isRecord(request.metadata?.openaiRequestBody)
      ? request.metadata.openaiRequestBody
      : null;
    if (openAIBody) {
      const pathname = typeof context.metadata?.pathname === 'string'
        ? context.metadata.pathname
        : '/v1/chat/completions';
      const converted = this.openAIToAnthropic.convert(pathname, openAIBody);
      if (converted) {
        return converted.body;
      }
    }

    const metadataBody = isRecord(request.metadata?.anthropicRequestBody)
      ? request.metadata.anthropicRequestBody
      : null;
    if (metadataBody) {
      return metadataBody;
    }

    const anthropicBody: JsonRecord = {
      messages: toAnthropicMessages(request.messages)
    };

    if (typeof request.model === 'string') {
      anthropicBody.model = request.model;
    }

    const systemMessages = request.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .filter((content) => content.length > 0);
    if (systemMessages.length > 0) {
      anthropicBody.system = systemMessages.join('\n');
    }

    if (request.tools) {
      anthropicBody.tools = request.tools;
    }

    if (request.toolChoice !== undefined) {
      anthropicBody.tool_choice = request.toolChoice;
    }

    return anthropicBody;
  }

  toCanonicalResponse(response: JsonRecord, context: ConversionContext): CanonicalResponse {
    const responseBody = isRecord(response) ? response : {};
    const canonicalResponse: CanonicalResponse = {
      metadata: {
        ...context.metadata,
        anthropicResponseBody: responseBody
      }
    };

    if (typeof responseBody.role === 'string') {
      canonicalResponse.message = {
        role: normalizeRole(responseBody.role),
        content: responseBody.content,
        metadata: responseBody
      };
    }

    return canonicalResponse;
  }

  fromCanonicalResponse(response: CanonicalResponse): JsonRecord {
    const metadataBody = isRecord(response.metadata?.anthropicResponseBody)
      ? response.metadata.anthropicResponseBody
      : null;
    if (metadataBody) {
      return metadataBody;
    }

    if (response.message) {
      return {
        role: response.message.role,
        content: response.message.content
      };
    }

    return {};
  }

  toCanonicalStreamEvent(event: unknown): CanonicalStreamEvent {
    return {
      type: 'anthropic.stream',
      payload: event
    };
  }

  fromCanonicalStreamEvent(event: CanonicalStreamEvent): unknown {
    if (event.type === 'anthropic.stream') {
      return event.payload;
    }

    return event.payload;
  }
}
