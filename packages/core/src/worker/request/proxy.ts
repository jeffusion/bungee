/**
 * Request proxy module
 * Core logic for proxying requests to upstream servers
 */

import { logger } from '../../logger';
import { forEach, isEmpty } from 'lodash-es';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { RequestLogger } from '../../logger/request-logger';
import { processDynamicValue } from '../../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream, RequestSnapshot } from '../types';
import type { PhaseAwareHooks } from '../../scoped-plugin-registry';
import { buildRequestContextFromSnapshot } from './context-builder';
import type { MutableRequestContext as HookMutableRequestContext } from '../../hooks';
import { LegacyCompatAdapter } from '../../compat/legacy-plugin-adapter';
import { cloneMutableRequestContext, rebaseToUpstream, type MutableRequestContext } from './context';
import { deepMergeRules, applyBodyRules, applyQueryRules } from '../rules/modifier';
import { prepareResponse, type StreamCompletionState } from '../response/processor';

type ExtendedRequestInit = RequestInit & { verbose?: boolean };
type NetworkError = Error & { code?: string };

export interface ProxyRequestResult {
  response: Response;
  streamCompletionState?: StreamCompletionState;
  upstreamId: string;
  shortCircuitedByPlugin?: boolean;
}

export class UpstreamPhaseFailoverSignal extends Error {
  readonly reason?: string;

  constructor(reason?: string) {
    super(reason ? `Upstream phase requested failover: ${reason}` : 'Upstream phase requested failover');
    this.name = 'UpstreamPhaseFailoverSignal';
    this.reason = reason;
  }
}

