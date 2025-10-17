import { logger } from './logger';
import { statsCollector } from './api/collectors/stats-collector';
import type { AppConfig, Upstream, RouteConfig, ModificationRules, TransformerConfig, ResponseRuleSet } from '@jeffusion/bungee-shared';
import type { Server } from 'bun';
import { loadConfig } from './config';
import { processDynamicValue, type ExpressionContext } from './expression-engine';
import { transformers } from './transformers';
import { createSseTransformerStream } from './streaming';
import { authenticateRequest } from './auth';
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
  lastFailure: number;
}

export const runtimeState = new Map<string, { upstreams: RuntimeUpstream[] }>();

export function initializeRuntimeState(config: AppConfig) {
  runtimeState.clear();
  forEach(config.routes, (route) => {
    if (route.failover?.enabled && route.upstreams && route.upstreams.length > 0) {
      runtimeState.set(route.path, {
        upstreams: map(route.upstreams, (up) => ({
          ...up,
          status: 'HEALTHY' as const,
          lastFailure: 0,
        })),
      });
    }
  });
  logger.info('Runtime state initialized.');
}

// --- Health Checker (Inline) ---
async function probeUpstream(
  retryableStatusCodes: number[],
  requestData: {
    url: string;
    method: string;
    headers: [string, string][];
    body: string | null;
  }
): Promise<boolean> {
  try {
    // Reconstruct headers
    const headers = new Headers();
    for (const [key, value] of requestData.headers) {
      // Avoid headers that cause issues in fetch
      if (!['content-length', 'host'].includes(key.toLowerCase())) {
        headers.append(key, value);
      }
    }

    // Perform the probe request
    const response = await fetch(requestData.url, {
      method: requestData.method,
      headers: headers,
      body: requestData.body,
      redirect: 'manual',
    });

    // A recovery is successful if the status code is NOT one of the retryable codes.
    return !retryableStatusCodes.includes(response.status);
  } catch (error) {
    // If the probe fails, upstream is still unhealthy
    return false;
  }
}

