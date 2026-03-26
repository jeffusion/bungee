/**
 * Response processor module
 * Handles response modification and streaming
 */

import { logger } from '../../logger';
import { accessLogWriter } from '../../logger/access-log-writer';
import { bodyStorageManager } from '../../logger/body-storage';
import type { RequestLogger } from '../../logger/request-logger';
import type { AppConfig, ModificationRules } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../expression-engine';
import type { PluginHooks, RequestContext } from '../../hooks';
import { applyBodyRules } from '../rules/modifier';
import {
  createPluginTransformStream,
  createSSEParserStream,
  createSSESerializerStream
} from '../../stream-executor';

const SSE_IDLE_HEARTBEAT_MS = 4_000;

interface LoggedSSEMessage {
  index: number;
  event?: string;
  done?: boolean;
  dataText: string;
  data?: unknown;
}

interface LoggedSSEPayload {
  kind: 'sse_messages';
  totalMessages: number;
  capturedMessages: number;
  droppedMessages: number;
  messages: LoggedSSEMessage[];
}

function createSSECaptureTapStream(
  requestLog: any,
  reqLogger: RequestLogger
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | null = null;
  let currentDataLines: string[] = [];
  const messages: LoggedSSEMessage[] = [];
  let totalMessages = 0;

  const resetCurrentMessage = () => {
    currentEvent = null;
    currentDataLines = [];
  };

  const parseDataIfJson = (fullDataText: string): unknown | undefined => {
    if (!fullDataText) {
      return undefined;
    }

    try {
      return JSON.parse(fullDataText);
    } catch {
      return undefined;
    }
  };

  const captureCurrentMessage = () => {
    if (currentDataLines.length === 0) {
      resetCurrentMessage();
      return;
    }

    const fullDataText = currentDataLines.join('\n');
    const isDone = fullDataText.trim() === '[DONE]';

    messages.push({
      index: totalMessages,
      event: currentEvent || undefined,
      done: isDone ? true : undefined,
      dataText: fullDataText,
      data: isDone ? undefined : parseDataIfJson(fullDataText),
    });

    totalMessages += 1;
    resetCurrentMessage();
  };

  const consumeCompleteLines = (text: string) => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const lineWithCR of lines) {
      const line = lineWithCR.endsWith('\r') ? lineWithCR.slice(0, -1) : lineWithCR;

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentDataLines.push(line.slice(5).trimStart());
      } else if (line === '') {
        captureCurrentMessage();
      }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      consumeCompleteLines(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    async flush() {
      const remainingText = `${decoder.decode()}${buffer}`;
      if (remainingText.length > 0) {
        const line = remainingText.endsWith('\r') ? remainingText.slice(0, -1) : remainingText;
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentDataLines.push(line.slice(5).trimStart());
        }
      }

      captureCurrentMessage();

      if (totalMessages === 0) {
        return;
      }

      const requestId = reqLogger.getRequestId();
      const payload: LoggedSSEPayload = {
        kind: 'sse_messages',
        totalMessages,
        capturedMessages: totalMessages,
        droppedMessages: 0,
        messages,
      };

      try {
        const bodyId = await bodyStorageManager.save(requestId, payload, 'response', true);

        if (!bodyId) {
          logger.debug(
            {
              request: requestLog,
              stream: {
                requestId,
                totalMessages,
                capturedMessages: totalMessages,
              },
            },
            'Skipped SSE message recording'
          );
          return;
        }

        accessLogWriter.updateResponseBodyId(requestId, bodyId);
        logger.debug(
          {
            request: requestLog,
            stream: {
              requestId,
              totalMessages,
              capturedMessages: totalMessages,
              bodyId,
            },
          },
          'Recorded SSE messages into request log'
        );
      } catch (error) {
        logger.warn(
          {
            request: requestLog,
            error,
            stream: {
              requestId,
              totalMessages,
              capturedMessages: totalMessages,
            },
          },
          'Failed to record SSE messages into request log'
        );
      }
    }
  });
}

function getRequestIdFromLog(requestLog: any): string {
  return typeof requestLog?.requestId === 'string' ? requestLog.requestId : 'unknown';
}

