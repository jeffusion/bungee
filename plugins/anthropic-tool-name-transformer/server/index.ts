/**
 * Anthropic Tool Name Transformer Plugin
 *
 * 功能：
 * 1. 请求转换：将 tool name 从小写转为 PascalCase（支持自定义映射表）
 * 2. 非流式响应：修复 tool_use input 中数组/对象被序列化为字符串的问题
 * 3. SSE 流式响应：转换 content_block_start 中的 tool_use name
 *
 * 使用场景：
 * - 某些 upstream 返回的 tool name 全小写，而客户端期望 PascalCase
 * - 某些 upstream 将 tool_use input 中的数组/对象序列化为字符串
 */

import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';

// ============================================================
// Name Mapping Utilities
// ============================================================

type NameMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析用户配置的名称映射表
 * 格式：每行一个映射，key=value
 */
function parseNameMap(raw: string | undefined): NameMap {
  const map: NameMap = {};
  if (!raw || typeof raw !== 'string') return map;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && value) {
      map[key] = value;
    }
  }
  return map;
}

/**
 * 映射 tool name：优先查自定义映射表，否则首字母大写
 */
function mapName(name: string, nameMap: NameMap): string {
  if (!name || typeof name !== 'string') return name;
  if (nameMap[name]) return nameMap[name];

  const parts = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return name;
  }

  return parts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// ============================================================
// Transform Helpers
// ============================================================

/**
 * 转换请求体中的 tool name
 * - tools[] 定义中的 name
 * - messages[] 历史中 tool_use block 的 name
 */
function transformRequestBody(body: any, nameMap: NameMap): void {
  if (!body) return;

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.name) tool.name = mapName(tool.name, nameMap);
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.name) {
            block.name = mapName(block.name, nameMap);
          }
        }
      }
    }
  }
}

/**
 * 修复响应体中 tool_use input 里被序列化为字符串的数组/对象
 */
function fixSerializedInputs(body: any): boolean {
  if (!body || !Array.isArray(body.content)) return false;

  let modified = false;

  for (const block of body.content) {
    if (block.type === 'tool_use' && isRecord(block.input)) {
      for (const key of Object.keys(block.input)) {
        const val = block.input[key];
        if (
          typeof val === 'string' &&
          (val.trim().startsWith('[') || val.trim().startsWith('{'))
        ) {
          try {
            block.input[key] = JSON.parse(val);
            modified = true;
          } catch {
            // 非合法 JSON，保持原样
          }
        }
      }
    }
  }

  return modified;
}

// ============================================================
// Plugin Options
// ============================================================

interface ToolNameTransformerOptions {
  /** 自定义名称映射（key=value 格式，每行一个） */
  nameMap?: string;
  /** 是否修复序列化的数组/对象，默认 true */
  fixSerializedArrays?: boolean;
}

// ============================================================
// Plugin Definition
// ============================================================

export const AnthropicToolNameTransformerPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'anthropic-tool-name-transformer';
    static readonly version = '1.0.0';

    private nameMap: NameMap;
    private shouldFixArrays: boolean;

    constructor(options?: ToolNameTransformerOptions) {
      this.nameMap = parseNameMap(options?.nameMap);
      this.shouldFixArrays = options?.fixSerializedArrays !== false;
    }

    register(hooks: PluginHooks): void {
      const pluginName = 'anthropic-tool-name-transformer';

      // 1. 请求前处理：转换 tool name
      hooks.onBeforeRequest.tap(
        { name: pluginName, stage: 0 },
        (ctx) => {
          transformRequestBody(ctx.body, this.nameMap);
          return ctx;
        }
      );

      // 2. 非流式响应处理：修复序列化数组 + 反向映射无需处理（upstream 返回的是转换后的名称）
      if (this.shouldFixArrays) {
        hooks.onResponse.tapPromise(
          { name: pluginName },
          async (response, _ctx) => {
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) return response;

            const text = await response.text();
            const headers = new Headers(response.headers);
            let bodyText = text;

            try {
              const body = JSON.parse(text);
              if (fixSerializedInputs(body)) {
                bodyText = JSON.stringify(body);
                headers.delete('content-length');
              }
            } catch {
              // 非合法 JSON，保持原始响应体和元数据
            }

            return new Response(bodyText, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
        );
      }

      // 3. SSE 流式响应：转换 content_block_start 中的 tool_use name
      hooks.onStreamChunk.tap(
        { name: pluginName, stage: 0 },
        (chunk, _ctx) => {
          if (isRecord(chunk)) {
            const block = chunk.content_block;
            if (
              chunk.type === 'content_block_start' &&
              isRecord(block) &&
              block.type === 'tool_use' &&
              typeof block.name === 'string'
            ) {
              block.name = mapName(block.name, this.nameMap);
            }
            return [chunk];
          }

          if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
            return [chunk];
          }

          const sourceText = typeof chunk === 'string'
            ? chunk
            : new TextDecoder().decode(chunk);

          const lines = sourceText.split('\n');
          let modified = false;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('data:')) continue;

            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            try {
              const data = JSON.parse(jsonStr);
              if (
                data.type === 'content_block_start' &&
                data.content_block?.type === 'tool_use' &&
                data.content_block.name
              ) {
                data.content_block.name = mapName(data.content_block.name, this.nameMap);
                lines[i] = 'data: ' + JSON.stringify(data);
                modified = true;
              }
            } catch {
              // 非合法 JSON SSE 行，跳过
            }
          }

          if (!modified) {
            return [chunk];
          }

          const output = lines.join('\n');
          if (typeof chunk === 'string') {
            return [output];
          }

          return [new TextEncoder().encode(output)];
        }
      );
    }

    async reset(): Promise<void> {
      // 无状态插件，无需重置
    }
  }
);

export default AnthropicToolNameTransformerPlugin;
