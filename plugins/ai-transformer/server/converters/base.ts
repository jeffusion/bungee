/**
 * AI Converter Base Interface
 *
 * 定义所有 AI 格式转换器的基础接口
 * 转换器负责在不同 AI 提供商的请求/响应格式之间进行转换
 */

import type { MutableRequestContext, ResponseContext, StreamChunkContext } from '../../../../packages/core/src/hooks';

/**
 * AI 转换器接口
 *
 * 实现此接口的类负责处理特定方向的 AI 格式转换（如 anthropic → openai）
 */
export interface AIConverter {
  /**
   * 源格式标识符（如 'anthropic', 'openai', 'gemini'）
   */
  readonly from: string;

  /**
   * 目标格式标识符（如 'anthropic', 'openai', 'gemini'）
   */
  readonly to: string;

  /**
   * 在请求发送到上游之前转换请求格式
   *
   * @param ctx - 可修改的请求上下文，包含 url, headers, body 等信息
   * @returns Promise<void>
   */
  onBeforeRequest?(ctx: MutableRequestContext): Promise<void>;

  /**
   * 在响应返回给客户端之前转换响应格式
   *
   * @param ctx - 响应上下文，包含 response 等信息
   * @returns 新的 Response 对象或 void（void 表示不修改响应）
   */
  onResponse?(ctx: ResponseContext): Promise<Response | void>;

  /**
   * 处理流式响应的数据块
   *
   * @param chunk - 流式响应的数据块（已解析为 JSON 对象）
   * @param ctx - 流上下文，包含 streamState 等信息
   * @returns 转换后的数据块数组（可能将一个块拆分为多个），或 null（表示不处理此块）
   */
  processStreamChunk?(chunk: any, ctx: StreamChunkContext): Promise<any[] | null>;

  /**
   * 在流式响应结束时刷新剩余数据
   *
   * @param ctx - 流上下文
   * @returns 剩余的数据块数组
   */
  flushStream?(ctx: StreamChunkContext): Promise<any[]>;
}

/**
 * 转换方向类型
 */
export type TransformDirection = `${string}-${string}`;
