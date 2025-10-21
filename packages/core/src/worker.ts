import { logger } from './logger';
import { statsCollector } from './api/collectors/stats-collector';
import type { AppConfig, Upstream, RouteConfig, ModificationRules } from '@jeffusion/bungee-shared';
import type { Server } from 'bun';
import { loadConfig } from './config';
import { processDynamicValue, type ExpressionContext } from './expression-engine';
import { authenticateRequest } from './auth';
import { RequestLogger } from './logger/request-logger';
import { bodyStorageManager } from './logger/body-storage';
import { logCleanupService } from './logger/log-cleanup';
import { PluginRegistry } from './plugin-registry';
import { createPluginTransformStream, createSSEParserStream, createSSESerializerStream } from './stream-executor';
import type { PluginContext, Plugin } from './plugin.types';
import {
  mergeWith,
  isArray,
  forEach,
  map,
  filter,
  sumBy,
  sortBy,
  find,
  isEmpty
} from 'lodash-es';
import { handleUIRequest } from './ui/server';


// --- Runtime State Management ---
interface RuntimeUpstream extends Upstream {
  status: 'HEALTHY' | 'UNHEALTHY';
  lastFailureTime?: number;
}

export const runtimeState = new Map<string, { upstreams: RuntimeUpstream[] }>();

// --- Plugin Registry ---
let pluginRegistry: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry | null {
  return pluginRegistry;
}

export function initializeRuntimeState(config: AppConfig) {
  runtimeState.clear();
  forEach(config.routes, (route) => {
    if (route.failover?.enabled && route.upstreams && route.upstreams.length > 0) {
      runtimeState.set(route.path, {
        upstreams: map(route.upstreams, (up) => ({
          ...up,
          status: 'HEALTHY' as const,
          lastFailureTime: undefined,
        })),
      });
    }
  });
  logger.info('Runtime state initialized.');
}

/**
 * Initialize Plugin Registry for testing
 * This function is designed for test environments to set up the plugin system
 */
export async function initializePluginRegistryForTests(config: AppConfig, basePath: string = process.cwd()): Promise<void> {
  // Clean up existing registry if any
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
  }

  // Create new registry
  pluginRegistry = new PluginRegistry(basePath);

  // Load global plugins if configured
  if (config.plugins && config.plugins.length > 0) {
    await pluginRegistry.loadPlugins(config.plugins);
  }

  logger.debug('Plugin registry initialized for tests');
}

/**
 * Clean up Plugin Registry (for testing)
 */
export async function cleanupPluginRegistry(): Promise<void> {
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
    pluginRegistry = null;
  }
}


const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8088;

function selectUpstream(upstreams: RuntimeUpstream[]): RuntimeUpstream | undefined {
  if (upstreams.length === 0) return undefined;

  // 按优先级分组 (priority 值越小优先级越高)
  const priorityGroups = new Map<number, RuntimeUpstream[]>();

  forEach(upstreams, (upstream) => {
    const priority = upstream.priority || 1;
    if (!priorityGroups.has(priority)) {
      priorityGroups.set(priority, []);
    }
    priorityGroups.get(priority)!.push(upstream);
  });

  // 获取排序后的优先级列表（从高到低）
  const sortedPriorities = sortBy(Array.from(priorityGroups.keys()));

  // 依次尝试每个优先级组，选择第一个有可用 upstream 的组
  for (const priority of sortedPriorities) {
    const priorityUpstreams = priorityGroups.get(priority)!;

    // 在同一优先级组内使用加权随机选择
    const totalWeight = sumBy(priorityUpstreams, (up) => up.weight ?? 100);
    if (totalWeight === 0) continue;

    let random = Math.random() * totalWeight;
    for (const upstream of priorityUpstreams) {
      random -= upstream.weight ?? 100;
      if (random <= 0) {
        return upstream;
      }
    }

    // 如果由于浮点精度问题没有选中，返回组内最后一个
    if (priorityUpstreams.length > 0) {
      return priorityUpstreams[priorityUpstreams.length - 1];
    }
  }

  return undefined;
}

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

    // ✅ 加载路由级别 plugins
    const routePlugins: Plugin[] = [];
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
    // 确定最终使用的 auth 配置：路���级 > 全局级
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
      const response = await proxyRequest(req, route, selectedUpstream, requestLog, config, routePlugins, reqLogger);
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

    const firstTryUpstream = upstreamSelector(healthyUpstreams.length > 0 ? healthyUpstreams : recoveryCandidates);
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
        const response = await proxyRequest(req, route, attemptUpstream, requestLog, config, routePlugins, reqLogger);
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

