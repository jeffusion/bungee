/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../../logger';
import { RequestLogger } from '../../logger/request-logger';
import { find, filter, map, sortBy } from 'lodash-es';
import type { AppConfig } from '@jeffusion/bungee-shared';
import type { ExpressionContext } from '../../expression-engine';
import type { RuntimeUpstream } from '../types';
import { selectUpstream } from '../upstream/selector';
import { runtimeState } from '../state/runtime-state';
import { getPluginRegistry } from '../state/plugin-manager';
import type { Plugin } from '../../plugin.types';
import { createRequestSnapshot } from './snapshot';
import { proxyRequest } from './proxy';
import { authenticateRequest } from '../../auth';
import { handleUIRequest } from '../../ui/server';
import { statsCollector } from '../../api/collectors/stats-collector';

/**
 * Handles incoming HTTP requests
 *
 * This is the main entry point for request processing. It orchestrates:
 * 1. **Special requests**: UI, health checks, favicon
 * 2. **Route matching**: Finds matching route configuration
 * 3. **Request snapshot**: Creates immutable copy for failover isolation
 * 4. **Plugin loading**: Loads route-level plugins
 * 5. **Authentication**: Validates request credentials (if enabled)
 * 6. **Upstream selection**: Chooses target upstream server
 * 7. **Failover/Retry**: Attempts multiple upstreams on failure
 * 8. **Recovery mechanism**: Allows UNHEALTHY upstreams to recover
 * 9. **Stats collection**: Records request metrics
 * 10. **Request logging**: Persists request details to database
 *
 * **Failover behavior**:
 * - Healthy upstreams are tried first (by priority/weight)
 * - Recovery candidates (UNHEALTHY but past recovery interval) are tried next
 * - Each attempt uses a clean snapshot to prevent plugin state pollution
 * - Upstreams are marked UNHEALTHY on failure, HEALTHY on success
 *
 * **Authentication**:
 * - Route-level auth config overrides global config
 * - Returns 401 Unauthorized if auth fails
 * - Authorization header is automatically removed after successful auth
 *
 * @param req - Incoming HTTP request
 * @param config - Application configuration
 * @param upstreamSelector - Upstream selection strategy (defaults to selectUpstream)
 * @returns Response from upstream or error response
 *
 * @example
 * ```typescript
 * // Standard usage
 * const response = await handleRequest(req, config);
 *
 * // Custom upstream selector
 * const response = await handleRequest(req, config, customSelector);
 * ```
 */
