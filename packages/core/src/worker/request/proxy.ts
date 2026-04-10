/**
 * Request proxy module
 * Core logic for proxying requests to upstream servers
 */

import { logger } from '../../logger';
import { forEach, isEmpty } from 'lodash-es';
import type { AppConfig, RouteConfig } from '@jeffusion/bungee-types';
import type { RequestLogger } from '../../logger/request-logger';
import { processDynamicValue } from '../../expression-engine';
import type { RuntimeUpstream, RequestSnapshot } from '../types';
import { getScopedPluginRegistry } from '../../scoped-plugin-registry';
import { buildRequestContextFromSnapshot } from './context-builder';
import { deepMergeRules, applyBodyRules, applyQueryRules } from '../rules/modifier';
import { prepareResponse, type StreamCompletionState } from '../response/processor';

type ExtendedRequestInit = RequestInit & { verbose?: boolean };
type NetworkError = Error & { code?: string };

export interface ProxyRequestResult {
  response: Response;
  streamCompletionState?: StreamCompletionState;
}

/**
 * Proxies a request to an upstream server
 *
 * This is the core request handling function that:
 * 1. Loads and deduplicates plugins
 * 2. Applies path rewriting
 * 3. Executes plugin hooks (onion model)
 * 4. Applies body/header modification rules
 * 5. Sends request to upstream
 * 6. Processes response
 * 7. Handles errors
 *
 * **Plugin execution order** (onion model):
 * - Request: onRequestInit → onBeforeRequest → onInterceptRequest
 * - Response: onResponse (reverse order)
 * - Error: onError (reverse order)
 *
 * @param requestSnapshot - Request snapshot (for failover isolation)
 * @param route - Route configuration
 * @param upstream - Target upstream server
 * @param requestLog - Request log for debugging
 * @param config - Application configuration
 * @param routeId - Route ID for precompiled hooks lookup
 * @param reqLogger - Request logger for recording
 * @returns Response from upstream (or plugin)
 *
 * @example
 * ```typescript
 * const response = await proxyRequest(
 *   snapshot,
 *   route,
 *   selectedUpstream,
 *   requestLog,
 *   config,
 *   route.path,
 *   reqLogger
 * );
 * ```
 */