function deepMergeRules(base: ModificationRules, override: ModificationRules): ModificationRules {
  const customizer = (objValue: any, srcValue: any) => {
    if (isArray(objValue)) {
      return [...new Set([...objValue, ...srcValue])];
    }
  };
  return mergeWith({}, base, override, customizer);
}

export async function applyBodyRules(
  body: Record<string, any>,
  rules: ModificationRules['body'],
  context: ExpressionContext,
  requestLog: any
): Promise<Record<string, any>> {
  // ✅ Use structuredClone for deep copy to prevent mutation of original body
  let modifiedBody = structuredClone(body);
  logger.debug({ request: requestLog, phase: 'before', body: modifiedBody }, "Body before applying rules");

  if (rules) {
    const processAndSet = (key: string, value: any, action: 'add' | 'replace' | 'default') => {
      try {
        const processedValue = processDynamicValue(value, context);

        // ✅ 只排除 undefined（JSON 不支持），保留其他所有值
        if (processedValue !== undefined) {
          modifiedBody[key] = processedValue;
          logger.debug(
            { request: requestLog, body: { key, value: processedValue } },
            `Applied body '${action}' rule`
          );
        } else {
          logger.debug(
            { request: requestLog, body: { key } },
            `Skipped body '${action}' rule (undefined result)`
          );
        }
      } catch (err) {
        logger.error(
          { request: requestLog, body: { key }, err },
          `Failed to process body '${action}' rule`
        );
      }
    };

    if (rules.add) {
      forEach(rules.add, (value, key) => {
        processAndSet(key, value, 'add');
      });
    }
    if (rules.replace) {
      forEach(rules.replace, (value, key) => {
        if (key in modifiedBody || (rules.add && key in rules.add)) {
          processAndSet(key, value, 'replace');
        }
      });
    }
    if (rules.default) {
      forEach(rules.default, (value, key) => {
        if (modifiedBody[key] === undefined) {
          processAndSet(key, value, 'default');
        }
      });
    }
    if (rules.remove) {
      for (const key of rules.remove) {
        const wasAdded = rules.add && key in rules.add;
        const wasReplaced = rules.replace && key in rules.replace;
        if (!wasAdded && !wasReplaced) {
          delete modifiedBody[key];
          logger.debug({ request: requestLog, body: { key } }, 'Removed body field');
        }
      }
    }
  }

  // ✅ 不需要任何清理逻辑！

  // 检查多事件
  if (modifiedBody.__multi_events && Array.isArray(modifiedBody.__multi_events)) {
    logger.debug(
      { request: requestLog, eventCount: modifiedBody.__multi_events.length },
      "Returning multiple events"
    );
    return modifiedBody.__multi_events;
  }

  logger.debug(
    { request: requestLog, phase: 'after', body: modifiedBody },
    "Body after applying rules"
  );
  return modifiedBody;
}

