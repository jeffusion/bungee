/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../../logger';
import { RequestLogger } from '../../logger/request-logger';
import { find, map } from 'lodash-es';
import type { AppConfig, CorsConfig, ResponseRuleConfig, RouteConfig } from '@jeffusion/bungee-types';
import { processDynamicValue, type ExpressionContext } from '../../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../types';
import { selectUpstream } from '../upstream/selector';
import { FailoverCoordinator } from '../upstream/failover-coordinator';
import { runtimeState, incrementActiveRequests, decrementActiveRequests } from '../state/runtime-state';
import { getPluginRegistry } from '../state/plugin-manager';
import { getScopedPluginRegistry, type PrecompiledHooks } from '../../scoped-plugin-registry';
import { createRequestSnapshot, ensureSnapshotCloned } from './snapshot';
import { isUpstreamPhaseFailoverSignal, proxyRequest, type ProxyRequestResult } from './proxy';
import { authenticateRequest } from '../../auth';
import { handleUIRequest } from '../../ui/server';
import { statsCollector } from '../../api/collectors/stats-collector';
import { activateSlowStart, deactivateSlowStart } from '../utils/slow-start';
import { createStatusCodeMatcher, type StatusCodeMatcher } from '../utils/status-code-matcher';
import { resolveEffectiveRouteEndpoints, resolveRouteService } from '../../utils/endpoint-resolver';
import { LegacyCompatAdapter } from '../../compat/legacy-plugin-adapter';
import {
  buildFinalUpstreamFinallyContext,
  buildRequestLevelFinallyContext,
  cloneMutableRequestContext,
  type MutableRequestContext,
} from './context';
import type { MutableRequestContext as HookMutableRequestContext } from '../../hooks';

const rateLimitBuckets = new Map<string, { count: number; resetTime: number }>();

function isStreamingResponse(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/event-stream') ?? false;
}

function cloneResponseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveEffectiveRoute(config: AppConfig, route: RouteConfig): EffectiveRouteConfig {
  const service = resolveRouteService(config, route);
  const endpoints = resolveEffectiveRouteEndpoints(route, config.services);

  return {
    ...route,
    endpoints,
    failover: service?.failover,
    service_timeouts: service?.timeouts,
    load_balancing: service?.load_balancing,
    state_key: service?.name ?? route.path,
  };
}

function stripRouteWildcard(routePath: string): string {
  return routePath.replace(/\/\*$/, '').replace(/\/:\w+/g, '');
}

function getRouteRelativePath(pathname: string, routePath: string): string {
  const basePath = stripRouteWildcard(routePath);
  if (!basePath || basePath === '/') return pathname;
  if (!pathname.startsWith(basePath)) return pathname;
  const relative = pathname.slice(basePath.length);
  return relative.startsWith('/') ? relative : `/${relative}`;
}

function pathMatchesRule(pathname: string, routePath: string, rule: ResponseRuleConfig): boolean {
  if (!rule.enabled || !rule.path) return false;

  const matchType = rule.match_type ?? 'exact';
  const normalizedRulePath = rule.path.startsWith('/') ? rule.path : `/${rule.path}`;
  const relativePath = getRouteRelativePath(pathname, routePath);
  const candidates = [pathname, relativePath];

  if (matchType === 'regex') {
    try {
      const pattern = new RegExp(normalizedRulePath);
      return candidates.some(candidate => pattern.test(candidate));
    } catch {
      return false;
    }
  }

  if (matchType === 'prefix') {
    return candidates.some(candidate => candidate.startsWith(normalizedRulePath));
  }

  return candidates.some(candidate => candidate === normalizedRulePath);
}

function findResponseRule(route: RouteConfig, pathname: string): ResponseRuleConfig | undefined {
  return route.response_rules?.find(rule => pathMatchesRule(pathname, route.path, rule));
}

function createResponseRuleResponse(rule: ResponseRuleConfig, req: Request): Response {
  if (rule.type === 'redirect') {
    const responseStatus = rule.status ?? 302;
    const redirectTarget = rule.url ?? '/';
    const redirectUrl = rule.preserve_path ? redirectTarget + new URL(req.url).pathname : redirectTarget;
    return new Response(null, { status: responseStatus, headers: { location: redirectUrl } });
  }

  const status = rule.status ?? 200;
  const headers = { ...(rule.headers ?? {}) };
  if (!Object.keys(headers).some(header => header.toLowerCase() === 'content-type')) {
    headers['content-type'] = rule.content_type ?? 'text/plain';
  }
  return new Response(rule.body ?? '', {
    status,
    headers
  });
}