export async function handleRequest(
  req: Request,
  config: AppConfig,
  upstreamSelector: (upstreams: RuntimeUpstream[]) => RuntimeUpstream | undefined = selectUpstream
): Promise<Response> {
  // 优先处理 UI 请求（不计入统计）
  const uiResponse = await handleUIRequest(req);
  if (uiResponse) {
    return uiResponse;
  }

  const url = new URL(req.url);

  // 健康检查请求（不计入统计）
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 浏览器自动请求（不计入统计）
  if (url.pathname === '/favicon.ico' ||
      url.pathname === '/.well-known/appspecific/com.chrome.devtools.json') {
    return new Response(null, { status: 404 });
  }

  // 创建请求日志记录器
  const reqLogger = new RequestLogger(req);
  const requestLog = reqLogger.getRequestInfo();

  const startTime = Date.now();
  let success = true;
  let responseStatus = 200;
  let routePath: string | undefined;
  let upstream: string | undefined;
  let errorMessage: string | undefined;

  try {
    logger.info({ request: requestLog }, `\n=== Incoming Request ===`);

    const route = find(config.routes, (r) => url.pathname.startsWith(r.path));

    if (!route) {
      logger.error({ request: requestLog }, `No route found for path: ${url.pathname}`);
      success = false;
      responseStatus = 404;
      errorMessage = 'Route not found';
      return new Response(JSON.stringify({ error: 'Route not found' }), { status: 404 });
    }

    // 记录匹配的路由
    routePath = route.path;
    reqLogger.addStep('route_matched', { path: route.path });

    // 创建请求快照（在任何 plugin 执行之前）
    // This ensures each upstream retry gets a clean copy of the original request
    const requestSnapshot = await createRequestSnapshot(req);
    reqLogger.addStep('request_snapshot_created', {
      method: requestSnapshot.method,
      hasBody: !!requestSnapshot.body,
      bodyType: requestSnapshot.isJsonBody ? 'json' : 'binary'
    });

    // ✅ 加载路由级别 plugins
    const routePlugins: Plugin[] = [];
    const pluginRegistry = getPluginRegistry();
    if (route.plugins && pluginRegistry) {
      for (const pluginConfig of route.plugins) {
        try {
          const plugin = await pluginRegistry.loadPluginFromConfig(pluginConfig);
          if (plugin) {
            routePlugins.push(plugin);
            logger.debug({ pluginName: plugin.name }, 'Route plugin loaded');
          }
        } catch (error) {
          logger.error({ error, pluginConfig }, 'Failed to load route plugin');
        }
      }
    }

    // --- Authentication Check ---
    // 确定最终使用的 auth 配置：路由级 > 全局级
    const effectiveAuthConfig = route.auth ?? config.auth;

    if (effectiveAuthConfig?.enabled) {
      // 构建简单的认证上下文（包含 headers 和 env）
      const headersObject: { [key: string]: string } = {};
      req.headers.forEach((value, key) => {
        headersObject[key] = value;
      });

      const authContext: ExpressionContext = {
        headers: headersObject,
        body: {},
        url: { pathname: url.pathname, search: url.search, host: url.hostname, protocol: url.protocol },
        method: req.method,
        env: process.env as Record<string, string>,
      };

      // 执行认证
      const authResult = await authenticateRequest(req, effectiveAuthConfig, authContext);

      if (!authResult.success) {
        const authLevel = route.auth ? 'route' : 'global';
        logger.warn(
          {
            request: requestLog,
            authLevel,
            error: authResult.error,
          },
          'Authentication failed'
        );
        reqLogger.addStep('auth_failed', { level: authLevel, error: authResult.error });
        success = false;
        responseStatus = 401;
        errorMessage = `Authentication failed: ${authResult.error}`;
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
          },
        });
      }

      logger.debug(
        {
          request: requestLog,
          authLevel: route.auth ? 'route' : 'global',
        },
        'Authentication successful'
      );
      reqLogger.addStep('auth_success', { level: route.auth ? 'route' : 'global' });
    }
    // --- End Authentication Check ---

    const routeState = runtimeState.get(route.path);
    if (!routeState) {
      const staticUpstreams = map(route.upstreams, (up) => ({
        ...up,
        status: 'HEALTHY' as const,
        lastFailure: 0
      } as RuntimeUpstream));
      const selectedUpstream = upstreamSelector(staticUpstreams);
      if (!selectedUpstream) {
        logger.error({ request: requestLog }, 'No valid upstream found for route.');
        success = false;
        responseStatus = 500;
        errorMessage = 'No valid upstream found';
        return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
      }
      upstream = selectedUpstream.target;
      // transformerName is no longer used - plugins are loaded dynamically
      reqLogger.addStep('upstream_selected', { target: upstream });
      const response = await proxyRequest(requestSnapshot, route, selectedUpstream, requestLog, config, routePlugins, reqLogger);
      responseStatus = response.status;
      if (response.status >= 400) {
        success = false;
      }
      return response;
    }

    const healthyUpstreams = filter(routeState.upstreams, (up) => up.status === 'HEALTHY');

    // 获取可以尝试恢复的上游（被动恢复机制）
    const recoveryIntervalMs = route.failover?.recoveryIntervalMs || 5000;
    const now = Date.now();
    const recoveryCandidates = filter(routeState.upstreams, (up) =>
      up.status === 'UNHEALTHY' &&
      up.lastFailureTime !== undefined &&
      (now - up.lastFailureTime) >= recoveryIntervalMs
    );

    // 合并健康上游和恢复候选（健康上游优先）
    const availableUpstreams = [...healthyUpstreams, ...recoveryCandidates];

    if (availableUpstreams.length === 0) {
      logger.error({ request: requestLog }, 'No healthy upstreams available for this route.');
      success = false;
      responseStatus = 503;
      errorMessage = 'No healthy upstreams available';
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }

    const firstTryUpstream = upstreamSelector(availableUpstreams);
    if (!firstTryUpstream) {
      logger.error({ request: requestLog }, 'Upstream selection failed.');
      success = false;
      responseStatus = 503;
      errorMessage = 'Upstream selection failed';
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }
    upstream = firstTryUpstream.target;
    // transformerName is no longer used - plugins are loaded dynamically
    reqLogger.addStep('upstream_selected', { target: upstream });

    // 构建重试队列：优先使用健康上游，然后是恢复候选
    const retryQueue = sortBy(
      filter(availableUpstreams, (up) => up.target !== firstTryUpstream.target),
      [(up) => up.status === 'UNHEALTHY' ? 1 : 0, (up) => up.priority || 1, (up) => -(up.weight || 100)]
    );
    const attemptQueue = [firstTryUpstream, ...retryQueue];

    for (const attemptUpstream of attemptQueue) {
      try {
        upstream = attemptUpstream.target;
        reqLogger.addStep('trying_upstream', { target: upstream });
        const response = await proxyRequest(requestSnapshot, route, attemptUpstream, requestLog, config, routePlugins, reqLogger);
        responseStatus = response.status;

        // 检查是否应该重试（防御性检查）
        const retryableStatusCodes = route.failover?.retryableStatusCodes || [];
        const shouldRetry = retryableStatusCodes.length > 0 && retryableStatusCodes.includes(response.status);

        if (!shouldRetry) {
          // 成功响应 - 如果上游之前是 UNHEALTHY，恢复为 HEALTHY
          if (attemptUpstream.status === 'UNHEALTHY') {
            attemptUpstream.status = 'HEALTHY';
            attemptUpstream.lastFailureTime = undefined;
            logger.info({ target: attemptUpstream.target }, 'Upstream recovered and marked as HEALTHY');
            reqLogger.addStep('upstream_recovered', { target: attemptUpstream.target });
          }

          if (response.status >= 400) {
            success = false;
          }
          return response;
        }

        logger.warn({ request: requestLog, target: attemptUpstream.target, status: response.status }, 'Upstream returned a retryable status code.');
        reqLogger.addStep('upstream_retry', { target: upstream, status: response.status });
        throw new Error(`Upstream returned retryable status code: ${response.status}`);

      } catch (error) {
        logger.warn({ request: requestLog, target: attemptUpstream.target, error: (error as Error).message }, 'Request to upstream failed. Marking as UNHEALTHY and trying next.');
        reqLogger.addStep('upstream_failed', { target: attemptUpstream.target, error: (error as Error).message });
        attemptUpstream.status = 'UNHEALTHY';
        attemptUpstream.lastFailureTime = Date.now();
      }
    }

    logger.error({ request: requestLog }, 'All healthy upstreams failed.');
    success = false;
    responseStatus = 503;
    errorMessage = 'All healthy upstreams failed';
    return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
  } finally {
    const responseTime = Date.now() - startTime;
    statsCollector.recordRequest(success, responseTime);

    // 写入请求日志到数据库
    await reqLogger.complete(responseStatus, {
      routePath,
      upstream,
      errorMessage
    });
  }
}
