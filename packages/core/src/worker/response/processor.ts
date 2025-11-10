/**
 * Response processor module
 * Handles response modification and streaming
 */

import { logger } from '../../logger';
import type { RequestLogger } from '../../logger/request-logger';
import type { AppConfig, ModificationRules } from '@jeffusion/bungee-shared';
import type { ExpressionContext } from '../../expression-engine';
import type { Plugin } from '../../plugin.types';
import type { PluginRegistry } from '../../plugin-registry';
import { applyBodyRules } from '../rules/modifier';
import {
  createPluginTransformStream,
  createSSEParserStream,
  createSSESerializerStream
} from '../../stream-executor';

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
 * @param dedupedRoutePlugins - Route-specific plugins (for streaming)
 * @param pluginRegistry - Global plugin registry (for streaming)
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
 *   routePlugins,
 *   pluginRegistry
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
  dedupedRoutePlugins?: Plugin[],
  pluginRegistry?: PluginRegistry | null
): Promise<PrepareResponseResult> {
  const headers = new Headers(res.headers);
  const contentType = headers.get('content-type') || '';

  // Since we are buffering the body, we MUST remove chunked encoding headers.
  headers.delete('transfer-encoding');
  headers.delete('content-encoding');

  // ===== Streaming Response (SSE) =====
  if (isStreamingRequest && contentType.includes('text/event-stream') && res.body) {
    logger.info({ request: requestLog }, '--- Applying SSE Stream Transformation ---');

    // Record SSE response headers (不记录 body，因为是流式数据)
    if (reqLogger) {
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      reqLogger.setResponseHeaders(responseHeaders);
    }

    // For streams, we don't modify content-length here as the final length is unknown.
    let streamBody: ReadableStream;

    // ===== 洋葱模型：流式处理（内→外）=====
    // Collect all plugins with processStreamChunk capability (route → global order)
    const streamPlugins: Plugin[] = [];
    const pluginNames = new Set<string>();

    // Add route plugins in reverse order (inbound)
    // Note: dedupedRoutePlugins already contains all plugins (route + upstream merged)
    if (dedupedRoutePlugins) {
      for (const plugin of [...dedupedRoutePlugins].reverse()) {
        if (plugin.processStreamChunk && !pluginNames.has(plugin.name)) {
          streamPlugins.push(plugin);
          pluginNames.add(plugin.name);
        }
      }
    }

    if (streamPlugins.length > 0) {
      // Use plugin chain for stream transformation
      logger.info(
        {
          request: requestLog,
          pluginCount: streamPlugins.length,
          plugins: streamPlugins.map(p => p.name)
        },
        'Using plugin chain for stream transformation'
      );

      // 串联三个 TransformStream：
      // 1. SSE 解析器：Uint8Array → JSON objects
      // 2. Plugin 转换器：JSON objects → transformed JSON objects
      // 3. SSE 序列化器：JSON objects → Uint8Array
      streamBody = res.body
        .pipeThrough(createSSEParserStream())
        .pipeThrough(createPluginTransformStream(streamPlugins, requestLog))
        .pipeThrough(createSSESerializerStream());
    } else {
      // No stream plugins - pass through unchanged
      logger.debug({ request: requestLog }, 'No stream plugins found, passing through unchanged');
      streamBody = res.body;
    }

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