function corsHeaders(cors: CorsConfig, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const headers: Record<string, string> = {};
  if (cors.allowed_origins?.includes('*') || cors.allowed_origins?.includes(origin)) {
    headers['access-control-allow-origin'] = cors.allowed_origins?.includes('*') ? '*' : origin;
    if (cors.allow_credentials) headers['access-control-allow-credentials'] = 'true';
    if (cors.allowed_methods) headers['access-control-allow-methods'] = cors.allowed_methods.join(', ');
    if (cors.allowed_headers) headers['access-control-allow-headers'] = cors.allowed_headers.join(', ');
    if (cors.expose_headers) headers['access-control-expose-headers'] = cors.expose_headers.join(', ');
    if (cors.max_age !== undefined) headers['access-control-max-age'] = String(cors.max_age);
  }
  return headers;
}

function applyCorsHeaders(response: Response, cors: CorsConfig | undefined, request: Request): Response {
  if (!cors?.enabled) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(cors, request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveRateLimitKey(route: RouteConfig, request: Request, context: ExpressionContext): string {
  const expression = route.rate_limit?.key_expression;
  if (expression && expression.trim().length > 0) {
    try {
      const evaluated = processDynamicValue(expression, context);
      if (evaluated !== undefined && evaluated !== null) {
        const key = String(evaluated).trim();
        if (key.length > 0) {
          return key;
        }
      }
    } catch (error) {
      logger.warn({ error: (error as Error).message, route: route.path }, 'Failed to evaluate rate_limit key_expression; falling back to client IP');
    }
  }

  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

function checkRateLimit(route: RouteConfig, request: Request, context: ExpressionContext): boolean {
  const rateLimit = route.rate_limit;
  if (!rateLimit?.enabled) {
    return true;
  }

  const requestsPerSecond = rateLimit.requests_per_second ?? 1;
  const burst = rateLimit.burst ?? requestsPerSecond;
  const key = `${route.path}:${resolveRateLimitKey(route, request, context)}`;
  const now = Date.now();
  const resetTime = now + 1000;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetTime <= now) {
    rateLimitBuckets.set(key, { count: 1, resetTime });
    return true;
  }

  if (bucket.count >= burst) {
    return false;
  }

  bucket.count++;
  return true;
}

function createPhaseContext(
  requestSnapshot: Awaited<ReturnType<typeof createRequestSnapshot>>,
  requestId: string,
  routeId: string,
  routeServiceName: string | undefined,
): MutableRequestContext {
  const originalUrl = new URL(requestSnapshot.url);
  return {
    method: requestSnapshot.method,
    originalUrl,
    url: new URL(requestSnapshot.url),
    headers: { ...requestSnapshot.headers },
    body: requestSnapshot.is_json_body && requestSnapshot.body ? structuredClone(requestSnapshot.body) : {},
    clientIP: requestSnapshot.headers['x-forwarded-for'] || requestSnapshot.headers['x-real-ip'] || 'unknown',
    requestId,
    routeId,
    serviceName: routeServiceName,
  };
}

function applyRoutePathRewriteToContext(ctx: MutableRequestContext, route: RouteConfig, requestLog: ReturnType<RequestLogger['getRequestInfo']>): void {
  if (!route.path_rewrite) {
    return;
  }

  const originalPathname = ctx.url.pathname;
  for (const [pattern, replacement] of Object.entries(route.path_rewrite)) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(ctx.url.pathname)) {
        ctx.url.pathname = ctx.url.pathname.replace(regex, replacement);
        logger.debug(
          {
            request: requestLog,
            path: { from: originalPathname, to: ctx.url.pathname },
            rule: { pattern, replacement },
          },
          'Applied route path_rewrite before plugin route phase'
        );
        break;
      }
    } catch (error) {
      logger.error({ request: requestLog, pattern, error }, 'Invalid regex in path_rewrite rule');
    }
  }
}