async function proxyRequest(req: Request, route: RouteConfig, upstream: RuntimeUpstream, requestLog: any, config: AppConfig, routePlugins: Plugin[], reqLogger?: RequestLogger): Promise<Response> {
  const allRoutePlugins = [...routePlugins];

  // ===== 加载 upstream 级别的 plugins =====
  if (upstream.plugins && pluginRegistry) {
    for (const pluginConfig of upstream.plugins) {
      try {
        const plugin = await pluginRegistry.loadPluginFromConfig(pluginConfig);
        if (plugin) {
          // 避免重复添加（如果 route 已经加载了相同的 plugin）
          if (!allRoutePlugins.some(p => p.name === plugin.name)) {
            allRoutePlugins.push(plugin);
            logger.debug({ pluginName: plugin.name, request: requestLog }, 'Upstream plugin loaded');
          }
        }
      } catch (error) {
        logger.error({ error, pluginConfig, request: requestLog }, 'Failed to load upstream plugin');
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

  // 1. Set target URL and apply route-level pathRewrite
  const targetUrl = new URL(upstream.target);
  const targetBasePath = targetUrl.pathname;
  targetUrl.pathname = new URL(req.url).pathname;
  targetUrl.search = new URL(req.url).search;

  if (route.pathRewrite) {
    const originalPathname = targetUrl.pathname;
    for (const [pattern, replacement] of Object.entries(route.pathRewrite)) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(targetUrl.pathname)) {
          targetUrl.pathname = targetUrl.pathname.replace(regex, replacement);
          logger.debug({ request: requestLog, path: { from: originalPathname, to: targetUrl.pathname }, rule: { pattern, replacement } }, `Applied route pathRewrite`);
          break;
        }
      } catch (error) {
        logger.error({ request: requestLog, pattern, error }, 'Invalid regex in pathRewrite rule');
      }
    }
  }

  // 2. Build initial context
  const { context, isStreamingRequest, parsedBody } = await buildRequestContext(req, { pathname: targetUrl.pathname, search: targetUrl.search }, requestLog);

  // ===== 洋葱模型：请求阶段（外→内）=====

  // 构建 Plugin Context
  const headersObj: Record<string, string> = {};
  new Headers(req.headers).forEach((value, key) => {
    headersObj[key] = value;
  });

  let pluginContext: PluginContext = {
    method: req.method,
    url: new URL(targetUrl.href),
    headers: headersObj,
    body: parsedBody,
    request: requestLog
  };

  // 2.1 onRequestInit - 全局 plugins
  if (pluginRegistry) {
    await pluginRegistry.executeOnRequestInit(pluginContext);
  }

  // 2.2 onRequestInit - 路由 plugins
  for (const plugin of dedupedRoutePlugins) {
    if (plugin.onRequestInit) {
      try {
        await plugin.onRequestInit(pluginContext);
      } catch (error) {
        logger.error({ error, pluginName: plugin.name }, 'Error in onRequestInit hook');
      }
    }
  }

  // 4. Build final request context following the Onion Model
  // Layer 1 (Outer): Route and Upstream rules
  const { path: routePath, upstreams, ...routeModificationRules } = route;
  const { target, weight, priority, plugins: upstreamPlugins, ...upstreamModificationRules } = upstream;
  const routeAndUpstreamRequestRules = deepMergeRules(routeModificationRules, upstreamModificationRules);

  let intermediateContext: ExpressionContext = { ...context };
  let intermediateBody = parsedBody;
  if(routeAndUpstreamRequestRules.body) {
    logger.debug({ request: requestLog }, "Applying Route + Upstream body rules (Layer 1)");
    intermediateBody = await applyBodyRules(parsedBody, routeAndUpstreamRequestRules.body, intermediateContext, requestLog);
    intermediateContext.body = intermediateBody;
  }

  // Rebuild context with the final body
  const finalContext: ExpressionContext = { ...context, body: intermediateBody };
  let finalBody = intermediateBody;  // Use intermediateBody as final body (no transformer layer anymore)

  targetUrl.pathname = (targetBasePath === '/' ? '' : targetBasePath.replace(/\/$/, '')) + targetUrl.pathname;

  // 5. Prepare final headers
  const finalRequestRules = routeAndUpstreamRequestRules;
  const headers = new Headers(req.headers);
  headers.delete('host');

  // 6.1. Remove Authorization header (if auth is enabled)
  const effectiveAuthConfig = route.auth ?? config.auth;
  if (effectiveAuthConfig?.enabled) {
    // 固定行为：启用 auth 后自动移除 Authorization header
    headers.delete('Authorization');
    logger.debug(
      { request: requestLog },
      'Removed Authorization header after authentication (automatic security measure)'
    );
  }

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
            logger.error({request: requestLog, error: (e as Error).message}, "Header replace expression failed");
          }
        }
      });
    }
    if (finalRequestRules.headers.add) {
      forEach(finalRequestRules.headers.add, (value, key) => {
        try {
          headers.set(key, String(processDynamicValue(value, finalContext)));
        } catch (e) {
          logger.error({request: requestLog, error: (e as Error).message}, "Header add expression failed");
        }
      });
    }
  }

  // 7. Prepare final body
  let body: BodyInit | null = req.body;
  const contentType = req.headers.get('content-type') || '';
  if (req.body && contentType.includes('application/json')) {
    body = JSON.stringify(finalBody);
    // Avoid setting Content-Length for empty bodies
    if (!isEmpty(finalBody)) {
      headers.set('Content-Length', String(Buffer.byteLength(body as string)));
    } else {
        headers.delete('Content-Length');
    }
  }

  // 7.1. Record final request headers and body sent to upstream
  if (reqLogger) {
    // Record final headers
    const requestHeaders: Record<string, string> = {}
    headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    reqLogger.setRequestHeaders(requestHeaders);

    // Record final body (只记录 JSON 类型)
    if (config.logging?.body?.enabled && contentType.includes('application/json') && body) {
      try {
        const bodyToRecord = typeof body === 'string' ? JSON.parse(body) : body;
        reqLogger.setRequestBody(bodyToRecord);
      } catch (err) {
        logger.warn({ request: requestLog, error: err }, 'Failed to parse request body for recording');
      }
    }
  }

  // ===== 洋葱模型：onBeforeRequest（外→内）=====

  // 更新 plugin context
  pluginContext.url = new URL(targetUrl.href);
  pluginContext.headers = {};
  headers.forEach((value, key) => {
    pluginContext.headers[key] = value;
  });
  pluginContext.body = finalBody;

  // 7.2 onBeforeRequest - 全局 plugins
  if (pluginRegistry) {
    await pluginRegistry.executeOnBeforeRequest(pluginContext);

    // 应用修改
    targetUrl.href = pluginContext.url.href;
    const existingHeaders: string[] = [];
    headers.forEach((_, key) => existingHeaders.push(key));
    existingHeaders.forEach(key => headers.delete(key));
    for (const [key, value] of Object.entries(pluginContext.headers)) {
      headers.set(key, value);
    }
    // Always update finalBody reference in case plugin replaced it
    finalBody = pluginContext.body;
  }

  // 7.3 onBeforeRequest - 路由 plugins
  for (const plugin of dedupedRoutePlugins) {
    if (plugin.onBeforeRequest) {
      try {
        // 更新 context
        pluginContext.url = new URL(targetUrl.href);
        pluginContext.headers = {};
        headers.forEach((value, key) => {
          pluginContext.headers[key] = value;
        });
        pluginContext.body = finalBody;

        await plugin.onBeforeRequest(pluginContext);

        // 应用修改
        targetUrl.href = pluginContext.url.href;
        const existingHeaders: string[] = [];
        headers.forEach((_, key) => existingHeaders.push(key));
        existingHeaders.forEach(key => headers.delete(key));
        for (const [key, value] of Object.entries(pluginContext.headers)) {
          headers.set(key, value);
        }
        // Always update finalBody reference in case plugin replaced it
        finalBody = pluginContext.body;
      } catch (error) {
        logger.error({ error, pluginName: plugin.name }, 'Error in onBeforeRequest hook');
      }
    }
  }

  // 7.4 Re-serialize body after plugins have modified it
  // Only re-serialize if the original request had a body
  if (req.body && contentType.includes('application/json')) {
    body = JSON.stringify(finalBody);
    if (!isEmpty(finalBody)) {
      headers.set('Content-Length', String(Buffer.byteLength(body as string)));
    } else {
      headers.delete('Content-Length');
    }
  }

  // ===== 洋葱模型：onInterceptRequest（外→内，可能短路）=====

  // 更新 plugin context
  pluginContext.url = new URL(targetUrl.href);
  pluginContext.headers = {};
  headers.forEach((value, key) => {
    pluginContext.headers[key] = value;
  });
  pluginContext.body = finalBody;

  // 7.4 onInterceptRequest - 全局 plugins
  if (pluginRegistry) {
    const interceptedResponse = await pluginRegistry.executeOnInterceptRequest(pluginContext);
    if (interceptedResponse) {
      return interceptedResponse;
    }
  }

  // 7.5 onInterceptRequest - 路由 plugins
  for (const plugin of dedupedRoutePlugins) {
    if (plugin.onInterceptRequest) {
      try {
        // 更新 context
        pluginContext.url = new URL(targetUrl.href);
        pluginContext.headers = {};
        headers.forEach((value, key) => {
          pluginContext.headers[key] = value;
        });
        pluginContext.body = finalBody;

        const interceptedResponse = await plugin.onInterceptRequest(pluginContext);
        if (interceptedResponse) {
          logger.info({ pluginName: plugin.name }, 'Request intercepted by plugin');
          return interceptedResponse;
        }
      } catch (error) {
        logger.error({ error, pluginName: plugin.name }, 'Error in onInterceptRequest hook');
      }
    }
  }

  // 8. Execute the request
  logger.info({ request: requestLog, target: targetUrl.href }, `\n=== Proxying to target ===`);
  try {
    // 为恢复尝试设置独立的超时时间
    const isRecoveryAttempt = upstream.status === 'UNHEALTHY';
    const recoveryTimeoutMs = route.failover?.recoveryTimeoutMs || 3000;

    let fetchOptions: RequestInit = { method: req.method, headers, body, redirect: 'manual' };
    let controller: AbortController | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // 如果是恢复尝试，添加超时控制
    if (isRecoveryAttempt) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller!.abort(), recoveryTimeoutMs);
      fetchOptions.signal = controller.signal;
      logger.debug({ request: requestLog, timeout: recoveryTimeoutMs }, 'Recovery attempt with timeout');
    }

    let proxyRes: Response;
    try {
      proxyRes = await fetch(targetUrl.href, fetchOptions);
      if (timeoutId) clearTimeout(timeoutId);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        logger.warn({ request: requestLog, target: targetUrl.href, timeout: recoveryTimeoutMs }, 'Recovery attempt timed out');
      }
      throw error;
    }
    logger.info({ request: requestLog, status: proxyRes.status, target: targetUrl.href }, `\n=== Received Response from target ===`);

    // ===== 洋葱模型：onResponse（内→外）=====

    if (!isStreamingRequest) {
      let currentResponse = proxyRes;

      // 8.1 onResponse - 路由 plugins (reverse order for inbound)
      for (const plugin of [...dedupedRoutePlugins].reverse()) {
        if (plugin.onResponse) {
          try {
            const responseHeadersObj: Record<string, string> = {};
            currentResponse.headers.forEach((value, key) => {
              responseHeadersObj[key] = value;
            });

            const pluginContext: PluginContext & { response: Response } = {
              method: req.method,
              url: new URL(targetUrl.href),
              headers: responseHeadersObj,
              body: null,
              request: requestLog,
              response: currentResponse
            };

            const result = await plugin.onResponse(pluginContext);
            if (result && result instanceof Response) {
              currentResponse = result;
              logger.info(
                { pluginName: plugin.name },
                'Plugin returned modified response'
              );
            }
          } catch (error) {
            logger.error({ error, pluginName: plugin.name }, 'Error in onResponse hook');
          }
        }
      }

      // 8.2 onResponse - 全局 plugins
      if (pluginRegistry) {
        const responseHeadersObj: Record<string, string> = {};
        currentResponse.headers.forEach((value, key) => {
          responseHeadersObj[key] = value;
        });

        const pluginContext: PluginContext & { response: Response } = {
          method: req.method,
          url: new URL(targetUrl.href),
          headers: responseHeadersObj,
          body: null,
          request: requestLog,
          response: currentResponse
        };

        currentResponse = await pluginRegistry.executeOnResponse(pluginContext);
      }

      proxyRes = currentResponse;
    }

    // 9. Prepare the response (Response Onion)
    const finalResponseRules = upstreamModificationRules;

    const { headers: responseHeaders, body: responseBody } = await prepareResponse(proxyRes, finalResponseRules, context, requestLog, isStreamingRequest, reqLogger, config, dedupedRoutePlugins, pluginRegistry);

    return new Response(responseBody, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    // ===== 洋葱模型：onError（内→外）=====

    const headersObj: Record<string, string> = {};
    headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    const pluginContext: PluginContext & { error: Error } = {
      method: req.method,
      url: new URL(targetUrl.href),
      headers: headersObj,
      body: finalBody,
      request: requestLog,
      error: error as Error
    };

    // 8.3 onError - 路由 plugins (reverse order for inbound)
    for (const plugin of [...dedupedRoutePlugins].reverse()) {
      if (plugin.onError) {
        try {
          await plugin.onError(pluginContext);
        } catch (hookError) {
          logger.error(
            { error: hookError, pluginName: plugin.name },
            'Error in onError hook'
          );
        }
      }
    }

    // 8.4 onError - 全局 plugins
    if (pluginRegistry) {
      await pluginRegistry.executeOnError(pluginContext);
    }

    throw error;
  }
}