function createSSEStageTapStream<T>(
  stage: string,
  requestLog: any,
  options?: { includeBytes?: boolean }
): TransformStream<T, T> {
  const startAt = Date.now();
  let chunkCount = 0;
  let byteCount = 0;
  let doneCount = 0;

  return new TransformStream<T, T>({
    transform(chunk, controller) {
      chunkCount++;

      if ((chunk as any)?.type === '[DONE]') {
        doneCount++;
      }

      if (options?.includeBytes && chunk instanceof Uint8Array) {
        byteCount += chunk.byteLength;
      }

      if (chunkCount === 1) {
        logger.debug(
          {
            request: requestLog,
            stream: {
              stage,
              firstChunkLatencyMs: Date.now() - startAt,
              requestId: getRequestIdFromLog(requestLog)
            }
          },
          'SSE stream stage received first chunk'
        );
      }

      controller.enqueue(chunk);
    },
    flush() {
      logger.debug(
        {
          request: requestLog,
          stream: {
            stage,
            requestId: getRequestIdFromLog(requestLog),
            chunks: chunkCount,
            bytes: options?.includeBytes ? byteCount : undefined,
            doneSignals: doneCount,
            durationMs: Date.now() - startAt
          }
        },
        'SSE stream stage completed'
      );
    }
  });
}

function createSSEIdleHeartbeatStream(
  source: ReadableStream<Uint8Array>,
  requestLog: any,
  idleMs: number = SSE_IDLE_HEARTBEAT_MS
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = source.getReader();
  let closed = false;
  let heartbeatCount = 0;
  let lastOutboundAt = Date.now();
  let sawAnthropicMessageStart = false;
  let sawAnthropicMessageStop = false;
  let sawDoneSignal = false;
  let outboundEventCount = 0;
  let recentSSEText = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  const TERMINAL_BUFFER_LIMIT = 4096;

  const updateSSEStateFromChunk = (chunk: Uint8Array): void => {
    const chunkText = decoder.decode(chunk, { stream: true });
    if (!chunkText) {
      return;
    }

    recentSSEText = `${recentSSEText}${chunkText}`;
    if (recentSSEText.length > TERMINAL_BUFFER_LIMIT) {
      recentSSEText = recentSSEText.slice(-TERMINAL_BUFFER_LIMIT);
    }

    if (recentSSEText.includes('event: message_start')) {
      sawAnthropicMessageStart = true;
    }
    if (recentSSEText.includes('event: message_stop')) {
      sawAnthropicMessageStop = true;
    }
    if (recentSSEText.includes('data: [DONE]')) {
      sawDoneSignal = true;
    }

    const eventMatches = chunkText.match(/\nevent:/g);
    if (eventMatches) {
      outboundEventCount += eventMatches.length;
    }
    if (chunkText.startsWith('event:')) {
      outboundEventCount += 1;
    }
  };

  const emitAnthropicTerminalFallback = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!sawAnthropicMessageStart || sawAnthropicMessageStop || sawDoneSignal) {
      return;
    }

    const fallbackPayload =
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":0}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    try {
      controller.enqueue(encoder.encode(fallbackPayload));
      sawAnthropicMessageStop = true;
      logger.warn(
        {
          request: requestLog,
          stream: {
            requestId: getRequestIdFromLog(requestLog),
            outboundEventCount,
            heartbeatCount
          }
        },
        'Injected fallback Anthropic terminal SSE events after downstream stream error'
      );
    } catch (emitError) {
      logger.warn(
        {
          request: requestLog,
          error: emitError,
          stream: {
            requestId: getRequestIdFromLog(requestLog),
            outboundEventCount,
            heartbeatCount
          }
        },
        'Failed to inject fallback Anthropic terminal SSE events'
      );
    }
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const tickMs = Math.max(1000, Math.floor(idleMs / 2));
      timer = setInterval(() => {
        if (closed) {
          return;
        }

        const now = Date.now();
        if (now - lastOutboundAt < idleMs) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          heartbeatCount++;
          lastOutboundAt = now;

          if (heartbeatCount === 1 || heartbeatCount % 20 === 0) {
            logger.debug(
              {
                request: requestLog,
                stream: {
                  requestId: getRequestIdFromLog(requestLog),
                  heartbeatCount,
                  idleMs
                }
              },
              'Sent SSE heartbeat to keep client connection alive'
            );
          }
        } catch (error) {
          logger.debug(
            { request: requestLog, error },
            'Failed to send SSE heartbeat, likely stream already closed'
          );
          closed = true;
          stopTimer();
        }
      }, tickMs);
    },
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          stopTimer();
          controller.close();
          logger.info(
            {
              request: requestLog,
              stream: {
                requestId: getRequestIdFromLog(requestLog),
                heartbeatCount
              }
            },
            'SSE stream closed after heartbeat protection'
          );
          return;
        }

        controller.enqueue(value);
        updateSSEStateFromChunk(value);
        lastOutboundAt = Date.now();
      } catch (error) {
        closed = true;
        stopTimer();
        emitAnthropicTerminalFallback(controller);
        logger.warn(
          {
            request: requestLog,
            error,
            stream: {
              requestId: getRequestIdFromLog(requestLog),
              sawAnthropicMessageStart,
              sawAnthropicMessageStop,
              sawDoneSignal,
              outboundEventCount,
              heartbeatCount
            }
          },
          'SSE heartbeat wrapper read failed, closing stream'
        );
        controller.close();
      }
    },
    async cancel(reason) {
      closed = true;
      stopTimer();
      try {
        await reader.cancel(reason);
      } catch {
      }
    }
  });
}

