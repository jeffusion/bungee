/**
 * Converter Utility Functions
 *
 * 提供转换器使用的通用工具函数
 */

/**
 * 生成 Anthropic 风格的消息 ID
 *
 * @returns 格式为 msg_xxxxxxxxxxxxxxxxxxxxxxxx 的 ID（24位十六进制）
 */
export function generateAnthropicMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

/**
 * 生成 OpenAI 风格的聊天完成 ID
 *
 * @returns 格式为 chatcmpl-xxxxxxxxxxxxxxxxxxxxxxxx 的 ID
 */
export function generateOpenAIChatCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

/**
 * 生成 Gemini 风格的候选 ID
 *
 * @returns 格式为 candidate-xxxxxxxx 的 ID
 */
export function generateGeminiCandidateId(): string {
  return `candidate-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}`;
}

/**
 * 解析文本中的 <thinking> 标签
 *
 * @param text - 包含 <thinking> 标签的文本
 * @returns 解析后的内容块数组
 */
export function parseThinkingTags(text: string): Array<{ type: string; text?: string; thinking?: string }> {
  const content: any[] = [];
  const thinkingRegex = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
  let lastIdx = 0;
  let match;

  while ((match = thinkingRegex.exec(text)) !== null) {
    // 前面的文本
    const beforeText = text.substring(lastIdx, match.index).trim();
    if (beforeText) {
      content.push({ type: 'text', text: beforeText });
    }

    // thinking 块
    const thinkingText = match[1].trim();
    if (thinkingText) {
      content.push({ type: 'thinking', thinking: thinkingText });
    }

    lastIdx = match.index + match[0].length;
  }

  // 后面的文本
  const afterText = text.substring(lastIdx).trim();
  if (afterText) {
    content.push({ type: 'text', text: afterText });
  }

  // 如果没有匹配到任何 thinking，直接添加文本
  if (content.length === 0 && text.trim()) {
    content.push({ type: 'text', text: text });
  }

  return content;
}

/**
 * 将 thinking 块转换为 <thinking> 标签文本
 *
 * @param blocks - 内容块数组
 * @returns 包含 <thinking> 标签的文本
 */
export function convertThinkingBlocksToTags(blocks: any[]): string {
  let text = '';

  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'thinking') {
      text += `<thinking>\n${block.thinking || ''}\n</thinking>\n\n`;
    }
  }

  return text.trim();
}

/**
 * 映射 Anthropic stop_reason 到 OpenAI finish_reason
 *
 * @param stopReason - Anthropic stop_reason
 * @returns OpenAI finish_reason
 */
export function mapAnthropicStopReasonToOpenAI(stopReason: string): string {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'content_filter';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

/**
 * 映射 OpenAI finish_reason 到 Anthropic stop_reason
 *
 * @param finishReason - OpenAI finish_reason
 * @returns Anthropic stop_reason
 */
export function mapOpenAIFinishReasonToAnthropic(finishReason: string): string {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

/**
 * 安全解析 JSON 字符串
 *
 * @param jsonString - JSON 字符串
 * @param defaultValue - 解析失败时的默认值
 * @returns 解析结果或默认值
 */
export function safeJsonParse<T = any>(jsonString: string, defaultValue: T = {} as T): T {
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue;
  }
}

/**
 * 安全 JSON 字符串化
 *
 * @param obj - 要字符串化的对象
 * @param defaultValue - 字符串化失败时的默认值
 * @returns JSON 字符串或默认值
 */
export function safeJsonStringify(obj: any, defaultValue: string = '{}'): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return defaultValue;
  }
}