async function prepareResponse(
  res: Response,
  rules: ModificationRules,
  requestContext: ExpressionContext,
  requestLog: any,
  isStreamingRequest: boolean,
  reqLogger?: RequestLogger,
  config?: AppConfig,
  dedupedRoutePlugins?: Plugin[],
  pluginRegistry?: PluginRegistry | null
): Promise<{ headers: Headers; body: BodyInit | null }> {
  const headers = new Headers(res.headers);
  const contentType = headers.get('content-type') || '';

  // Since we are buffering the body, we MUST remove chunked encoding headers.
  headers.delete('transfer-encoding');
  headers.delete('content-encoding');

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
    if (dedupedRoutePlugins) {
      for (const plugin of [...dedupedRoutePlugins].reverse()) {
        if (plugin.processStreamChunk && !pluginNames.has(plugin.name)) {
          streamPlugins.push(plugin);
          pluginNames.add(plugin.name);
        }
      }
    }

    // Add global plugins (skip if already added as route plugin)
    if (pluginRegistry) {
      const globalPlugins = pluginRegistry.getEnabledPlugins();
      for (const plugin of globalPlugins) {
        if (plugin.processStreamChunk && !pluginNames.has(plugin.name)) {
          streamPlugins.push(plugin);
          pluginNames.add(plugin.name);
        }
      }
    }

    if (streamPlugins.length > 0) {
      // Use plugin chain for stream transformation
      logger.info(
        { request: requestLog, pluginCount: streamPlugins.length, plugins: streamPlugins.map(p => p.name) },
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

  // Safely read the body as text first to avoid consuming the stream more than once.
  const rawBodyText = await res.text();
  logger.debug({ request: requestLog, responseBody: rawBodyText }, "Raw response body from upstream");
  let body: BodyInit | null = rawBodyText;

  // Record original response headers and body from upstream
  if (reqLogger) {
    // Record original response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    reqLogger.setResponseHeaders(responseHeaders);

    // Record original response body (只记录 JSON 类型)
    if (config?.logging?.body?.enabled && rawBodyText && contentType.includes('application/json')) {
      try {
        const parsedResponseBody = JSON.parse(rawBodyText);
        reqLogger.setResponseBody(parsedResponseBody);
      } catch (err) {
        logger.warn({ request: requestLog, error: err }, 'Failed to parse response body for recording');
      }
    }
  }

  if (rules.body && contentType.includes('application/json')) {
    try {
      // Only parse and modify if there is a body.
      if (rawBodyText) {
        const parsedBody = JSON.parse(rawBodyText);
        const { body: _, ...baseRequestContext } = requestContext;
        const responseContext: ExpressionContext = { ...baseRequestContext, body: parsedBody };
        const modifiedBody = await applyBodyRules(parsedBody, rules.body, responseContext, requestLog);
        body = JSON.stringify(modifiedBody);
      } else {
        logger.debug({ request: requestLog }, "Response body is empty, skipping modification.");
      }
    } catch (err) {
      logger.error({ request: requestLog, error: err }, 'Failed to parse or modify JSON response body. Returning original body.');
      // `body` already contains the original rawBodyText, so no action needed.
    }
  }

  // Always calculate and set the final content-length as we have buffered the entire body.
  const finalBody = body as string || '';
  headers.set('Content-Length', String(Buffer.byteLength(finalBody)));

  return { headers, body: finalBody };
}

async function buildRequestContext(req: Request, rewrittenPath: { pathname: string, search: string }, requestLog: any): Promise<{ context: ExpressionContext; isStreamingRequest: boolean; parsedBody: Record<string, any> }> {
  const url = new URL(req.url);
  let parsedBody: Record<string, any> = {};
  const contentType = req.headers.get('content-type') || '';
  if (req.body && contentType.includes('application/json')) {
    try {
      parsedBody = await req.clone().json();
    } catch (err) {
      logger.warn({ request: requestLog, error: err }, 'Failed to parse JSON body for expression context');
    }
  }

  const headersObject: { [key: string]: string } = {};
  req.headers.forEach((value, key) => {
    headersObject[key] = value;
  });

  const context: ExpressionContext = {
    headers: headersObject,
    body: parsedBody,
    url: { pathname: rewrittenPath.pathname, search: rewrittenPath.search, host: url.hostname, protocol: url.protocol },
    method: req.method,
    env: process.env as Record<string, string>,
  };

  return { context, isStreamingRequest: !!context.body.stream, parsedBody };
}

export async function startServer(config: AppConfig): Promise<Server> {
  initializeRuntimeState(config);

  // 初始化 Plugin Registry
  pluginRegistry = new PluginRegistry(process.cwd());

  // 加载全局 plugins
  if (config.plugins && config.plugins.length > 0) {
    logger.info(`🔌 Loading ${config.plugins.length} global plugin(s)...`);
    await pluginRegistry.loadPlugins(config.plugins);
  }

  logger.info(`🚀 Reverse proxy server starting on port ${PORT}`);
  logger.info(`📋 Health check: http://localhost:${PORT}/health`);
  logger.info('\n📝 Configured routes:');
  forEach(config.routes, (route) => {
    const targets = map(route.upstreams, (up) => `${up.target} (w: ${up.weight}, p: ${up.priority || 1})`).join(', ');
    logger.info(`  ${route.path} -> [${targets}]`);
  });
  logger.info('\n');

  const server = Bun.serve({
    port: PORT,
    reusePort: true,
    fetch: (req) => handleRequest(req, config),
    error(error: Error) {
      logger.fatal({ error }, 'A top-level server error occurred');
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    },
  });
  return server;
}

export async function shutdownServer(server: Server) {
  logger.info('Shutting down server...');

  // 清理 plugins
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
    pluginRegistry = null;
  }

  server.stop(true);
  logger.info('Server has been shut down.');
  process.exit(0);
}

// --- Worker (Slave) Logic ---
async function startWorker() {
  try {
    // Get worker configuration from environment variables
    const workerId = process.env.WORKER_ID ? parseInt(process.env.WORKER_ID) : 0;
    const configPath = process.env.CONFIG_PATH;

    logger.info(`Worker #${workerId} starting with PID ${process.pid}`);

    const config = configPath ? await loadConfig(configPath) : await loadConfig();

    // 初始化 body 存储管理器配置
    if (config.logging?.body) {
      bodyStorageManager.updateConfig({
        enabled: config.logging.body.enabled,
        maxSize: config.logging.body.maxSize,
        retentionDays: config.logging.body.retentionDays,
      });
      logger.info({ bodyLogging: config.logging.body }, 'Body storage configured');
    }

    // 启动日志清理服务（仅在非 worker 模式，即主进程或单进程模式）
    if (process.env.BUNGEE_ROLE !== 'worker') {
      logCleanupService.start();
      logger.info('Log cleanup service started in worker process');
    }

    const server = await startServer(config);

    // Notify master that worker is ready
    if (process.send) {
      process.send({ status: 'ready', pid: process.pid });
    }

    // Listen for shutdown commands from master
    process.on('message', async (message: any) => {
      if (message && typeof message === 'object' && message.command === 'shutdown') {
        logger.info(`Worker #${workerId} received shutdown command. Initiating graceful shutdown...`);
        await shutdownServer(server);
      }
    });

    const handleSignal = async (signal: NodeJS.Signals) => {
      logger.info(`Worker #${workerId} received ${signal}. Initiating graceful shutdown...`);
      await shutdownServer(server);
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

  } catch (error) {
    logger.error({ error }, 'Worker failed to start');
    if (process.send) {
      process.send({ status: 'error', error: (error instanceof Error ? error.message : String(error)) });
    }
    process.exit(1);
  }
}

// Start worker if running as worker process
if (process.env.BUNGEE_ROLE === 'worker' || import.meta.main) {
  startWorker();
}
