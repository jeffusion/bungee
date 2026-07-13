import { logger } from '../../logger';
import { isStreamingResponse } from './handler';
import type { ResponseRetryRule } from '@jeffusion/bungee-types';

export const MAX_BODY_INSPECT = 1024 * 1024;
export const MAX_PEEK_BYTES = 4096;

export interface ResponseCheckResult {
  hit: boolean;
  matchedRule?: ResponseRetryRule;
  response?: Response;
}

/**
 * 检测响应是否命中 failover 内容规则。
 *
 * 命中：返回 { hit: true, matchedRule } —— 调用方在 retryable-status 分支统一处理
 *      （更新被动健康、断路器、failover 下一上游），不抛 UpstreamPhaseFailoverSignal。
 *      这避免了 UpstreamPhaseFailoverSignal 路径（handler.ts:1057-1077）绕过被动健康
 *      失败计数（handler.ts:1106-1170）的健康语义不一致问题。
 *
 * peek 异常：**抛 Error** —— 已读取部分字节后异常发生，原 stream 已消费不可透传；
 *           让 handler 走通用 catch 进入下一 failover attempt，保证被动健康失败计数路径不被绕过。
 *
 * 未命中：返回 { hit: false, response } —— 调用方用返回的 response 替换 result.response
 *        （流式场景：包含 peeked bytes + overflowTail + rest body；非流式：原 response）。
 */
export async function checkResponseForFailover(
  response: Response,
  rules: ResponseRetryRule[]
): Promise<ResponseCheckResult> {
  if (!rules || rules.length === 0) return { hit: false, response };

  const matchingRules = rules.filter(r => matchStatus(response.status, r.status));
  if (matchingRules.length === 0) return { hit: false, response };

  if (response.body && isStreamingResponse(response)) {
    return await peekStreamForKeywords(response, matchingRules);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_INSPECT) {
    logger.warn(
      { contentLength: parseInt(contentLength, 10), limit: MAX_BODY_INSPECT },
      'response body exceeds inspect limit (Content-Length), skipping body match'
    );
    return { hit: false, response };
  }

  const cloned = response.clone();
  const reader = cloned.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_INSPECT) {
        await reader.cancel();
        try { reader.releaseLock(); } catch { /* */ }
        logger.warn({ totalBytes, limit: MAX_BODY_INSPECT }, 'response body exceeds inspect limit during read, skipping body match');
        return { hit: false, response };
      }
      text += decoder.decode(value, { stream: true });
      for (const r of matchingRules) {
        if (text.includes(r.body_contains)) {
          await reader.cancel();
          try { reader.releaseLock(); } catch { /* */ }
          return { hit: true, matchedRule: r };
        }
      }
    }
    text += decoder.decode();
    for (const r of matchingRules) {
      if (text.includes(r.body_contains)) {
        await reader.cancel();
        try { reader.releaseLock(); } catch { /* */ }
        return { hit: true, matchedRule: r };
      }
    }
    await reader.cancel();
    try { reader.releaseLock(); } catch { /* */ }
  } catch (err) {
    try { await reader.cancel(); } catch { /* */ }
    try { reader.releaseLock(); } catch { /* */ }
    return { hit: false, response };
  }

  return { hit: false, response };
}

function matchStatus(actual: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

/**
 * 流式响应 first-peek 实现：
 *
 * 1. peek 循环：reader.read() 累积到 buffer
 *    - 切片：每个 chunk 读到后，按 MAX_PEEK_BYTES - totalBytes 切片
 *      * peekedTail（切片前部）→ 入 peekedChunks + decoder.decode + 检查关键字
 *      * overflowTail（超出 4KB 部分）→ 入 overflowChunks，不参与检测，作为 wrapper 前缀
 *      * v4 修正（Oracle v3 B2）：切片后立即 push overflowTail，再做后续 break 判断
 *    - 命中 → reader.cancel + releaseLock + 返回 { hit: true, matchedRule }
 *    - 未命中且遇到 SSE event 边界 `\n\n` 或 `\r\n\r\n` → 停止 peek
 *    - 未命中达到 MAX_PEEK_BYTES（已切片）→ 停止 peek
 *
 * 2. 未命中时构造 wrapped ReadableStream：
 *    - start(): enqueue peekedPrefix + overflowPrefix 一次性合并入队
 *    - pull(): reader.read() 一次 + enqueue（背压驱动，不在 start 中循环读）
 *    - cancel(reason): reader.cancel(reason) 透传取消
 *
 * 3. peek 读取异常：抛 Error（不返回结构化结果）—— 已读取部分字节后异常，
 *    原 stream 已消费不可透传；handler 通用 catch 接 Error 进入下一 failover attempt，
 *    保证被动健康失败计数路径不被绕过。
 */
async function peekStreamForKeywords(
  response: Response,
  rules: ResponseRetryRule[]
): Promise<ResponseCheckResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  let peekedChunks: Uint8Array[] = [];
  let overflowChunks: Uint8Array[] = [];

  try {
    while (totalBytes < MAX_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;

      const remainingPeek = MAX_PEEK_BYTES - totalBytes;
      let peekedTail: Uint8Array;
      let overflowTail: Uint8Array | null = null;

      if (value.byteLength > remainingPeek) {
        peekedTail = value.subarray(0, remainingPeek);
        overflowTail = value.subarray(remainingPeek);
      } else {
        peekedTail = value;
      }

      // v4 修正（Oracle v3 B2）：切片后立即 push overflowTail，再做任何 break 判断
      if (overflowTail !== null) {
        overflowChunks.push(overflowTail);
      }

      peekedChunks.push(peekedTail);
      buffer += decoder.decode(peekedTail, { stream: true });
      totalBytes += peekedTail.byteLength;

      for (const r of rules) {
        if (buffer.includes(r.body_contains)) {
          await reader.cancel();
          reader.releaseLock();
          return { hit: true, matchedRule: r };
        }
      }

      if (buffer.includes('\n\n') || buffer.includes('\r\n\r\n')) break;

      if (overflowTail !== null) {
        buffer += decoder.decode();
        for (const r of rules) {
          if (buffer.includes(r.body_contains)) {
            await reader.cancel();
            reader.releaseLock();
            return { hit: true, matchedRule: r };
          }
        }
        break;
      }
    }

    buffer += decoder.decode();
    for (const r of rules) {
      if (buffer.includes(r.body_contains)) {
        await reader.cancel();
        reader.releaseLock();
        return { hit: true, matchedRule: r };
      }
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* */ }
    try { reader.releaseLock(); } catch { /* */ }
    throw new Error(
      `Failed to peek streaming response for retry_on_response check: ${(err as Error).message}`
    );
  }

  const peekedPrefix = concatUint8Arrays(peekedChunks);
  const overflowPrefix = concatUint8Arrays(overflowChunks);
  const fullPrefix = concatUint8Arrays([peekedPrefix, overflowPrefix]);

  const wrappedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (fullPrefix.length > 0) {
        controller.enqueue(fullPrefix);
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => { /* ignore cancel errors */ });
    },
  });

  const wrappedResponse = new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return { hit: false, response: wrappedResponse };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
