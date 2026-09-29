/**
 * Request proxy module
 * Core logic for proxying requests to upstream servers
 */

import { logger } from '../../logger';
import { forEach, isEmpty } from 'lodash-es';
import type { AppConfig, PluginConfigOptions } from '@jeffusion/bungee-types';
import type { PluginManifest } from '../../plugin.types';
import type { RequestLogger } from '../../logger/request-logger';
import { processDynamicValue } from '../../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream, RequestSnapshot } from '../types';
import type { PhaseAwareHooks } from '../../scoped-plugin-registry';
import { buildRequestContextFromSnapshot } from './context-builder';
import type { MutableRequestContext as HookMutableRequestContext } from '../../hooks';
import { cloneMutableRequestContext, rebaseToUpstream, type MutableRequestContext } from './context';
import { deepMergeRules, applyBodyRules, applyQueryRules } from '../rules/modifier';
import { prepareResponse, type StreamCompletionState } from '../response/processor';
import { isStreamingResponse } from '../response/streaming-response';
import type { RawResponseCompletion, RawResponseResult } from '../../plugin-control/contracts';
import { getBoundControlClient } from '../../config-worker/runtime-dependencies';
import { getPluginRegistry } from '../state/plugin-manager';
import {
  assertCredentialTarget,
  applyOutboundHeaderProfile,
  credentialPolicyFromManifest,
  HOP_HEADERS,
  sanitizeError,
  sanitizeMessage,
  stripCredentialHeaders,
  validateCredentialLease,
} from './credential';

type ExtendedRequestInit = RequestInit & { verbose?: boolean };
type NetworkError = { message?: unknown; code?: unknown };

export interface ProxyRequestResult {
  response: Response;
  completion: Promise<RawResponseCompletion>;
  cleanup?: () => Promise<void>;
  streamCompletionState?: StreamCompletionState;
  upstreamId: string;
  credentialLeaseVersion?: number;
  rejectAccess?: (signal: AbortSignal) => Promise<void>;
  shortCircuitedByPlugin?: boolean;
}

export interface ProxyAttemptOptions {
  readonly servingRevision?: number;
  readonly attemptId: string;
}

export class AttemptCleanupError extends Error {
  constructor(message = 'upstream attempt cleanup failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AttemptCleanupError';
  }
}

export class UpstreamPhaseFailoverSignal extends Error {
  readonly reason?: string;

  constructor(reason?: string) {
    super(reason ? `Upstream phase requested failover: ${reason}` : 'Upstream phase requested failover');
    this.name = 'UpstreamPhaseFailoverSignal';
    this.reason = reason;
  }
}

export class ManagedUpstreamAccessError extends Error {
  readonly code = 'managed_upstream_access_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedUpstreamAccessError';
  }
}

export class UpstreamTimeoutError extends Error {
  readonly code = 'upstream_timeout';

  constructor(timeoutType: 'first_response_timeout' | 'request_timeout') {
    super(timeoutType === 'first_response_timeout'
      ? 'Upstream first response deadline exceeded'
      : 'Upstream request deadline exceeded');
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamNetworkError extends Error {
  readonly code = 'upstream_network_error';

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamNetworkError';
  }
}

export function isUpstreamTimeoutError(error: unknown): error is UpstreamTimeoutError {
  return error instanceof UpstreamTimeoutError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'upstream_timeout');
}

export function isUpstreamNetworkError(error: unknown): error is UpstreamNetworkError {
  return error instanceof UpstreamNetworkError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'upstream_network_error');
}

export function isManagedUpstreamAccessError(error: unknown): error is ManagedUpstreamAccessError {
  return error instanceof ManagedUpstreamAccessError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'managed_upstream_access_unavailable');
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

function headersForLog(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'api-key', 'x-api-key'].includes(key.toLowerCase())
      ? '[REDACTED]'
      : value;
  });
  return result;
}

type ManagedBy = { plugin: string; contributionId: string; bindingId: string };

function isManagedBy(value: unknown): value is ManagedBy {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.plugin === 'string' && item.plugin.length > 0
    && typeof item.contributionId === 'string' && item.contributionId.length > 0
    && typeof item.bindingId === 'string' && item.bindingId.length > 0;
}

