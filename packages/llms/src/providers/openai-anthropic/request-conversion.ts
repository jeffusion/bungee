import { OpenAIProtocolConversion } from '../openai/protocol-conversion';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseThinkingTags(text: string): Array<{ type: string; text?: string; thinking?: string }> {
  const content: Array<{ type: string; text?: string; thinking?: string }> = [];
  const thinkingRegex = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
  let lastIndex = 0;
  let match = thinkingRegex.exec(text);

  while (match !== null) {
    const beforeText = text.substring(lastIndex, match.index).trim();
    if (beforeText) {
      content.push({ type: 'text', text: beforeText });
    }

    const thinkingText = match[1]?.trim();
    if (thinkingText) {
      content.push({ type: 'thinking', thinking: thinkingText });
    }

    lastIndex = match.index + match[0].length;
    match = thinkingRegex.exec(text);
  }

  const afterText = text.substring(lastIndex).trim();
  if (afterText) {
    content.push({ type: 'text', text: afterText });
  }

  if (content.length === 0 && text.trim()) {
    content.push({ type: 'text', text });
  }

  return content;
}

export interface OpenAIToAnthropicRequestConversionResult {
  pathname: '/v1/messages';
  body: Record<string, unknown>;
}

export class OpenAIToAnthropicRequestConversion {
  constructor(private readonly protocolConversion = new OpenAIProtocolConversion()) {}

  convert(pathname: string, body: unknown): OpenAIToAnthropicRequestConversionResult | null {
    if (!isRecord(body)) {
      return null;
    }

    const isChatEndpoint = pathname === '/v1/chat/completions';
    const isResponsesEndpoint = pathname === '/v1/responses';
    if (!isChatEndpoint && !isResponsesEndpoint) {
      return null;
    }

    const normalizedBody = this.normalizeOpenAIRequestBody(body, isResponsesEndpoint);
    const anthropicBody: Record<string, unknown> = {
      model: normalizedBody.model
    };

    const instructionParts: string[] = [];
    if (typeof normalizedBody.system === 'string' && normalizedBody.system.trim()) {
      instructionParts.push(normalizedBody.system.trim());
    }

    if (Array.isArray(normalizedBody.messages)) {
      const instructionMessages = normalizedBody.messages
        .filter((m) => isRecord(m) && (m.role === 'system' || m.role === 'developer'))
        .map((m) => this.extractInstructionText(isRecord(m) ? m.content : undefined))
        .filter((text) => text.length > 0);

      instructionParts.push(...instructionMessages);
    }

    if (instructionParts.length > 0) {
      anthropicBody.system = instructionParts.join('\n');
    }

    if (Array.isArray(normalizedBody.messages)) {
      const convertedMessages = this.convertMessages(normalizedBody.messages);
      this.validateAndCleanToolCalls(convertedMessages);
      anthropicBody.messages = convertedMessages;
    }

    if (normalizedBody.max_tokens !== undefined) {
      anthropicBody.max_tokens = normalizedBody.max_tokens;
    }

    if (normalizedBody.temperature !== undefined) {
      anthropicBody.temperature = normalizedBody.temperature;
    }

    if (normalizedBody.top_p !== undefined) {
      anthropicBody.top_p = normalizedBody.top_p;
    }

    if (normalizedBody.stop !== undefined) {
      anthropicBody.stop_sequences = Array.isArray(normalizedBody.stop)
        ? normalizedBody.stop
        : [normalizedBody.stop];
    }

    if (normalizedBody.stream !== undefined) {
      anthropicBody.stream = normalizedBody.stream;
    }

    if (Array.isArray(normalizedBody.tools)) {
      anthropicBody.tools = this.convertTools(normalizedBody.tools);
    }

    const anthropicToolChoice = this.mapOpenAIToolChoiceToAnthropic(normalizedBody.tool_choice);
    if (anthropicToolChoice !== undefined) {
      anthropicBody.tool_choice = anthropicToolChoice;
      if (anthropicToolChoice === 'none') {
        delete anthropicBody.tools;
      }
    }

    return {
      pathname: '/v1/messages',
      body: anthropicBody
    };
  }

