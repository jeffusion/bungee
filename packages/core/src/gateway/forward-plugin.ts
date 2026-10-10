import { createBodySource } from './body-factory';
import { readControlledBody, controlledBodyHandle } from './controlled-views';
import { ResponseViews } from './response-views';
import { observeBodyStream } from './body-observation-stream';
import { RequestRetryAction } from './retry-action';
import type { GatewayRequestOverride } from './contracts';
import { gatewayHooks, requireGatewayResult } from './runtime';
import { DataAdmissionError } from '../data-admission/host';
/**
 * Request proxy module
 * Core logic for proxying requests to upstream servers
 */

import { logger } from '../logger';
import { forEach } from 'lodash-es';
import type { AppConfig, PluginConfigOptions, ResponseModificationRules } from '@jeffusion/bungee-types';
import type { PluginManifest } from '../plugin.types';
import type { RequestLogger } from '../logger/request-logger';
import { processDynamicValue } from '../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream, RequestSnapshot } from '../worker/types';
import type { PhaseAwareHooks } from '../scoped-plugin-registry';
import type { AttemptObservationEvent } from '../hooks/plugin-hooks';
import { readSnapshotJson } from '../worker/request/snapshot';
import { BodySource, bodySourceFor, bindBodySource, cancelBodyReader, BodyBufferLease, BodyProcessingError, isJsonMediaType, isObjectBody, reconcileEntityHeaders } from '../worker/request/body-source';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import { collectPluginBodyRequirements } from '../scoped-plugin-registry';
import { buildRequestContextFromSnapshot } from '../worker/request/context-builder';
import type { MutableRequestContext as HookMutableRequestContext } from '../hooks';
import { cloneMutableRequestContext, rebaseToUpstream, type MutableRequestContext } from '../worker/request/context';
import { deepMergeRules, applyBodyRules } from '../worker/rules/modifier';
import { prepareResponse, type StreamCompletionState } from '../worker/response/processor';
import { isStreamingResponse } from '../worker/response/streaming-response';
import type { RawResponseCompletion, RawResponseResult } from '../plugin-control/contracts';
import { createAttemptResponseObserver } from '../worker/response/attempt-observation';
import { getBoundControlClient } from '../config-worker/runtime-dependencies';
import { getPluginRegistry } from '../worker/state/plugin-manager';
import {
  assertCredentialTarget,
  applyOutboundHeaderProfile,
  credentialPolicyFromManifest,
  HOP_HEADERS,
  sanitizeError,
  sanitizeMessage,
  stripCredentialHeaders,
  validateCredentialLease,
} from '../worker/request/credential';

type ExtendedRequestInit = RequestInit & { verbose?: boolean; timeout?: number | boolean; decompress?: boolean; duplex?: string };
type NetworkError = { message?: unknown; code?: unknown };

export interface ProxyRequestResult {
  repairRetry?: {readonly action:RequestRetryAction;readonly request:GatewayRequestOverride};
  repairFallback?:boolean;
  attemptLogger?:RequestLogger;
  response: Response;
  completion: Promise<RawResponseCompletion>;
  protocolCompletion?: Promise<RawResponseCompletion>;
  observationCompletion?: Promise<void>;
  drainRetryObservation?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  streamCompletionState?: StreamCompletionState;
  upstreamId: string;
  credentialLeaseVersion?: number;
  rejectAccess?: (signal: AbortSignal) => Promise<void>;
  shortCircuitedByPlugin?: boolean;
  /** Deadline evidence only; never derived from an application completion result. */
  transportFailureCode?: () => string | undefined;
}

