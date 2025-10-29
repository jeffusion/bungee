/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../../logger';
import { RequestLogger } from '../../logger/request-logger';
import { find, filter, map, sortBy, forEach } from 'lodash-es';
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
import { addJitter } from '../utils/jitter';
import { activateSlowStart, deactivateSlowStart } from '../utils/slow-start';

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

  // 创建请求信息对象（用于传统日志输出和步骤追踪，不用于数据库日志）
  const reqLogger = new RequestLogger(req);
  const requestLog = reqLogger.getRequestInfo();

  const startTime = Date.now();
  let success = true;
  let responseStatus = 200;
  let routePath: string | undefined;
  let upstream: string | undefined;

  try {
    logger.info({ request: requestLog }, `\n=== Incoming Request ===`);

    const route = find(config.routes, (r) => url.pathname.startsWith(r.path));

    if (!route) {
      logger.error({ request: requestLog }, `No route found for path: ${url.pathname}`);
      success = false;
      responseStatus = 404;
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

    // 记录原始请求头和请求体（转换前）
    const originalHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      originalHeaders[key] = value;
    });
    reqLogger.setOriginalRequestHeaders(originalHeaders);

    if (requestSnapshot.body && requestSnapshot.isJsonBody) {
      reqLogger.setOriginalRequestBody(requestSnapshot.body);
    }

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
        lastFailureTime: undefined,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      } as RuntimeUpstream));
      const selectedUpstream = upstreamSelector(staticUpstreams);
      if (!selectedUpstream) {
        logger.error({ request: requestLog }, 'No valid upstream found for route.');
        success = false;
        responseStatus = 500;
        return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
      }
      upstream = selectedUpstream.target;

      // 创建请求日志记录器（无故障转移，单次尝试，类型为 final）
      const attemptLogger = new RequestLogger(req, {
        isFailoverAttempt: false,
        requestType: 'final'
      });

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(originalHeaders);
      if (requestSnapshot.body && requestSnapshot.isJsonBody) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      reqLogger.addStep('upstream_selected', { target: upstream });
      const response = await proxyRequest(requestSnapshot, route, selectedUpstream, requestLog, config, routePlugins, attemptLogger);
      responseStatus = response.status;
      if (response.status >= 400) {
        success = false;
      }

      // 完成请求日志记录（不影响请求流程）
      try {
        await attemptLogger.complete(responseStatus, {
          routePath,
          upstream: selectedUpstream.target,
          errorMessage: response.status >= 400 ? `Upstream returned error status: ${response.status}` : undefined
        });
      } catch (logError) {
        logger.error({ error: logError }, 'Failed to write request log');
      }

      return response;
    }

    const healthyUpstreams = filter(routeState.upstreams, (up) => up.status === 'HEALTHY');

    // 断路器模式：将符合恢复条件的 UNHEALTHY 上游转换为 HALF_OPEN 状态
    // HALF_OPEN 状态允许一次测试请求，成功则转为 HEALTHY，失败则转回 UNHEALTHY
    // 使用 Jitter 避免所有上游同时尝试恢复（惊群效应）
    const baseRecoveryIntervalMs = route.failover?.recoveryIntervalMs || 5000;
    const now = Date.now();

    forEach(routeState.upstreams, (up) => {
      if (up.status === 'UNHEALTHY' && up.lastFailureTime !== undefined) {
        // 为每个上游的恢复间隔添加 20% 的 jitter
        const jitteredRecoveryInterval = addJitter(baseRecoveryIntervalMs, 0.2);
        const elapsed = now - up.lastFailureTime;

        if (elapsed >= jitteredRecoveryInterval) {
          up.status = 'HALF_OPEN';
          logger.debug({
            target: up.target,
            lastFailureTime: up.lastFailureTime,
            elapsed,
            jitteredInterval: Math.round(jitteredRecoveryInterval)
          }, 'Upstream transitioned to HALF_OPEN state (circuit breaker test window with jitter)');
        }
      }
    });

    // 获取可以尝试恢复的上游（HALF_OPEN 状态）
    const recoveryCandidates = filter(routeState.upstreams, (up) => up.status === 'HALF_OPEN');

    // 合并健康上游和恢复候选（健康上游优先）
    const availableUpstreams = [...healthyUpstreams, ...recoveryCandidates];

    if (availableUpstreams.length === 0) {
      logger.error({ request: requestLog }, 'No healthy upstreams available for this route.');
      success = false;
      responseStatus = 503;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }

    // 优先从健康上游中选择
    const firstTryUpstream = healthyUpstreams.length > 0
      ? upstreamSelector(healthyUpstreams)
      : upstreamSelector(recoveryCandidates);

    if (!firstTryUpstream) {
      logger.error({ request: requestLog }, 'Upstream selection failed.');
      success = false;
      responseStatus = 503;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }
    upstream = firstTryUpstream.target;
    reqLogger.addStep('upstream_selected', { target: upstream });

    // 构建重试队列：
    // 1. 如果第一个选择来自健康上游，剩余健康上游按优先级/权重排序
    // 2. 所有健康上游尝试失败后，再尝试恢复候选
    const isFirstTryHealthy = firstTryUpstream.status === 'HEALTHY';
    const remainingHealthy = filter(healthyUpstreams, (up) => up.target !== firstTryUpstream.target);
    const sortedHealthy = sortBy(
      remainingHealthy,
      [(up) => up.priority || 1, (up) => -(up.weight || 100)]
    );
    const sortedRecovery = sortBy(
      isFirstTryHealthy ? recoveryCandidates : filter(recoveryCandidates, (up) => up.target !== firstTryUpstream.target),
      [(up) => up.priority || 1, (up) => -(up.weight || 100)]
    );
    // 健康上游优先，恢复候选在后
    const attemptQueue = [firstTryUpstream, ...sortedHealthy, ...sortedRecovery];

    for (let attemptIndex = 0; attemptIndex < attemptQueue.length; attemptIndex++) {
      const attemptUpstream = attemptQueue[attemptIndex];
      const isLastUpstream = attemptIndex === attemptQueue.length - 1;

      // 确定请求类型（优先级：HALF_OPEN → recovery，其他待后续根据结果判断）
      let initialRequestType: 'final' | 'retry' | 'recovery' = 'retry';
      if (attemptUpstream.status === 'HALF_OPEN') {
        initialRequestType = 'recovery';
      }

      // 为每次上游尝试创建独立的日志记录器
      const attemptLogger = new RequestLogger(req, {
        isFailoverAttempt: true,
        parentRequestId: reqLogger.getRequestId(),
        attemptNumber: attemptIndex + 1,
        attemptUpstream: attemptUpstream.target,
        requestType: initialRequestType
      });

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(originalHeaders);
      if (requestSnapshot.body && requestSnapshot.isJsonBody) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      try {
        upstream = attemptUpstream.target;
        reqLogger.addStep('trying_upstream', { target: upstream });

        const response = await proxyRequest(requestSnapshot, route, attemptUpstream, requestLog, config, routePlugins, attemptLogger);
        responseStatus = response.status;

        // 检查是否是可重试的状态码
        const retryableStatusCodes = route.failover?.retryableStatusCodes || [];
        const isRetryableStatus = retryableStatusCodes.length > 0 && retryableStatusCodes.includes(response.status);

        // 只有在以下情况才返回响应：
        // 1. 不是可重试状态码（成功或非重试错误）
        // 2. 是可重试状态码但已经是最后一个上游
        if (!isRetryableStatus || isLastUpstream) {
          // 保存初始状态（用于后续判断 requestType）
          const initialStatus = attemptUpstream.status;

          // 如果响应成功，处理恢复逻辑
          if (response.status < 400) {
            // 重置失败计数器，增加成功计数器
            attemptUpstream.consecutiveFailures = 0;

            // 断路器状态转换逻辑
            if (attemptUpstream.status === 'HALF_OPEN') {
              // HALF_OPEN → HEALTHY: 测试请求成功，立即恢复
              attemptUpstream.status = 'HEALTHY';
              attemptUpstream.lastFailureTime = undefined;
              attemptUpstream.consecutiveSuccesses = 0; // 重置计数器

              // 激活慢启动
              activateSlowStart(attemptUpstream, route);

              logger.info({
                target: attemptUpstream.target,
                previousStatus: 'HALF_OPEN',
                slowStartEnabled: route.failover?.slowStart?.enabled
              }, 'Upstream recovered from HALF_OPEN to HEALTHY (circuit breaker closed)');
              reqLogger.addStep('circuit_breaker_closed', {
                target: attemptUpstream.target
              });
            } else if (attemptUpstream.status === 'UNHEALTHY') {
              // UNHEALTHY → HEALTHY: 需要达到健康阈值
              attemptUpstream.consecutiveSuccesses++;

              const healthyThreshold = route.failover?.healthyThreshold || 2;
              if (attemptUpstream.consecutiveSuccesses >= healthyThreshold) {
                attemptUpstream.status = 'HEALTHY';
                attemptUpstream.lastFailureTime = undefined;

                // 激活慢启动
                activateSlowStart(attemptUpstream, route);

                logger.info({
                  target: attemptUpstream.target,
                  consecutiveSuccesses: attemptUpstream.consecutiveSuccesses,
                  healthyThreshold,
                  slowStartEnabled: route.failover?.slowStart?.enabled
                }, 'Upstream recovered and marked as HEALTHY');
                reqLogger.addStep('upstream_recovered', {
                  target: attemptUpstream.target,
                  consecutiveSuccesses: attemptUpstream.consecutiveSuccesses
                });
              } else {
                logger.debug({
                  target: attemptUpstream.target,
                  consecutiveSuccesses: attemptUpstream.consecutiveSuccesses,
                  healthyThreshold
                }, 'Upstream success recorded, not yet marked HEALTHY');
              }
            } else {
              // 对于 HEALTHY 上游，保持成功计数更新
              attemptUpstream.consecutiveSuccesses++;
            }
          } else {
            // 响应失败，重置成功计数器
            attemptUpstream.consecutiveSuccesses = 0;

            // 如果是 HALF_OPEN 状态失败，需要转回 UNHEALTHY 并重置恢复时间
            if (attemptUpstream.status === 'HALF_OPEN') {
              attemptUpstream.status = 'UNHEALTHY';
              attemptUpstream.lastFailureTime = Date.now();

              // 取消慢启动
              deactivateSlowStart(attemptUpstream);

              logger.warn({
                target: attemptUpstream.target,
                status: response.status
              }, 'HALF_OPEN upstream failed, circuit breaker reopened');
              reqLogger.addStep('circuit_breaker_reopened', {
                target: attemptUpstream.target,
                status: response.status
              });
            }
          }

          // 确定最终的请求类型
          // 优先级：HALF_OPEN → recovery，成功或最后一个上游 → final，其他 → retry
          if (initialStatus !== 'HALF_OPEN') {
            if (response.status < 400 || isLastUpstream) {
              attemptLogger.setRequestType('final');
            } else {
              attemptLogger.setRequestType('retry');
            }
          }
          // HALF_OPEN 的情况已经在创建时设置为 'recovery'

          // 记录此次尝试的日志（不影响请求流程）
          try {
            await attemptLogger.complete(responseStatus, {
              routePath,
              upstream: attemptUpstream.target,
              errorMessage: response.status >= 400 ? `Upstream returned error status: ${response.status}` : undefined
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write request log');
          }

          if (response.status >= 400) {
            success = false;
          }
          return response;
        }

        // 是可重试状态码且还有其他上游，记录此次尝试并进入重试逻辑
        logger.warn({ request: requestLog, target: attemptUpstream.target, status: response.status }, 'Upstream returned a retryable status code, trying next upstream.');
        reqLogger.addStep('upstream_retry', { target: upstream, status: response.status });

        // 确定请求类型（非 HALF_OPEN 且非最后一个上游的失败尝试 → retry）
        if (attemptUpstream.status !== 'HALF_OPEN') {
          attemptLogger.setRequestType('retry');
        }

        // 记录此次失败尝试的日志（不影响重试逻辑）
        try {
          await attemptLogger.complete(response.status, {
            routePath,
            upstream: attemptUpstream.target,
            errorMessage: `Upstream returned retryable status code: ${response.status}`
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        throw new Error(`Upstream returned retryable status code: ${response.status}`);

      } catch (error) {
        logger.warn({ request: requestLog, target: attemptUpstream.target, error: (error as Error).message, isLastUpstream }, 'Request to upstream failed.');
        reqLogger.addStep('upstream_failed', { target: attemptUpstream.target, error: (error as Error).message });

        // 确定请求类型（异常情况）
        // 优先级：HALF_OPEN → recovery，最后一个上游 → final，其他 → retry
        if (attemptUpstream.status !== 'HALF_OPEN') {
          if (isLastUpstream) {
            attemptLogger.setRequestType('final');
          } else {
            attemptLogger.setRequestType('retry');
          }
        }

        // 记录此次失败尝试的日志（不影响 failover 逻辑）
        try {
          await attemptLogger.complete(503, {
            routePath,
            upstream: attemptUpstream.target,
            errorMessage: (error as Error).message
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        // 递增失败计数器，重置成功计数器
        attemptUpstream.consecutiveFailures++;
        attemptUpstream.consecutiveSuccesses = 0;

        // 断路器状态转换逻辑
        if (attemptUpstream.status === 'HALF_OPEN') {
          // HALF_OPEN → UNHEALTHY: 测试请求失败，重置恢复时间
          attemptUpstream.status = 'UNHEALTHY';
          attemptUpstream.lastFailureTime = Date.now();
          logger.warn({
            target: attemptUpstream.target,
            error: (error as Error).message
          }, 'HALF_OPEN upstream failed, circuit breaker reopened');
          reqLogger.addStep('circuit_breaker_reopened', {
            target: attemptUpstream.target
          });
        } else {
          // HEALTHY/UNHEALTHY 状态的失败处理
          const failureThreshold = route.failover?.consecutiveFailuresThreshold || 3;
          if (attemptUpstream.consecutiveFailures >= failureThreshold && attemptUpstream.status !== 'UNHEALTHY') {
            // HEALTHY → UNHEALTHY: 达到连续失败阈值
            attemptUpstream.status = 'UNHEALTHY';
            attemptUpstream.lastFailureTime = Date.now();
            logger.warn({
              target: attemptUpstream.target,
              consecutiveFailures: attemptUpstream.consecutiveFailures,
              failureThreshold
            }, 'Upstream marked as UNHEALTHY after consecutive failures (circuit breaker opened)');
            reqLogger.addStep('circuit_breaker_opened', {
              target: attemptUpstream.target,
              consecutiveFailures: attemptUpstream.consecutiveFailures
            });
          } else if (attemptUpstream.status === 'UNHEALTHY') {
            // 已经是 UNHEALTHY 状态，更新失败时间
            attemptUpstream.lastFailureTime = Date.now();
          } else {
            logger.debug({
              target: attemptUpstream.target,
              consecutiveFailures: attemptUpstream.consecutiveFailures,
              failureThreshold
            }, 'Upstream failure recorded, not yet marked UNHEALTHY');
          }
        }

        // 如果是最后一个上游，不要继续循环，直接跳出
        if (isLastUpstream) {
          break;
        }
      }
    }

    logger.error({ request: requestLog }, 'All healthy upstreams failed.');
    success = false;
    responseStatus = 503;
    return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
  } finally {
    const responseTime = Date.now() - startTime;
    statsCollector.recordRequest(success, responseTime);

    // 不再写入主请求日志到数据库
    // 每个 attempt 会创建独立的日志记录
  }
}