export function isUpstreamPhaseFailoverSignal(error: unknown): error is UpstreamPhaseFailoverSignal {
  return error instanceof UpstreamPhaseFailoverSignal;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function createExpressionContext(ctx: MutableRequestContext) {
  return {
    headers: ctx.headers,
    body: ctx.body ?? {},
    url: {
      pathname: ctx.url.pathname,
      search: ctx.url.search,
      host: ctx.url.hostname,
      protocol: ctx.url.protocol,
    },
    method: ctx.method,
    env: process.env as Record<string, string>,
  };
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
  route: EffectiveRouteConfig,
  upstream: RuntimeUpstream,
  requestLog: any,
  config: AppConfig,
  routeId: string,
  reqLogger?: RequestLogger,
  phaseAwareHooks?: PhaseAwareHooks | null,
  phase1and2Context?: MutableRequestContext
): Promise<ProxyRequestResult> {
  // Record start time for latency calculation
  const requestStartTime = Date.now();

  // Log snapshot usage for debugging
  const bodySize = requestSnapshot.body
    ? (requestSnapshot.is_json_body
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
        bodyType: requestSnapshot.is_json_body ? 'json' : 'binary',
        bodySize,
        isRetry: upstream.status === 'UNHEALTHY'
      }
    },
    'Using request snapshot for upstream attempt'
  );

  const upstream_id = upstream.upstream_id; // Use the unique upstream_id
  const upstreamPhase = phaseAwareHooks?.upstreamPhase ?? null;

  // Extract request metadata for plugin hooks
  const clientIP = requestSnapshot.headers['x-forwarded-for'] ||
                   requestSnapshot.headers['x-real-ip'] ||
                   'unknown';
  const requestId = phase1and2Context?.requestId || requestLog?.requestId || reqLogger?.getRequestInfo().requestId || crypto.randomUUID();
  const originalUrl = new URL(requestSnapshot.url);

  if (upstreamPhase) {
    logger.debug(
      {
        request: requestLog,
        pluginCount: upstreamPhase.metadata.pluginCount,
        plugins: upstreamPhase.metadata.pluginNames,
        scope: upstreamPhase.metadata.scope
      },
      'Using upstream phase hooks for request'
    );
  }

  // ===== 1. Prepare route-relative URL and apply route-level path_rewrite =====
  const targetUrl = new URL(upstream.target);
  const targetBasePath = targetUrl.pathname;
  const routeRelativeUrl = new URL(phase1and2Context?.url.toString() ?? requestSnapshot.url);

  if (route.path_rewrite) {
    const originalPathname = routeRelativeUrl.pathname;
    for (const [pattern, replacement] of Object.entries(route.path_rewrite)) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(routeRelativeUrl.pathname)) {
          routeRelativeUrl.pathname = routeRelativeUrl.pathname.replace(regex, replacement);
          logger.debug(
            {
              request: requestLog,
              path: { from: originalPathname, to: routeRelativeUrl.pathname },
              rule: { pattern, replacement }
            },
            `Applied route path_rewrite`
          );
          break;
        }
      } catch (error) {
        logger.error({ request: requestLog, pattern, error }, 'Invalid regex in path_rewrite rule');
      }
    }
  }

  // 记录 path_rewrite 转换后的路径（不包含 base path）
  if (reqLogger && routeRelativeUrl.pathname !== new URL(requestSnapshot.url).pathname) {
    reqLogger.setTransformedPath(routeRelativeUrl.pathname);
    logger.debug({ request: requestLog, transformedPath: routeRelativeUrl.pathname }, 'Path after path_rewrite');
  }

  // ===== 2. Build initial context from snapshot =====
  const { isStreamingRequest, parsedBody } = buildRequestContextFromSnapshot(
    requestSnapshot,
    { pathname: routeRelativeUrl.pathname, search: routeRelativeUrl.search },
    requestLog
  );

  const attemptContext: MutableRequestContext = phase1and2Context
    ? cloneMutableRequestContext(phase1and2Context)
    : {
      method: requestSnapshot.method,
      originalUrl,
      url: routeRelativeUrl,
      headers: { ...requestSnapshot.headers },
      body: parsedBody,
      clientIP,
      requestId,
      routeId,
      serviceName: route.service,
    };
  attemptContext.url = routeRelativeUrl;
  rebaseToUpstream(attemptContext, upstream);
  attemptContext.upstreamId = upstream_id;
  const targetUrlForRequest = attemptContext.url;

  // ===== 3. Apply route and upstream modification rules =====
  // Layer 1 (Outer): Route and Upstream rules
  const {
    path: routePath,
    endpoints,
    service,
    timeouts,
    failover,
    path_rewrite,
    auth,
    plugins,
    rate_limit,
    cors,
    direct_response,
    redirect,
    retry,
    ...routeModificationRules
  } = route;
  const {
    target,
    weight,
    priority,
    plugins: upstreamPlugins,
    id,
    is_disabled,
    upstream_id: runtime_upstream_id,
    status,
    last_failure_time,
    consecutive_failures,
    consecutive_successes,
    recovery_attempt_count,
    health_check_successes,
    health_check_failures,
    slow_start_recovery_time,
    slow_start_weight_factor,
    ...upstreamModificationRules
  } = upstream;
  const routeAndUpstreamRequestRules = deepMergeRules(routeModificationRules, upstreamModificationRules);

  let intermediateContext = createExpressionContext(attemptContext);
  let intermediateBody = attemptContext.body ?? parsedBody;

  if (routeAndUpstreamRequestRules.body) {
    logger.debug({ request: requestLog }, "Applying Route + Upstream body rules (Layer 1)");
    intermediateBody = await applyBodyRules(
      intermediateBody,
      routeAndUpstreamRequestRules.body,
      intermediateContext,
      requestLog
    );
    intermediateContext.body = intermediateBody;
  }

  // Rebuild context with the final body
  attemptContext.body = intermediateBody;
  const finalContext = { ...intermediateContext, body: intermediateBody };
  let finalBody = intermediateBody;

  // ===== 4. Prepare final headers from phase context =====
  const finalRequestRules = routeAndUpstreamRequestRules;
  // Shallow copy is sufficient for headers (all values are strings)
  const headers = new Headers({ ...attemptContext.headers });
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
      new URLSearchParams(targetUrlForRequest.search),
      finalRequestRules.query,
      finalContext,
      requestLog
    );
    targetUrlForRequest.search = modifiedSearchParams.toString();
  }

  // ===== 5. Prepare final body from snapshot =====
  let body: BodyInit | null = null;

  if (requestSnapshot.body) {
    if (requestSnapshot.is_json_body) {
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

  // ===== 6. Plugin onBeforeRequest (upstream phase) =====
  let pluginBeforeRequestDuration = 0;
  if (upstreamPhase) {
    const headersObj = headersToRecord(headers);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: targetUrlForRequest,
      headers: headersObj,
      body: finalBody,
      clientIP,
      requestId,
      routeId,
      upstreamId: upstream_id,
    };

    const beforeRequestStartTime = performance.now();
    const result = await upstreamPhase.hooks.onBeforeRequest.promise(ctx);
    pluginBeforeRequestDuration = performance.now() - beforeRequestStartTime;

    // Apply modifications from plugins
    targetUrlForRequest.href = result.url.href;
    headers.forEach((_, key) => {
      headers.delete(key);
    });
    for (const [key, value] of Object.entries(result.headers)) {
      headers.set(key, value);
    }
    finalBody = result.body;
    attemptContext.url = targetUrlForRequest;
    attemptContext.headers = { ...result.headers };
    attemptContext.body = finalBody;

    // 记录 plugin onBeforeRequest 执行（带耗时）
    if (reqLogger && upstreamPhase.metadata.pluginCount > 0) {
      reqLogger.addStepWithDuration('plugin_before_request', pluginBeforeRequestDuration, {
        count: upstreamPhase.metadata.pluginCount,
        plugins: upstreamPhase.metadata.pluginNames
      });
    }
  }

  // 记录插件转换后的最终路径（仍不包含 base path）
  if (reqLogger) {
    reqLogger.setTransformedPath(targetUrlForRequest.pathname);
    logger.debug({ request: requestLog, finalTransformedPath: targetUrlForRequest.pathname }, 'Path after plugins');
  }

  // 7.1 Re-serialize body after plugins have modified it
  if (requestSnapshot.body && requestSnapshot.is_json_body) {
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
    if (config.logging?.body?.enabled && requestSnapshot.is_json_body && finalBody) {
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

  // ===== 7. Plugin onInterceptRequest (upstream phase, may short-circuit or failover) =====
  if (upstreamPhase && upstreamPhase.hasInterceptCallbacks) {
    const headersObj = headersToRecord(headers);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: targetUrlForRequest,
      headers: headersObj,
      body: finalBody,
      clientIP,
      requestId,
      routeId,
      upstreamId: upstream_id,
    };

    const interceptStartTime = performance.now();
    const interceptResult = await upstreamPhase.hooks.onInterceptRequest.promise(ctx);
    const adaptedInterceptResult = LegacyCompatAdapter.adaptInterceptResult(interceptResult);
    const interceptDuration = performance.now() - interceptStartTime;

    if (adaptedInterceptResult?.action === 'respond') {
      // 记录 plugin 拦截（带耗时）
      if (reqLogger) {
        reqLogger.addStepWithDuration('plugin_intercepted', interceptDuration, {
          message: 'Request intercepted by plugin'
        });
      }
      return { response: adaptedInterceptResult.response, upstreamId: upstream_id, shortCircuitedByPlugin: true };
    }

    if (adaptedInterceptResult?.action === 'failover') {
      throw new UpstreamPhaseFailoverSignal(adaptedInterceptResult.reason);
    }
  }

  // ===== 8. Execute the request =====
  logger.debug({ request: requestLog, target: targetUrlForRequest.href }, `\n=== Proxying to target ===`);
  logger.debug({ request: requestLog, finalPath: targetUrlForRequest.pathname, targetBasePath }, 'Final path with base path');

  let requestTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const clearRequestTimeout = () => {
    if (requestTimeoutId) {
      clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  };

  try {
    const failoverEnabled = route.failover?.enabled === true;
    const isRecoveryAttempt = failoverEnabled &&
      (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN');
    const recoveryTimeoutMs = route.failover?.recovery?.probe_timeout_ms || 3000;
    const configuredRequestTimeoutMs = route.timeouts?.request_ms || 30000;
    const timeoutMs = isRecoveryAttempt ? recoveryTimeoutMs : configuredRequestTimeoutMs;
    const connectTimeoutMs = route.timeouts?.connect_ms || 5000;

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
        target: targetUrlForRequest.href,
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
          target: targetUrlForRequest.href
      },
      `Request with ${isRecoveryAttempt ? 'recovery' : 'normal'} timeout`
    );

    let proxyRes: Response;
    try {
      proxyRes = await fetch(targetUrlForRequest.href, fetchOptions);
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
            target: targetUrlForRequest.href,
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
      let friendlyMessage = `Network error while proxying to ${targetUrlForRequest.href}: ${rawMessage}`;

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
        friendlyMessage = `Connection error (${code}) while proxying to ${targetUrlForRequest.href}`;
      } else if (code && dnsErrorCodes.has(code)) {
        category = 'dns';
        friendlyMessage = `DNS lookup failed (${code}) for ${targetUrlForRequest.hostname}`;
      } else if (normalizedMessage.includes('socket')) {
        category = 'socket';
        friendlyMessage = `Socket error while communicating with ${targetUrlForRequest.href}: ${rawMessage}`;
      }

      logger.error(
        {
          request: requestLog,
          target: targetUrlForRequest.href,
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
      { request: requestLog, status: proxyRes.status, target: targetUrlForRequest.href },
      `\n=== Received Response from target ===`
    );

    // ===== 9. Plugin onResponse (inbound chain) =====
    if (!isStreamingRequest && phaseAwareHooks) {
      const latencyMs = Date.now() - requestStartTime;
      const ctx = {
        method: requestSnapshot.method,
        originalUrl,
        response: proxyRes,
        latencyMs,
        clientIP,
        requestId,
        routeId,
        upstreamId: upstream_id,
      };
      const responseStartTime = performance.now();
      proxyRes = await phaseAwareHooks.inbound.onResponse(proxyRes, ctx);
      const responseDuration = performance.now() - responseStartTime;

      // 记录 plugin onResponse 执行（带耗时）
      if (reqLogger && upstreamPhase && upstreamPhase.metadata.pluginCount > 0) {
        reqLogger.addStepWithDuration('plugin_response', responseDuration, {
          count: upstreamPhase.metadata.pluginCount,
          plugins: upstreamPhase.metadata.pluginNames
        });
      }
    }

    // ===== 10. Prepare the response =====
    const finalResponseRules = upstreamModificationRules;

    // Build stream request context for stream processing
    const streamRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      clientIP,
      requestId,
      routeId,
      upstreamId: upstream_id,
    };

    const streamCompletionState: StreamCompletionState | undefined =
      isStreamingRequest && proxyRes.headers.get('content-type')?.includes('text/event-stream')
        ? { interrupted: false, cancelled: false }
        : undefined;

    const { headers: responseHeaders, body: responseBody } = await prepareResponse(
      proxyRes,
      finalResponseRules,
      createExpressionContext(attemptContext),
      requestLog,
      isStreamingRequest,
      reqLogger,
      config,
      undefined,
      streamRequestContext,
      streamCompletionState,
      phaseAwareHooks?.inbound,
      Boolean(phaseAwareHooks && (
        phaseAwareHooks.upstreamPhase.hasStreamCallbacks ||
        phaseAwareHooks.servicePhase?.hasStreamCallbacks ||
        phaseAwareHooks.routePhase.hasStreamCallbacks
      ))
    );

    clearRequestTimeout();
    return {
      response: new Response(responseBody, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: responseHeaders,
      }),
      streamCompletionState,
      upstreamId: upstream_id,
    };
  } catch (error) {
    clearRequestTimeout();
    if (error instanceof UpstreamPhaseFailoverSignal) {
      throw error;
    }

    // ===== 11. Plugin onError (inbound chain) =====
    let errorDuration = 0;
    if (phaseAwareHooks) {
      const headersObj = headersToRecord(headers);

      const ctx = {
        method: requestSnapshot.method,
        originalUrl,
        error: error as Error,
        headers: headersObj,
        body: finalBody,
        clientIP,
        requestId,
        routeId,
        upstreamId: upstream_id,
      };
      const errorStartTime = performance.now();
      await phaseAwareHooks.inbound.onError(ctx);
      errorDuration = performance.now() - errorStartTime;

      // 记录 plugin onError 执行（带耗时）
      if (reqLogger && upstreamPhase && upstreamPhase.metadata.pluginCount > 0) {
        reqLogger.addStepWithDuration('plugin_error', errorDuration, {
          count: upstreamPhase.metadata.pluginCount,
          plugins: upstreamPhase.metadata.pluginNames,
          error: (error as Error).message
        });
      }
    }

    throw error;
  }
  // 注：预编译 hooks 无需 acquire/release，长生命周期实例
}
