/**
 * Request proxy module
 * Core logic for proxying requests to upstream servers
 */

import { logger } from '../../logger';
import { forEach, isEmpty } from 'lodash-es';
import type { AppConfig, RouteConfig } from '@jeffusion/bungee-shared';
import type { RequestLogger } from '../../logger/request-logger';
import type { Plugin } from '../../plugin.types';
import { processDynamicValue } from '../../expression-engine';
import type { RuntimeUpstream, RequestSnapshot } from '../types';
import { getPluginRegistry } from '../state/plugin-manager';
import { buildRequestContextFromSnapshot } from './context-builder';
import { deepMergeRules, applyBodyRules } from '../rules/modifier';
import { PluginExecutor } from '../plugin/executor';
import { prepareResponse } from '../response/processor';
import { createPluginUrl } from '../plugin/url-adapter';

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
 * @param routePlugins - Route-specific plugins
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
 *   routePlugins,
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
  routePlugins: Plugin[],
  reqLogger?: RequestLogger
): Promise<Response> {
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

  const allRoutePlugins = [...routePlugins];
  const pluginRegistry = getPluginRegistry();

  // ===== Load upstream-level plugins =====
  if (upstream.plugins && pluginRegistry) {
    for (const pluginConfig of upstream.plugins) {
      try {
        const plugin = await pluginRegistry.loadPluginFromConfig(pluginConfig);
        if (plugin) {
          // Avoid duplicates (if route already loaded the same plugin)
          if (!allRoutePlugins.some(p => p.name === plugin.name)) {
            allRoutePlugins.push(plugin);
            logger.debug(
              { pluginName: plugin.name, request: requestLog },
              'Upstream plugin loaded'
            );
          }
        }
      } catch (error) {
        logger.error(
          { error, pluginConfig, request: requestLog },
          'Failed to load upstream plugin'
        );
      }
    }
  }

  // Deduplicate plugins: Remove route plugins that are already in global registry
  // This prevents double execution when a plugin is configured both globally and per-route
  const globalPluginNames = new Set<string>();
  if (pluginRegistry) {
    const globalPlugins = pluginRegistry.getEnabledPlugins();
    globalPlugins.forEach(p => globalPluginNames.add(p.name));
  }

  const dedupedRoutePlugins = allRoutePlugins.filter(p => !globalPluginNames.has(p.name));

  // Create plugin executor
  const pluginExecutor = new PluginExecutor(pluginRegistry, dedupedRoutePlugins);

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
  const headersObj: Record<string, string> = structuredClone(requestSnapshot.headers);

  let pluginContext = {
    method: requestSnapshot.method,
    url: createPluginUrl(targetUrl),
    headers: headersObj,
    body: parsedBody,
    request: requestLog
  };

  await pluginExecutor.executeOnRequestInit(pluginContext);

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
  const headers = new Headers(structuredClone(requestSnapshot.headers));
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
  finalBody = await pluginExecutor.executeOnBeforeRequest(
    pluginContext,
    targetUrl,
    headers,
    finalBody
  );

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
  const interceptedResponse = await pluginExecutor.executeOnInterceptRequest(
    pluginContext,
    targetUrl,
    headers,
    finalBody
  );

  if (interceptedResponse) {
    return interceptedResponse;
  }

  // ===== 9. Execute the request =====
  logger.info({ request: requestLog, target: targetUrl.href }, `\n=== Proxying to target ===`);

  // 9.1. 添加上游 base path（在发送请求前）
  targetUrl.pathname = (targetBasePath === '/' ? '' : targetBasePath.replace(/\/$/, '')) + targetUrl.pathname;
  logger.debug({ request: requestLog, finalPath: targetUrl.pathname }, 'Final path with base path');

  try {
    // Determine timeout based on upstream health status
    // HALF_OPEN uses recovery timeout (test window), others use normal timeout
    const isRecoveryAttempt = upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN';
    const recoveryTimeoutMs = route.failover?.recoveryTimeoutMs || 3000;
    const requestTimeoutMs = route.failover?.requestTimeoutMs || 30000;
    const timeoutMs = isRecoveryAttempt ? recoveryTimeoutMs : requestTimeoutMs;

    let fetchOptions: RequestInit = {
      method: requestSnapshot.method,
      headers,
      body,
      redirect: 'manual'
    };

    // Add timeout control for all requests (with AbortController)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;

    logger.debug(
      {
        request: requestLog,
        timeout: timeoutMs,
        upstreamStatus: upstream.status,
        isRecoveryAttempt,
        target: targetUrl.href
      },
      `Request with ${isRecoveryAttempt ? 'recovery' : 'normal'} timeout`
    );

    let proxyRes: Response;
    try {
      proxyRes = await fetch(targetUrl.href, fetchOptions);
      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        logger.warn(
          {
            request: requestLog,
            target: targetUrl.href,
            timeout: timeoutMs,
            upstreamStatus: upstream.status,
            isRecoveryAttempt
          },
          `Request timed out after ${timeoutMs}ms`
        );
        throw new Error(`Request timeout: ${timeoutMs}ms exceeded`);
      }
      throw error;
    }

    logger.info(
      { request: requestLog, status: proxyRes.status, target: targetUrl.href },
      `\n=== Received Response from target ===`
    );

    // ===== 10. Plugin onResponse (inbound) =====
    if (!isStreamingRequest) {
      proxyRes = await pluginExecutor.executeOnResponse(
        requestSnapshot.method,
        targetUrl,
        requestLog,
        proxyRes
      );
    }

    // ===== 11. Prepare the response =====
    const finalResponseRules = upstreamModificationRules;

    const { headers: responseHeaders, body: responseBody } = await prepareResponse(
      proxyRes,
      finalResponseRules,
      context,
      requestLog,
      isStreamingRequest,
      reqLogger,
      config,
      dedupedRoutePlugins,
      pluginRegistry
    );

    return new Response(responseBody, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    // ===== 12. Plugin onError (inbound) =====
    await pluginExecutor.executeOnError(
      requestSnapshot.method,
      targetUrl,
      headers,
      finalBody,
      requestLog,
      error as Error
    );

    throw error;
  }
}