function stripHopHeaders(headers: Headers): void {
  for (const name of HOP_HEADERS) headers.delete(name);
}

function createCompletion(): {
  promise: Promise<RawResponseCompletion>;
  settle: (completion: RawResponseCompletion) => void;
} {
  let settled = false;
  let resolve!: (completion: RawResponseCompletion) => void;
  const promise = new Promise<RawResponseCompletion>((nextResolve) => { resolve = nextResolve; });
  return {
    promise,
    settle(completion) {
      if (settled) return;
      settled = true;
      resolve(completion);
    },
  };
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  const discardLateValue = (value: T): void => {
    try { onLateValue?.(value); } catch { /* cancellation is best effort */ }
    try {
      if (value instanceof Response && value.body) void value.body.cancel('request aborted').catch(() => undefined);
    } catch { /* cancellation is best effort */ }
  };
  if (signal.aborted) {
    void promise.then(discardLateValue, () => undefined);
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void promise.then((value) => {
      if (settled || signal.aborted) {
        discardLateValue(value);
        return;
      }
      finish(resolve, value);
    }, (error) => {
      if (settled || signal.aborted) return;
      finish(reject, error);
    });
  });
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function combineCompletions(
  rawCompletion: Promise<RawResponseCompletion>,
  transportCompletion: Promise<RawResponseCompletion>,
): Promise<RawResponseCompletion> {
  return Promise.all([rawCompletion, transportCompletion]).then(([raw, transport]) =>
    raw.status === 'completed' ? transport : raw,
  );
}

function isSafeUpstreamHttpError(
  originalResponse: Response,
  originalStatus: number,
  rawResponse: RawResponseResult,
  finalResponse: Response,
  completion: RawResponseCompletion,
): boolean {
  // The trusted raw hook generates the safe replacement; core only validates
  // the status and body-consumption invariants around that replacement.
  return (originalStatus < 200 || originalStatus >= 300)
    && rawResponse.response !== originalResponse
    && rawResponse.response.status === originalStatus
    && finalResponse.status === originalStatus
    && (originalResponse.body === null || originalResponse.bodyUsed)
    && completion.status === 'failed'
    && completion.code === 'upstream_http_error';
}

type ManagedCredentialContext = {
  readonly managedBy: ManagedBy;
  readonly control: NonNullable<PluginManifest['control']>;
  readonly bindingOptions: Record<string, unknown>;
  readonly policy: ReturnType<typeof credentialPolicyFromManifest>;
  readonly source: URL;
  readonly endpointId: string;
};

function inspectManagedCredential(upstream: RuntimeUpstream): ManagedCredentialContext {
  const endpoint = upstream as unknown as {
    managedBy?: unknown;
    plugins?: Array<{ id?: string; name?: string; options?: Record<string, unknown>; enabled?: boolean }>;
  };
  if (!isManagedBy(endpoint.managedBy)) throw new Error('managed upstream marker is invalid');
  const managedBy = endpoint.managedBy;
  const pluginSnapshot = getPluginRegistry()?.getPluginStateSnapshot(managedBy.plugin);
  const control = pluginSnapshot?.manifest?.control;
  if (pluginSnapshot?.persistedEnabled === 'disabled' || control === undefined || pluginSnapshot?.manifest === undefined) {
    throw new Error('managed upstream control is unavailable');
  }
  const binding = endpoint.plugins?.find((item) => item.name === managedBy.plugin && item.id === managedBy.bindingId);
  if (!binding || binding.enabled !== true) throw new Error('managed upstream binding is unavailable');
  if (typeof upstream.id !== 'string' || upstream.id.length === 0) {
    throw new Error('managed upstream endpoint identity is unavailable');
  }
  return {
    managedBy,
    control,
    bindingOptions: binding.options ?? {},
    policy: credentialPolicyFromManifest(pluginSnapshot.manifest, managedBy.contributionId),
    source: new URL(upstream.target),
    endpointId: upstream.id,
  };
}