  private normalizeOpenAIRequestBody(
    body: Record<string, unknown>,
    isResponsesEndpoint: boolean
  ): Record<string, unknown> {
    if (!isResponsesEndpoint) {
      return body;
    }

    const normalized: Record<string, unknown> = {
      ...body,
      messages: this.protocolConversion.convertResponsesInputToMessages(body.input)
    };

    if (normalized.max_tokens === undefined && body.max_output_tokens !== undefined) {
      normalized.max_tokens = body.max_output_tokens;
    }

    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      normalized.system = body.instructions.trim();
    }

    return normalized;
  }

  private convertTools(tools: unknown[]): Array<Record<string, unknown>> {
    return tools
      .filter((tool) => isRecord(tool) && tool.type === 'function')
      .map((tool) => {
        if (!isRecord(tool)) {
          return null;
        }

        if (isRecord(tool.function)) {
          return {
            name: typeof tool.function.name === 'string' ? tool.function.name : '',
            description: typeof tool.function.description === 'string' ? tool.function.description : '',
            input_schema: tool.function.parameters ?? {}
          } as Record<string, unknown>;
        }

        return {
          name: typeof tool.name === 'string' ? tool.name : '',
          description: typeof tool.description === 'string' ? tool.description : '',
          input_schema: tool.parameters ?? {}
        } as Record<string, unknown>;
      })
      .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === 'string' && tool.name.length > 0);
  }

  private mapOpenAIToolChoiceToAnthropic(toolChoice: unknown): unknown {
    if (toolChoice === undefined || toolChoice === null) {
      return undefined;
    }

    if (typeof toolChoice === 'string') {
      const normalized = toolChoice.trim().toLowerCase();
      if (normalized === 'none') {
        return 'none';
      }
      if (normalized === 'required') {
        return { type: 'any' };
      }
      if (normalized === 'auto') {
        return { type: 'auto' };
      }
      return undefined;
    }

    if (!isRecord(toolChoice)) {
      return undefined;
    }

    const type = typeof toolChoice.type === 'string' ? toolChoice.type.trim().toLowerCase() : '';
    if (type === 'function') {
      const functionObject = isRecord(toolChoice.function) ? toolChoice.function : undefined;
      const name = typeof functionObject?.name === 'string' ? functionObject.name.trim() : '';
      if (!name) {
        return undefined;
      }

      return {
        type: 'tool',
        name
      };
    }

    if (type === 'none') {
      return 'none';
    }

    if (type === 'required' || type === 'any') {
      return { type: 'any' };
    }

    if (type === 'auto') {
      return { type: 'auto' };
    }

    return undefined;
  }

  private extractInstructionText(content: unknown): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return item.text;
        if (isRecord(item) && typeof item.text === 'string') return item.text;
        return '';
      })
      .join('')
      .trim();
  }

  private validateAndCleanToolCalls(messages: Array<Record<string, unknown>>): void {
    const toolResultIds = new Set<string>();

    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        continue;
      }

      for (const block of message.content) {
        if (!isRecord(block)) {
          continue;
        }

        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        continue;
      }

      message.content = message.content.filter((block) => {
        if (!isRecord(block) || block.type !== 'tool_use') {
          return true;
        }

        return typeof block.id === 'string' && toolResultIds.has(block.id);
      });
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 0) {
        messages.splice(i, 1);
      }
    }
  }

  private parseImageSource(url: string): Record<string, string> | null {
    if (!url) {
      return null;
    }

    if (url.startsWith('data:')) {
      const parts = url.split(';base64,');
      if (parts.length !== 2) {
        return null;
      }

      return {
        type: 'base64',
        media_type: parts[0].replace('data:', ''),
        data: parts[1]
      };
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      return {
        type: 'url',
        url
      };
    }

    return null;
  }

  private normalizeToolResultContent(content: unknown): string | unknown[] {
    if (content === undefined || content === null) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const blocks = content
        .map((part) => this.convertToolResultPart(part))
        .filter((part): part is Record<string, unknown> => part !== null);

      if (blocks.length === 0) {
        return '';
      }

      if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
        return blocks[0].text;
      }

      return blocks;
    }

    if (isRecord(content)) {
      if ('content' in content) {
        return this.normalizeToolResultContent(content.content);
      }

      return JSON.stringify(content);
    }

    return String(content);
  }

  private convertToolResultPart(part: unknown): Record<string, unknown> | null {
    if (typeof part === 'string') {
      const text = part.trim();
      return text ? { type: 'text', text } : null;
    }

    if (!isRecord(part)) {
      return null;
    }

    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      const text = typeof part.text === 'string' ? part.text : '';
      return text.trim() ? { type: 'text', text } : null;
    }

    if (part.type === 'image_url' || part.type === 'input_image') {
      const imageUrl = typeof part.image_url === 'string'
        ? part.image_url
        : isRecord(part.image_url) && typeof part.image_url.url === 'string'
          ? part.image_url.url
          : undefined;

      const source = typeof imageUrl === 'string' ? this.parseImageSource(imageUrl) : null;
      if (source) {
        return {
          type: 'image',
          source
        };
      }
    }

    if (part.type === 'image' && isRecord(part.source)) {
      return {
        type: 'image',
        source: part.source
      };
    }

    return {
      type: 'text',
      text: JSON.stringify(part)
    };
  }

  private convertToolMessageToResultBlock(toolMsg: Record<string, unknown>): Record<string, unknown> {
    const block: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id : '',
      content: this.normalizeToolResultContent(toolMsg.content)
    };

    if (toolMsg.is_error === true) {
      block.is_error = true;
    }

    return block;
  }

  private convertMessages(messages: unknown[]): Array<Record<string, unknown>> {
    const anthropicMessages: Array<Record<string, unknown>> = [];
    const filtered = messages.filter((message) => isRecord(message) && message.role !== 'system' && message.role !== 'developer');

    let i = 0;
    while (i < filtered.length) {
      const message = filtered[i] as Record<string, unknown>;
      const role = message.role;

      if (role === 'tool') {
        const toolResults: Array<Record<string, unknown>> = [];

        while (i < filtered.length) {
          const current = filtered[i];
          if (!isRecord(current) || current.role !== 'tool') {
            break;
          }

          toolResults.push(this.convertToolMessageToResultBlock(current));
          i += 1;
        }

        if (toolResults.length > 0) {
          anthropicMessages.push({
            role: 'user',
            content: toolResults
          });
        }

        continue;
      }

      i += 1;

      if (role === 'user') {
        const content = message.content;
        if (typeof content === 'string') {
          const textContent = content.trim();
          if (!textContent) {
            continue;
          }

          const blocks = parseThinkingTags(content);
          if (blocks.length === 0) {
            anthropicMessages.push({ role: 'user', content: textContent });
          } else if (blocks.length === 1 && blocks[0].type === 'text') {
            anthropicMessages.push({ role: 'user', content: blocks[0].text ?? '' });
          } else {
            anthropicMessages.push({ role: 'user', content: blocks });
          }

          continue;
        }

        if (!Array.isArray(content)) {
          continue;
        }

        const images: unknown[] = [];
        const texts: unknown[] = [];
        const others: unknown[] = [];

        for (const item of content) {
          if (typeof item === 'string') {
            texts.push({ type: 'text', text: item });
            continue;
          }

          if (!isRecord(item)) {
            others.push(item);
            continue;
          }

          if (item.type === 'image_url' || item.type === 'input_image') {
            images.push(item);
          } else if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') {
            texts.push(item);
          } else {
            others.push(item);
          }
        }

        const anthropicContent: unknown[] = [];
        for (const image of images) {
          if (!isRecord(image)) {
            continue;
          }

          const url = typeof image.image_url === 'string'
            ? image.image_url
            : isRecord(image.image_url) && typeof image.image_url.url === 'string'
              ? image.image_url.url
              : '';
          const source = this.parseImageSource(url);
          if (source) {
            anthropicContent.push({
              type: 'image',
              source
            });
          }
        }

        for (const textPart of texts) {
          if (isRecord(textPart) && typeof textPart.text === 'string' && textPart.text.trim()) {
            anthropicContent.push({ type: 'text', text: textPart.text });
          }
        }

        anthropicContent.push(...others);

        if (anthropicContent.length === 1 && isRecord(anthropicContent[0]) && anthropicContent[0].type === 'text') {
          anthropicMessages.push({ role: 'user', content: anthropicContent[0].text ?? '' });
        } else if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: 'user', content: anthropicContent });
        }

        continue;
      }

      if (role === 'assistant') {
        if (Array.isArray(message.tool_calls)) {
          const content: unknown[] = [];
          const assistantText = this.extractInstructionText(message.content);
          if (assistantText) {
            content.push({ type: 'text', text: assistantText });
          }

          for (const toolCall of message.tool_calls) {
            if (!isRecord(toolCall) || toolCall.type !== 'function' || !isRecord(toolCall.function)) {
              continue;
            }

            const argumentsValue = toolCall.function.arguments ?? '{}';
            let argumentsObject: unknown = {};
            try {
              argumentsObject = typeof argumentsValue === 'string'
                ? JSON.parse(argumentsValue)
                : argumentsValue;
            } catch {
              argumentsObject = {};
            }

            content.push({
              type: 'tool_use',
              id: typeof toolCall.id === 'string' ? toolCall.id : '',
              name: typeof toolCall.function.name === 'string' ? toolCall.function.name : '',
              input: argumentsObject
            });
          }

          if (content.length > 0) {
            anthropicMessages.push({ role: 'assistant', content });
          }

          continue;
        }

        const content = message.content;
        if (typeof content === 'string') {
          if (content.trim()) {
            anthropicMessages.push({ role: 'assistant', content });
          }
          continue;
        }

        if (!Array.isArray(content)) {
          continue;
        }

        const anthropicContent: unknown[] = [];
        for (const part of content) {
          if (typeof part === 'string') {
            if (part.trim()) {
              anthropicContent.push({ type: 'text', text: part });
            }
            continue;
          }

          if (!isRecord(part)) {
            continue;
          }

          if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            const text = typeof part.text === 'string' ? part.text : '';
            if (text.trim()) {
              anthropicContent.push({ type: 'text', text });
            }
            continue;
          }

          if (part.type === 'thinking') {
            const thinking = typeof part.thinking === 'string' ? part.thinking : '';
            if (thinking.trim()) {
              anthropicContent.push({ type: 'thinking', thinking });
            }
            continue;
          }

          if (part.type === 'image_url' || part.type === 'input_image') {
            const imageUrl = typeof part.image_url === 'string'
              ? part.image_url
              : isRecord(part.image_url) && typeof part.image_url.url === 'string'
                ? part.image_url.url
                : undefined;
            const source = typeof imageUrl === 'string' ? this.parseImageSource(imageUrl) : null;
            if (source) {
              anthropicContent.push({ type: 'image', source });
            }
            continue;
          }

          if (part.type === 'image' && isRecord(part.source)) {
            anthropicContent.push({ type: 'image', source: part.source });
          }
        }

        if (anthropicContent.length === 1 && isRecord(anthropicContent[0]) && anthropicContent[0].type === 'text') {
          anthropicMessages.push({ role: 'assistant', content: anthropicContent[0].text ?? '' });
        } else if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: 'assistant', content: anthropicContent });
        }
      }
    }

    return anthropicMessages;
  }
}
