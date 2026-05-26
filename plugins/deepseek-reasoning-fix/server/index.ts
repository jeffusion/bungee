/**
 * DeepSeek Reasoning Fix Plugin
 *
 * 修复 DeepSeek/Moonshot/Kimi 等模型在 tool_calls 场景下
 * thinking/reasoning 内容回传丢失的问题。
 *
 * 参考: https://github.com/farion1231/cc-switch/pull/2543
 *
 * 核心修复：当 assistant 消息同时包含 thinking 内容和 tool_calls 时，
 * 将 thinking 内容提取为 reasoning_content 字段放在 tool_calls 同级。
 *
 * 仅做 OpenAI 格式内部的数据结构调整，不涉及协议转换。
 * 插件应用在哪个 route/upstream 由用户配置控制。
 */

import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, MutableRequestContext } from '../../../packages/core/src/hooks';
import { logger } from '../../../packages/core/src/logger';

// ============ 工具函数 ============

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return value;
}

// ============ 请求方向修补 ============

/**
 * 修补 OpenAI 格式请求体：当 assistant 消息有 tool_calls 时，
 * 从 content 中提取 thinking 内容放入 reasoning_content 字段。
 *
 * 对应 cc-switch PR#2543:
 *   should_preserve_reasoning_content_for_openai_chat
 *   + anthropic_to_openai_with_reasoning_content
 *
 * 场景：Anthropic→OpenAI 转换后，assistant 消息中 thinking 内容
 * 被 ai-transformer 放入了 content（<thinking>标签或 thinking 类型块），
 * 但 DeepSeek 等模型要求有 tool_calls 时 thinking 必须放在
 * message.reasoning_content 字段，否则上游会报错。
 */
function patchRequestForReasoningContent(
  body: unknown
): { body: unknown; patched: boolean } {
  if (!isRecord(body)) return { body, patched: false };

  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, patched: false };

  let patched = false;
  const out = deepClone(body);
  const outMessages = out.messages as any[];

  for (const msg of outMessages) {
    if (!isRecord(msg) || msg.role !== 'assistant') continue;

    // 必须有 tool_calls 才需要 reasoning_content
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;

    // 已经有 reasoning_content 则跳过
    if (typeof msg.reasoning_content === 'string') continue;

    const thinkingTexts: string[] = [];

    if (typeof msg.content === 'string') {
      // 从 <thinking>...</thinking> 标签提取
      const thinkingPattern = /<thinking>([\s\S]*?)<\/thinking>/gi;
      let match: RegExpExecArray | null;
      while ((match = thinkingPattern.exec(msg.content)) !== null) {
        const text = match[1].trim();
        if (text) thinkingTexts.push(text);
      }
      if (thinkingTexts.length > 0) {
        const cleaned = msg.content
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
          .trim();
        msg.content = cleaned || null;
      }
    } else if (Array.isArray(msg.content)) {
      // 从 content 数组中提取 thinking/reasoning 类型的块
      const newContent: unknown[] = [];
      for (const part of msg.content) {
        if (!isRecord(part)) {
          newContent.push(part);
          continue;
        }
        const partType = typeof part.type === 'string' ? part.type : '';
        if (partType === 'thinking') {
          const text = typeof part.thinking === 'string' ? part.thinking.trim() : '';
          if (text) thinkingTexts.push(text);
          continue;
        }
        if (partType === 'reasoning' || partType === 'reasoning_content') {
          const text =
            typeof part.text === 'string' ? part.text.trim()
            : typeof part.reasoning === 'string' ? part.reasoning.trim()
            : '';
          if (text) thinkingTexts.push(text);
          continue;
        }
        newContent.push(part);
      }
      if (thinkingTexts.length > 0) {
        if (
          newContent.length === 1 &&
          isRecord(newContent[0]) &&
          newContent[0].type === 'text' &&
          typeof newContent[0].text === 'string'
        ) {
          msg.content = newContent[0].text;
        } else if (newContent.length === 0) {
          msg.content = null;
        } else {
          msg.content = newContent;
        }
      }
    }

    if (thinkingTexts.length > 0) {
      msg.reasoning_content = thinkingTexts.join('\n\n');
      patched = true;
    }
  }

  return { body: out, patched };
}

// ============ 插件实现 ============

export const DeepSeekReasoningFixPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'deepseek-reasoning-fix';
    static readonly version = '1.0.0';

    constructor() {}

    register(hooks: PluginHooks): void {
      // 在 ai-transformer 转换后修补
      // stage=20 确保在 ai-transformer (stage=0) 之后执行
      hooks.onBeforeRequest.tap(
        { name: 'deepseek-reasoning-fix', stage: 20 },
        (ctx: MutableRequestContext) => {
          try {
            const { body: patchedBody, patched } = patchRequestForReasoningContent(
              ctx.body
            );
            if (patched) {
              ctx.body = patchedBody;
              logger.debug(
                { url: ctx.url.pathname },
                'deepseek-reasoning-fix: patched request - thinking -> reasoning_content'
              );
            }
          } catch (error) {
            logger.error(
              { error, url: ctx.url.pathname },
              'deepseek-reasoning-fix: error patching request'
            );
          }
          return ctx;
        }
      );
    }

    async reset(): Promise<void> {
      // 无状态插件，无需重置
    }
  }
);

export default DeepSeekReasoningFixPlugin;
