/**
 * Request context builder module
 * Constructs ExpressionContext for dynamic value processing
 */

import { logger } from '../../logger';
import type { ExpressionContext } from '../../expression-engine';
import type { RequestSnapshot } from '../types';

/**
 * Result type for context building functions
 */
export interface RequestContextResult {
  /** Expression context for dynamic value processing */
  context: ExpressionContext;
  /** Whether the request is streaming (SSE) */
  isStreamingRequest: boolean;
  /** Parsed request body (empty object if not JSON) */
  parsedBody: Record<string, any>;
}

/**
 * Builds request context from a Request object
 *
 * Parses the request and extracts all information needed for
 * expression evaluation (headers, body, URL, method, env).
 *
 * **Note:** For failover scenarios, use `buildRequestContextFromSnapshot()` instead
 * to ensure proper isolation.
 *
 * @param req - Incoming HTTP request
 * @param rewrittenPath - Path after pathRewrite rules applied
 * @param requestLog - Request log for debugging
 * @returns Request context result
 *
 * @example
 * ```typescript
 * const { context, isStreamingRequest, parsedBody } =
 *   await buildRequestContext(req, { pathname: '/api/v1', search: '?id=123' }, requestLog);
 *
 * // Use context for dynamic value processing
 * const apiKey = processDynamicValue('${env.API_KEY}', context);
 * ```
 */
export async function buildRequestContext(
  req: Request,
  rewrittenPath: { pathname: string; search: string },
  requestLog: any
): Promise<RequestContextResult> {
  const url = new URL(req.url);
  let parsedBody: Record<string, any> = {};

  // Parse JSON body if present
  const contentType = req.headers.get('content-type') || '';
  if (req.body && contentType.includes('application/json')) {
    try {
      parsedBody = await req.clone().json();
    } catch (err) {
      logger.warn(
        { request: requestLog, error: err },
        'Failed to parse JSON body for expression context'
      );
    }
  }

  // Extract headers
  const headersObject: { [key: string]: string } = {};
  req.headers.forEach((value, key) => {
    headersObject[key] = value;
  });

  // Build expression context
  const context: ExpressionContext = {
    headers: headersObject,
    body: parsedBody,
    url: {
      pathname: rewrittenPath.pathname,
      search: rewrittenPath.search,
      host: url.hostname,
      protocol: url.protocol
    },
    method: req.method,
    env: process.env as Record<string, string>,
  };

  return {
    context,
    isStreamingRequest: !!context.body.stream,
    parsedBody
  };
}

/**
 * Builds request context from a snapshot instead of a Request object
 *
 * This ensures complete isolation for failover retries. Each upstream
 * attempt receives a clean copy of the original context, preventing
 * plugin modifications from affecting subsequent retries.
 *
 * **Key differences from `buildRequestContext()`:**
 * - No async I/O (snapshot already contains parsed body)
 * - Deep clones headers and body for complete isolation
 * - Used exclusively in failover retry scenarios
 *
 * @param snapshot - Request snapshot created before plugin execution
 * @param rewrittenPath - Path after pathRewrite rules applied
 * @param requestLog - Request log for debugging
 * @returns Request context result
 *
 * @example
 * ```typescript
 * // In failover retry loop
 * for (const upstream of retryQueue) {
 *   // Each iteration gets a clean context from snapshot
 *   const { context, isStreamingRequest, parsedBody } =
 *     buildRequestContextFromSnapshot(snapshot, rewrittenPath, requestLog);
 *
 *   // Plugins can modify context without affecting next retry
 *   await executePlugins(context);
 * }
 * ```
 */
export function buildRequestContextFromSnapshot(
  snapshot: RequestSnapshot,
  rewrittenPath: { pathname: string; search: string },
  requestLog: any
): RequestContextResult {
  const url = new URL(snapshot.url);

  // Deep clone the body to ensure isolation
  const parsedBody = snapshot.isJsonBody && snapshot.body
    ? structuredClone(snapshot.body)
    : {};

  // Build expression context with deep cloned data
  const context: ExpressionContext = {
    headers: structuredClone(snapshot.headers),
    body: parsedBody,
    url: {
      pathname: rewrittenPath.pathname,
      search: rewrittenPath.search,
      host: url.hostname,
      protocol: url.protocol
    },
    method: snapshot.method,
    env: process.env as Record<string, string>,
  };

  return {
    context,
    isStreamingRequest: !!parsedBody.stream,
    parsedBody
  };
}
