/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../../logger';
import { RequestLogger } from '../../logger/request-logger';
import { find, map } from 'lodash-es';
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
 * Checks if an upstream can be attempted based on its status and recovery interval
 *
 * @param upstream - The upstream to check
 * @param recoveryIntervalMs - Base recovery interval in milliseconds
 * @returns Object indicating if upstream can be attempted and if it should transition to HALF_OPEN
 */
function canAttemptUpstream(
  upstream: RuntimeUpstream,
  recoveryIntervalMs: number
): { canAttempt: boolean; shouldTransitionToHalfOpen: boolean } {
  // HEALTHY upstreams can always be attempted
  if (upstream.status === 'HEALTHY') {
    return { canAttempt: true, shouldTransitionToHalfOpen: false };
  }

  // HALF_OPEN upstreams are already in recovery test mode
  if (upstream.status === 'HALF_OPEN') {
    return { canAttempt: true, shouldTransitionToHalfOpen: false };
  }

  // UNHEALTHY upstreams: check if recovery interval has elapsed
  if (upstream.status === 'UNHEALTHY' && upstream.lastFailureTime !== undefined) {
    const elapsed = Date.now() - upstream.lastFailureTime;
    const jitteredInterval = addJitter(recoveryIntervalMs, 0.2);

    if (elapsed >= jitteredInterval) {
      // Recovery interval met, can attempt and should transition to HALF_OPEN
      return { canAttempt: true, shouldTransitionToHalfOpen: true };
    }
  }

  // UNHEALTHY and recovery interval not met
  return { canAttempt: false, shouldTransitionToHalfOpen: false };
}

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
  upstreamSelector: (upstreams: RuntimeUpstream[], route?: import('@jeffusion/bungee-shared').RouteConfig) => RuntimeUpstream | undefined = selectUpstream
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

  // Plugin 清理函数，需要在 try 外层声明以便 finally 块访问
  let releasePlugins: (() => Promise<void>) | undefined;

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

    // ✅ 获取路由级别 plugins（每请求实例化）
    const pluginRegistry = getPluginRegistry();
    let routePlugins: Plugin[] = [];

    if (route.plugins && route.plugins.length > 0 && pluginRegistry) {
      // 确保所有需要的 plugins 已加载到 registry（仅在首次请求时加载）
      const pluginNames: string[] = [];

      for (const pluginConfig of route.plugins) {
        try {
          const pluginName = await pluginRegistry.ensurePluginLoaded(pluginConfig);
          pluginNames.push(pluginName);
        } catch (error) {
          logger.error({ error, pluginConfig }, 'Failed to load route plugin');
        }
      }

      // 为当前请求创建或获取 plugin 实例
      if (pluginNames.length > 0) {
        try {
          const result = await pluginRegistry.acquirePluginInstances(pluginNames);
          routePlugins = result.plugins;
          releasePlugins = result.release; // 赋值给外层声明的变量
          logger.debug(
            {
              pluginCount: routePlugins.length,
              plugins: routePlugins.map(p => p.name)
            },
            'Route plugins acquired for request'
          );
        } catch (error) {
          logger.error({ error }, 'Failed to acquire route plugin instances');
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

    // 新的统一选择逻辑：所有 upstream 都参与选择，选中后根据状态判断是否可以尝试
    // 选择规则：先按优先级，同一优先级内按权重比例随机选择
    // 如果选中的 upstream 不可用，将其从候选集合移除并重新选择
    const baseRecoveryIntervalMs = route.failover?.recoveryIntervalMs || 5000;
    const allUpstreams = routeState.upstreams;
    const attemptedUpstreams = new Set<string>(); // 记录已尝试的 upstream
    const skippedUpstreams = new Set<string>(); // 记录跳过的 upstream（不满足恢复间隔）
    let attemptCount = 0;

    // 循环尝试所有可用的 upstreams
    while (attemptedUpstreams.size + skippedUpstreams.size < allUpstreams.length) {
      // 从未尝试且未跳过的 upstreams 中选择
      const availableUpstreams = allUpstreams.filter(
        up => !attemptedUpstreams.has(up.target) && !skippedUpstreams.has(up.target)
      );

      if (availableUpstreams.length === 0) {
        break;
      }

      // 按优先级+权重选择 upstream（不考虑状态）
      // 选择器会确保：先选择高优先级组，同一优先级内按权重比例随机选择
      const selectedUpstream = upstreamSelector(availableUpstreams, route);
      if (!selectedUpstream) {
        logger.error({ request: requestLog }, 'Upstream selection failed.');
        break;
      }

      // 检查选中的 upstream 是否可以尝试
      const { canAttempt, shouldTransitionToHalfOpen } = canAttemptUpstream(
        selectedUpstream,
        baseRecoveryIntervalMs
      );

      if (!canAttempt) {
        // 不满足恢复间隔，跳过此 upstream（从候选集合中移除）
        skippedUpstreams.add(selectedUpstream.target);
        logger.debug({
          target: selectedUpstream.target,
          status: selectedUpstream.status,
          lastFailureTime: selectedUpstream.lastFailureTime,
          elapsed: selectedUpstream.lastFailureTime ? Date.now() - selectedUpstream.lastFailureTime : 0,
          requiredInterval: baseRecoveryIntervalMs
        }, 'Skipping upstream: recovery interval not met, removing from candidate pool');
        continue; // 重新从剩余候选集合中选择
      }

      // 状态转换：UNHEALTHY → HALF_OPEN（如果满足恢复间隔）
      if (shouldTransitionToHalfOpen) {
        selectedUpstream.status = 'HALF_OPEN';
        logger.info({
          target: selectedUpstream.target,
          previousStatus: 'UNHEALTHY',
          elapsed: selectedUpstream.lastFailureTime ? Date.now() - selectedUpstream.lastFailureTime : 0,
          recoveryInterval: baseRecoveryIntervalMs
        }, 'Upstream transitioned to HALF_OPEN for recovery attempt');
      }

      // 标记为已尝试
      attemptedUpstreams.add(selectedUpstream.target);
      attemptCount++;
      upstream = selectedUpstream.target;

      // 记录选择的 upstream
      if (attemptCount === 1) {
        reqLogger.addStep('upstream_selected', { target: upstream });
      } else {
        reqLogger.addStep('trying_upstream', { target: upstream });
      }

      // 确定是否是最后一个可尝试的 upstream
      const isLastUpstream = attemptedUpstreams.size === allUpstreams.length;

      // 确定请求类型
      let initialRequestType: 'final' | 'retry' | 'recovery' = 'retry';
      if (selectedUpstream.status === 'HALF_OPEN') {
        initialRequestType = 'recovery';
      } else if (isLastUpstream) {
        initialRequestType = 'final';
      }

      // 为每次上游尝试创建独立的日志记录器
      const attemptLogger = new RequestLogger(req, {
        isFailoverAttempt: true,
        parentRequestId: reqLogger.getRequestId(),
        attemptNumber: attemptCount,
        attemptUpstream: selectedUpstream.target,
        requestType: initialRequestType
      });

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(originalHeaders);
      if (requestSnapshot.body && requestSnapshot.isJsonBody) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      try {
        const response = await proxyRequest(requestSnapshot, route, selectedUpstream, requestLog, config, routePlugins, attemptLogger);
        responseStatus = response.status;

        // 检查是否是可重试的状态码
        const retryableStatusCodes = route.failover?.retryableStatusCodes || [];
        const isRetryableStatus = retryableStatusCodes.length > 0 && retryableStatusCodes.includes(response.status);

        // 只有在以下情况才返回响应：
        // 1. 不是可重试状态码（成功或非重试错误）
        // 2. 是可重试状态码但已经是最后一个上游
        if (!isRetryableStatus || isLastUpstream) {
          // 保存初始状态（用于后续判断 requestType）
          const initialStatus = selectedUpstream.status;

          // 如果响应成功，处理恢复逻辑
          if (response.status < 400) {
            // 重置失败计数器，增加成功计数器
            selectedUpstream.consecutiveFailures = 0;

            // 断路器状态转换逻辑
            if (selectedUpstream.status === 'HALF_OPEN') {
              // HALF_OPEN → HEALTHY: 测试请求成功，立即恢复
              selectedUpstream.status = 'HEALTHY';
              selectedUpstream.lastFailureTime = undefined;
              selectedUpstream.consecutiveSuccesses = 0; // 重置计数器

              // 激活慢启动
              activateSlowStart(selectedUpstream, route);

              logger.info({
                target: selectedUpstream.target,
                previousStatus: 'HALF_OPEN',
                slowStartEnabled: route.failover?.slowStart?.enabled
              }, 'Upstream recovered from HALF_OPEN to HEALTHY (circuit breaker closed)');
              reqLogger.addStep('circuit_breaker_closed', {
                target: selectedUpstream.target
              });
            } else if (selectedUpstream.status === 'UNHEALTHY') {
              // UNHEALTHY → HEALTHY: 需要达到健康阈值
              selectedUpstream.consecutiveSuccesses++;

              const healthyThreshold = route.failover?.healthyThreshold || 2;
              if (selectedUpstream.consecutiveSuccesses >= healthyThreshold) {
                selectedUpstream.status = 'HEALTHY';
                selectedUpstream.lastFailureTime = undefined;

                // 激活慢启动
                activateSlowStart(selectedUpstream, route);

                logger.info({
                  target: selectedUpstream.target,
                  consecutiveSuccesses: selectedUpstream.consecutiveSuccesses,
                  healthyThreshold,
                  slowStartEnabled: route.failover?.slowStart?.enabled
                }, 'Upstream recovered and marked as HEALTHY');
                reqLogger.addStep('upstream_recovered', {
                  target: selectedUpstream.target,
                  consecutiveSuccesses: selectedUpstream.consecutiveSuccesses
                });
              } else {
                logger.debug({
                  target: selectedUpstream.target,
                  consecutiveSuccesses: selectedUpstream.consecutiveSuccesses,
                  healthyThreshold
                }, 'Upstream success recorded, not yet marked HEALTHY');
              }
            } else {
              // 对于 HEALTHY 上游，保持成功计数更新
              selectedUpstream.consecutiveSuccesses++;
            }
          } else {
            // 响应失败，重置成功计数器
            selectedUpstream.consecutiveSuccesses = 0;

            // 如果是 HALF_OPEN 状态失败，需要转回 UNHEALTHY 并重置恢复时间
            if (selectedUpstream.status === 'HALF_OPEN') {
              selectedUpstream.status = 'UNHEALTHY';
              selectedUpstream.lastFailureTime = Date.now();

              // 取消慢启动
              deactivateSlowStart(selectedUpstream);

              logger.warn({
                target: selectedUpstream.target,
                status: response.status
              }, 'HALF_OPEN upstream failed, circuit breaker reopened');
              reqLogger.addStep('circuit_breaker_reopened', {
                target: selectedUpstream.target,
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
              upstream: selectedUpstream.target,
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
        logger.warn({ request: requestLog, target: selectedUpstream.target, status: response.status }, 'Upstream returned a retryable status code, trying next upstream.');
        reqLogger.addStep('upstream_retry', { target: upstream, status: response.status });

        // 确定请求类型（非 HALF_OPEN 且非最后一个上游的失败尝试 → retry）
        if (selectedUpstream.status !== 'HALF_OPEN') {
          attemptLogger.setRequestType('retry');
        }

        // 记录此次失败尝试的日志（不影响重试逻辑）
        try {
          await attemptLogger.complete(response.status, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: `Upstream returned retryable status code: ${response.status}`
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        throw new Error(`Upstream returned retryable status code: ${response.status}`);

      } catch (error) {
        logger.warn({ request: requestLog, target: selectedUpstream.target, error: (error as Error).message, isLastUpstream }, 'Request to upstream failed.');
        reqLogger.addStep('upstream_failed', { target: selectedUpstream.target, error: (error as Error).message });

        // 确定请求类型（异常情况）
        // 优先级：HALF_OPEN → recovery，最后一个上游 → final，其他 → retry
        if (selectedUpstream.status !== 'HALF_OPEN') {
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
            upstream: selectedUpstream.target,
            errorMessage: (error as Error).message
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        // 递增失败计数器，重置成功计数器
        selectedUpstream.consecutiveFailures++;
        selectedUpstream.consecutiveSuccesses = 0;

        // 断路器状态转换逻辑
        if (selectedUpstream.status === 'HALF_OPEN') {
          // HALF_OPEN → UNHEALTHY: 测试请求失败，重置恢复时间
          selectedUpstream.status = 'UNHEALTHY';
          selectedUpstream.lastFailureTime = Date.now();
          logger.warn({
            target: selectedUpstream.target,
            error: (error as Error).message
          }, 'HALF_OPEN upstream failed, circuit breaker reopened');
          reqLogger.addStep('circuit_breaker_reopened', {
            target: selectedUpstream.target
          });
        } else {
          // HEALTHY/UNHEALTHY 状态的失败处理
          const failureThreshold = route.failover?.consecutiveFailuresThreshold || 3;
          if (selectedUpstream.consecutiveFailures >= failureThreshold && selectedUpstream.status !== 'UNHEALTHY') {
            // HEALTHY → UNHEALTHY: 达到连续失败阈值
            selectedUpstream.status = 'UNHEALTHY';
            selectedUpstream.lastFailureTime = Date.now();
            logger.warn({
              target: selectedUpstream.target,
              consecutiveFailures: selectedUpstream.consecutiveFailures,
              failureThreshold
            }, 'Upstream marked as UNHEALTHY after consecutive failures (circuit breaker opened)');
            reqLogger.addStep('circuit_breaker_opened', {
              target: selectedUpstream.target,
              consecutiveFailures: selectedUpstream.consecutiveFailures
            });
          } else if (selectedUpstream.status === 'UNHEALTHY') {
            // 已经是 UNHEALTHY 状态，更新失败时间
            selectedUpstream.lastFailureTime = Date.now();
          } else {
            logger.debug({
              target: selectedUpstream.target,
              consecutiveFailures: selectedUpstream.consecutiveFailures,
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

    // 检查是否有任何 upstream 被尝试
    if (attemptCount === 0) {
      logger.error({ request: requestLog }, 'No upstreams available (all UNHEALTHY and within recovery interval).');
      success = false;
      responseStatus = 503;
      return new Response(JSON.stringify({
        error: 'Service Unavailable',
        reason: 'All upstreams are unhealthy and within recovery interval'
      }), { status: 503 });
    }

    logger.error({ request: requestLog, attemptCount }, 'All attempted upstreams failed.');
    success = false;
    responseStatus = 503;
    return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
  } finally {
    const responseTime = Date.now() - startTime;
    statsCollector.recordRequest(success, responseTime);

    // 清理 plugin 实例（归还到池或销毁）
    if (releasePlugins) {
      try {
        await releasePlugins();
        logger.debug('Route plugins released successfully');
      } catch (error) {
        logger.error({ error }, 'Error releasing route plugins');
      }
    }

    // 不再写入主请求日志到数据库
    // 每个 attempt 会创建独立的日志记录
  }
}