async function acquireManagedCredential(
  upstream: RuntimeUpstream,
  managed: ManagedCredentialContext,
  target: URL,
  expectedPath: string,
  method: string,
  requestSignal: AbortSignal | undefined,
  attemptOptions: ProxyAttemptOptions | undefined,
): Promise<{ headers: Record<string, string>; version: number; rejectAccess: (signal: AbortSignal) => Promise<void> }> {
  if (attemptOptions?.servingRevision === undefined || !Number.isSafeInteger(attemptOptions.servingRevision)
    || attemptOptions.servingRevision < 1 || typeof attemptOptions.attemptId !== 'string' || attemptOptions.attemptId.length === 0) {
    throw new Error('managed upstream attempt identity is unavailable');
  }
  assertCredentialTarget(target, managed.source, managed.policy, method, expectedPath);

  const credentialMethod = managed.control.rpc.find((entry) => entry.name === 'getCredential');
  if (!credentialMethod) throw new Error('managed upstream credential method is not declared');
  const client = getBoundControlClient({
    plugin: managed.managedBy.plugin,
    contributionId: managed.managedBy.contributionId,
    bindingId: managed.managedBy.bindingId,
    bindingOptions: managed.bindingOptions as PluginConfigOptions,
  }, {
    revision: attemptOptions.servingRevision,
    endpointId: managed.endpointId,
    attemptId: attemptOptions.attemptId,
  });
  const targetHref = target.href;
  const lease = validateCredentialLease(await abortable(
    client.call(credentialMethod.name, {}, requestSignal ?? new AbortController().signal),
    requestSignal,
  ));
  if (target.href !== targetHref) throw new Error('managed upstream target changed while acquiring credentials');
  assertCredentialTarget(target, managed.source, managed.policy, method, expectedPath);
  const allowed = new Set(managed.policy.allowedHeaderNames.map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(lease.headers)) {
    const normalized = name.toLowerCase();
    if (HOP_HEADERS.has(normalized) || !allowed.has(normalized)) continue;
    headers[normalized] = value;
  }
  if (Object.keys(headers).length === 0) throw new Error('credential lease has no allowed headers');

  const rejectMethod = managed.control.rpc.find((entry) => entry.name === 'rejectAccess');
  return {
    headers,
    version: lease.version,
    rejectAccess: rejectMethod === undefined
      ? async () => undefined
      : async (signal) => {
        await client.call(rejectMethod.name, { version: lease.version }, signal);
      },
  };
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
  phase1and2Context?: MutableRequestContext,
  requestSignal?: AbortSignal,
  attemptOptions?: ProxyAttemptOptions,
): Promise<ProxyRequestResult> {
  // Record start time for latency calculation
  const requestStartTime = Date.now();
  const completion = createCompletion();
  const transportCompletion = createCompletion();
  let credentialLeaseVersion: number | undefined;
  let rejectAccess: ((signal: AbortSignal) => Promise<void>) | undefined;
  const credentialSecrets: string[] = [];

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
  const managedEndpoint = (upstream as unknown as { managedBy?: unknown }).managedBy !== undefined;
  let managedCredential: ManagedCredentialContext | undefined;
  if (managedEndpoint) {
    try {
      managedCredential = inspectManagedCredential(upstream);
    } catch (error) {
      throw new ManagedUpstreamAccessError('managed upstream access is unavailable', { cause: error });
    }
  }
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
  const { parsedBody } = buildRequestContextFromSnapshot(
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
  const hookHeaders = new Headers({ ...attemptContext.headers });
  hookHeaders.delete('host');

  // 5.1. Remove Authorization header (if auth is enabled)
  const effectiveAuthConfig = route.auth ?? config.auth;
  if (effectiveAuthConfig?.enabled) {
    hookHeaders.delete('Authorization');
    logger.debug(
      { request: requestLog },
      'Removed Authorization header after authentication (automatic security measure)'
    );
  }

  // A managed lease is the only authority for upstream credentials. Strip
  // inbound credential-looking headers before any upstream hook can observe
  // or preserve them; the lease is injected only after all mutable hooks.
  if (managedCredential) stripCredentialHeaders(hookHeaders, managedCredential.policy);

  // 5.2. Apply header modification rules
  if (finalRequestRules.headers) {
    if (finalRequestRules.headers.remove) {
      forEach(finalRequestRules.headers.remove, (key) => hookHeaders.delete(key));
    }
    if (finalRequestRules.headers.replace) {
      forEach(finalRequestRules.headers.replace, (value, key) => {
        if (hookHeaders.has(key)) {
          try {
            hookHeaders.set(key, String(processDynamicValue(value, finalContext)));
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
          hookHeaders.set(key, String(processDynamicValue(value, finalContext)));
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
        hookHeaders.set('Content-Length', String(Buffer.byteLength(body as string)));
      } else {
        hookHeaders.delete('Content-Length');
      }
    } else {
      // Non-JSON body - use original data from snapshot (ArrayBuffer can be reused)
      body = requestSnapshot.body;
    }
  }

  // 6.1. Record request headers before plugin transformation
  // Note: Headers and body will be recorded again after plugin transformation
  if (reqLogger) {
    reqLogger.setRequestHeaders(headersForLog(hookHeaders));
  }

  // ===== 6. Plugin onBeforeRequest (upstream phase) =====
  let pluginBeforeRequestDuration = 0;
  if (upstreamPhase) {
    const headersObj = headersToRecord(hookHeaders);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: new URL(targetUrlForRequest.href),
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
    hookHeaders.forEach((_, key) => {
      hookHeaders.delete(key);
    });
    for (const [key, value] of Object.entries(result.headers)) {
      hookHeaders.set(key, value);
    }
    if (managedCredential) stripCredentialHeaders(hookHeaders, managedCredential.policy);
    stripHopHeaders(hookHeaders);
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
      hookHeaders.set('Content-Length', String(Buffer.byteLength(body as string)));
    } else {
      hookHeaders.delete('Content-Length');
    }
  }

  // 7.2 Record headers and body after plugin transformation
  if (reqLogger) {
    // Record transformed headers
    reqLogger.setRequestHeaders(headersForLog(hookHeaders));

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
    const headersObj = headersToRecord(hookHeaders);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: new URL(targetUrlForRequest.href),
      headers: headersObj,
      body: finalBody,
      clientIP,
      requestId,
      routeId,
      upstreamId: upstream_id,
    };

    const interceptStartTime = performance.now();
    const interceptResult = await upstreamPhase.hooks.onInterceptRequest.promise(ctx);
    const interceptDuration = performance.now() - interceptStartTime;

    if (interceptResult?.action === 'respond') {
      // 记录 plugin 拦截（带耗时）
      if (reqLogger) {
        reqLogger.addStepWithDuration('plugin_intercepted', interceptDuration, {
          message: 'Request intercepted by plugin'
        });
      }
      completion.settle({ status: 'completed' });
      return {
        response: interceptResult.response,
        completion: completion.promise,
        upstreamId: upstream_id,
        shortCircuitedByPlugin: true,
      };
    }

    if (interceptResult?.action === 'failover') {
      throw new UpstreamPhaseFailoverSignal(interceptResult.reason);
    }
  }

  // Hooks receive mutable URL objects; fetch and credential checks use this private copy.
  if (managedCredential) stripCredentialHeaders(hookHeaders, managedCredential.policy);
  stripHopHeaders(hookHeaders);
  const finalTargetUrl = new URL(targetUrlForRequest.href);
  const credentialExpectedPath = finalTargetUrl.pathname;
  let credentialRequest: ReturnType<typeof assertCredentialTarget> | undefined;
  if (managedCredential) {
    try {
      credentialRequest = assertCredentialTarget(
        finalTargetUrl,
        managedCredential.source,
        managedCredential.policy,
        requestSnapshot.method,
        credentialExpectedPath,
      );
    } catch (error) {
      throw new ManagedUpstreamAccessError('managed upstream access is unavailable', { cause: error });
    }
  }
  let fetchHeaders = credentialRequest?.outboundHeaders === undefined
    ? new Headers(hookHeaders)
    : applyOutboundHeaderProfile(hookHeaders, credentialRequest.outboundHeaders);

  const failoverEnabled = route.failover?.enabled === true;
  const isRecoveryAttempt = failoverEnabled &&
    (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN');
  const recoveryTimeoutMs = route.failover?.recovery?.probe_timeout_ms || 3000;
  const configuredRequestTimeoutMs = route.timeouts?.request_ms || 30000;
  const timeoutMs = isRecoveryAttempt ? recoveryTimeoutMs : configuredRequestTimeoutMs;
  const firstResponseTimeoutMs = (route.timeouts as (typeof route.timeouts & { first_response_ms?: number }) | undefined)
    ?.first_response_ms;
  let requestTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let firstResponseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let upstreamResponse: Response | undefined;
  let rawResponse: RawResponseResult | undefined;
  let preparedResponseBody: ReadableStream<Uint8Array> | undefined;
  let streamCompletionState: StreamCompletionState | undefined;
  const attemptController = new AbortController();
  const deadlineController = new AbortController();
  type TimeoutReason = 'first_response_timeout' | 'request_timeout';
  type AbortSource = TimeoutReason | 'client_cancelled';
  let abortSource: AbortSource | null = null;
  let responseHeadersReceived = false;
  const abortWithReason = (_triggeredBy: TimeoutReason) => {
    if (abortSource) return;
    // Request timeout is the global cap. Before response headers, an earlier
    // first-response deadline wins; at equal deadlines it wins deterministically.
    abortSource = !responseHeadersReceived
      && firstResponseTimeoutMs !== undefined
      && firstResponseTimeoutMs > 0
      && firstResponseTimeoutMs <= timeoutMs
      ? 'first_response_timeout'
      : 'request_timeout';
    deadlineController.abort(abortSource);
  };
  const captureClientAbort = () => { abortSource ??= 'client_cancelled'; };
  let cleanupPromise: Promise<void> | null = null;
  const clearRequestTimeout = () => {
    if (requestTimeoutId) {
      clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  };
  const clearFirstResponseTimeout = () => {
    if (firstResponseTimeoutId) {
      clearTimeout(firstResponseTimeoutId);
      firstResponseTimeoutId = null;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearRequestTimeout();
      clearFirstResponseTimeout();
      requestSignal?.removeEventListener('abort', captureClientAbort);
      const bodies = [upstreamResponse, rawResponse?.response]
        .filter((response): response is Response => response !== undefined && !response.bodyUsed)
        .map((response) => response.body)
        .filter(Boolean) as ReadableStream<Uint8Array>[];
      const streamTeardown = streamCompletionState?.teardown;
      const requestTeardown = streamCompletionState?.teardownNow?.('attempt cleanup');
      const cancelPreparedBody = preparedResponseBody?.cancel('attempt cleanup').catch(() => undefined);
      const waitsForStreamTeardown = Boolean(streamTeardown && preparedResponseBody);
      if (!waitsForStreamTeardown) attemptController.abort('attempt cleanup');
      const cancel = Promise.all(bodies.map(async (body) => {
        try { await body.cancel(); } catch (error) { throw error; }
      }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (waitsForStreamTeardown) attemptController.abort('attempt cleanup timeout');
          reject(new AttemptCleanupError('upstream attempt cleanup timed out'));
        }, 250);
      });
      try {
        await Promise.race([
          Promise.all([
            cancel,
            cancelPreparedBody,
            requestTeardown,
            streamTeardown ?? Promise.resolve(),
          ]),
          deadline,
        ]);
        if (waitsForStreamTeardown) attemptController.abort('attempt cleanup');
      } catch (error) {
        if (error instanceof AttemptCleanupError) throw error;
        throw new AttemptCleanupError('upstream attempt cleanup failed', { cause: sanitizeError(error, credentialSecrets) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return cleanupPromise;
  };

  if (requestSignal?.aborted) captureClientAbort();
  else requestSignal?.addEventListener('abort', captureClientAbort, { once: true });
  if (firstResponseTimeoutMs !== undefined && firstResponseTimeoutMs > 0) {
    firstResponseTimeoutId = setTimeout(() => abortWithReason('first_response_timeout'), firstResponseTimeoutMs);
  }
  requestTimeoutId = setTimeout(() => abortWithReason('request_timeout'), timeoutMs);
  const attemptSignal = AbortSignal.any([requestSignal, attemptController.signal, deadlineController.signal]
    .filter(Boolean) as AbortSignal[]);
  const fetchOptions: ExtendedRequestInit = {
    method: requestSnapshot.method,
    headers: fetchHeaders,
    body,
    redirect: 'manual',
    keepalive: true,
    verbose: false,
    signal: attemptSignal,
  };

  try {
    // ===== 8. Managed credential acquisition (after all mutable hooks) =====
    if (managedCredential) {
      let credential: Awaited<ReturnType<typeof acquireManagedCredential>>;
      try {
        credential = await acquireManagedCredential(
          upstream,
          managedCredential,
          finalTargetUrl,
          credentialExpectedPath,
          requestSnapshot.method,
          attemptSignal,
          attemptOptions,
        );
      } catch {
        if (abortSource === 'first_response_timeout' || abortSource === 'request_timeout') {
          throw new UpstreamTimeoutError(abortSource);
        }
        if (abortSource === 'client_cancelled') throw new Error('Request cancelled');
        throw new ManagedUpstreamAccessError('managed upstream access is unavailable');
      }
      credentialLeaseVersion = credential.version;
      rejectAccess = credential.rejectAccess;
      credentialSecrets.push(...Object.values(credential.headers));
      for (const [name, value] of Object.entries(credential.headers)) fetchHeaders.set(name, value);
    }

    // ===== 9. Execute the request =====
    stripHopHeaders(fetchHeaders);
    logger.debug({ request: { requestId } }, `\n=== Proxying to target ===`);
    logger.debug({ request: { requestId } }, 'Final path with base path');

    let headerCount = 0;
    fetchHeaders.forEach(() => {
      headerCount += 1;
    });
    logger.debug(
      {
        request: { requestId },
        fetchOptions: {
          method: fetchOptions.method,
          redirect: fetchOptions.redirect,
          keepalive: fetchOptions.keepalive,
          verbose: fetchOptions.verbose,
          hasBody: Boolean(fetchOptions.body),
          headerCount
        },
        timeouts: {
          firstResponseTimeoutMs,
          requestTimeoutMs: timeoutMs
        }
      },
      'Configured fetch options for upstream request'
    );

    logger.debug(
      {
        request: { requestId },
        timeout: timeoutMs,
        firstResponseTimeout: firstResponseTimeoutMs,
        upstreamStatus: upstream.status,
        isRecoveryAttempt,
      },
      `Request with ${isRecoveryAttempt ? 'recovery' : 'normal'} timeout`
    );

    let proxyRes: Response;
    try {
      proxyRes = await abortable(fetch(finalTargetUrl.href, fetchOptions), attemptSignal);
      upstreamResponse = proxyRes;
      responseHeadersReceived = true;
      clearFirstResponseTimeout();
    } catch (error) {
      clearFirstResponseTimeout();
      clearRequestTimeout();
      if (abortSource === 'first_response_timeout' || abortSource === 'request_timeout') {
        const timeoutReason = abortSource;
        const exceededMs = timeoutReason === 'first_response_timeout' ? firstResponseTimeoutMs : timeoutMs;
        const timeoutMessage = timeoutReason === 'first_response_timeout'
          ? 'Upstream first response deadline exceeded'
          : 'Upstream request deadline exceeded';
        logger.warn(
          {
            request: { requestId },
            timeout: exceededMs,
            timeoutType: timeoutReason,
            upstreamStatus: upstream.status,
            isRecoveryAttempt
          },
          timeoutMessage
        );
        throw new UpstreamTimeoutError(timeoutReason);
      }
      if (abortSource === 'client_cancelled') throw new Error('Request cancelled');
      const networkError = error !== null && typeof error === 'object' ? error as NetworkError : undefined;
      const code = typeof networkError?.code === 'string' ? networkError.code : undefined;
      const errorMessage = typeof networkError?.message === 'string' ? networkError.message : '';
      const rawMessage = sanitizeMessage(errorMessage, credentialSecrets);
      const normalizedMessage = rawMessage.toLowerCase();
      let category: 'connection' | 'socket' | 'dns' | 'network' = 'network';
      let friendlyMessage = 'Upstream network error';

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
        friendlyMessage = `Upstream connection error (${code})`;
      } else if (code && dnsErrorCodes.has(code)) {
        category = 'dns';
        friendlyMessage = `Upstream DNS lookup failed (${code})`;
      } else if (normalizedMessage.includes('socket')) {
        category = 'socket';
        friendlyMessage = 'Upstream socket error';
      }

      logger.error(
        {
          request: { requestId },
          category,
          upstreamStatus: upstream.status,
          isRecoveryAttempt,
          timeouts: {
            firstResponseTimeoutMs,
            requestTimeoutMs: timeoutMs
          }
        },
        `Proxy request failed (${category})`
      );
      throw new UpstreamNetworkError(friendlyMessage);
    }

    logger.debug(
      { request: { requestId }, status: proxyRes.status },
      `\n=== Received Response from target ===`
    );

    const originalResponse = proxyRes;
    const originalStatus = proxyRes.status;

    if (proxyRes.status === 401 && rejectAccess) {
      try {
        await abortable(rejectAccess(attemptSignal), attemptSignal);
      } catch (error) {
        if (abortSource === 'first_response_timeout' || abortSource === 'request_timeout') {
          throw new UpstreamTimeoutError(abortSource);
        }
        if (abortSource === 'client_cancelled') throw new Error('Request cancelled');
        logger.warn(
          { request: requestLog, error: sanitizeError(error, credentialSecrets).message },
          'Failed to reject managed upstream lease',
        );
        throw new ManagedUpstreamAccessError('managed upstream access is unavailable', { cause: error });
      }
    }

    // Strict raw response hooks run before all legacy response processing.
    rawResponse = { response: proxyRes, completion: transportCompletion.promise };
    const hasRawResponseCallbacks = Boolean(phaseAwareHooks && (
      phaseAwareHooks.upstreamPhase.hasRawResponseCallbacks
      || phaseAwareHooks.servicePhase?.hasRawResponseCallbacks
      || phaseAwareHooks.routePhase.hasRawResponseCallbacks
      || phaseAwareHooks.globalPrecompiled?.hasRawResponseCallbacks
    ));
    if (hasRawResponseCallbacks && phaseAwareHooks) {
      rawResponse = await abortable(phaseAwareHooks.inbound.onRawResponse!(rawResponse, {
        method: requestSnapshot.method,
        originalUrl,
        clientIP,
        requestId,
        routeId,
        upstreamId: upstream_id,
        attemptId: attemptOptions?.attemptId ?? requestId,
        signal: attemptSignal,
      }), attemptSignal, (lateResult) => {
        if (lateResult.response.body) void lateResult.response.body.cancel('request aborted').catch(() => undefined);
      });
      if (!(rawResponse.response instanceof Response) || typeof rawResponse.completion?.then !== 'function') {
        throw new Error('strict raw response hook returned an invalid result');
      }
      proxyRes = rawResponse.response;
    }
    const strictCompletion = abortable(
      combineCompletions(rawResponse.completion, transportCompletion.promise),
      attemptSignal,
    ).then(
      (outcome) => outcome.status === 'cancelled'
        && abortSource !== 'client_cancelled'
        && (abortSource === 'first_response_timeout' || abortSource === 'request_timeout')
        ? { status: 'failed' as const, code: abortSource }
        : outcome,
      () => abortSource === 'client_cancelled'
        ? { status: 'cancelled' as const }
        : { status: 'failed' as const, code: abortSource ?? 'attempt_aborted' },
    );

    // ===== 11. Plugin onResponse (inbound chain) =====
    if (!isStreamingResponse(proxyRes) && phaseAwareHooks) {
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
      proxyRes = await abortable(
        Promise.resolve().then(() => phaseAwareHooks.inbound.onResponse(proxyRes, ctx)),
        attemptSignal,
        (lateResponse) => {
          if (lateResponse.body) void lateResponse.body.cancel('request aborted').catch(() => undefined);
        },
      );
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

    // Safe raw HTTP error replacements are intentionally non-stream only.
    if (hasRawResponseCallbacks
      && (rawResponse.response.status < 200 || rawResponse.response.status >= 300)
      && isStreamingResponse(proxyRes)) {
      throw new Error('streaming raw HTTP error replacement requires strict failure');
    }

    streamCompletionState =
      isStreamingResponse(proxyRes)
        ? { interrupted: false, cancelled: false }
        : undefined;

    const preparedResponse = await abortable(
      prepareResponse(
        proxyRes,
        finalResponseRules,
        createExpressionContext(attemptContext),
        requestLog,
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
        )),
        hasRawResponseCallbacks,
        attemptSignal,
      ),
      attemptSignal,
      (lateResponse) => {
        if (lateResponse.body instanceof ReadableStream) {
          void lateResponse.body.cancel('request aborted').catch(() => undefined);
        }
      },
    );
    const { headers: responseHeaders, body: responseBody } = preparedResponse;
    if (streamCompletionState && responseBody instanceof ReadableStream) {
      preparedResponseBody = responseBody;
    }

    if (streamCompletionState) {
      streamCompletionState.completion = strictCompletion;
      streamCompletionState.complete = transportCompletion.settle;
    } else {
      transportCompletion.settle({ status: 'completed' });
      const outcome = await abortable(strictCompletion, attemptSignal);
      logger.info({ request: requestLog, httpStatus: proxyRes.status, protocolOutcome: outcome.status }, 'Upstream response protocol completed');
      if (outcome.status !== 'completed' && !isSafeUpstreamHttpError(
        originalResponse,
        originalStatus,
        rawResponse,
        proxyRes,
        outcome,
      )) {
        throw new Error(`raw response completed with ${outcome.status}:${'code' in outcome ? outcome.code : ''}`);
      }
    }
    const result: ProxyRequestResult = {
      response: new Response(responseBody, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: responseHeaders,
      }),
      completion: strictCompletion,
      cleanup,
      streamCompletionState,
      upstreamId: upstream_id,
      credentialLeaseVersion,
      rejectAccess,
    };
    const completionState = streamCompletionState;
    if (completionState) {
      Object.defineProperty(result, 'completion', {
        enumerable: true,
        get: () => completionState.finalCompletion ?? strictCompletion,
      });
    }
    return result;
  } catch (error) {
    const timeoutReason = abortSource === 'first_response_timeout' || abortSource === 'request_timeout'
      ? abortSource
      : null;
    const deadlineError = timeoutReason ? new UpstreamTimeoutError(timeoutReason) : undefined;
    const clientCancelled = abortSource === 'client_cancelled';
    const safeError = deadlineError
      ?? (clientCancelled ? new Error('Request cancelled')
        : error instanceof UpstreamNetworkError ? error : sanitizeError(error, credentialSecrets));
    const completionFailure = deadlineError
      ? { status: 'failed' as const, code: timeoutReason! }
      : clientCancelled
        ? { status: 'cancelled' as const }
        : { status: 'failed' as const, code: 'attempt_failed' };
    completion.settle(completionFailure);
    transportCompletion.settle(completionFailure);
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (errorDuringCleanup) {
      cleanupError = errorDuringCleanup;
    }
    const cleanupFailure = cleanupError && deadlineError
      ? new AttemptCleanupError('upstream attempt cleanup failed after request deadline', {
        cause: { cleanupError, deadlineError },
      })
      : cleanupError;
    if (error instanceof UpstreamPhaseFailoverSignal) {
      if (cleanupFailure) throw cleanupFailure;
      throw safeError;
    }

    // ===== 11. Plugin onError (inbound chain) =====
    let errorDuration = 0;
    let hookError: Error | undefined;
    if (phaseAwareHooks) {
      const headersObj = headersToRecord(hookHeaders);

      const ctx = {
        method: requestSnapshot.method,
        originalUrl,
        error: safeError,
        headers: headersObj,
        body: finalBody,
        clientIP,
        requestId,
        routeId,
        upstreamId: upstream_id,
      };
      const errorStartTime = performance.now();
      try {
        await bounded(
          Promise.resolve().then(() => phaseAwareHooks.inbound.onError(ctx)),
          100,
          'plugin onError timed out',
        );
      } catch (hookThrown) {
        if (!(hookThrown instanceof Error && hookThrown.message === 'plugin onError timed out')) {
          hookError = sanitizeError(hookThrown, credentialSecrets);
        }
      }
      errorDuration = performance.now() - errorStartTime;

      // 记录 plugin onError 执行（带耗时）
      if (reqLogger && upstreamPhase && upstreamPhase.metadata.pluginCount > 0) {
        reqLogger.addStepWithDuration('plugin_error', errorDuration, {
          count: upstreamPhase.metadata.pluginCount,
          plugins: upstreamPhase.metadata.pluginNames,
          error: safeError.message
        });
      }
    }

    if (cleanupFailure) throw cleanupFailure;
    if (deadlineError) throw deadlineError;
    if (clientCancelled) throw safeError;
    if (error instanceof UpstreamNetworkError) throw safeError;
    throw hookError ?? safeError;
  }
  // 注：预编译 hooks 无需 acquire/release，长生命周期实例
}