function scheduleHealthCheck(
  target: string,
  retryableStatusCodes: number[],
  requestData: {
    url: string;
    method: string;
    headers: [string, string][];
    body: string | null;
  }
) {
  // Poll every 5 seconds
  const intervalId = setInterval(async () => {
    const recovered = await probeUpstream(retryableStatusCodes, requestData);

    if (recovered) {
      // Update runtime state
      for (const routeState of runtimeState.values()) {
        const upstream = find(routeState.upstreams, (up) => up.target === target);
        if (upstream && upstream.status === 'UNHEALTHY') {
          upstream.status = 'HEALTHY';
          logger.warn({ target }, 'Upstream has recovered and is back in service.');
          clearInterval(intervalId);
          break;
        }
      }
    }
  }, 5000);
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

  const startTime = Date.now();
  let success = true;

  try {

    const requestLog = {
      method: req.method,
      url: url.pathname,
      search: url.search,
      requestId: crypto.randomUUID(),
    };

    logger.info({ request: requestLog }, `\n=== Incoming Request ===`);

    const route = find(config.routes, (r) => url.pathname.startsWith(r.path));

    if (!route) {
      logger.error({ request: requestLog }, `No route found for path: ${url.pathname}`);
      success = false;
      return new Response(JSON.stringify({ error: 'Route not found' }), { status: 404 });
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
        logger.warn(
          {
            request: requestLog,
            authLevel: route.auth ? 'route' : 'global',
            error: authResult.error,
          },
          'Authentication failed'
        );
        success = false;
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
        return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
      }
      const response = await proxyRequest(req, route, selectedUpstream, requestLog, config);
      if (response.status >= 400) {
        success = false;
      }
      return response;
    }

    const healthyUpstreams = filter(routeState.upstreams, (up) => up.status === 'HEALTHY');
    if (healthyUpstreams.length === 0) {
      logger.error({ request: requestLog }, 'No healthy upstreams available for this route.');
      success = false;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }

    const firstTryUpstream = upstreamSelector(healthyUpstreams);
    if (!firstTryUpstream) {
      logger.error({ request: requestLog }, 'Upstream selection failed.');
      success = false;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }
    const retryQueue = sortBy(
      filter(healthyUpstreams, (up) => up.target !== firstTryUpstream.target),
      [(up) => up.priority || 1, (up) => -(up.weight || 100)]
    );
    const attemptQueue = [firstTryUpstream, ...retryQueue];

    for (const upstream of attemptQueue) {
      try {
        const response = await proxyRequest(req, route, upstream, requestLog, config);

        if (!route.failover?.retryableStatusCodes.includes(response.status)) {
          if (response.status >= 400) {
            success = false;
          }
          return response;
        }

        logger.warn({ request: requestLog, target: upstream.target, status: response.status }, 'Upstream returned a retryable status code.');
        throw new Error(`Upstream returned retryable status code: ${response.status}`);

      } catch (error) {
        logger.warn({ request: requestLog, target: upstream.target, error: (error as Error).message }, 'Request to upstream failed. Marking as UNHEALTHY and trying next.');
        upstream.status = 'UNHEALTHY';
        upstream.lastFailure = Date.now();

        // Schedule health check for recovery using a simple GET request
        if (route.failover?.retryableStatusCodes) {
          scheduleHealthCheck(
            upstream.target,
            route.failover.retryableStatusCodes,
            {
              url: upstream.target + '/health',
              method: 'GET',
              headers: [],
              body: null,
            }
          );
        }
      }
    }

    logger.error({ request: requestLog }, 'All healthy upstreams failed.');
    success = false;
    return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
  } finally {
    const responseTime = Date.now() - startTime;
    statsCollector.recordRequest(success, responseTime);
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

async function proxyRequest(req: Request, route: RouteConfig, upstream: Upstream, requestLog: any, config: AppConfig): Promise<Response> {
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

  // 3. Find active transformer rule
  const transformerConfig = upstream.transformer || route.transformer;

  let transformerRules: TransformerConfig[] = [];
  if (typeof transformerConfig === 'string') {
    transformerRules = transformers[transformerConfig] || [];
  } else if (Array.isArray(transformerConfig)) {
    transformerRules = transformerConfig;
  } else if (typeof transformerConfig === 'object' && transformerConfig !== null) {
    transformerRules = [transformerConfig as TransformerConfig];
  }

  let activeTransformerRule: TransformerConfig | undefined;
  if (transformerRules.length > 0) {
    const currentPath = targetUrl.pathname;
    activeTransformerRule = transformerRules.find(rule => {
        try {
            const matches = new RegExp(rule.path.match).test(currentPath);
            return matches;
        } catch (e) {
            return false;
        }
    });
  }

  // 4. Build final request context following the Onion Model
  // Layer 1 (Outer): Route and Upstream rules
  const { path: routePath, upstreams, transformer: routeTransformer, ...routeModificationRules } = route;
  const { target, weight, priority, transformer: upstreamTransformer, ...upstreamModificationRules } = upstream;
  const routeAndUpstreamRequestRules = deepMergeRules(routeModificationRules, upstreamModificationRules);

  let intermediateContext: ExpressionContext = { ...context };
  let intermediateBody = parsedBody;
  if(routeAndUpstreamRequestRules.body) {
    logger.debug({ request: requestLog }, "Applying Route + Upstream body rules (Layer 1)");
    intermediateBody = await applyBodyRules(parsedBody, routeAndUpstreamRequestRules.body, intermediateContext, requestLog);
    intermediateContext.body = intermediateBody;
  }

  // 5a. Apply path transformation using the intermediate context (after upstream rules, before transformer body rules)
  if (activeTransformerRule) {
    logger.debug({ request: requestLog, pathMatch: activeTransformerRule.path.match }, `Activating transformer rule`);
    const { match, replace } = activeTransformerRule.path;
    try {
        const originalPath = targetUrl.pathname;
        const processedReplacement = processDynamicValue(replace, intermediateContext);
        const newPath = originalPath.replace(new RegExp(match), processedReplacement);
        const urlParts = newPath.split('?');
        targetUrl.pathname = urlParts[0];
        targetUrl.search = urlParts.length > 1 ? '?' + urlParts.slice(1).join('?') : '';
        logger.debug({ request: requestLog, path: { from: originalPath, to: targetUrl.pathname + targetUrl.search, rule: match } }, `Applied transformer path rule`);
    } catch(error) {
        logger.error({ request: requestLog, rule: activeTransformerRule.path, error }, 'Failed to apply transformer path rule');
    }
  }

  // 5b. Apply transformer body rules (Inner layer)
  const transformerRequestRules = activeTransformerRule?.request || {};
  let finalBody = intermediateBody;
  if(transformerRequestRules.body) {
    logger.debug({ request: requestLog }, "Applying Transformer body rules (Layer 2)");
    finalBody = await applyBodyRules(intermediateBody, transformerRequestRules.body, intermediateContext, requestLog);
  }

  // Rebuild context with the final body
  const finalContext: ExpressionContext = { ...context, body: finalBody };

  targetUrl.pathname = (targetBasePath === '/' ? '' : targetBasePath.replace(/\/$/, '')) + targetUrl.pathname;

  // 6. Prepare final headers
  const finalRequestRules = deepMergeRules(routeAndUpstreamRequestRules, transformerRequestRules);
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

  // 8. Execute the request
  logger.info({ request: requestLog, target: targetUrl.href }, `\n=== Proxying to target ===`);
  try {
    const proxyRes = await fetch(targetUrl.href, { method: req.method, headers, body, redirect: 'manual' });
    logger.info({ request: requestLog, status: proxyRes.status, target: targetUrl.href }, `\n=== Received Response from target ===`);

    // 9. Prepare the response (Response Onion)
    let finalResponseRules: ModificationRules = {};
    const responseRules = activeTransformerRule?.response;
    let activeResponseRuleSet: ResponseRuleSet | undefined;

    if (responseRules) {
        for (const rule of responseRules) {
            try {
                const statusMatch = new RegExp(rule.match.status).test(String(proxyRes.status));
                // Header matching logic can be added here in the future
                if (statusMatch) {
                    activeResponseRuleSet = rule.rules;
                    logger.debug({ request: requestLog, match: rule.match }, "Found matching response rule");
                    break; // Use the first matching rule
                }
            } catch (e) {
                logger.error({ request: requestLog, rule, error: e }, "Invalid regex in response rule match");
            }
        }
    }

    if (activeResponseRuleSet) {
        if (isStreamingRequest && activeResponseRuleSet.stream) {
            // 对于流式请求，直接使用stream规则（可能是StreamTransformRules或ModificationRules）
            finalResponseRules = activeResponseRuleSet.stream as any;
        } else {
            const responseRuleSet = activeResponseRuleSet.default;
            // Response Onion - Inner layer (Transformer) is applied first, then merged with outer layer (Upstream)
            finalResponseRules = deepMergeRules(responseRuleSet || {}, upstreamModificationRules);
        }
    } else {
        finalResponseRules = upstreamModificationRules;
    }

    const { headers: responseHeaders, body: responseBody } = await prepareResponse(proxyRes, finalResponseRules, context, requestLog, isStreamingRequest);

    return new Response(responseBody, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    throw error;
  }
}

async function prepareResponse(
  res: Response,
  rules: ModificationRules,
  requestContext: ExpressionContext,
  requestLog: any,
  isStreamingRequest: boolean
): Promise<{ headers: Headers; body: BodyInit | null }> {
  const headers = new Headers(res.headers);
  const contentType = headers.get('content-type') || '';

  // Since we are buffering the body, we MUST remove chunked encoding headers.
  headers.delete('transfer-encoding');
  headers.delete('content-encoding');

  if (isStreamingRequest && contentType.includes('text/event-stream') && res.body) {
    logger.info({ request: requestLog }, '--- Applying SSE Stream Transformation ---');

    // For streams, we don't modify content-length here as the final length is unknown.
    return {
      headers,
      body: res.body.pipeThrough(createSseTransformerStream(rules, requestContext, requestLog)),
    };
  }

  // Safely read the body as text first to avoid consuming the stream more than once.
  const rawBodyText = await res.text();
  logger.debug({ request: requestLog, responseBody: rawBodyText }, "Raw response body from upstream");
  let body: BodyInit | null = rawBodyText;

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

  // 🔍 Debug: Log the final response body that will be sent to client
  logger.debug({ request: requestLog, finalResponseBody: finalBody }, "Final response body sent to client");

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

export function startServer(config: AppConfig): Server {
  initializeRuntimeState(config);
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

export function shutdownServer(server: Server) {
  logger.info('Shutting down server...');
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
    const server = startServer(config);

    // Notify master that worker is ready
    if (process.send) {
      process.send({ status: 'ready', pid: process.pid });
    }

    // Listen for shutdown commands from master
    process.on('message', (message: any) => {
      if (message && typeof message === 'object' && message.command === 'shutdown') {
        logger.info(`Worker #${workerId} received shutdown command. Initiating graceful shutdown...`);
        shutdownServer(server);
      }
    });

    const handleSignal = (signal: NodeJS.Signals) => {
      logger.info(`Worker #${workerId} received ${signal}. Initiating graceful shutdown...`);
      shutdownServer(server);
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