function createResilientSSEInputStream(source: ReadableStream<Uint8Array>, requestLog: any): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        logger.warn(
          { request: requestLog, error },
          'Upstream SSE stream aborted unexpectedly, closing stream gracefully'
        );
        closed = true;
        controller.close();
      }
    },
    async cancel(reason) {
      closed = true;
      try {
        await reader.cancel(reason);
      } catch {
      }
    }
  });
}

/**
 * Result type for response preparation
 */
export interface PrepareResponseResult {
  /** Modified response headers */
  headers: Headers;
  /** Modified response body (may be stream or buffered) */
  body: BodyInit | null;
}

/**
 * Prepares the response for return to client
 *
 * Handles two types of responses:
 * 1. **Streaming responses** (SSE): Pipes through plugin transform streams
 * 2. **Buffered responses**: Applies body rules and modifications
 *
 * **Processing steps**:
 * - Removes chunked encoding headers (transfer-encoding, content-encoding)
 * - For streams: Applies plugin transformations if available
 * - For buffered: Parses, modifies, and re-serializes body
 * - Records response headers/body to request logger
 * - Calculates final Content-Length for buffered responses
 *
 * @param res - Response from upstream
 * @param rules - Modification rules to apply
 * @param requestContext - Expression context for dynamic values
 * @param requestLog - Request log for debugging
 * @param isStreamingRequest - Whether the request is streaming (SSE)
 * @param reqLogger - Request logger for recording
 * @param config - Application configuration
 * @param pluginHooks - Plugin hooks for stream processing (optional)
 * @param streamRequestContext - Request context for stream processing (optional)
 * @returns Modified headers and body
 *
 * @example
 * ```typescript
 * const { headers, body } = await prepareResponse(
 *   upstreamResponse,
 *   upstreamRules,
 *   expressionContext,
 *   requestLog,
 *   false, // not streaming
 *   reqLogger,
 *   config,
 *   pluginExecutor.getHooks(),
 *   requestContext
 * );
 *
 * return new Response(body, { status: 200, headers });
 * ```
 */