async function executePreFailoverPhase(
  phase: PrecompiledHooks | null | undefined,
  ctx: MutableRequestContext,
  options: {
    phaseName: 'route' | 'service';
    requestLog: ReturnType<RequestLogger['getRequestInfo']>;
    requestId: string;
    routeId: string;
    serviceName?: string;
  }
): Promise<Response | undefined> {
  if (!phase) {
    return undefined;
  }

  if (options.phaseName === 'route' && phase.hooks.onRequestInit.hasCallbacks()) {
    await phase.hooks.onRequestInit.promise({
      method: ctx.method,
      originalUrl: ctx.originalUrl,
      clientIP: ctx.clientIP,
      requestId: options.requestId,
      routeId: options.routeId,
    });
  }

  if (phase.hooks.onBeforeRequest.hasCallbacks()) {
    const result = await phase.hooks.onBeforeRequest.promise(ctx as HookMutableRequestContext);
    ctx.url = result.url;
    ctx.headers = { ...result.headers };
    ctx.body = result.body;
  }

  if (!phase.hasInterceptCallbacks) {
    return undefined;
  }

  const interceptResult = await phase.hooks.onInterceptRequest.promise(ctx as HookMutableRequestContext);
  const adapted = LegacyCompatAdapter.adaptInterceptResult(interceptResult);
  if (adapted?.action === 'respond') {
    return adapted.response;
  }
  if (adapted?.action === 'failover') {
    logger.warn(
      {
        request: options.requestLog,
        routeId: options.routeId,
        serviceName: options.serviceName,
        phase: options.phaseName,
        reason: adapted.reason,
      },
      options.phaseName === 'route'
        ? 'Phase 1 onInterceptRequest returned failover action - ignored (failover not available before upstream selection)'
        : 'Phase 2 onInterceptRequest returned failover action - ignored (failover not available before upstream selection)'
    );
  }
  return undefined;
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
  upstreamSelector: (
    upstreams: RuntimeUpstream[],
    route?: EffectiveRouteConfig,
    context?: ExpressionContext
  ) => RuntimeUpstream | undefined = selectUpstream
): Promise<Response> {
  // 优先处理 UI 请求（不计入统计）
  const pluginRegistry = getPluginRegistry();
  const uiResponse = await handleUIRequest(req, pluginRegistry || undefined);
  if (uiResponse) {
    return uiResponse;
  }

  const url = new URL(req.url);

  // 健康检查请求（不计入统计）
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 浏览器自动请求（不计入统计）
  if (url.pathname === '/favicon.ico') {
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#4F46E5"/><path d="M18 5L7 17h7v10l11-13h-7V5z" fill="#fff"/><circle cx="22" cy="10" r="2.5" fill="#14B8A6"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } }
    );
  }

  if (url.pathname === '/.well-known/appspecific/com.chrome.devtools.json') {
    return new Response(null, { status: 404 });
  }

  // 创建请求信息对象（用于传统日志输出和步骤追踪，不用于数据库日志）
  const reqLogger = new RequestLogger(req);
  const requestLog = reqLogger.getRequestInfo();

  const startTime = Date.now();
  const requestId = requestLog.requestId;
  let success = true;
  let responseStatus: number | undefined;
  let routePath: string | undefined;
  let routeId: string | undefined;
  let routeServiceName: string | undefined;
  let upstream: string | undefined;
  let lastAttemptedUpstreamId: string | undefined;
  let finalUpstreamIdForFinally: string | undefined;
  let deferFinallyToStream = false;
  let finalized = false;
  let streamResult: ProxyRequestResult | undefined;

  const finalizeRequest = async () => {
    if (finalized) {
      return;
    }
    finalized = true;

    const latencyMs = Date.now() - startTime;
    const streamInterrupted = streamResult?.streamCompletionState?.interrupted ?? false;
    const streamCancelled = streamResult?.streamCompletionState?.cancelled ?? false;
    const finalSuccess = success && !streamInterrupted && !streamCancelled;

    statsCollector.recordRequest(finalSuccess, latencyMs);

    if (!routeId) {
      return;
    }

    const scopedRegistry = getScopedPluginRegistry();
    const finalHooks = scopedRegistry?.getPrecompiledHooks(routeId, finalUpstreamIdForFinally, routeServiceName) ?? null;
    const finallyBaseContext = {
      method: req.method,
      originalUrl: new URL(req.url),
      clientIP: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
      requestId,
      upstreamId: finalUpstreamIdForFinally ?? lastAttemptedUpstreamId,
      success: finalSuccess,
      statusCode: responseStatus,
      latencyMs,
    };

    if (finalUpstreamIdForFinally && finalHooks?.upstreamPhase.hooks.onFinally.hasCallbacks()) {
      try {
        await finalHooks.upstreamPhase.hooks.onFinally.promise({
          ...buildFinalUpstreamFinallyContext(routeId, finalUpstreamIdForFinally, routeServiceName),
          ...finallyBaseContext,
        });
      } catch (error) {
        logger.error({ error, request: requestLog }, 'Failed to execute final-upstream-level onFinally hooks');
      }
    }

  if (finalHooks?.servicePhase?.hooks.onFinally.hasCallbacks()) {
    try {
      await finalHooks.servicePhase.hooks.onFinally.promise({
        ...buildRequestLevelFinallyContext(routeId, routeServiceName),
        ...finallyBaseContext,
      });
    } catch (error) {
      logger.error({ error, request: requestLog }, 'Failed to execute service-level onFinally hooks');
    }
  }

  const routeFinallyHooks = finalHooks?.routePrecompiled ?? finalHooks?.routePhase;
  if (routeFinallyHooks?.hooks.onFinally.hasCallbacks()) {
    try {
      await routeFinallyHooks.hooks.onFinally.promise({
        ...buildRequestLevelFinallyContext(routeId, routeServiceName),
        ...finallyBaseContext,
      });
    } catch (error) {
      logger.error({ error, request: requestLog }, 'Failed to execute route-level onFinally hooks');
    }
  }

  if (finalHooks?.globalPrecompiled?.hooks.onFinally.hasCallbacks()) {
    try {
      await finalHooks.globalPrecompiled.hooks.onFinally.promise({
        ...buildRequestLevelFinallyContext(routeId, routeServiceName),
        ...finallyBaseContext,
      });
    } catch (error) {
      logger.error({ error, request: requestLog }, 'Failed to execute global-level onFinally hooks');
    }
  }
  };

  const finalizeStreamingResponse = (response: Response, result: ProxyRequestResult): Response => {
    if (!isStreamingResponse(response) || !response.body) {
      return response;
    }

    deferFinallyToStream = true;
    const reader = response.body.getReader();

    const wrappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            await finalizeRequest();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          if (result.streamCompletionState) {
            result.streamCompletionState.interrupted = true;
          }
          await finalizeRequest();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (result.streamCompletionState) {
          result.streamCompletionState.cancelled = true;
        }
        try {
          await reader.cancel(reason);
        } finally {
          await finalizeRequest();
        }
      },
    });

    return cloneResponseWithBody(response, wrappedBody);
  };

  try {
    logger.debug({ request: requestLog }, `\n=== Incoming Request ===`);

    const routeMatchStart = performance.now();
    const route = find(config.routes, (r) => url.pathname.startsWith(r.path));

    if (!route) {
      logger.error({ request: requestLog }, `No route found for path: ${url.pathname}`);
      success = false;
      responseStatus = 404;
      return new Response(JSON.stringify({ error: 'Route not found' }), { status: 404 });
    }

    // 记录匹配的路由（带耗时）
    routePath = route.path;
    reqLogger.addStepWithDuration('route_matched', performance.now() - routeMatchStart, { path: route.path });

    // 创建请求快照（在任何 plugin 执行之前）
    // This ensures each upstream retry gets a clean copy of the original request
    const snapshotStart = performance.now();
    const requestSnapshot = await createRequestSnapshot(req);
    reqLogger.addStepWithDuration('request_snapshot_created', performance.now() - snapshotStart, {
      method: requestSnapshot.method,
      hasBody: !!requestSnapshot.body,
      bodyType: requestSnapshot.is_json_body ? 'json' : 'binary'
    });

    // 记录原始请求头和请求体（转换前）
    const originalHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      originalHeaders[key] = value;
    });
    reqLogger.setOriginalRequestHeaders(originalHeaders);

    if (requestSnapshot.body && requestSnapshot.is_json_body) {
      reqLogger.setOriginalRequestBody(requestSnapshot.body);
    }

    // 获取路由 ID（用于预编译 hooks 查找）
    // 统一使用 route.path 作为唯一标识
    routeId = route.path;
    routeServiceName = route.service;
    const currentRouteId = route.path;
    const effectiveRoute = resolveEffectiveRoute(config, route);
    const endpoints = effectiveRoute.endpoints;
    const runtimeStateKey = route.service ?? route.path;

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

      // 执行认证（带耗时测量）
      const authStart = performance.now();
      const authResult = await authenticateRequest(req, effectiveAuthConfig, authContext);
      const authDuration = performance.now() - authStart;

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
        reqLogger.addStepWithDuration('auth_failed', authDuration, { level: authLevel, error: authResult.error });
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
      reqLogger.addStepWithDuration('auth_success', authDuration, { level: route.auth ? 'route' : 'global' });
    }
    // --- End Authentication Check ---

    // 构建表达式上下文（用于 upstream 条件过滤）
    const expressionContext: ExpressionContext = {
      headers: originalHeaders,
      body: requestSnapshot.body && requestSnapshot.is_json_body ? requestSnapshot.body : {},
      url: { pathname: url.pathname, search: url.search, host: url.hostname, protocol: url.protocol },
      method: req.method,
      env: process.env as Record<string, string>,
    };

    const responseRule = findResponseRule(route, url.pathname);
    if (responseRule) {
      const response = createResponseRuleResponse(responseRule, req);
      responseStatus = response.status;
      success = response.status < 400;
      return response;
    }

    if (route.direct_response?.enabled) {
      const { status, body, content_type, headers } = route.direct_response;
      responseStatus = status;
      success = status < 400;
      return new Response(body ?? '', {
        status,
        headers: { 'content-type': content_type ?? 'text/plain', ...headers }
      });
    }

    if (route.redirect?.enabled) {
      const { url: redirectTarget, status, preserve_path } = route.redirect;
      const redirectUrl = preserve_path ? redirectTarget + new URL(req.url).pathname : redirectTarget;
      responseStatus = status ?? 302;
      success = responseStatus < 400;
      return new Response(null, { status: responseStatus, headers: { location: redirectUrl } });
    }

    if (route.cors?.enabled && req.method.toUpperCase() === 'OPTIONS') {
      responseStatus = 204;
      return new Response(null, { status: 204, headers: corsHeaders(route.cors, req) });
    }

    if (!checkRateLimit(route, req, expressionContext)) {
      success = false;
      responseStatus = 429;
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const scopedRegistry = getScopedPluginRegistry();
    const requestPhaseHooks = scopedRegistry?.getPrecompiledHooks(currentRouteId, undefined, routeServiceName) ?? null;
    const phaseContext = createPhaseContext(requestSnapshot, requestId, currentRouteId, routeServiceName);
    applyRoutePathRewriteToContext(phaseContext, route, requestLog);
    const routePhaseResponse = await executePreFailoverPhase(requestPhaseHooks?.routePhase, phaseContext, {
      phaseName: 'route',
      requestLog,
      requestId,
      routeId: currentRouteId,
      serviceName: routeServiceName,
    });
    if (routePhaseResponse) {
      responseStatus = routePhaseResponse.status;
      success = routePhaseResponse.status < 400;
      return applyCorsHeaders(routePhaseResponse, route.cors, req);
    }

    const servicePhaseResponse = await executePreFailoverPhase(requestPhaseHooks?.servicePhase, phaseContext, {
      phaseName: 'service',
      requestLog,
      requestId,
      routeId: currentRouteId,
      serviceName: routeServiceName,
    });
    if (servicePhaseResponse) {
      responseStatus = servicePhaseResponse.status;
      success = servicePhaseResponse.status < 400;
      return applyCorsHeaders(servicePhaseResponse, route.cors, req);
    }

    const phase1and2Context = cloneMutableRequestContext(phaseContext);

    const proxyWithRouteRetry = async (
      selectedUpstream: RuntimeUpstream,
      attemptLogger: RequestLogger
    ): Promise<ProxyRequestResult> => {
      const phaseAwareHooks = scopedRegistry?.getPrecompiledHooks(currentRouteId, selectedUpstream.upstream_id, routeServiceName) ?? null;
      let result = await proxyRequest(requestSnapshot, effectiveRoute, selectedUpstream, requestLog, config, currentRouteId, attemptLogger, phaseAwareHooks, phase1and2Context);
      const retryConfig = route.retry;
      const retryOn = retryConfig?.retry_on ?? [];

      if (!retryConfig?.enabled || result.response.ok || !retryOn.includes(result.response.status)) {
        return result;
      }

      for (let i = 0; i < (retryConfig.max_retries ?? 1); i++) {
        ensureSnapshotCloned(requestSnapshot);
        const retryResponse = await proxyRequest(requestSnapshot, effectiveRoute, selectedUpstream, requestLog, config, currentRouteId, attemptLogger, phaseAwareHooks, phase1and2Context);
        result = retryResponse;
        if (!retryOn.includes(retryResponse.response.status)) {
          return retryResponse;
        }
      }

      return result;
    };

    const routeState = runtimeState.get(runtimeStateKey);
    if (!routeState) {
      const staticUpstreams = map(endpoints, (up, index) => {
        const configuredId = 'id' in up && typeof up.id === 'string' ? up.id : undefined;
        return {
          ...up,
          upstream_id: configuredId || String(index), // Use config id or fallback to index
          status: 'HEALTHY' as const,
          last_failure_time: undefined,
          consecutive_failures: 0,
          consecutive_successes: 0,
          recovery_attempt_count: 0,
        } as RuntimeUpstream;
      });
      const selectedUpstream = upstreamSelector(staticUpstreams, effectiveRoute, expressionContext);
      if (!selectedUpstream) {
        logger.error({ request: requestLog }, 'No valid upstream found for route.');
        success = false;
        responseStatus = 500;
        return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
      }
      upstream = selectedUpstream.target;
      lastAttemptedUpstreamId = selectedUpstream.upstream_id;

      // 创建请求日志记录器（无故障转移，单次尝试，类型为 final）
      const attemptLogger = new RequestLogger(req, {
        isFailoverAttempt: false,
        requestType: 'final'
      });

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(originalHeaders);
      if (requestSnapshot.body && requestSnapshot.is_json_body) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      reqLogger.addStep('upstream_selected', { target: upstream });
      let result: ProxyRequestResult;
      try {
        result = await proxyWithRouteRetry(selectedUpstream, attemptLogger);
      } catch (error) {
        if (isUpstreamPhaseFailoverSignal(error)) {
          logger.warn(
            { request: requestLog, target: selectedUpstream.target, reason: error.reason },
            'Upstream phase requested failover but no failover loop is active.'
          );
          success = false;
          responseStatus = 503;
          return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
        }
        throw error;
      }
  streamResult = result;
  finalUpstreamIdForFinally = result.response.status < 400 ? result.upstreamId : undefined;
  responseStatus = result.response.status;
  if (result.response.status >= 400) {
    success = false;
  }

      // 完成请求日志记录（不影响请求流程）
      try {
        // 将主请求的处理步骤复制到 attemptLogger
        attemptLogger.addSteps(reqLogger.getSteps());
        await attemptLogger.complete(responseStatus, {
          routePath,
          upstream: selectedUpstream.target,
          errorMessage: result.response.status >= 400 ? `Upstream returned error status: ${result.response.status}` : undefined
        });
      } catch (logError) {
        logger.error({ error: logError }, 'Failed to write request log');
      }

      return finalizeStreamingResponse(applyCorsHeaders(result.response, route.cors, req), result);
    }

    // 使用 FailoverCoordinator 管理故障转移流程
    const baseRecoveryIntervalMs = effectiveRoute.failover?.recovery?.probe_interval_ms || 5000;
    const retryableRules = effectiveRoute.failover?.retry_on;
    let retryableStatusMatcher: StatusCodeMatcher | null = null;
    if (retryableRules !== undefined) {
      try {
        retryableStatusMatcher = createStatusCodeMatcher(retryableRules);
      } catch (matcherError) {
        logger.error(
          {
            route: route.path,
            rules: retryableRules,
            error: (matcherError as Error).message
          },
          'Invalid retryable status code rules, fallback to no retries'
        );
        retryableStatusMatcher = null;
      }
    }
    const coordinator = new FailoverCoordinator(
      routeState.upstreams,
      effectiveRoute,
      baseRecoveryIntervalMs,
      expressionContext
    );

    let attemptCount = 0;

    // 简化的故障转移循环：使用 coordinator 迭代器
    while (coordinator.hasNext()) {
      const selection = coordinator.selectNext();

      if (!selection) {
        break; // 无可用 upstream
      }

      const { upstream: selectedUpstream, shouldTransitionToHalfOpen } = selection;
      attemptCount++;
      upstream = selectedUpstream.target;
      lastAttemptedUpstreamId = selectedUpstream.upstream_id;
      // Lazy clone: deep clone headers and body when failover retry is needed
      if (attemptCount > 1) {
        ensureSnapshotCloned(requestSnapshot);
      }

      // 状态转换：UNHEALTHY → HALF_OPEN（如果满足恢复间隔）
      if (shouldTransitionToHalfOpen) {
        selectedUpstream.status = 'HALF_OPEN';
        logger.info({
          target: selectedUpstream.target,
          previousStatus: 'UNHEALTHY',
          elapsed: selectedUpstream.last_failure_time ? Date.now() - selectedUpstream.last_failure_time : 0,
          recoveryInterval: baseRecoveryIntervalMs
        }, 'Upstream transitioned to HALF_OPEN for recovery attempt');
      }

      // 记录选择的 upstream
      if (attemptCount === 1) {
        reqLogger.addStep('upstream_selected', { target: upstream });
      } else {
        reqLogger.addStep('trying_upstream', { target: upstream });
      }

      // 确定是否是最后一个可尝试的 upstream
      const isLastUpstream = !coordinator.hasNext();

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
      if (requestSnapshot.body && requestSnapshot.is_json_body) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      const stateKeyForCounter = effectiveRoute.state_key ?? effectiveRoute.service ?? effectiveRoute.path;
      incrementActiveRequests(stateKeyForCounter, selectedUpstream.upstream_id);
      let counterDecrementted = false;
      const decrementCounter = () => {
        if (!counterDecrementted) {
          counterDecrementted = true;
          decrementActiveRequests(stateKeyForCounter, selectedUpstream.upstream_id);
        }
      };

  try {
  const result = await proxyWithRouteRetry(selectedUpstream, attemptLogger);
  streamResult = result;
  finalUpstreamIdForFinally = result.response.status < 400 ? result.upstreamId : undefined;
  responseStatus = result.response.status;

        // 检查是否是可重试的状态码
        const isRetryableStatus = retryableStatusMatcher ? retryableStatusMatcher(result.response.status) : false;

        // 只有在以下情况才返回响应：
        // 1. 不是可重试状态码（成功或非重试错误）
        // 2. 是可重试状态码但已经是最后一个上游
        if (!isRetryableStatus || isLastUpstream) {
          // 保存初始状态（用于后续判断 requestType）
          const initialStatus = selectedUpstream.status;

          // 如果响应成功，处理恢复逻辑
          if (result.response.status < 400) {
            // 重置失败计数器，增加成功计数器
            selectedUpstream.consecutive_failures = 0;

            // 断路器状态转换逻辑
            if (selectedUpstream.status === 'HALF_OPEN') {
              // HALF_OPEN → HEALTHY: 测试请求成功，立即恢复
              selectedUpstream.status = 'HEALTHY';
              selectedUpstream.last_failure_time = undefined;
              selectedUpstream.consecutive_successes = 0; // 重置计数器
              selectedUpstream.recovery_attempt_count = 0; // 重置恢复尝试计数（指数退避）

              // 激活慢启动
              activateSlowStart(selectedUpstream, effectiveRoute);

              logger.info({
                target: selectedUpstream.target,
                previousStatus: 'HALF_OPEN',
                slow_startEnabled: effectiveRoute.failover?.slow_start?.enabled
              }, 'Upstream recovered from HALF_OPEN to HEALTHY (circuit breaker closed)');
              reqLogger.addStep('circuit_breaker_closed', {
                target: selectedUpstream.target
              });
            } else if (selectedUpstream.status === 'UNHEALTHY') {
              // UNHEALTHY → HEALTHY: 需要达到健康阈值
              selectedUpstream.consecutive_successes++;

              const healthy_threshold = effectiveRoute.failover?.passive_health?.healthy_successes || 2;
              if (selectedUpstream.consecutive_successes >= healthy_threshold) {
                selectedUpstream.status = 'HEALTHY';
                selectedUpstream.last_failure_time = undefined;

                // 激活慢启动
                activateSlowStart(selectedUpstream, effectiveRoute);

                logger.info({
                  target: selectedUpstream.target,
                  consecutive_successes: selectedUpstream.consecutive_successes,
                  healthy_threshold,
                  slow_startEnabled: effectiveRoute.failover?.slow_start?.enabled
                }, 'Upstream recovered and marked as HEALTHY');
                reqLogger.addStep('upstream_recovered', {
                  target: selectedUpstream.target,
                  consecutive_successes: selectedUpstream.consecutive_successes
                });
              } else {
                logger.debug({
                  target: selectedUpstream.target,
                  consecutive_successes: selectedUpstream.consecutive_successes,
                  healthy_threshold
                }, 'Upstream success recorded, not yet marked HEALTHY');
              }
            } else {
              // 对于 HEALTHY 上游，保持成功计数更新
              selectedUpstream.consecutive_successes++;
            }
          } else {
            // 响应失败，重置成功计数器
            selectedUpstream.consecutive_successes = 0;

// 如果是 HALF_OPEN 状态失败，需要转回 UNHEALTHY 并重置恢复时间
          if (selectedUpstream.status === 'HALF_OPEN') {
            selectedUpstream.status = 'UNHEALTHY';
            selectedUpstream.last_failure_time = Date.now();
            selectedUpstream.recovery_attempt_count++; // 增加恢复尝试计数（指数退避）

              // 取消慢启动
              deactivateSlowStart(selectedUpstream);

              logger.warn({
                target: selectedUpstream.target,
                status: result.response.status
              }, 'HALF_OPEN upstream failed, circuit breaker reopened');
              reqLogger.addStep('circuit_breaker_reopened', {
                target: selectedUpstream.target,
                status: result.response.status
              });
            }
          }

          // 确定最终的请求类型
          // 优先级：HALF_OPEN → recovery，成功或最后一个上游 → final，其他 → retry
          if (initialStatus !== 'HALF_OPEN') {
             if (result.response.status < 400 || isLastUpstream) {
               attemptLogger.setRequestType('final');
             } else {
               attemptLogger.setRequestType('retry');
            }
          }
          // HALF_OPEN 的情况已经在创建时设置为 'recovery'

          // 记录此次尝试的日志（不影响请求流程）
          try {
            // 将主请求的处理步骤复制到 attemptLogger
            attemptLogger.addSteps(reqLogger.getSteps());
            await attemptLogger.complete(responseStatus, {
              routePath,
              upstream: selectedUpstream.target,
              errorMessage: result.response.status >= 400 ? `Upstream returned error status: ${result.response.status}` : undefined
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write request log');
          }

          if (result.response.status >= 400) {
            success = false;
          }
          return finalizeStreamingResponse(applyCorsHeaders(result.response, route.cors, req), result);
        }

        // 是可重试状态码且还有其他上游，记录此次尝试并进入重试逻辑
        logger.warn({ request: requestLog, target: selectedUpstream.target, status: result.response.status }, 'Upstream returned a retryable status code, trying next upstream.');
        reqLogger.addStep('upstream_retry', { target: upstream, status: result.response.status });

        // 确定请求类型（非 HALF_OPEN 且非最后一个上游的失败尝试 → retry）
        if (selectedUpstream.status !== 'HALF_OPEN') {
          attemptLogger.setRequestType('retry');
        }

        // 记录此次失败尝试的日志（不影响重试逻辑）
        try {
          // 将主请求的处理步骤复制到 attemptLogger
          attemptLogger.addSteps(reqLogger.getSteps());
          await attemptLogger.complete(result.response.status, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: `Upstream returned retryable status code: ${result.response.status}`
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        throw new Error(`Upstream returned retryable status code: ${result.response.status}`);

      } catch (error) {
        if (isUpstreamPhaseFailoverSignal(error)) {
          logger.warn(
            { request: requestLog, target: selectedUpstream.target, reason: error.reason, isLastUpstream },
            'Upstream phase requested failover, trying next upstream.'
          );
          reqLogger.addStep('plugin_failover', { target: selectedUpstream.target, reason: error.reason });
          try {
            attemptLogger.addSteps(reqLogger.getSteps());
            await attemptLogger.complete(503, {
              routePath,
              upstream: selectedUpstream.target,
              errorMessage: error.message,
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write request log');
          }
          if (isLastUpstream) {
            break;
          }
          continue;
        }

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
          // 将主请求的处理步骤复制到 attemptLogger
          attemptLogger.addSteps(reqLogger.getSteps());
          await attemptLogger.complete(503, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: (error as Error).message
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        // 递增失败计数器，重置成功计数器
        selectedUpstream.consecutive_failures++;
        selectedUpstream.consecutive_successes = 0;

        const auto_disable_threshold = effectiveRoute.failover?.passive_health?.auto_disable_threshold;
        if (
          auto_disable_threshold &&
          selectedUpstream.consecutive_failures >= auto_disable_threshold &&
          !selectedUpstream.is_disabled
        ) {
          selectedUpstream.is_disabled = true;
          logger.error(
            {
              target: selectedUpstream.target,
              consecutive_failures: selectedUpstream.consecutive_failures,
              auto_disable_threshold
            },
            'Upstream automatically disabled after exceeding failure threshold'
          );
          reqLogger.addStep('upstream_auto_disabled', {
            target: selectedUpstream.target,
            consecutive_failures: selectedUpstream.consecutive_failures
          });
        }

        // 断路器状态转换逻辑
        if (selectedUpstream.status === 'HALF_OPEN') {
          // HALF_OPEN → UNHEALTHY: 测试请求失败，重置恢复时间
          selectedUpstream.status = 'UNHEALTHY';
          selectedUpstream.last_failure_time = Date.now();
          logger.warn({
            target: selectedUpstream.target,
            error: (error as Error).message
          }, 'HALF_OPEN upstream failed, circuit breaker reopened');
          reqLogger.addStep('circuit_breaker_reopened', {
            target: selectedUpstream.target
          });
        } else {
          // HEALTHY/UNHEALTHY 状态的失败处理
          const failureThreshold = effectiveRoute.failover?.passive_health?.consecutive_failures || 3;
          if (selectedUpstream.consecutive_failures >= failureThreshold && selectedUpstream.status !== 'UNHEALTHY') {
            // HEALTHY → UNHEALTHY: 达到连续失败阈值
            selectedUpstream.status = 'UNHEALTHY';
            selectedUpstream.last_failure_time = Date.now();
            logger.warn({
              target: selectedUpstream.target,
              consecutive_failures: selectedUpstream.consecutive_failures,
              failureThreshold
            }, 'Upstream marked as UNHEALTHY after consecutive failures (circuit breaker opened)');
            reqLogger.addStep('circuit_breaker_opened', {
              target: selectedUpstream.target,
              consecutive_failures: selectedUpstream.consecutive_failures
            });
          } else if (selectedUpstream.status === 'UNHEALTHY') {
            // 已经是 UNHEALTHY 状态，更新失败时间
            selectedUpstream.last_failure_time = Date.now();
          } else {
            logger.debug({
              target: selectedUpstream.target,
              consecutive_failures: selectedUpstream.consecutive_failures,
              failureThreshold
            }, 'Upstream failure recorded, not yet marked UNHEALTHY');
          }
        }

        // 如果是最后一个上游，不要继续循环，直接跳出
        if (isLastUpstream) {
          break;
        }
      } finally {
        decrementCounter();
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
  } catch (error) {
    success = false;
    throw error;
  } finally {
    if (!deferFinallyToStream) {
      await finalizeRequest();
    }
  }
}
