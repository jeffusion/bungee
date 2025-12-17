/**
 * Anthropic Filter Error Tool Results Plugin
 *
 * 功能：
 * - 遍历请求体中的 messages 数组
 * - 针对每一条 user 消息，检查其 tool_result 内容
 * - 获取前一条 assistant 消息中的所有 tool_use id
 * - 过滤 user 消息：移除所有 tool_use_id 不在上一条 assistant 消息中的 tool_result
 * - 移除 content 为空的消息
 *
 * 使用场景：
 * - 修复 "Phantom Tool Results" (幻影工具结果)
 * - 确保 tool_result 与 tool_use 的严格对应
 * - 避免发送空消息给 upstream
 */

import { isArray, filter, map, includes, isEmpty } from 'lodash-es';
import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';

export const AnthropicFilterErrorToolResultsPlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'anthropic-filter-error-tool-results';
    static readonly version = '1.0.0';

    constructor(options?: any) {
      // 插件不需要任何配置选项
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'anthropic-filter-error-tool-results', stage: 0 },
        (ctx) => {
          const body = ctx.body as any;

          if (!body || !isArray(body.messages)) {
            return ctx;
          }

          const messages = body.messages;
          const newMessages: any[] = [];

          for (let i = 0; i < messages.length; i++) {
            const message = messages[i];

            if (message.role === 'user' && isArray(message.content)) {
              let validToolIds: string[] = [];

              if (i > 0) {
                const prevMessage = messages[i - 1];
                if (prevMessage.role === 'assistant' && isArray(prevMessage.content)) {
                  validToolIds = map(
                    filter(prevMessage.content, { type: 'tool_use' }),
                    'id'
                  );
                }
              }

              message.content = filter(message.content, (item) => {
                if (item && item.type === 'tool_result') {
                  return includes(validToolIds, item.tool_use_id);
                }
                return true;
              });
            }

            if (!isEmpty(message.content)) {
              newMessages.push(message);
            }
          }

          ctx.body.messages = newMessages;
          return ctx;
        }
      );
    }

    async reset(): Promise<void> {}
  }
);

export default AnthropicFilterErrorToolResultsPlugin;