export async function prepareResponse(
  res: Response,
  rules: ModificationRules,
  requestContext: ExpressionContext,
  requestLog: any,
  isStreamingRequest: boolean,
  reqLogger?: RequestLogger,
  config?: AppConfig,
  pluginHooks?: PluginHooks,
  streamRequestContext?: RequestContext
): Promise<PrepareResponseResult> {
  const headers = new Headers(res.headers);
  const contentType = headers.get('content-type') || '';

  // Since we are buffering the body, we MUST remove chunked encoding headers.
  headers.delete('transfer-encoding');
  headers.delete('content-encoding');

  // ===== Streaming Response (SSE) =====
  if (isStreamingRequest && contentType.includes('text/event-stream') && res.body) {
    logger.info({ request: requestLog }, '--- Applying SSE Stream Transformation ---');
    headers.delete('content-length');

    if (reqLogger) {
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      reqLogger.setResponseHeaders(responseHeaders);
    }

    // For streams, we don't modify content-length here as the final length is unknown.
    let streamBody: ReadableStream<Uint8Array>;
    const upstreamSSEBody = createResilientSSEInputStream(res.body, requestLog);

    // Check if there are stream processing hooks registered
    const hasStreamCallbacks = pluginHooks?.onStreamChunk.hasCallbacks() ?? false;

    if (hasStreamCallbacks && pluginHooks && streamRequestContext) {
      // Use Hook system for stream transformation
      logger.info(
        { request: requestLog },
        'Using Hook system for stream transformation'
      );

      // 串联三个 TransformStream：
      // 1. SSE 解析器：Uint8Array → JSON objects
      // 2. Plugin 转换器：JSON objects → transformed JSON objects
      // 3. SSE 序列化器：JSON objects → Uint8Array
      streamBody = upstreamSSEBody
        .pipeThrough(createSSEStageTapStream<Uint8Array>('upstream', requestLog, { includeBytes: true }))
        .pipeThrough(createSSEParserStream())
        .pipeThrough(createSSEStageTapStream<any>('parser', requestLog))
        .pipeThrough(createPluginTransformStream(pluginHooks, streamRequestContext))
        .pipeThrough(createSSEStageTapStream<any>('transform', requestLog))
        .pipeThrough(createSSESerializerStream())
        .pipeThrough(createSSEStageTapStream<Uint8Array>('serializer', requestLog, { includeBytes: true }));
    } else {
      // No stream plugins - pass through unchanged
      logger.debug({ request: requestLog }, 'No stream plugins found, passing through unchanged');
      streamBody = upstreamSSEBody.pipeThrough(
        createSSEStageTapStream<Uint8Array>('upstream-pass-through', requestLog, { includeBytes: true })
      );
    }

    const shouldCaptureSSEMessages = Boolean(reqLogger && config?.logging?.body?.enabled);
    if (shouldCaptureSSEMessages && reqLogger) {
      streamBody = streamBody.pipeThrough(createSSECaptureTapStream(requestLog, reqLogger));
    }

    streamBody = createResilientSSEInputStream(streamBody, requestLog);

    streamBody = createSSEIdleHeartbeatStream(streamBody, requestLog);

    return {
      headers,
      body: streamBody,
    };
  }

  // ===== Buffered Response (Non-streaming) =====

  // Safely read the body as text first to avoid consuming the stream more than once.
  const rawBodyText = await res.text();
  logger.debug(
    { request: requestLog, responseBody: rawBodyText },
    "Raw response body from upstream"
  );
  let body: BodyInit | null = rawBodyText;

  // Record original response headers and body from upstream
  if (reqLogger) {
    // Record original response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    reqLogger.setResponseHeaders(responseHeaders);

    // Record original response body
    if (config?.logging?.body?.enabled && rawBodyText) {
      const isErrorResponse = res.status >= 400;

      if (isErrorResponse) {
        // 错误响应：记录所有类型的 body，不仅限于 JSON
        try {
          // 尝试解析为 JSON
          const parsedResponseBody = JSON.parse(rawBodyText);
          reqLogger.setResponseBody(parsedResponseBody);
        } catch {
          // 如果不是 JSON，直接记录原始字符串
          reqLogger.setResponseBody(rawBodyText);
        }
      } else if (contentType.includes('application/json')) {
        // 成功响应：仅记录 JSON 类型
        try {
          const parsedResponseBody = JSON.parse(rawBodyText);
          reqLogger.setResponseBody(parsedResponseBody);
        } catch (err) {
          logger.warn(
            { request: requestLog, error: err },
            'Failed to parse response body for recording'
          );
        }
      }
    }
  }

  // Apply body modification rules (if configured and JSON response)
  if (rules.body && contentType.includes('application/json')) {
    try {
      // Only parse and modify if there is a body.
      if (rawBodyText) {
        const parsedBody = JSON.parse(rawBodyText);
        const { body: _, ...baseRequestContext } = requestContext;
        const responseContext: ExpressionContext = {
          ...baseRequestContext,
          body: parsedBody
        };
        const modifiedBody = await applyBodyRules(
          parsedBody,
          rules.body,
          responseContext,
          requestLog
        );
        body = JSON.stringify(modifiedBody);
      } else {
        logger.debug(
          { request: requestLog },
          "Response body is empty, skipping modification."
        );
      }
    } catch (err) {
      logger.error(
        { request: requestLog, error: err },
        'Failed to parse or modify JSON response body. Returning original body.'
      );
      // `body` already contains the original rawBodyText, so no action needed.
    }
  }

  // Always calculate and set the final content-length as we have buffered the entire body.
  const finalBody = (body as string) || '';
  headers.set('Content-Length', String(Buffer.byteLength(finalBody)));

  return { headers, body: finalBody };
}
