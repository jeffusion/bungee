import { logger } from '../../logger';
import { isStreamingResponse } from './handler';

export const MAX_BODY_INSPECT = 1024 * 1024;
export const MAX_PEEK_BYTES = 4096;

export interface ResponseCheckResult {
  hit: boolean;
  matchedKeyword?: string;
  response?: Response;
}

/**
 * 检测响应体是否命中 failover 关键字列表。
 *
 * 命中：{ hit: true, matchedKeyword } —— 调用方走通用 catch 更新被动健康/断路器
 * peek 异常：抛 Error —— 原 stream 已消费不可透传，进入下一 failover attempt
 * 未命中：{ hit: false, response } —— 流式场景返回含 peeked+overflow+rest 的 wrapped response
 */
export async function checkResponseForFailover(
  response: Response,
  keywords: string[]
): Promise<ResponseCheckResult> {
  const rules = normalizeKeywords(keywords);
  if (rules.length === 0) return { hit: false, response };

  if (response.body && isStreamingResponse(response)) {
    return await peekStreamForKeywords(response, rules);
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
      const hit = findKeyword(text, rules);
      if (hit) {
        await reader.cancel();
        try { reader.releaseLock(); } catch { /* */ }
        return { hit: true, matchedKeyword: hit };
      }
    }
    text += decoder.decode();
    const hit = findKeyword(text, rules);
    if (hit) {
      await reader.cancel();
      try { reader.releaseLock(); } catch { /* */ }
      return { hit: true, matchedKeyword: hit };
    }
    await reader.cancel();
    try { reader.releaseLock(); } catch { /* */ }
  } catch {
    try { await reader.cancel(); } catch { /* */ }
    try { reader.releaseLock(); } catch { /* */ }
    return { hit: false, response };
  }

  return { hit: false, response };
}

function normalizeKeywords(keywords: string[]): string[] {
  if (!keywords || keywords.length === 0) return [];
  return keywords.map((k) => k.trim()).filter((k) => k.length > 0);
}

function findKeyword(text: string, keywords: string[]): string | undefined {
  for (const kw of keywords) {
    if (text.includes(kw)) return kw;
  }
  return undefined;
}

/**
 * 流式 first-peek：buffer 首 4KB / 首 SSE event，命中则 cancel；
 * 未命中则 pull-driven wrapper 透传 peeked + overflow + rest。
 */
async function peekStreamForKeywords(
  response: Response,
  keywords: string[]
): Promise<ResponseCheckResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  const peekedChunks: Uint8Array[] = [];
  const overflowChunks: Uint8Array[] = [];

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

      // 切片后立即 push overflow，再做 break 判断，避免 SSE 边界 break 丢 tail
      if (overflowTail !== null) {
        overflowChunks.push(overflowTail);
      }

      peekedChunks.push(peekedTail);
      buffer += decoder.decode(peekedTail, { stream: true });
      totalBytes += peekedTail.byteLength;

      const hit = findKeyword(buffer, keywords);
      if (hit) {
        await reader.cancel();
        reader.releaseLock();
        return { hit: true, matchedKeyword: hit };
      }

      if (buffer.includes('\n\n') || buffer.includes('\r\n\r\n')) break;

      if (overflowTail !== null) {
        buffer += decoder.decode();
        const hitAfterFlush = findKeyword(buffer, keywords);
        if (hitAfterFlush) {
          await reader.cancel();
          reader.releaseLock();
          return { hit: true, matchedKeyword: hitAfterFlush };
        }
        break;
      }
    }

    buffer += decoder.decode();
    const hitFinal = findKeyword(buffer, keywords);
    if (hitFinal) {
      await reader.cancel();
      reader.releaseLock();
      return { hit: true, matchedKeyword: hitFinal };
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