export async function proxyRequest(
  requestSnapshot: RequestSnapshot,
  route: RouteConfig,
  upstream: RuntimeUpstream,
  requestLog: any,
  config: AppConfig,
  routeId: string,
  reqLogger?: RequestLogger
): Promise<ProxyRequestResult> {
  // Record start time for latency calculation
  const requestStartTime = Date.now();

  // Log snapshot usage for debugging
  const bodySize = requestSnapshot.body
    ? (requestSnapshot.isJsonBody
      ? JSON.stringify(requestSnapshot.body).length
      : requestSnapshot.body.byteLength)
    : 0;

  logger.debug(
    {
      request: requestLog,
      upstream: upstream.target,
      snapshot: {
        method: requestSnapshot.method,
        hasBody: !!requestSnapshot.body,
        bodyType: requestSnapshot.isJsonBody ? 'json' : 'binary',
        bodySize,
        isRetry: upstream.status === 'UNHEALTHY'
      }
    },
    'Using request snapshot for upstream attempt'
  );

  // ===== 获取预编译的 Hooks（O(1) 查找）=====
  const upstreamId = upstream.upstreamId; // Use the unique upstreamId
  const scopedRegistry = getScopedPluginRegistry();
  const precompiledHooks = scopedRegistry?.getPrecompiledHooks(routeId, upstreamId) ?? null;

  // Extract request metadata for plugin hooks
  const clientIP = requestSnapshot.headers['x-forwarded-for'] ||
                   requestSnapshot.headers['x-real-ip'] ||
                   'unknown';
  const requestId = reqLogger?.getRequestInfo().requestId || crypto.randomUUID();

  // 记录使用的预编译 hooks 信息
  if (precompiledHooks) {
    logger.debug(
      {
        request: requestLog,
        pluginCount: precompiledHooks.metadata.pluginCount,
        plugins: precompiledHooks.metadata.pluginNames,
        scope: precompiledHooks.metadata.scope
      },
      'Using precompiled hooks for request'
    );
  }

  // ===== 1. Set target URL and apply route-level pathRewrite =====
  const targetUrl = new URL(upstream.target);
  const targetBasePath = targetUrl.pathname;
  const snapshotUrl = new URL(requestSnapshot.url);
  targetUrl.pathname = snapshotUrl.pathname;
  targetUrl.search = snapshotUrl.search;

  if (route.pathRewrite) {
    const originalPathname = targetUrl.pathname;
    for (const [pattern, replacement] of Object.entries(route.pathRewrite)) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(targetUrl.pathname)) {
          targetUrl.pathname = targetUrl.pathname.replace(regex, replacement);
          logger.debug(
            {
              request: requestLog,
              path: { from: originalPathname, to: targetUrl.pathname },
              rule: { pattern, replacement }
            },
            `Applied route pathRewrite`
          );
          break;
        }
      } catch (error) {
        logger.error({ request: requestLog, pattern, error }, 'Invalid regex in pathRewrite rule');
      }
    }
  }

  // 记录 pathRewrite 转换后的路径（不包含 base path）
  if (reqLogger && targetUrl.pathname !== snapshotUrl.pathname) {
    reqLogger.setTransformedPath(targetUrl.pathname);
    logger.debug({ request: requestLog, transformedPath: targetUrl.pathname }, 'Path after pathRewrite');
  }

  // ===== 2. Build initial context from snapshot =====
  const { context, isStreamingRequest, parsedBody } = buildRequestContextFromSnapshot(
    requestSnapshot,
    { pathname: targetUrl.pathname, search: targetUrl.search },
    requestLog
  );

  // ===== 3. Plugin onRequestInit (outer layer) =====
  const originalUrl = new URL(requestSnapshot.url);

  if (precompiledHooks) {
    const ctx = {
      method: requestSnapshot.method,
      originalUrl,
      clientIP,
      requestId,
      routeId,
      upstreamId,
    };
    const pluginInitStartTime = performance.now();
    await precompiledHooks.hooks.onRequestInit.promise(ctx);
    const pluginInitDuration = performance.now() - pluginInitStartTime;

    // 记录 plugin onRequestInit 执行（带耗时）
    if (reqLogger && precompiledHooks.metadata.pluginCount > 0) {
      reqLogger.addStepWithDuration('plugin_request_init', pluginInitDuration, {
        count: precompiledHooks.metadata.pluginCount,
        plugins: precompiledHooks.metadata.pluginNames
      });
    }
  }

  // ===== 4. Apply route and upstream modification rules =====
  // Layer 1 (Outer): Route and Upstream rules
  const { path: routePath, upstreams, ...routeModificationRules } = route;
  const { target, weight, priority, plugins: upstreamPlugins, ...upstreamModificationRules } = upstream;
  const routeAndUpstreamRequestRules = deepMergeRules(routeModificationRules, upstreamModificationRules);

  let intermediateContext = { ...context };
  let intermediateBody = parsedBody;

  if (routeAndUpstreamRequestRules.body) {
    logger.debug({ request: requestLog }, "Applying Route + Upstream body rules (Layer 1)");
    intermediateBody = await applyBodyRules(
      parsedBody,
      routeAndUpstreamRequestRules.body,
      intermediateContext,
      requestLog
    );
    intermediateContext.body = intermediateBody;
  }

  // Rebuild context with the final body
  const finalContext = { ...context, body: intermediateBody };
  let finalBody = intermediateBody;

  // ===== 5. Prepare final headers from snapshot =====
  const finalRequestRules = routeAndUpstreamRequestRules;
  // Shallow copy is sufficient for headers (all values are strings)
  const headers = new Headers({ ...requestSnapshot.headers });
  headers.delete('host');

  // 5.1. Remove Authorization header (if auth is enabled)
  const effectiveAuthConfig = route.auth ?? config.auth;
  if (effectiveAuthConfig?.enabled) {
    headers.delete('Authorization');
    logger.debug(
      { request: requestLog },
      'Removed Authorization header after authentication (automatic security measure)'
    );
  }

  // 5.2. Apply header modification rules
  if (finalRequestRules.headers) {
    if (finalRequestRules.headers.remove) {
      forEach(finalRequestRules.headers.remove, (key) => headers.delete(key));
    }
    if (finalRequestRules.headers.replace) {
      forEach(finalRequestRules.headers.replace, (value, key) => {
        if (headers.has(key)) {
          try {
            headers.set(key, String(processDynamicValue(value, finalContext)));
          } catch (e) {
            logger.error(
              { request: requestLog, error: (e as Error).message },
              "Header replace expression failed"
            );
          }
        }
      });
    }
    if (finalRequestRules.headers.add) {
      forEach(finalRequestRules.headers.add, (value, key) => {
        try {
          headers.set(key, String(processDynamicValue(value, finalContext)));
        } catch (e) {
          logger.error(
            { request: requestLog, error: (e as Error).message },
            "Header add expression failed"
          );
        }
      });
    }
  }

  // 5.3. Apply query parameter modification rules
  if (finalRequestRules.query) {
    logger.debug({ request: requestLog }, "Applying query parameter rules");
    const modifiedSearchParams = applyQueryRules(
      new URLSearchParams(targetUrl.search),
      finalRequestRules.query,
      finalContext,
      requestLog
    );
    targetUrl.search = modifiedSearchParams.toString();
  }

  // ===== 6. Prepare final body from snapshot =====
  let body: BodyInit | null = null;

  if (requestSnapshot.body) {
    if (requestSnapshot.isJsonBody) {
      // JSON body - serialize finalBody (which may have been modified by plugins/rules)
      body = JSON.stringify(finalBody);
      if (!isEmpty(finalBody)) {
        headers.set('Content-Length', String(Buffer.byteLength(body as string)));
      } else {
        headers.delete('Content-Length');
      }
    } else {
      // Non-JSON body - use original data from snapshot (ArrayBuffer can be reused)
      body = requestSnapshot.body;
    }
  }

  // 6.1. Record request headers before plugin transformation
  // Note: Headers and body will be recorded again after plugin transformation
  if (reqLogger) {
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    reqLogger.setRequestHeaders(requestHeaders);
  }

  // ===== 7. Plugin onBeforeRequest =====
  let pluginBeforeRequestDuration = 0;
  if (precompiledHooks) {
    // 转换 headers 为 Record
    const headersObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headersObj[k] = v;
    });

    const ctx = {
      method: requestSnapshot.method,
      originalUrl,
      url: targetUrl,
      headers: headersObj,
      body: finalBody,
      clientIP,
      requestId,
      routeId,
      upstreamId,
    };

    const beforeRequestStartTime = performance.now();
    const result = await precompiledHooks.hooks.onBeforeRequest.promise(ctx);
    pluginBeforeRequestDuration = performance.now() - beforeRequestStartTime;

    // Apply modifications from plugins
    targetUrl.href = result.url.href;
    headers.forEach((_, key) => {
      headers.delete(key);
    });
    for (const [key, value] of Object.entries(result.headers)) {
      headers.set(key, value);
    }
    finalBody = result.body;

    // 记录 plugin onBeforeRequest 执行（带耗时）
    if (reqLogger && precompiledHooks.metadata.pluginCount > 0) {
      reqLogger.addStepWithDuration('plugin_before_request', pluginBeforeRequestDuration, {
        count: precompiledHooks.metadata.pluginCount,
        plugins: precompiledHooks.metadata.pluginNames
      });
    }
  }

  // 记录插件转换后的最终路径（仍不包含 base path）
  if (reqLogger) {
    reqLogger.setTransformedPath(targetUrl.pathname);
    logger.debug({ request: requestLog, finalTransformedPath: targetUrl.pathname }, 'Path after plugins');
  }

  // 7.1 Re-serialize body after plugins have modified it
  if (requestSnapshot.body && requestSnapshot.isJsonBody) {
    body = JSON.stringify(finalBody);
    if (!isEmpty(finalBody)) {
      headers.set('Content-Length', String(Buffer.byteLength(body as string)));
    } else {
      headers.delete('Content-Length');
    }
  }

  // 7.2 Record headers and body after plugin transformation
  if (reqLogger) {
    // Record transformed headers
    const transformedHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      transformedHeaders[key] = value;
    });
    reqLogger.setRequestHeaders(transformedHeaders);

    // Record transformed body (只记录 JSON 类型)
    if (config.logging?.body?.enabled && requestSnapshot.isJsonBody && finalBody) {
      try {
        reqLogger.setRequestBody(finalBody);
      } catch (err) {
        logger.warn(
          { request: requestLog, error: err },
          'Failed to record transformed request body'
        );
      }
    }
  }

  // ===== 8. Plugin onInterceptRequest (may short-circuit) =====
  if (precompiledHooks && precompiledHooks.hasInterceptCallbacks) {
    const headersObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headersObj[k] = v;
    });

    const ctx = {
      method: requestSnapshot.method,
      originalUrl,
      url: targetUrl,
      headers: headersObj,
      body: finalBody,
      clientIP,
      requestId,
      routeId,
      upstreamId,
    };

    const interceptStartTime = performance.now();
    const interceptedResponse = await precompiledHooks.hooks.onInterceptRequest.promise(ctx);
    const interceptDuration = performance.now() - interceptStartTime;

    if (interceptedResponse) {
      // 记录 plugin 拦截（带耗时）
      if (reqLogger) {
        reqLogger.addStepWithDuration('plugin_intercepted', interceptDuration, {
          message: 'Request intercepted by plugin'
        });
      }
      return { response: interceptedResponse };
    }
  }

  // ===== 9. Execute the request =====
  logger.debug({ request: requestLog, target: targetUrl.href }, `\n=== Proxying to target ===`);

  // 9.1. 添加上游 base path（在发送请求前）
  targetUrl.pathname = (targetBasePath === '/' ? '' : targetBasePath.replace(/\/$/, '')) + targetUrl.pathname;
  logger.debug({ request: requestLog, finalPath: targetUrl.pathname }, 'Final path with base path');

  let requestTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const clearRequestTimeout = () => {
    if (requestTimeoutId) {
      clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  };

  try {
    // Determine timeout based on upstream health status
    // HALF_OPEN uses recovery timeout (test window), others use normal timeout
    const isRecoveryAttempt = upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN';
    const recoveryTimeoutMs = route.failover?.recoveryTimeoutMs || 3000;
    const configuredRequestTimeoutMs = route.failover?.requestTimeoutMs || 30000;
    const timeoutMs = isRecoveryAttempt ? recoveryTimeoutMs : configuredRequestTimeoutMs;
    const connectTimeoutMs = route.failover?.connectTimeoutMs || 5000;

    let fetchOptions: ExtendedRequestInit = {
      method: requestSnapshot.method,
      headers,
      body,
      redirect: 'manual',
      keepalive: true,
      verbose: true
    };

    let headerCount = 0;
    headers.forEach(() => {
      headerCount += 1;
    });
    logger.debug(
      {
        request: requestLog,
        target: targetUrl.href,
        fetchOptions: {
          method: fetchOptions.method,
          redirect: fetchOptions.redirect,
          keepalive: fetchOptions.keepalive,
          verbose: fetchOptions.verbose,
          hasBody: Boolean(fetchOptions.body),
          headerCount
        },
        timeouts: {
          connectTimeoutMs,
          requestTimeoutMs: timeoutMs
        }
      },
      'Configured fetch options for upstream request'
    );

    // Add timeout control for all requests (with AbortController)
    const controller = new AbortController();
    type TimeoutReason = 'connect_timeout' | 'request_timeout';
    let abortReason: TimeoutReason | null = null;
    const abortWithReason = (reason: TimeoutReason) => {
      if (abortReason) {
        return;
      }
      abortReason = reason;
      controller.abort();
    };
    const connectTimeoutId = setTimeout(() => abortWithReason('connect_timeout'), connectTimeoutMs);
    requestTimeoutId = setTimeout(() => abortWithReason('request_timeout'), timeoutMs);
    fetchOptions.signal = controller.signal;

    logger.debug(
      {
        request: requestLog,
        timeout: timeoutMs,
        connectTimeout: connectTimeoutMs,
        upstreamStatus: upstream.status,
        isRecoveryAttempt,
        target: targetUrl.href
      },
      `Request with ${isRecoveryAttempt ? 'recovery' : 'normal'} timeout`
    );

    let proxyRes: Response;
    try {
      proxyRes = await fetch(targetUrl.href, fetchOptions);
      clearTimeout(connectTimeoutId);
    } catch (error) {
      clearTimeout(connectTimeoutId);
      clearRequestTimeout();
      if ((error as Error).name === 'AbortError') {
        const timeoutType = abortReason === 'connect_timeout' ? 'connect' : 'request';
        const exceededMs = timeoutType === 'connect' ? connectTimeoutMs : timeoutMs;
        const timeoutMessage =
          timeoutType === 'connect'
            ? `Connection timeout: ${connectTimeoutMs}ms exceeded`
            : `Request timeout: ${timeoutMs}ms exceeded`;
        logger.warn(
          {
            request: requestLog,
            target: targetUrl.href,
            timeout: exceededMs,
            timeoutType,
            upstreamStatus: upstream.status,
            isRecoveryAttempt
          },
          timeoutMessage
        );
        throw new Error(timeoutMessage, { cause: error as Error });
      }
      const networkError = error as NetworkError;
      const code = networkError?.code;
      const rawMessage = networkError?.message || 'Unknown network error';
      const normalizedMessage = rawMessage.toLowerCase();
      let category: 'connection' | 'socket' | 'dns' | 'network' = 'network';
      let friendlyMessage = `Network error while proxying to ${targetUrl.href}: ${rawMessage}`;

      const connectionErrorCodes = new Set([
        'ECONNREFUSED',
        'ECONNRESET',
        'ECONNABORTED',
        'EHOSTUNREACH',
        'EPIPE',
        'ETIMEDOUT'
      ]);
      const dnsErrorCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ESERVFAIL']);

      if (code && connectionErrorCodes.has(code)) {
        category = 'connection';
        friendlyMessage = `Connection error (${code}) while proxying to ${targetUrl.href}`;
      } else if (code && dnsErrorCodes.has(code)) {
        category = 'dns';
        friendlyMessage = `DNS lookup failed (${code}) for ${targetUrl.hostname}`;
      } else if (normalizedMessage.includes('socket')) {
        category = 'socket';
        friendlyMessage = `Socket error while communicating with ${targetUrl.href}: ${rawMessage}`;
      }

      logger.error(
        {
          request: requestLog,
          target: targetUrl.href,
          errorCode: code,
          category,
          upstreamStatus: upstream.status,
          isRecoveryAttempt,
          message: rawMessage,
          timeouts: {
            connectTimeoutMs,
            requestTimeoutMs: timeoutMs
          }
        },
        `Proxy request failed (${category})`
      );
      throw new Error(friendlyMessage, { cause: error as Error });
    }

    logger.debug(
      { request: requestLog, status: proxyRes.status, target: targetUrl.href },
      `\n=== Received Response from target ===`
    );

    // ===== 10. Plugin onResponse (inbound) =====
    if (!isStreamingRequest && precompiledHooks && precompiledHooks.hasResponseCallbacks) {
      const latencyMs = Date.now() - requestStartTime;
      const ctx = {
        method: requestSnapshot.method,
        originalUrl,
        response: proxyRes,
        latencyMs,
        clientIP,
        requestId,
        routeId,
        upstreamId,
      };
      const responseStartTime = performance.now();
      proxyRes = await precompiledHooks.hooks.onResponse.promise(proxyRes, ctx);
      const responseDuration = performance.now() - responseStartTime;

      // 记录 plugin onResponse 执行（带耗时）
      if (reqLogger && precompiledHooks.metadata.pluginCount > 0) {
        reqLogger.addStepWithDuration('plugin_response', responseDuration, {
          count: precompiledHooks.metadata.pluginCount,
          plugins: [...precompiledHooks.metadata.pluginNames].reverse() // 反向顺序
        });
      }
    }

    // ===== 11. Prepare the response =====
    const finalResponseRules = upstreamModificationRules;

    // Build stream request context for stream processing
    const streamRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      clientIP,
      requestId,
      routeId,
      upstreamId,
    };

    const streamCompletionState: StreamCompletionState | undefined =
      isStreamingRequest && proxyRes.headers.get('content-type')?.includes('text/event-stream')
        ? { interrupted: false, cancelled: false }
        : undefined;

    const { headers: responseHeaders, body: responseBody } = await prepareResponse(
      proxyRes,
      finalResponseRules,
      context,
      requestLog,
      isStreamingRequest,
      reqLogger,
      config,
      precompiledHooks?.hooks,
      streamRequestContext,
      streamCompletionState
    );

    clearRequestTimeout();
    return {
      response: new Response(responseBody, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: responseHeaders,
      }),
      streamCompletionState,
    };
  } catch (error) {
    clearRequestTimeout();
    // ===== 12. Plugin onError (inbound) =====
    let errorDuration = 0;
    if (precompiledHooks) {
      const headersObj: Record<string, string> = {};
        headers.forEach((v, k) => {
          headersObj[k] = v;
        });

      const ctx = {
        method: requestSnapshot.method,
        originalUrl,
        error: error as Error,
        headers: headersObj,
        body: finalBody,
        clientIP,
        requestId,
        routeId,
        upstreamId,
      };
      const errorStartTime = performance.now();
      await precompiledHooks.hooks.onError.promise(ctx);
      errorDuration = performance.now() - errorStartTime;

      // 记录 plugin onError 执行（带耗时）
      if (reqLogger && precompiledHooks.metadata.pluginCount > 0) {
        reqLogger.addStepWithDuration('plugin_error', errorDuration, {
          count: precompiledHooks.metadata.pluginCount,
          plugins: [...precompiledHooks.metadata.pluginNames].reverse(), // 反向顺序
          error: (error as Error).message
        });
      }
    }

    throw error;
  }
  // 注：预编译 hooks 无需 acquire/release，长生命周期实例
}