export interface ProxyAttemptOptions {
  readonly nativeWebSocket?: boolean;
  readonly websocketBridge?: import('../websocket').WebSocketBridge;
  readonly requestOverride?:GatewayRequestOverride;
  readonly servingRevision?: number;
  readonly attemptId: string;
  readonly beforeSend?: (target: { url: string; model: string | null; body: unknown }) => Promise<void>;
  readonly onRequestDispatch?: () => void;
  readonly observeRequest?: (event: AttemptObservationEvent) => Promise<void>;
  readonly shouldObserveResponse?: (protocol: 'json'|'sse') => boolean;
  readonly observeResponse?: (event: AttemptObservationEvent) => Promise<void>;
  readonly observeIncomplete?: (reason: 'raw-response-incomplete', detail?: Pick<AttemptObservationEvent,'direction'|'representation'|'view'>) => Promise<void>;
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

function headersForLog(headers: Headers, credentialHeaderNames: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  const sensitive = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'api-key', 'x-api-key',
    ...credentialHeaderNames.map(name => name.toLowerCase())]);
  headers.forEach((value, key) => {
    result[key] = sensitive.has(key.toLowerCase())
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

function immutableSnapshot<T>(value: T): T {
  let cloned: T;
  try {
    cloned = structuredClone(value);
  } catch {
    return null as T;
  }
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return;
    Object.freeze(item);
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
  };
  freeze(cloned);
  return cloned;
}

function isSafeUpstreamHttpError(
  originalResponse: Response,
  originalStatus: number,
  rawResponse: RawResponseResult,
  finalResponse: Response,
  completion: RawResponseCompletion,
  originalConsumed:boolean, representationChanged:boolean,
): boolean {
  // The trusted raw hook generates the safe replacement; core only validates
  // the status and body-consumption invariants around that replacement.
  return (originalStatus < 200 || originalStatus >= 300)
    && representationChanged && rawResponse.response !== originalResponse
    && rawResponse.response.status === originalStatus
    && finalResponse.status === originalStatus
    && originalConsumed
    && completion.status === 'failed'
    && completion.code === 'upstream_http_error';
}

function isSafeAdaptedErrorResponse(
  originalResponse: Response,
  rawResponse: RawResponseResult,
  finalResponse: Response,
  completion: RawResponseCompletion,
  originalConsumed:boolean, representationChanged:boolean,
): boolean {
  // A trusted adapter may turn a failed HTTP-200 protocol response into a
  // redacted JSON error. Keep that response and its failure diagnostic rather
  // than throwing a generic exception that discards both.
  return completion.status === 'failed' && completion.error !== undefined
    && representationChanged && rawResponse.response !== originalResponse
    && originalConsumed
    && rawResponse.response.status >= 400 && rawResponse.response.status < 600
    && finalResponse.status === rawResponse.response.status
    && rawResponse.response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
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
    body: ctx.body,
    request: {headers:ctx.headers,body:ctx.body},
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
export async function executeForward(
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
  const requestOverride=attemptOptions?.requestOverride;
  let repairRetry:ProxyRequestResult['repairRetry'];
  let finalResponseVersion=0;
  const completion = createCompletion();
  const transportCompletion = createCompletion();
  let credentialLeaseVersion: number | undefined;
  let rejectAccess: ((signal: AbortSignal) => Promise<void>) | undefined;
  const credentialSecrets: string[] = [];
  const responseBodyOwners: Array<{dispose():void}> = [];

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

  if (route.path_rewrite && !requestOverride) {
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

  const selectedDemandUrl = new URL(routeRelativeUrl);
  rebaseToUpstream({url:selectedDemandUrl} as MutableRequestContext,upstream);
  const selectedDemand = collectPluginBodyRequirements([phaseAwareHooks?.upstreamPhase], {
    requestId,method:requestSnapshot.method,url:selectedDemandUrl,routeId,serviceId:route.service,upstreamId:upstream_id,stage:'selected',
  });
  const requestRules = deepMergeRules(route.request ?? {}, upstream.request ?? {});
  const requestBodyMatches = !['GET','HEAD'].includes(requestSnapshot.method)
    && (isJsonMediaType(requestSnapshot.content_type) || requestSnapshot.bodySource?.mode === 'empty');
  if (!requestBodyMatches && hasBodyModification(requestRules.body)) {
    reqLogger?.addStep('request_body_rules_skipped',{reason:'media_type_not_selected',content_type:requestSnapshot.content_type});
    delete requestRules.body;
  }
  const responseRules: ResponseModificationRules = deepMergeRules(upstream.response ?? {}, route.response ?? {});
  if (route.response?.body_formats !== undefined) responseRules.body_formats = route.response.body_formats;
  const readDependency = analyzeExpressionDependencies(requestRules,'request').requestBody
    || analyzeExpressionDependencies(responseRules,'response').requestBody;
  const requestWrite = Boolean(requestOverride) || !['GET','HEAD'].includes(requestSnapshot.method) && (hasBodyModification(requestRules.body) || selectedDemand.request === 'json-write' || phase1and2Context?.bodyWrite === true);
  if (!requestOverride && selectedDemand.replay) await requestSnapshot.bodySource?.buffer('plugin-replay');
  if (!requestOverride && !requestSnapshot.is_json_body && (requestWrite || readDependency || selectedDemand.request !== 'none')) {
    await readSnapshotJson(requestSnapshot,'selected-body-demand',requestWrite || requestSnapshot.bodySource?.mode === 'empty');
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
  if (attemptContext.body === undefined && requestSnapshot.is_json_body) attemptContext.body = structuredClone(requestSnapshot.body);
  attemptContext.url = routeRelativeUrl;
  rebaseToUpstream(attemptContext, upstream);
  attemptContext.upstreamId = upstream_id;
  const targetUrlForRequest = attemptContext.url;

  // ===== 3. Apply route and upstream modification rules =====
  // Layer 1 (Outer): Route and Upstream rules
  const routeAndUpstreamRequestRules = requestRules;
  let intermediateContext = createExpressionContext(attemptContext);
  let intermediateBody = requestOverride ? structuredClone(requestOverride.body) : attemptContext.body;

  if (!requestOverride && hasBodyModification(routeAndUpstreamRequestRules.body) && !['GET','HEAD'].includes(requestSnapshot.method)) {
    if (!isObjectBody(intermediateBody)) throw new BodyProcessingError(400, 'request_body_must_be_object');
    logger.debug({ request: requestLog }, "Applying Route + Upstream body rules (Layer 1)");
    intermediateBody = await applyBodyRules(
      intermediateBody,
      routeAndUpstreamRequestRules.body,
      intermediateContext,
      requestLog
    );
    intermediateContext.body = intermediateBody;
    intermediateContext.request!.body = intermediateBody;
  }

  // Rebuild context with the final body
  attemptContext.body = intermediateBody;
  const finalContext = { ...intermediateContext, body: intermediateBody };
  let finalBody = intermediateBody;

  // ===== 4. Prepare final headers from phase context =====
  const finalRequestRules = routeAndUpstreamRequestRules;
  // Shallow copy is sufficient for headers (all values are strings)
  const hookHeaders = new Headers(requestOverride ? {...requestOverride.headers} : { ...attemptContext.headers });
  if(requestOverride)targetUrlForRequest.href=requestOverride.url;
  hookHeaders.delete('host');

  // A managed lease is the only authority for upstream credentials. Strip
  // inbound credential-looking headers before any upstream hook can observe
  // or preserve them; the lease is injected only after all mutable hooks.
  if (managedCredential) stripCredentialHeaders(hookHeaders, managedCredential.policy);

  if(!requestOverride)requireGatewayResult(await gatewayHooks().onGatewayHeaderRules.promise(hookHeaders,finalRequestRules.headers,finalContext), 'onGatewayHeaderRules');
  // 5.3. Apply query parameter modification rules
  if (!requestOverride && finalRequestRules.query) {
    logger.debug({ request: requestLog }, "Applying query parameter rules");
    const modifiedSearchParams = requireGatewayResult(await gatewayHooks().onGatewayQueryRules.promise(
      new URLSearchParams(targetUrlForRequest.search),
      finalRequestRules.query,
      finalContext,
      requestLog
    ), 'onGatewayQueryRules');
    targetUrlForRequest.search = modifiedSearchParams.toString();
  }

  // ===== 5. Prepare final body from snapshot =====
  let body: BodyInit | null = null;


  // 6.1. Record request headers before plugin transformation
  // Note: Headers and body will be recorded again after plugin transformation
  if (reqLogger) {
    reqLogger.setRequestHeaders(headersForLog(hookHeaders));
  }

  // ===== 6. Plugin onBeforeRequest (upstream phase) =====
  let pluginBeforeRequestDuration = 0;
  if (upstreamPhase && !requestOverride) {
    const headersObj = headersToRecord(hookHeaders);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: new URL(targetUrlForRequest.href),
      headers: headersObj,
      body: finalBody,
      bodyHandle:requestWrite ? undefined:requestSnapshot.bodySource?.handle({requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'request',stage:'outbound-request',version:0,contentType:requestSnapshot.content_type,contentEncoding:requestSnapshot.headers['content-encoding'] ?? ''}),
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


  // 7.2 Record headers and body after plugin transformation
  if (reqLogger) {
    // Record transformed headers
    reqLogger.setRequestHeaders(headersForLog(hookHeaders));

    // Record transformed body (只记录 JSON 类型)
    if (config.logging?.body?.enabled && requestSnapshot.is_json_body && finalBody !== undefined) {
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
  if (!requestOverride && upstreamPhase && upstreamPhase.hasInterceptCallbacks) {
    const headersObj = headersToRecord(hookHeaders);

    const ctx: HookMutableRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      url: new URL(targetUrlForRequest.href),
      headers: headersObj,
      body: finalBody,
      bodyHandle:requestWrite ? undefined:requestSnapshot.bodySource?.handle({requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'request',stage:'outbound-request',version:0,contentType:requestSnapshot.content_type,contentEncoding:requestSnapshot.headers['content-encoding'] ?? ''}),
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
    finalBody = ctx.body;
    targetUrlForRequest.href = ctx.url.href;
    hookHeaders.forEach((_,key)=>hookHeaders.delete(key));
    for (const [key,value] of Object.entries(ctx.headers)) hookHeaders.set(key,value);
  }

  // Strict plugin validation observes a frozen final representation before acquiring
  // an upstream credential or opening a connection, including repair/failover attempts.
  const validation = Object.freeze({method:requestSnapshot.method, originalUrl,
    clientIP, requestId, routeId, upstreamId:upstream_id, url:targetUrlForRequest.href,
    model:isObjectBody(finalBody) && typeof finalBody.model==='string' ? finalBody.model : null,
    body:immutableSnapshot(finalBody), attemptId:attemptOptions?.attemptId??requestId, signal:requestSignal});
  for(const phase of [phaseAwareHooks?.routePhase,phaseAwareHooks?.servicePhase,phaseAwareHooks?.upstreamPhase,phaseAwareHooks?.dispatchAdapter]) {
    await phase?.hooks.onValidateOutbound.promise(validation);
  }

  // Hooks receive mutable URL objects; fetch and credential checks use this private copy.
  if (managedCredential) stripCredentialHeaders(hookHeaders, managedCredential.policy);
  stripHopHeaders(hookHeaders);
  const finalTargetUrl = new URL(targetUrlForRequest.href);
  // Admission does not rewrite Authorization. Forward it according to the
  // configured header rules and hooks; managed upstreams use their own policy.
  const credentialExpectedPath = finalTargetUrl.pathname;
  let credentialRequest: ReturnType<typeof assertCredentialTarget> | undefined;
  if (managedCredential) {
    try {
      credentialRequest = assertCredentialTarget(
        finalTargetUrl,
        managedCredential.source,
        managedCredential.policy,
        attemptOptions?.nativeWebSocket ? 'GET' : requestSnapshot.method,
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
  let observedRawBodyCompleted = false;
  const observationCompletions: Promise<void>[] = [];
  const wireTeardowns: Promise<void>[] = [];
  const ownedWireStreams: ReadableStream<Uint8Array>[] = [];
  const trackResponseWire = (source: ReadableStream<Uint8Array>,onRead?:()=>void): ReadableStream<Uint8Array> => {
    const wireReader = source.getReader();
    let finishWire!: () => void; let failWire!: (error:unknown) => void;
    const wireTeardown = new Promise<void>((resolve,reject) => {finishWire=resolve;failWire=reject;});
    void wireTeardown.catch(() => undefined); wireTeardowns.push(wireTeardown);
    let wireCancelling=false;
    const wireStream=new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { onRead?.();const part=await wireReader.read(); if(part.done){if(!wireCancelling){wireReader.releaseLock();finishWire();controller.close();}}else controller.enqueue(part.value); }
        catch(error){if(!wireCancelling){failWire(error);controller.error(error);}}
      },
      async cancel(reason) {
        wireCancelling=true;
        try {await cancelBodyReader(wireReader,reason);finishWire();}catch(error){failWire(error);throw error;}
        finally {wireReader.releaseLock();}
      },
    },{highWaterMark:0});
    ownedWireStreams.push(wireStream);return wireStream;
  };
  let instrumentedRawResponse: Response | undefined;
  let preparedResponseBody: ReadableStream<Uint8Array> | undefined;
  let streamCompletionState: StreamCompletionState | undefined;
  const attemptController = new AbortController();
  const deadlineController = new AbortController();
  type TimeoutReason = 'first_response_timeout' | 'request_timeout';
  type AbortSource = TimeoutReason | 'client_cancelled';
  let abortSource: AbortSource | null = null;
  void transportCompletion.promise.then((outcome) => {
    const timedOut = abortSource === 'first_response_timeout' || abortSource === 'request_timeout';
    const status = timedOut && outcome.status !== 'completed' ? 'failed' : outcome.status;
    reqLogger?.updateUpstreamTransportOutcome?.(status === 'incomplete' ? 'unknown' : status,
      timedOut && outcome.status !== 'completed' ? abortSource! : 'code' in outcome ? outcome.code : undefined);
  }).catch(() => undefined);
  let responseHeadersReceived = false;
  let deadlineStartedAt = 0;
  const elapsedDeadlineReason = (): TimeoutReason | undefined => {
    if (deadlineStartedAt === 0) return undefined;
    const elapsed = performance.now() - deadlineStartedAt;
    if (!responseHeadersReceived && firstResponseTimeoutMs !== undefined && firstResponseTimeoutMs > 0
      && firstResponseTimeoutMs <= timeoutMs && elapsed >= firstResponseTimeoutMs) {
      return 'first_response_timeout';
    }
    if (elapsed >= timeoutMs) return 'request_timeout';
    return undefined;
  };
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
  const captureClientAbort = () => {
    if (abortSource) return;
    const elapsedTimeout = elapsedDeadlineReason();
    if (elapsedTimeout) abortWithReason(elapsedTimeout);
    else abortSource = 'client_cancelled';
  };
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
      const ownerStops=responseBodyOwners.splice(0).map(owner=>owner instanceof BodySource
        ? owner.cancelReading('attempt cleanup').finally(()=>owner.dispose()) : Promise.resolve().then(()=>owner.dispose()));
      requestSignal?.removeEventListener('abort', captureClientAbort);
      const bodies = [upstreamResponse, rawResponse?.response]
        .filter((response): response is Response => response !== undefined && !response.bodyUsed)
        .map((response) => response.body)
        .filter(body => body !== null && !body.locked && !bodySourceFor(body)) as ReadableStream<Uint8Array>[];
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
      const secondaryWireCancellation=(work:Promise<void>)=>work.catch(error=>{
        // A disposed view can error its wrapper while the independently awaited
        // physical cancellation is still settling. Its synthetic read error is no cancel failure.
        if(error instanceof BodyProcessingError && error.code==='body_stream_cancelled')return;
        throw error;
      });
      try {
        await Promise.race([
          Promise.all([
            cancel,
            cancelPreparedBody,
            requestTeardown,
            ...ownedWireStreams.filter(stream=>!stream.locked).map(stream=>secondaryWireCancellation(stream.cancel('attempt cleanup'))),
            ...wireTeardowns.map(secondaryWireCancellation),
            ...ownerStops,
            streamTeardown ?? Promise.resolve(),
          ]),
          deadline,
        ]);
        if (waitsForStreamTeardown) attemptController.abort('attempt cleanup');
      } catch (error) {
        if (error instanceof AttemptCleanupError) throw error;
        logger.warn({requestId,error:sanitizeError(error,credentialSecrets).message},'Attempt resource cancellation failed');
        throw new AttemptCleanupError('upstream attempt cleanup failed', { cause: sanitizeError(error, credentialSecrets) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return cleanupPromise;
  };

  deadlineStartedAt = performance.now();
  if (requestSignal?.aborted) captureClientAbort();
  else requestSignal?.addEventListener('abort', captureClientAbort, { once: true });
  if (firstResponseTimeoutMs !== undefined && firstResponseTimeoutMs > 0) {
    firstResponseTimeoutId = setTimeout(() => abortWithReason('first_response_timeout'), firstResponseTimeoutMs);
  }
  requestTimeoutId = setTimeout(() => abortWithReason('request_timeout'), timeoutMs);
  const attemptSignal = AbortSignal.any([requestSignal, attemptController.signal, deadlineController.signal]
    .filter(Boolean) as AbortSignal[]);
  const throwIfAttemptCannotDispatch = (): void => {
    if (!abortSource) {
      const elapsedTimeout = elapsedDeadlineReason();
      if (elapsedTimeout) abortWithReason(elapsedTimeout);
    }
    if (abortSource === 'first_response_timeout' || abortSource === 'request_timeout') {
      throw new UpstreamTimeoutError(abortSource);
    }
    if (abortSource === 'client_cancelled' || attemptSignal.aborted) throw new Error('Request cancelled');
  };
  const fetchOptions: ExtendedRequestInit = {
    method: requestSnapshot.method,
    headers: fetchHeaders,
    body,
    redirect: 'manual',
    keepalive: true,
    verbose: false,
    // Route deadlines own cancellation; Bun's default idle timeout can cut off quiet LLM streams early.
    timeout: false,
    signal: attemptSignal,
    decompress: false,
    duplex: 'half',
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
          attemptOptions?.nativeWebSocket ? 'GET' : requestSnapshot.method,
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

    // Entity metadata is reconciled after profiles, hooks and credentials.
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
          timeout: fetchOptions.timeout,
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
      throwIfAttemptCannotDispatch();
      await attemptOptions?.beforeSend?.({ url: finalTargetUrl.href,
        model: null,
        body: immutableSnapshot(finalBody) });
      if (!requestWrite && !['GET','HEAD'].includes(requestSnapshot.method)) fetchOptions.body = requestSnapshot.bodySource?.take() ?? requestSnapshot.body ?? null;
      if (requestWrite && !['GET','HEAD'].includes(requestSnapshot.method)) {
        fetchOptions.body = JSON.stringify(finalBody);
        if(requestOverride)fetchHeaders.set('content-type','application/json');
        if(requestOverride && (typeof fetchOptions.body!=='string' || Buffer.byteLength(fetchOptions.body)> (requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024)))
          throw new BodyProcessingError(413,'request_body_too_large');
        const outputLease=new BodyBufferLease();responseBodyOwners.push(outputLease);outputLease.add(Buffer.byteLength(fetchOptions.body as string));
      }
      reconcileEntityHeaders(fetchHeaders,fetchOptions.body ?? null,requestWrite);
      attemptContext.headers = headersToRecord(fetchHeaders);
      attemptContext.body = finalBody;
      attemptContext.url = finalTargetUrl;
      if (reqLogger) {
        reqLogger.setRequestHeaders(headersForLog(fetchHeaders, managedCredential?.policy.allowedHeaderNames));
        fetchOptions.body = reqLogger.observeBody(fetchOptions.body ?? null, 'request', fetchHeaders, config.logging?.body, attemptSignal,undefined,
          {bodyHandle:requestWrite ? undefined:requestSnapshot.bodySource?.handle(),identity:{requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'request',stage:'outbound-request',version:requestWrite ? 1:0,contentType:fetchHeaders.get('content-type') ?? '',contentEncoding:fetchHeaders.get('content-encoding') ?? ''},maxBodyBytes:requestSnapshot.bodySource?.maxBytes});
      }
      reqLogger?.addStep('request_body_dispatch',{mode:requestWrite ? 'json-write' : requestSnapshot.bodySource?.mode ?? 'empty',reasons:requestSnapshot.bodySource?.reasons ?? [],source:'wire',replay:requestSnapshot.bodySource?.replayable ?? false,observer_incomplete:false});
      throwIfAttemptCannotDispatch();
      if (finalBody !== undefined && attemptOptions?.observeRequest) observationCompletions.push(attemptOptions.observeRequest(Object.freeze({
        requestId,
        routeId,
          attemptId: attemptOptions.attemptId,
          upstreamId: upstream_id,
          phase: 'request' as const,
          direction:'request' as const,representation:'json' as const,
          view:{requestId,attemptId:attemptOptions.attemptId,direction:'request' as const,stage:'outbound-request' as const,version:requestWrite ? 1:0,contentType:fetchHeaders.get('content-type') ?? '',contentEncoding:fetchHeaders.get('content-encoding') ?? ''},
          isActive: () => true,
          // Query strings may contain provider API keys. Path preserves model context without credentials.
          url: finalTargetUrl.pathname,
          body: immutableSnapshot(finalBody),
      })));
      if (finalBody === undefined && attemptOptions?.observeRequest && fetchOptions.body !== null && fetchOptions.body !== undefined) {
        const observer = createAttemptResponseObserver('json',{requestId,routeId,attemptId:attemptOptions.attemptId,upstreamId:upstream_id,status:0},
          event=>attemptOptions.observeRequest!(Object.freeze({...event,direction:'request',representation:'json',view:{requestId,attemptId:attemptOptions.attemptId,direction:'request',stage:'outbound-request',version:requestWrite ? 1:0,contentType:fetchHeaders.get('content-type') ?? '',contentEncoding:fetchHeaders.get('content-encoding') ?? ''}})),undefined,fetchHeaders.get('content-encoding') ?? '', 'request',finalTargetUrl.pathname,attemptSignal,{maxBytes:requestSnapshot.bodySource?.maxBytes,bodyHandle:requestWrite ? undefined:requestSnapshot.bodySource?.handle()});
        const observerSource = fetchOptions.body instanceof ReadableStream ? fetchOptions.body : new Response(fetchOptions.body).body!;
        fetchOptions.body = observeBodyStream(observerSource,observer); observationCompletions.push(observer.completion);
        void transportCompletion.promise.then(() => observer.finish());
      }
      throwIfAttemptCannotDispatch();
      attemptOptions?.onRequestDispatch?.();
      if (attemptOptions?.nativeWebSocket) {
        if (!attemptOptions.websocketBridge || !isObjectBody(finalBody)) throw new DataAdmissionError(422,'websocket_generation_body_required');
        for (const name of ['content-length','content-encoding','transfer-encoding','sec-websocket-key','sec-websocket-version','sec-websocket-protocol']) fetchHeaders.delete(name);
        proxyRes = await abortable(attemptOptions.websocketBridge.requestResponses({url:finalTargetUrl,headers:fetchHeaders,body:finalBody,signal:attemptSignal}),attemptSignal);
      } else proxyRes = await abortable(fetch(finalTargetUrl.href, fetchOptions), attemptSignal);
      upstreamResponse = proxyRes;
      if (!abortSource) {
        const elapsedTimeout = elapsedDeadlineReason();
        if (elapsedTimeout) abortWithReason(elapsedTimeout);
      }
      if (abortSource === 'first_response_timeout' || abortSource === 'request_timeout') {
        throw new UpstreamTimeoutError(abortSource);
      }
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
      if (error instanceof DataAdmissionError || error instanceof BodyProcessingError) throw error;
      if (requestSnapshot.bodySource?.lastError) throw requestSnapshot.bodySource.lastError;
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
    let originalConsumed=proxyRes.body===null;
    let rawRepresentationChanged=false;
    if(proxyRes.body){
      const tracked=new Response(trackResponseWire(proxyRes.body,()=>{originalConsumed=true;}),{status:proxyRes.status,statusText:proxyRes.statusText,headers:proxyRes.headers});
      for(const key of ['url','redirected','type'] as const)Object.defineProperty(tracked,key,{value:proxyRes[key]});
      proxyRes=tracked;
    }

    if (attemptOptions?.observeResponse && proxyRes.body && ![204, 205, 304].includes(proxyRes.status)) {
      const contentType = proxyRes.headers.get('content-type')?.toLowerCase() ?? '';
      // Some managed upstreams omit Content-Type even though the outbound request explicitly asks for SSE.
      const requestedSse = fetchHeaders.get('accept')?.toLowerCase().includes('text/event-stream');
      const protocol = contentType.includes('text/event-stream') || (!contentType && requestedSse)
        ? 'sse'
        : /(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType) ? 'json' : undefined;
      if (!protocol) observationCompletions.push(attemptOptions.observeIncomplete?.('raw-response-incomplete', {
        direction:'response',representation:'wire',view:{requestId,attemptId:attemptOptions.attemptId,direction:'response',stage:'upstream-response',version:0,
          contentType:proxyRes.headers.get('content-type') ?? '',contentEncoding:proxyRes.headers.get('content-encoding') ?? ''},
      }) ?? Promise.resolve());
      if (protocol && (attemptOptions.shouldObserveResponse?.(protocol) ?? true)) {
        try {
          // Preflight metadata reconstruction before locking the transport body in pipeThrough.
          const preflight = new Response(null, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: proxyRes.headers,
          });
          Object.defineProperty(preflight, 'url', { value: proxyRes.url });
          Object.defineProperty(preflight, 'redirected', { value: proxyRes.redirected });
          Object.defineProperty(preflight, 'type', { value: proxyRes.type });

          const sourceResponse = proxyRes;
          const view={requestId,attemptId:attemptOptions.attemptId,direction:'response' as const,stage:'upstream-response' as const,version:0,contentType:sourceResponse.headers.get('content-type') ?? '',contentEncoding:sourceResponse.headers.get('content-encoding') ?? ''};
          const wireOwner=createBodySource(trackResponseWire(sourceResponse.body!),requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024,view.contentEncoding,attemptSignal,view);
          responseBodyOwners.push(wireOwner);
          const handle=wireOwner.handle(view);
          const observer = createAttemptResponseObserver(protocol,{requestId,routeId,attemptId:attemptOptions.attemptId,upstreamId:upstream_id,status:proxyRes.status},
            event=>attemptOptions.observeResponse!(Object.freeze({...event,direction:'response',representation:protocol === 'sse' ? 'sse':'json',view:{requestId,attemptId:attemptOptions.attemptId,direction:'response',stage:'upstream-response',version:0,contentType:sourceResponse.headers.get('content-type') ?? '',contentEncoding:sourceResponse.headers.get('content-encoding') ?? ''}})),()=>{observedRawBodyCompleted=true;},proxyRes.headers.get('content-encoding') ?? '', 'response','',attemptSignal,{maxBytes:requestSnapshot.bodySource?.maxBytes,bodyHandle:handle});
          observationCompletions.push(observer.completion);
          const wireSource=wireOwner.take() as ReadableStream<Uint8Array>;
          const observedBody=observeBodyStream(wireSource,observer);
          bindBodySource(observedBody,wireOwner);
          const observedResponse = new Response(observedBody, {
            status: sourceResponse.status,
            statusText: sourceResponse.statusText,
            headers: sourceResponse.headers,
          });
          Object.defineProperty(observedResponse, 'url', { value: sourceResponse.url });
          Object.defineProperty(observedResponse, 'redirected', { value: sourceResponse.redirected });
          Object.defineProperty(observedResponse, 'type', { value: sourceResponse.type });
          proxyRes = observedResponse;
          instrumentedRawResponse = observedResponse;
          upstreamResponse = observedResponse;
        } catch (error) {
          logger.error({ error, request: requestLog, target: finalTargetUrl.href }, 'Could not safely install attempt response observer');
          // Do not fabricate a response observation if metadata-preserving setup fails.
          throw error;
        }
      }
    }

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

    const responseDemand = collectPluginBodyRequirements([phaseAwareHooks?.upstreamPhase,phaseAwareHooks?.servicePhase,phaseAwareHooks?.routePhase,phaseAwareHooks?.dispatchAdapter], {
      requestId,method:requestSnapshot.method,url:finalTargetUrl,routeId,serviceId:route.service,upstreamId:upstream_id,stage:'selected',
    });
    // Strict raw response hooks run before all legacy response processing.
    rawResponse = { response: proxyRes, completion: transportCompletion.promise };
    const hasRawResponseCallbacks = Boolean(phaseAwareHooks && (
      phaseAwareHooks.upstreamPhase.hasRawResponseCallbacks
      || phaseAwareHooks.servicePhase?.hasRawResponseCallbacks
      || phaseAwareHooks.routePhase.hasRawResponseCallbacks
      || phaseAwareHooks.globalPrecompiled?.hasRawResponseCallbacks
    ));
    if (hasRawResponseCallbacks && phaseAwareHooks) {
      // A declared decoded consumer must fail before exposing a lazy response.
      // This metadata check reserves no reader and leaves opaque forwarding alone.
      const needsDecodedResponse=Boolean(responseDemand.response?.length || selectedDemand.response?.length || phase1and2Context?.bodyRequirements?.response?.length);
      const responseCoding=(proxyRes.headers.get('content-encoding') ?? '').trim().toLowerCase();
      if(needsDecodedResponse && responseCoding && !['identity','gzip','zstd'].includes(responseCoding))
        throw new BodyProcessingError(502,'invalid_response_body');
      const rawView={requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'response' as const,stage:'upstream-response' as const,version:0,
        contentType:proxyRes.headers.get('content-type') ?? '',contentEncoding:proxyRes.headers.get('content-encoding') ?? ''};
      let rawBodyOwner=proxyRes.body ? bodySourceFor(proxyRes.body) : undefined;
      if(!rawBodyOwner && proxyRes.body && (responseDemand.response?.length || selectedDemand.response?.length || phase1and2Context?.bodyRequirements?.response?.length)){
        rawBodyOwner=createBodySource(trackResponseWire(proxyRes.body),requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024,rawView.contentEncoding,attemptSignal,rawView);
        responseBodyOwners.push(rawBodyOwner);
        const ownedResponse=new Response(rawBodyOwner.take(),{status:proxyRes.status,statusText:proxyRes.statusText,headers:proxyRes.headers});
        for(const key of ['url','redirected','type'] as const)Object.defineProperty(ownedResponse,key,{value:proxyRes[key]});
        proxyRes=ownedResponse;rawResponse={...rawResponse,response:ownedResponse};
      }
      const rawViews=new ResponseViews(proxyRes,rawView,requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024,attemptSignal,responseBodyOwners,true,rawBodyOwner);
      const rawContext=rawViews.context({method:requestSnapshot.method,originalUrl,clientIP,requestId,routeId,upstreamId:upstream_id,
        attemptId:attemptOptions?.attemptId ?? requestId,signal:attemptSignal,redactDiagnostic:(message:string)=>sanitizeMessage(message,credentialSecrets)});
      rawResponse = await abortable(phaseAwareHooks.inbound.onRawResponse!({...rawResponse,response:rawViews.input()},rawContext),attemptSignal,
        lateResult=>{if(lateResult.response.body)void lateResult.response.body.cancel('request aborted').catch(()=>undefined);});
      if (!(rawResponse.response instanceof Response) || typeof rawResponse.completion?.then !== 'function')
        throw new Error('strict raw response hook returned an invalid result');
      proxyRes=rawViews.materialize(rawViews.accept(rawResponse.response));
      rawRepresentationChanged=rawViews.changed;
      finalResponseVersion=rawViews.versionNumber();
      rawResponse={...rawResponse,response:proxyRes};
    }

    const rawBodyWasLeftUnconsumed = instrumentedRawResponse
      && rawResponse.response !== instrumentedRawResponse
      && !instrumentedRawResponse.bodyUsed;
    const rawObservationCompletion = rawBodyWasLeftUnconsumed
      ? transportCompletion.promise.then(async () => {
        if (observedRawBodyCompleted) return;
        await attemptOptions?.observeIncomplete?.('raw-response-incomplete', {
          direction:'response',representation:'wire',view:{requestId,attemptId:attemptOptions.attemptId,direction:'response',stage:'upstream-response',version:0,
            contentType:instrumentedRawResponse?.headers.get('content-type') ?? '',contentEncoding:instrumentedRawResponse?.headers.get('content-encoding') ?? ''},
        });
        const bodyToCancel = instrumentedRawResponse?.body;
        if (!bodyToCancel) return;
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            bodyToCancel.cancel('raw response replacement left the observed source incomplete').catch(() => undefined),
            new Promise<void>((resolve) => { cancelTimer = setTimeout(resolve, 100); }),
          ]);
        } catch {
          // A downstream adapter may still own the reader; its completion path handles cancellation.
        } finally {
          if (cancelTimer) clearTimeout(cancelTimer);
        }
      })
      : Promise.resolve();
    const strictCompletion = abortable(
      Promise.all([
        combineCompletions(rawResponse.completion, transportCompletion.promise),
      ]).then(([completion]) => completion),
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

    void strictCompletion.then(clearRequestTimeout,clearRequestTimeout);

    let pluginBodyOwner:BodySource|undefined;
    let restoredPluginWire=false;
    let pluginRepresentationChanged=false;
    if(!isStreamingResponse(proxyRes) && phaseAwareHooks){
      const pluginView={requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'response' as const,stage:'upstream-response' as const,version:finalResponseVersion,
        contentType:proxyRes.headers.get('content-type') ?? '',contentEncoding:proxyRes.headers.get('content-encoding') ?? ''};
      if((responseDemand.response?.includes('json') || selectedDemand.response?.includes('json') || phase1and2Context?.bodyRequirements?.response?.includes('json')) && isJsonMediaType(pluginView.contentType) && proxyRes.body){
        pluginBodyOwner=bodySourceFor(proxyRes.body)??createBodySource(proxyRes.body,requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024,pluginView.contentEncoding,attemptSignal,pluginView);
        if(!responseBodyOwners.includes(pluginBodyOwner))responseBodyOwners.push(pluginBodyOwner);
        try {
          await readControlledBody(pluginBodyOwner,proxyRes.body,()=>pluginBodyOwner!.handle().json({id:'plugin-response-demand',mandatory:true}),attemptSignal);
        } catch(error) {
          if(attemptSignal.aborted || (error instanceof BodyProcessingError && error.status===503))throw error;
          throw new BodyProcessingError(502,'invalid_response_body');
        }
      }
      const views=new ResponseViews(proxyRes,pluginView,requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024,attemptSignal,responseBodyOwners,false,pluginBodyOwner);
      const ctx=views.context({method:requestSnapshot.method,originalUrl,latencyMs:Date.now()-requestStartTime,clientIP,requestId,routeId,upstreamId:upstream_id});
      const responseStartTime=performance.now();
      let transformed:Response;
      try {
        transformed=await abortable(Promise.resolve().then(()=>phaseAwareHooks.inbound.onResponse(views.input(),ctx)),attemptSignal,
          lateResponse=>{if(lateResponse.body)void lateResponse.body.cancel('request aborted').catch(()=>undefined);});
      } catch(error) {
        if(!(error instanceof RequestRetryAction))throw error;
        throwIfAttemptCannotDispatch();
        const headers=headersToRecord(fetchHeaders);
        if(managedCredential)for(const name of managedCredential.policy.allowedHeaderNames)delete headers[name.toLowerCase()];
        repairRetry={action:error,request:{url:finalTargetUrl.href,headers,body:error.body}};
        transformed=views.input();
      }
      proxyRes=views.materialize(views.accept(transformed));pluginBodyOwner=views.source();restoredPluginWire=true;pluginRepresentationChanged=views.changed;
      finalResponseVersion=views.versionNumber();
      if(reqLogger && upstreamPhase && upstreamPhase.metadata.pluginCount>0)
        reqLogger.addStepWithDuration('plugin_response',performance.now()-responseStartTime,{count:upstreamPhase.metadata.pluginCount,plugins:upstreamPhase.metadata.pluginNames});
    }
    // ===== 10. Prepare the response =====
    const finalResponseRules = responseRules;

    // Build stream request context for stream processing
    const streamRequestContext = {
      method: requestSnapshot.method,
      originalUrl,
      clientIP,
      requestId,
      routeId,
      upstreamId: upstream_id,
      attemptId:attemptOptions?.attemptId ?? requestId,
      bodyVersion:finalResponseVersion,
    };

    // Safe raw HTTP error replacements are intentionally non-stream only.
    if (hasRawResponseCallbacks
      && (rawResponse.response.status < 200 || rawResponse.response.status >= 300)
      && isStreamingResponse(proxyRes)) {
      throw new Error('streaming raw HTTP error replacement requires strict failure');
    }

    // A finite raw error replacement must prove its origin before any headers
    // escape. Stream ownership does not weaken the adapter's error contract.
    if (hasRawResponseCallbacks && !isStreamingResponse(proxyRes)
      && rawResponse.completion !== transportCompletion.promise
      && (rawResponse.response.status >= 400 || proxyRes.status >= 400)) {
      // Error replacements are deliberately finite. Consume only this bounded
      // representation to settle the transport half of joined raw proofs.
      const errorBody = createBodySource(proxyRes.body, requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024, '', attemptSignal,{requestId,attemptId:attemptOptions?.attemptId ?? requestId,direction:'response',stage:'client-response',version:1,contentType:proxyRes.headers.get('content-type') ?? '',contentEncoding:''});
      responseBodyOwners.push(errorBody);
      const errorBytes = await errorBody.buffer('raw-error-proof');
      proxyRes = new Response(errorBytes as BodyInit, {status:proxyRes.status,statusText:proxyRes.statusText,headers:proxyRes.headers});
      transportCompletion.settle({status:'completed'});
      const outcome = await abortable(rawResponse.completion, attemptSignal);
      if (outcome.status !== 'completed' && !isSafeUpstreamHttpError(originalResponse, originalStatus, rawResponse, proxyRes, outcome,originalConsumed,rawRepresentationChanged)
        && !isSafeAdaptedErrorResponse(originalResponse, rawResponse, proxyRes, outcome,originalConsumed,rawRepresentationChanged)) {
        logger.warn({requestId,originalStatus,rawStatus:rawResponse.response.status,finalStatus:proxyRes.status,
          completionStatus:outcome.status,completionCode:'code' in outcome?outcome.code:undefined,hasError:'error' in outcome&&outcome.error!==undefined,
          originalBodyUsed:originalResponse.bodyUsed,originalConsumed,representationChanged:rawRepresentationChanged,
          sameResponse:rawResponse.response===originalResponse,contentType:rawResponse.response.headers.get('content-type')},'Raw response error proof rejected');
        throw new Error('raw response error replacement failed validation');
      }
    }

    streamCompletionState = proxyRes.body ? { interrupted: false, cancelled: false, complete: outcome=>{transportCompletion.settle(outcome);} } : undefined;

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
        Boolean(phaseAwareHooks && (selectedDemand.response?.includes('sse-json') || phase1and2Context?.bodyRequirements?.response?.includes('sse-json')) && (
          phaseAwareHooks.globalPrecompiled?.hasStreamCallbacks ||
          phaseAwareHooks.upstreamPhase.hasStreamCallbacks ||
          phaseAwareHooks.servicePhase?.hasStreamCallbacks ||
          phaseAwareHooks.routePhase.hasStreamCallbacks || phaseAwareHooks.dispatchAdapter?.hasStreamCallbacks
        )),
        hasRawResponseCallbacks,
        attemptSignal,
        responseBodyOwners,
        restoredPluginWire ? pluginBodyOwner : undefined,
        pluginRepresentationChanged,
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
      streamCompletionState.complete = outcome=>{transportCompletion.settle(outcome);};
    } else {
      transportCompletion.settle({ status: 'completed' });
      const outcome = await abortable(strictCompletion, attemptSignal);
      logger.info({ request: requestLog, httpStatus: proxyRes.status, protocolOutcome: outcome.status }, 'Upstream response protocol completed');
      if (outcome.status !== 'completed' && !isSafeUpstreamHttpError(
        originalResponse,
        originalStatus,
        rawResponse,
        proxyRes,
        outcome,originalConsumed,rawRepresentationChanged,
      ) && !isSafeAdaptedErrorResponse(originalResponse, rawResponse, proxyRes, outcome,originalConsumed,rawRepresentationChanged)) {
        throw new Error(`raw response completed with ${outcome.status}:${'code' in outcome ? outcome.code : ''}`);
      }
    }
    const result: ProxyRequestResult = {
      repairRetry,
      response: new Response(responseBody, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: responseHeaders,
      }),
      completion: strictCompletion,
      observationCompletion: rawBodyWasLeftUnconsumed || observationCompletions.length > 0
        ? Promise.all([rawObservationCompletion, ...observationCompletions]).then(() => undefined) : undefined,
      drainRetryObservation: instrumentedRawResponse && isJsonMediaType(instrumentedRawResponse.headers.get('content-type') ?? '') ? async () => {
        // Capture finite error usage only when an optional consumer exists. Never
        // retain an unbounded retry body or wait beyond the attempt deadline.
        const body = preparedResponseBody;
        if (!body || body.locked) return;
        const reader = body.getReader(); let size = 0;
        const limit = requestSnapshot.bodySource?.maxBytes ?? 50*1024*1024;
        try { while (size <= limit) { const part = await abortable(reader.read(), attemptSignal); if (part.done) return; size += part.value.byteLength; } }
        finally { await reader.cancel('bounded retry observation finished').catch(() => undefined); reader.releaseLock(); }
      } : undefined,
      protocolCompletion: hasRawResponseCallbacks ? rawResponse.completion : undefined,
      cleanup,
      streamCompletionState,
      upstreamId: upstream_id,
      credentialLeaseVersion,
      rejectAccess,
      transportFailureCode: () => abortSource === 'first_response_timeout' || abortSource === 'request_timeout' ? abortSource : undefined,
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
        : error instanceof UpstreamNetworkError || error instanceof DataAdmissionError || error instanceof BodyProcessingError ? error : sanitizeError(error, credentialSecrets));
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
    if (error instanceof DataAdmissionError || error instanceof BodyProcessingError) throw error;
    throw hookError ?? safeError;
  }
  // 注：预编译 hooks 无需 acquire/release，长生命周期实例
}

import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
export class ForwardPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayForward.tapPromise('builtin.onGatewayForward', executeForward);
  }
}
