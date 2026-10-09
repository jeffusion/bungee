import {normalizeAdmissionError} from '../data-admission/errors';
import { hasWorkerAdmissionSession, type WorkerRequestAdmission, type PreparedAdmissionAttempt } from '../data-admission/worker';
import { DataAdmissionError } from '../data-admission/host';
/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../logger';
import { RequestLogger, type RequestLoggerDependencies, type RequestLogCompletionOptions } from '../logger/request-logger';
import { map } from 'lodash-es';
import type { AppConfig, RouteConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../worker/types';
import { selectUpstream } from '../worker/upstream/selector';
import { runtimeState, incrementActiveRequests, decrementActiveRequests, releaseHalfOpenSlot } from '../worker/state/runtime-state';
import { getScopedPluginRegistry, type AttemptObservationOwner, type PrecompiledHooks } from '../scoped-plugin-registry';
import { createRequestSnapshot, readSnapshotJson, ensureSnapshotCloned, RequestBodyTooLargeError } from '../worker/request/snapshot';
import {
  AttemptCleanupError,
  isUpstreamNetworkError,
  isUpstreamTimeoutError,
  isUpstreamPhaseFailoverSignal,
  isManagedUpstreamAccessError,
  proxyRequest,
  type ProxyRequestResult,
} from '../worker/request/proxy';
import { activateSlowStart, deactivateSlowStart } from '../worker/utils/slow-start';
import { createStatusCodeMatcher, type StatusCodeMatcher } from '../worker/utils/status-code-matcher';
import { checkResponseForFailover } from '../worker/request/response-detector';
import { gatewayHooks, requireGatewayResult } from './runtime';
import {
  buildFinalUpstreamFinallyContext,
  buildRequestLevelFinallyContext,
  cloneMutableRequestContext,
  rebaseToUpstream,
  type MutableRequestContext,
} from '../worker/request/context';
import type { MutableRequestContext as HookMutableRequestContext } from '../hooks';
import type { AttemptObservationEvent, AttemptObservationOutcome } from '../hooks/plugin-hooks';
import { getTrustedDataIdentity, getTrustedWorkerPeer } from '../config-worker/private-transport';
import { isStreamingResponse as isSSEResponse } from '../worker/response/streaming-response';
import { BodyProcessingError, isJsonMediaType, type BodySource } from '../worker/request/body-source';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import { collectPluginBodyRequirements } from '../scoped-plugin-registry';
// Every HTTP body participates in completion/drain; SSE terminal inference is separate.
function isStreamingResponse(response: Response): boolean { return response.body !== null; }

import type { RawResponseCompletion } from '../plugin-control/contracts';
import { observeTransportResponse } from './body-observation-stream';

export interface HandleRequestRuntimeContext {
  servingRevision?: number;
  /** Host-only session context, never accepted from client fields. */
  transport?: 'websocket';
  websocketBridge?: import('../websocket').WebSocketBridge;
  skipEntryRate?: boolean;
  logging?: RequestLoggerDependencies;
}

type UpstreamSelector = (
  upstreams: RuntimeUpstream[],
  route?: EffectiveRouteConfig,
  context?: ExpressionContext,
) => RuntimeUpstream | undefined;

type RequestTransportContext = {
  logger?: RequestLogger;
  loggers?: RequestLogger[];
  routePath?: string;
  upstream?: string;
  failureCode?: () => string | undefined;
};

type CleanupCapableResult = ProxyRequestResult & {
  cleanup?: () => Promise<void>;
};

async function cleanupAttempt(result: ProxyRequestResult, signal: AbortSignal, cancelResponse = true): Promise<void> {
  const cleanup = (result as CleanupCapableResult).cleanup;
  const cleanupPromise = cleanup
    ? cleanup()
    : cancelResponse ? result.response.body?.cancel(signal.reason) : undefined;
  if (!cleanupPromise) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanupPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('attempt cleanup deadline exceeded')), 1_000);
      }),
    ]);
  } catch (error) {
    throw new AttemptCleanupError('upstream attempt cleanup failed; retry stopped', { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ProtocolOutcome = RawResponseCompletion;

function isNeutralClientError(
  status: number,
  outcome: ProtocolOutcome,
  isRetryableStatus: boolean,
): boolean {
  return !isRetryableStatus
    && [400, 404, 422].includes(status)
    && outcome.status === 'failed'
    && outcome.code === 'upstream_http_error';
}

function isDeadlineFailure(error: unknown): boolean {
  if (isUpstreamTimeoutError(error)) return true;
  if (!(error instanceof AttemptCleanupError)) return false;
  const cause = error.cause;
  if (cause instanceof AttemptCleanupError) return isDeadlineFailure(cause);
  return cause !== null && typeof cause === 'object'
    && isUpstreamTimeoutError((cause as { deadlineError?: unknown }).deadlineError);
}

async function awaitProtocolCompletion(
  completion: Promise<ProtocolOutcome>,
  signal: AbortSignal,
): Promise<ProtocolOutcome> {
  if (signal.aborted) return { status: 'cancelled' };

  return new Promise<ProtocolOutcome>((resolve) => {
    let settled = false;
    const onAbort = () => finish({ status: 'cancelled' });
    const finish = (outcome: ProtocolOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    completion.then(
      finish,
      (error) => finish({ status: 'failed', code: error instanceof Error ? error.name : 'raw_completion_failed' }),
    );
  });
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(cleanup);
  });
}

function cloneResponseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function redactRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'api-key', 'x-api-key']) {
    if (name in redacted) redacted[name] = '[REDACTED]';
  }
  return redacted;
}

function createPhaseContext(
  requestSnapshot: Awaited<ReturnType<typeof createRequestSnapshot>>,
  requestId: string,
  routeId: string,
  routeServiceName: string | undefined,
): MutableRequestContext & import('../hooks').MutableRequestContext {
  const originalUrl = new URL(requestSnapshot.url);
  return {
    method: requestSnapshot.method,
    originalUrl,
    url: new URL(requestSnapshot.url),
    headers: { ...requestSnapshot.headers },
    body: requestSnapshot.is_json_body ? structuredClone(requestSnapshot.body) : undefined,
    bodyHandle:requestSnapshot.bodySource?.handle({requestId,attemptId:requestId,direction:'request',stage:'original-request',version:0,
      contentType:requestSnapshot.content_type,contentEncoding:requestSnapshot.headers['content-encoding'] ?? ''}),
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
  if (interceptResult?.action === 'respond') {
    return interceptResult.response;
  }
  if (interceptResult?.action === 'failover') {
    logger.warn(
      {
        request: options.requestLog,
        routeId: options.routeId,
        serviceName: options.serviceName,
        phase: options.phaseName,
        reason: interceptResult.reason,
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
 * 1. **Request logging**: Starts the normal request log
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
 * **Access control**:
 * - Optional admission plugins enforce policies using the trusted ingress identity
 * - Protected routes reject missing credentials or denied scopes
 * - Authorization follows configured header rules and plugin transformations
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
export async function executeHttpRequest(
  req: Request,
  config: AppConfig,
  runtimeContextOrSelector: HandleRequestRuntimeContext | UpstreamSelector = {},
  selectorOverride?: UpstreamSelector,
): Promise<Response> {
  const transport: RequestTransportContext = {};
  let response: Response;
  try { response = await executeHttpRequestInternal(req, config, runtimeContextOrSelector, selectorOverride, transport); }
  catch (error) {
    for (const requestLogger of transport.loggers ?? []) {
      try { requestLogger.releaseUnreturnedTransportFileLog(); } catch { /* diagnostic sink failure */ }
    }
    throw error;
  }
  // A repair can fall back to an earlier response. Release other attempts only
  // once the selected client response is known, so their immutable logs stay final.
  for (const requestLogger of transport.loggers ?? []) {
    if (requestLogger !== transport.logger) requestLogger.releaseUnreturnedTransportFileLog();
  }
  try { transport.logger?.beginTransport(response.status, { routePath: transport.routePath, upstream: transport.upstream }); }
  catch { /* A diagnostic sink failure must not prevent forwarding. */ }
  return observeTransportResponse(response, req.signal,
    (outcome, code) => transport.logger?.updateTransportOutcome(outcome, code),
    () => transport.failureCode?.());
}

async function executeHttpRequestInternal(
  req: Request,
  config: AppConfig,
  runtimeContextOrSelector: HandleRequestRuntimeContext | UpstreamSelector,
  selectorOverride: UpstreamSelector | undefined,
  transport: RequestTransportContext,
): Promise<Response> {
  const runtimeContext = typeof runtimeContextOrSelector === 'function' ? undefined : runtimeContextOrSelector;
  const upstreamSelector = typeof runtimeContextOrSelector === 'function'
    ? runtimeContextOrSelector
    : selectorOverride ?? selectUpstream;
  const requestLoggers: RequestLogger[] = [];
  transport.loggers = requestLoggers;
  const fileLogReleases: Array<() => void> = [];
  const createRequestLogger = async (request: Request, options?: ConstructorParameters<typeof RequestLogger>[1]): Promise<RequestLogger> => {
    const requestLogger = requireGatewayResult(requireGatewayResult(await gatewayHooks().onGatewayLog.promise({phase:'create',request,options,dependencies:runtimeContext?.logging}), 'onGatewayLog').logger, 'onGatewayLog');
    requestLogger.deferFileLogUntilTransportObserved();
    transport.logger = requestLogger;
    requestLoggers.push(requestLogger);
    if (config.logging?.body?.enabled) fileLogReleases.push(requestLogger.deferFileLog());
    return requestLogger;
  };
  const url = new URL(req.url);
  // Every request enters the normal pipeline and is logged before route matching.
  const reqLogger = await createRequestLogger(req);
  const requestLog = reqLogger.getRequestInfo();

  const startTime = Date.now();
  const trustedIdentity = getTrustedDataIdentity(req);
  const requestId = trustedIdentity?.requestId ?? requestLog.requestId;
  const originalBody = reqLogger.observeBody(req.body, 'original-request', req.headers, config.logging?.body, req.signal, undefined,
    {identity:{requestId,attemptId:requestId,direction:'request',stage:'original-request',version:0,
      contentType:req.headers.get('content-type') ?? '',contentEncoding:req.headers.get('content-encoding') ?? ''}});
  const keyId = trustedIdentity?.principal.domain === 'data' ? trustedIdentity.principal.keyId : null;
  const requestRegistry = getScopedPluginRegistry();
  const leaseReleases: Array<() => void> = [];
  const leasedOwners = new Set<string>();
  const ownerLeases = new Map<string, () => void>();
  const retainOwner = (plugin: string, scope = 'global'): void => {
    const key = `${plugin}\0${scope}`;
    if (leasedOwners.has(key)) return;
    if (requestRegistry?.serviceHost) { const lease = requestRegistry.serviceHost.acquireLease(plugin, scope); leaseReleases.push(lease); ownerLeases.set(key, lease); }
    leasedOwners.add(key);
  };
  const admissionHandlers = requestRegistry?.getGlobalAdmissionHandlers?.() ?? [];
  let dataAdmission: WorkerRequestAdmission | null = null;
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
  let attemptLoggerCreated = false;
  let finalAttemptLogger: RequestLogger | undefined;
  let localFailureResponse: Response | undefined;
  let streamResult: ProxyRequestResult | undefined;
  let rootProtocolOutcome: ProtocolOutcome['status'] | undefined;
  let rootErrorMessage: string | undefined;
  let rootProtocolCode: string | undefined;
  let rootPersisted = false;
  let rootPersisting: Promise<void> | undefined;
  const completedAttemptLoggers = new WeakSet<RequestLogger>();
  const completingAttemptLoggers = new WeakMap<RequestLogger, Promise<void>>();
  const participatingObservationOwners = new Map<string, { owner: AttemptObservationOwner; event: AttemptObservationEvent }>();
  const attemptEndCallbacks = new WeakMap<ProxyRequestResult, (outcome: AttemptObservationOutcome) => Promise<void>>();
  const pendingAttemptEnds = new Map<string, (outcome: AttemptObservationOutcome) => Promise<void>>();
  const observationStates = new Map<string, {
    readonly owners: readonly AttemptObservationOwner[];
    readonly identity: Pick<AttemptObservationEvent, 'requestId' | 'routeId' | 'attemptId' | 'upstreamId' | 'keyId'>;
    disabled: Set<string>;
    incompleteReasons: Set<string>;
  }>();
  const observationTimeoutMs = 250;

  const dispatchObserver = async (owner: AttemptObservationOwner, event: AttemptObservationEvent): Promise<{ failed: boolean; timedOut: boolean; error?: unknown }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const leasedEvent: AttemptObservationEvent = Object.freeze({ ...event, keyId, isActive: () => active && event.isActive() });
    try {
      return await Promise.race([
        owner.hooks.promise(leasedEvent).then(
          () => ({ failed: false, timedOut: false }),
          (error) => ({ failed: true, timedOut: false, error }),
        ),
        new Promise<{ failed: true; timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ failed: true, timedOut: true }), observationTimeoutMs);
        }),
      ]);
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
    }
  };

  const ownerIdentity = (owner: AttemptObservationOwner): string => `${owner.pluginName}\0${owner.scopeKey}`;
  const eventDirection = (event: AttemptObservationEvent): 'request' | 'response' | 'lifecycle' =>
    event.direction ?? (event.phase === 'request' ? 'request' : event.phase === 'response' ? 'response' : 'lifecycle');
  const acceptsObservation = (owner: AttemptObservationOwner, event: AttemptObservationEvent): boolean => {
    if (event.phase === 'request') return owner.observe?.request === true;
    if (event.phase === 'response') return (event.protocol === 'sse' ? owner.observe?.sse : owner.observe?.response) === true;
    return true;
  };
  const notifyObservationIncomplete = async (
    attemptId: string,
    reason: Extract<AttemptObservationEvent,{phase:'incomplete'}>['reason'],
    detail: Pick<AttemptObservationEvent,'direction'|'representation'|'view'> = {direction:'response',representation:'wire'},
    affectedOwners?: readonly AttemptObservationOwner[],
  ): Promise<void> => {
    const state = observationStates.get(attemptId);
    if (!state) return;
    const direction = detail.direction ?? 'response';
    await Promise.all((affectedOwners ?? state.owners.filter(owner => direction === 'request'
      ? owner.observe?.request : owner.observe?.response || owner.observe?.sse)).map(async owner => {
      const consumerId = ownerIdentity(owner);
      const key = `${consumerId}\0${direction}\0${reason}`;
      if (state.incompleteReasons.has(key)) return;
      state.incompleteReasons.add(key);
      state.disabled.add(`${consumerId}\0${direction}`);
      reqLogger.addStep('body_observer_incomplete',{source:detail.representation ?? 'wire',observer_incomplete:true,
        reason,direction,attemptId,consumerId,view:detail.view});
      const event: AttemptObservationEvent = Object.freeze({...state.identity,...detail,direction,consumerId,
        phase:'incomplete',reason,isActive:()=>true});
      const result = await dispatchObserver(owner,event);
      if (result.failed) logger.error({error:result.error,timeout:result.timedOut,pluginName:owner.pluginName,
        requestId:event.requestId,attemptId,phase:'incomplete'},'Attempt observer could not accept incomplete marker');
    }));
  };
  const notifyObservationOwners = async (
    owners: readonly AttemptObservationOwner[], event: AttemptObservationEvent,
  ): Promise<void> => {
    if (event.phase === 'incomplete') return notifyObservationIncomplete(event.attemptId,event.reason,event);
    const state = observationStates.get(event.attemptId);
    const direction = eventDirection(event);
    const lifecycle = event.phase === 'end' || event.phase === 'request-end';
    await Promise.all(owners.filter(owner => acceptsObservation(owner,event)
      && (lifecycle || !state?.disabled.has(`${ownerIdentity(owner)}\0${direction}`))).map(async owner => {
      const result = await dispatchObserver(owner,Object.freeze({...event,consumerId:ownerIdentity(owner)}));
      if (!result.failed) return;
      logger.error({error:result.error,timeout:result.timedOut,pluginName:owner.pluginName,
        requestId:event.requestId,phase:event.phase,direction},'Attempt observer failed or timed out');
      // Failure belongs only to this consumer and this representation direction.
      // A failed request callback cannot disable official upstream response usage.
      await notifyObservationIncomplete(event.attemptId,result.timedOut ? 'observer-timeout':'observer-error',
        {direction:direction === 'lifecycle' ? 'request':direction,representation:event.representation,view:event.view},[owner]);
    }));
  };

  const finishAttemptObservation = async (result: ProxyRequestResult, outcome: AttemptObservationOutcome): Promise<void> => {
    await result.observationCompletion;
    await attemptEndCallbacks.get(result)?.(outcome);
  };

  const completeAttempt = async (
    attemptLogger: RequestLogger,
    status: number,
    options: RequestLogCompletionOptions,
  ): Promise<void> => {
    if (completedAttemptLoggers.has(attemptLogger)) return;
    const inFlight = completingAttemptLoggers.get(attemptLogger);
    if (inFlight) return inFlight;
    const completion = gatewayHooks().onGatewayLog.promise({phase:'complete',logger:attemptLogger,status,options}).then(() => {
      completedAttemptLoggers.add(attemptLogger);
    });
    completingAttemptLoggers.set(attemptLogger, completion);
    try {
      await completion;
    } finally {
      completingAttemptLoggers.delete(attemptLogger);
    }
  };

  const persistRoot = (status: number, options: RequestLogCompletionOptions): Promise<void> => {
    if (rootPersisted) return Promise.resolve();
    if (rootPersisting) return rootPersisting;
    rootPersisting = gatewayHooks().onGatewayLog.promise({phase:'root',logger:reqLogger,status,options}).then(() => {
      rootPersisted = true;
    });
    return rootPersisting.finally(() => {
      rootPersisting = undefined;
    });
  };

  let requestBodySource: BodySource | undefined;
  const finalizeRequest = async () => {
    if (finalized) {
      return;
    }
    finalized = true;
    try {

    const latencyMs = Date.now() - startTime;
    const streamInterrupted = streamResult?.streamCompletionState?.interrupted ?? false;
    const streamCancelled = streamResult?.streamCompletionState?.cancelled ?? false;
    const finalSuccess = success && !streamInterrupted && !streamCancelled;

    await Promise.all(Array.from(pendingAttemptEnds.values()).map((end) => end(req.signal.aborted ? 'cancelled' : 'failed')));

    await Promise.all(Array.from(participatingObservationOwners.values()).map(async ({ owner, event }) => {
      const requestEnd = Object.freeze({
        requestId: event.requestId,
        keyId,
        routeId: event.routeId,
        attemptId: event.attemptId,
        upstreamId: event.upstreamId,
        phase: 'request-end' as const,
        isActive: () => true,
      });
      await notifyObservationOwners([owner], requestEnd);
    }));
    observationStates.clear();


    if (!attemptLoggerCreated) {
      try {
        await persistRoot(responseStatus ?? 500, {
          routePath,
          protocolOutcome: rootProtocolOutcome ?? (finalSuccess ? 'completed' : 'failed'),
          protocolCode: rootProtocolCode,
          errorMessage: rootErrorMessage,
          success: finalSuccess,
        });
      } catch (logError) {
        logger.error({ error: logError }, 'Failed to write root request log');
      }
    }

    if (!routeId) {
      return;
    }

    const scopedRegistry = requestRegistry;
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
    } finally {
      for (const requestLogger of requestLoggers) requestLogger.stopBodyLogging();
      for (const release of fileLogReleases.splice(0)) release();
      requestBodySource?.dispose();
      await dataAdmission?.release();
      for (const release of leaseReleases.splice(0)) release();
    }
  };

  const finalizeStreamingResponse = (
    response: Response,
    result: ProxyRequestResult,
    attemptLogger: RequestLogger,
    onOutcome?: (outcome: ProtocolOutcome) => Promise<void> | void,
  ): Response => {
    transport.logger = attemptLogger;
    transport.failureCode = result.transportFailureCode;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    attemptLogger.setResponseHeaders(responseHeaders);
    const observed = attemptLogger.observeBody(response.body, 'response', response.headers, config.logging?.body, req.signal, response.status);
    if (observed !== response.body) response = cloneResponseWithBody(response, observed as ReadableStream<Uint8Array>);
    if (!isStreamingResponse(response) || !response.body) {
      return response;
    }

    deferFinallyToStream = true;
    const reader = response.body.getReader();
    const resolveOutcome = (outcome: ProtocolOutcome) => outcome;
    let protocolCompletionOutcome: ProtocolOutcome | undefined;
    void (result.protocolCompletion ?? result.streamCompletionState?.completion ?? result.completion).then(
      (outcome) => { protocolCompletionOutcome = outcome; },
      () => undefined,
    );
    const cancellationOutcome = (): ProtocolOutcome => resolveOutcome(
      protocolCompletionOutcome?.status === 'failed' || protocolCompletionOutcome?.status === 'incomplete' || (result.protocolCompletion !== undefined && protocolCompletionOutcome?.status === 'completed')
        ? protocolCompletionOutcome
        : { status: 'cancelled' },
    );
    let resolveFinalCompletion!: (outcome: ProtocolOutcome) => void;
    const finalCompletion = new Promise<ProtocolOutcome>((resolve) => {
      resolveFinalCompletion = resolve;
    });
    if (result.streamCompletionState) {
      result.streamCompletionState.finalCompletion = finalCompletion;
    }
    let settledOutcome: Promise<ProtocolOutcome> | undefined;
    const settleOutcome = (outcome: ProtocolOutcome): Promise<ProtocolOutcome> => {
      if (settledOutcome) return settledOutcome;
      settledOutcome = (async () => {
        const persistedSuccess = outcome.status === 'completed' && response.status < 400;
        success = persistedSuccess;
        if (result.streamCompletionState) {
          result.streamCompletionState.cancelled = outcome.status === 'cancelled';
          result.streamCompletionState.clientCancelled = outcome.status === 'cancelled';
          result.streamCompletionState.interrupted = outcome.status === 'failed' || outcome.status === 'incomplete';
        }
        attemptLogger.updateProtocolOutcome(
          outcome.status,
          persistedSuccess,
          'code' in outcome ? outcome.code : undefined,
          'error' in outcome ? outcome.error : undefined,
        );
        try {
          await onOutcome?.(outcome);
        } finally {
          resolveFinalCompletion(outcome);
        }
        return outcome;
      })();
      return settledOutcome;
    };
    const cancelReader = async (reason?: unknown): Promise<void> => {
      try {
        await Promise.race([
          reader.cancel(reason),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      } catch {
        // Cancellation is bounded so response teardown cannot hang.
      }
    };

    const wrappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await readWithAbort(reader, req.signal);
          if (done) {
            const rawCompletion = result.streamCompletionState?.completion ?? result.completion;
            let completion = await awaitProtocolCompletion(rawCompletion, req.signal);
            // Wire EOF depends only on transport/protocol proof. Side observers
            // finish before accounting and lease cleanup, after the client closes.
            if (result.observationCompletion) controller.close();
            await result.observationCompletion;
            try {
              await cleanupAttempt(result, req.signal, false);
            } catch {
              completion = { status: 'failed', code: 'attempt_cleanup_failed' };
            }
            logger.info({ request: requestLog, httpStatus: response.status, protocolOutcome: completion.status, protocolCode: 'code' in completion ? completion.code : undefined }, 'Upstream response protocol settled');
            await settleOutcome(resolveOutcome(completion));
            if (!result.observationCompletion) controller.close();
            await finalizeRequest();
            return;
          }

          controller.enqueue(value);

        } catch (error) {
          const aborted = req.signal.aborted;
          const rawCompletion = result.streamCompletionState?.completion ?? result.completion;
          const completedOutcome = aborted
            ? cancellationOutcome()
            : await awaitProtocolCompletion(rawCompletion, req.signal);
          const streamOutcome: ProtocolOutcome = !aborted && completedOutcome.status === 'completed'
            ? { status: 'failed', code: 'stream_read_failed' }
            : completedOutcome;
          await cancelReader(error);
          await cleanupAttempt(result, req.signal, false).catch(() => undefined);
          await settleOutcome(resolveOutcome(streamOutcome));
          await finalizeRequest();
          controller.error(error);
        }
      },
      async cancel(reason) {
        const outcome = cancellationOutcome();
        try {
          await cancelReader(reason);
        } finally {
          await cleanupAttempt(result, req.signal, false).catch(() => undefined);
          await settleOutcome(outcome);
          await finalizeRequest();
        }
      },
    }, { highWaterMark: 0 });

    return cloneResponseWithBody(response, wrappedBody);
  };

  const finalizeRootStreamingResponse = (response: Response): Response => {
    const responseLogger = finalAttemptLogger ?? reqLogger;
    responseLogger.beginResponseBodyLogging();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    responseLogger.setResponseHeaders(responseHeaders);
    const observed = responseLogger.observeBody(response.body, 'response', response.headers, config.logging?.body, req.signal, response.status);
    if (observed !== response.body) response = cloneResponseWithBody(response, observed as ReadableStream<Uint8Array>);
    if (!isStreamingResponse(response) || !response.body) return response;

    deferFinallyToStream = true;
    const reader = response.body.getReader();
    let settled: Promise<void> | undefined;
    const settle = (outcome: ProtocolOutcome): Promise<void> => {
      if (settled) return settled;
      settled = (async () => {
        rootProtocolOutcome ??= outcome.status;
        success = outcome.status === 'completed' && response.status < 400;
        await finalizeRequest();
      })();
      return settled;
    };

    const wrappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await readWithAbort(reader, req.signal);
          if (done) {
            await settle({ status: 'completed' });
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          await settle(req.signal.aborted ? { status: 'cancelled' } : { status: 'failed', code: 'stream_read_failed' });
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // Reader teardown must not overwrite an already settled EOF outcome.
        }
        await settle({ status: 'cancelled' });
      },
    });

    return cloneResponseWithBody(response, wrappedBody);
  };

  const finalizeLocalResponse = (response: Response): Response =>
    config.logging?.body?.enabled ? finalizeRootStreamingResponse(response) : response;

  const prepareProcessingErrorResponse = (error: DataAdmissionError | BodyProcessingError): Response => {
    if (error instanceof DataAdmissionError) return finalizeLocalResponse(Response.json({ error: error.code }, {
      status: error.status,
      headers: error.retryAfter === undefined ? {} : { 'retry-after': String(error.retryAfter) },
    }));
    return finalizeLocalResponse(Response.json({ error: error.code, code: error.code, message: error.code,
      ...(error.limitBytes === undefined ? {} : { limit_bytes: error.limitBytes }),
      ...(error.receivedBytes === undefined ? {} : { received_bytes: error.receivedBytes }),
    }, { status: error.status }));
  };

  try {
    logger.debug({ request: requestLog }, `\n=== Incoming Request ===`);

    const routeMatchStart = performance.now();
    const routeDecision = requireGatewayResult(await gatewayHooks().onGatewayRoute.promise({request:req,config}), 'onGatewayRoute');
    let route = routeDecision.route;

    if (!route) {
      logger.error({ request: requestLog }, `No route found for path: ${url.pathname}`);
      success = false;
      responseStatus = 404;
      return finalizeLocalResponse(new Response(JSON.stringify({ error: 'Route not found' }), { status: 404 }));
    }

    // 记录匹配的路由（带耗时）
    routePath = route.path;
    transport.routePath = route.path;
    reqLogger.addStepWithDuration('route_matched', performance.now() - routeMatchStart, { path: route.path });

    // 记录原始请求头和请求体（转换前）
    const originalHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      originalHeaders[key] = value;
    });
    reqLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));

    if (hasWorkerAdmissionSession() && !trustedIdentity) {
      success = false; responseStatus = 401;
      return finalizeLocalResponse(Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } }));
    }
    if (routeDecision.response) {
      responseStatus = routeDecision.response.status;
      success = responseStatus < 400;
      return routeDecision.responseKind === 'rule' ? finalizeRootStreamingResponse(routeDecision.response) : finalizeLocalResponse(routeDecision.response);
    }

    // 创建请求快照（在任何 plugin 执行之前）
    // This ensures each upstream retry gets a clean copy of the original request
    const snapshotStart = performance.now();
    const processingDeadline = AbortSignal.timeout(route.timeouts?.request_ms ?? 30_000);
    const processingSignal = AbortSignal.any([req.signal,processingDeadline]);
    const requestSnapshot = await createRequestSnapshot(req, config.body_parser_limit, processingSignal, originalBody as ReadableStream<Uint8Array> | null,{requestId,attemptId:requestId,direction:'request',stage:'original-request',version:0,contentType:req.headers.get('content-type') ?? '',contentEncoding:req.headers.get('content-encoding') ?? ''});
    requestBodySource = requestSnapshot.bodySource;
    const entryRoute = route;
    const dispatchContext = createPhaseContext(requestSnapshot,requestId,entryRoute.path,entryRoute.service);
    const dispatchHooks = requestRegistry?.getRoutePrecompiledHooks?.(entryRoute.path);
    if (dispatchHooks?.hooks.onDispatchRequest.hasCallbacks()) {
      await readSnapshotJson(requestSnapshot,'internal-dispatch',true);
      dispatchContext.body = structuredClone(requestSnapshot.body);
    }
    for(const owner of requestRegistry?.getRoutePluginOwners?.(entryRoute.path,true) ?? [])retainOwner(owner.pluginName,owner.scopeKey);
    const dispatchWork=()=>gatewayHooks().onGatewayDispatch.promise({config,entry:entryRoute,context:dispatchContext,
      signal:processingSignal,principal:trustedIdentity?.principal,servingRevision:runtimeContext?.servingRevision});
    const dispatch = requireGatewayResult(await (requestRegistry ? requestRegistry.runWithRequestLeases(ownerLeases,dispatchWork) : dispatchWork()), 'onGatewayDispatch');
    route = dispatch.route;
    if (dispatch.target) {
      requestSnapshot.body = dispatch.context.body;
      reqLogger.addStep('internal_dispatch',{entry:entryRoute.id ?? entryRoute.path,target:dispatch.target,model:dispatch.context.body?.model});
    }
    routeId = route.path;
    routeServiceName = route.service;
    const currentRouteId = route.path;
    const effectiveRoute = dispatch.effective;
    const endpoints = effectiveRoute.endpoints;
    const runtimeStateKey = route.service ?? route.path;
    if (trustedIdentity) {
      for (const handler of admissionHandlers) retainOwner(handler.pluginName);
      dataAdmission = requireGatewayResult(await gatewayHooks().onGatewayAdmissionSession.promise({handlers:admissionHandlers, identity:{
        requestId, principal: trustedIdentity.principal, ...(dispatch.entryRouteId ? {entryRouteId:dispatch.entryRouteId} : {}), routeId: route.id ?? currentRouteId,
        serviceId: (route as { service_id?: string }).service_id
          ?? (config.services?.find(service => service.name === route.service) as { id?: string } | undefined)?.id ?? null,
      }, invoke:(plugin, method, payload, target) => requestRegistry!.invokeAdmissionRpc(plugin, method, payload, target, ownerLeases.get(`${plugin}\0global`)!)}), 'onGatewayAdmissionSession');
    }

    const demandHooks = requestRegistry?.getPrecompiledHooks(currentRouteId, undefined, routeServiceName, dispatch.adapter);
    const demandContext = createPhaseContext(requestSnapshot,requestId,currentRouteId,routeServiceName);
    if (dispatch.target) demandContext.url = new URL(dispatch.context.url);
    applyRoutePathRewriteToContext(demandContext,route,requestLog);
    const routeDemand = collectPluginBodyRequirements([demandHooks?.routePhase,demandHooks?.servicePhase,demandHooks?.dispatchAdapter], {
      requestId,method:req.method,url:demandContext.url,routeId:currentRouteId,serviceId:routeServiceName,stage:'route',
    });
    const selectionNeedsBody = analyzeExpressionDependencies({
      conditions:endpoints.map(endpoint=>endpoint.condition),hash:effectiveRoute.load_balancing?.hash_policy?.expression,
      rate:route.rate_limit?.key_expression,
    },'request').requestBody;
    const routeRequestDemand = isJsonMediaType(requestSnapshot.content_type) || requestBodySource?.mode === 'empty'
      ? route.request : {headers:route.request?.headers,query:route.request?.query};
    const routeNeedsBody = analyzeExpressionDependencies(routeRequestDemand,'request').requestBody
      || analyzeExpressionDependencies(route.response,'response').requestBody;
    if (routeDemand.replay || route.retry?.enabled || effectiveRoute.failover?.enabled) await requestBodySource?.buffer('configured-replay');
    if (!requestSnapshot.is_json_body && (selectionNeedsBody || routeNeedsBody || routeDemand.request !== 'none')) await readSnapshotJson(requestSnapshot,
      selectionNeedsBody ? 'selection-expression' : routeDemand.request !== 'none' ? 'plugin-body-demand' : 'route-expression',
      routeDemand.request === 'json-write' && !['GET','HEAD'].includes(req.method));
    reqLogger.addStep('request_body_plan',{mode:requestBodySource?.mode,reasons:requestBodySource?.reasons ?? [],replay:requestBodySource?.replayable ?? false,source:'wire'});
    reqLogger.addStepWithDuration('request_snapshot_created', performance.now() - snapshotStart, {
      method: requestSnapshot.method,
      hasBody: !!requestSnapshot.body,
      bodyType: requestSnapshot.is_json_body ? 'json' : 'binary'
    });

    if (requestSnapshot.body !== undefined && requestSnapshot.is_json_body) {
      reqLogger.setOriginalRequestBody(requestSnapshot.body);
    }

    // 构建表达式上下文（用于 upstream 条件过滤）
    const expressionContext: ExpressionContext = {
      headers: originalHeaders,
      body: requestSnapshot.is_json_body ? requestSnapshot.body : undefined,
      request: {headers:originalHeaders,body:requestSnapshot.is_json_body ? requestSnapshot.body : undefined},
      url: { pathname: url.pathname, search: url.search, host: url.hostname, protocol: url.protocol },
      method: req.method,
      env: process.env as Record<string, string>,
    };

    if (dispatch.target && entryRoute.id !== route.id && !runtimeContext?.skipEntryRate) {
      const entryAdmission = requireGatewayResult(await gatewayHooks().onGatewayAdmission.promise({route:entryRoute,trustedPeer:getTrustedWorkerPeer(req),context:expressionContext,servingRevision:runtimeContext?.servingRevision,signal:processingSignal}), 'onGatewayAdmission');
      if (!entryAdmission.allowed) throw new DataAdmissionError(entryAdmission.retryAfterMs === undefined ? 503 : 429,'entry_route_rate_limited');
    }
    const rateLimit = runtimeContext?.skipEntryRate && route.id === entryRoute.id ? {allowed:true as const} : requireGatewayResult(await gatewayHooks().onGatewayAdmission.promise({
      route,trustedPeer:getTrustedWorkerPeer(req),context:expressionContext,
      servingRevision:runtimeContext?.servingRevision,signal:req.signal,
    }), 'onGatewayAdmission');
    if (!rateLimit.allowed) {
      success = false;
      if (rateLimit.retryAfterMs === undefined) {
        responseStatus = 503;
        return finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      responseStatus = 429;
      return finalizeLocalResponse(new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))),
        },
      }));
    }

    const scopedRegistry = requestRegistry;
    const requestPhaseHooks = scopedRegistry?.getPrecompiledHooks(currentRouteId, undefined, routeServiceName, dispatch.adapter) ?? null;
    const phaseContext = createPhaseContext(requestSnapshot, requestId, currentRouteId, routeServiceName);
    phaseContext.bodyWrite = !!dispatch.target || routeDemand.request === 'json-write';
    if (dispatch.target) phaseContext.url = new URL(dispatch.context.url);
    phaseContext.bodyRequirements = routeDemand;
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
      return finalizeRootStreamingResponse(requireGatewayResult(await gatewayHooks().onGatewayCors.promise(routePhaseResponse, route.cors, req), 'onGatewayCors'));
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
      return finalizeRootStreamingResponse(requireGatewayResult(await gatewayHooks().onGatewayCors.promise(servicePhaseResponse, route.cors, req), 'onGatewayCors'));
    }

    const phase1and2Context = cloneMutableRequestContext(phaseContext);
    expressionContext.headers = phaseContext.headers;
    expressionContext.body = phaseContext.body;
    expressionContext.request = {headers:phaseContext.headers,body:phaseContext.body};
    expressionContext.url = {pathname:phaseContext.url.pathname,search:phaseContext.url.search,host:phaseContext.url.hostname,protocol:phaseContext.url.protocol};

    const settleStreamHealth = (selected: RuntimeUpstream, protocolOk: boolean, status: number): void => {
      if (protocolOk && status < 400) {
        selected.consecutive_failures = 0;
        selected.consecutive_successes++;
        if (selected.status === 'HALF_OPEN') {
          selected.status = 'HEALTHY';
          selected.last_failure_time = undefined;
          selected.recovery_attempt_count = 0;
          activateSlowStart(selected, effectiveRoute);
        } else if (selected.status === 'UNHEALTHY') {
          const threshold = effectiveRoute.failover?.passive_health?.healthy_successes || 2;
          if (selected.consecutive_successes >= threshold) {
            selected.status = 'HEALTHY';
            selected.last_failure_time = undefined;
            selected.recovery_attempt_count = 0;
            activateSlowStart(selected, effectiveRoute);
          }
        }
        return;
      }

      selected.consecutive_successes = 0;
      // An opaque HTTP error that reached EOF retains the status-only health
      // policy. Protocol failures and retryable statuses are handled separately.
      if (protocolOk && status >= 400 && selected.status !== 'HALF_OPEN') return;
      selected.consecutive_failures++;
      if (selected.status === 'HALF_OPEN') {
        selected.status = 'UNHEALTHY';
        selected.last_failure_time = Date.now();
        selected.recovery_attempt_count++;
        deactivateSlowStart(selected);
      } else if (selected.status === 'HEALTHY' && selected.consecutive_failures >= (effectiveRoute.failover?.passive_health?.consecutive_failures || 3)) {
        selected.status = 'UNHEALTHY';
        selected.last_failure_time = Date.now();
      } else if (selected.status === 'UNHEALTHY') {
        selected.last_failure_time = Date.now();
      }
    };

    const settleUpstreamFailure = (selected: RuntimeUpstream, reason: string): void => {
      selected.consecutive_failures++;
      selected.consecutive_successes = 0;

      const auto_disable_threshold = effectiveRoute.failover?.passive_health?.auto_disable_threshold;
      if (auto_disable_threshold
        && selected.consecutive_failures >= auto_disable_threshold
        && !selected.is_disabled) {
        selected.is_disabled = true;
        logger.error({
          upstreamId: selected.upstream_id,
          consecutive_failures: selected.consecutive_failures,
          auto_disable_threshold,
        }, 'Upstream automatically disabled after exceeding failure threshold');
        reqLogger.addStep('upstream_auto_disabled', {
          target: selected.target,
          consecutive_failures: selected.consecutive_failures,
        });
      }

      if (selected.status === 'HALF_OPEN') {
        selected.status = 'UNHEALTHY';
        selected.last_failure_time = Date.now();
        selected.recovery_attempt_count++;
        deactivateSlowStart(selected);
        logger.warn({ upstreamId: selected.upstream_id, error: reason }, 'HALF_OPEN upstream failed, circuit breaker reopened');
        reqLogger.addStep('circuit_breaker_reopened', { target: selected.target });
      } else {
        const failureThreshold = effectiveRoute.failover?.passive_health?.consecutive_failures || 3;
        if (selected.consecutive_failures >= failureThreshold && selected.status !== 'UNHEALTHY') {
          selected.status = 'UNHEALTHY';
          selected.last_failure_time = Date.now();
          logger.warn({
            upstreamId: selected.upstream_id,
            consecutive_failures: selected.consecutive_failures,
            failureThreshold,
          }, 'Upstream marked as UNHEALTHY after consecutive failures (circuit breaker opened)');
          reqLogger.addStep('circuit_breaker_opened', {
            target: selected.target,
            consecutive_failures: selected.consecutive_failures,
          });
        } else if (selected.status === 'UNHEALTHY') {
          selected.last_failure_time = Date.now();
        }
      }
    };

    let repairClaimed=false;
    const proxyWithRouteRetry = async (
      selectedUpstream: RuntimeUpstream,
      attemptLogger: RequestLogger
    ): Promise<ProxyRequestResult> => {
      if(dispatch.requiredUpstreamId && selectedUpstream.upstream_id!==dispatch.requiredUpstreamId)throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
      const phaseAwareHooks = scopedRegistry?.getPrecompiledHooks(currentRouteId, selectedUpstream.upstream_id, routeServiceName, dispatch.adapter) ?? null;
      const attemptLoggers=new Map<ProxyRequestResult,RequestLogger>();
      const runAttempt = async (requestOverride?:import('./contracts').GatewayRequestOverride): Promise<ProxyRequestResult> => {
        const currentLogger=requestOverride?await createRequestLogger(req,{isFailoverAttempt:true,parentRequestId:reqLogger.getRequestId(),attemptUpstream:selectedUpstream.target,requestType:'final'}):attemptLogger;
        if(requestOverride){currentLogger.inheritOriginalBody(reqLogger);currentLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));
          if(requestSnapshot.is_json_body)currentLogger.setOriginalRequestBody(requestSnapshot.body);}
        currentLogger.beginBodyLoggingAttempt();
        const attemptId = crypto.randomUUID();
        const ownerUrl=new URL(phase1and2Context.url);rebaseToUpstream({url:ownerUrl} as MutableRequestContext,selectedUpstream);
        const owners = scopedRegistry?.getAttemptObservationOwners?.(currentRouteId, selectedUpstream.upstream_id, routeServiceName,{requestId,method:req.method,url:ownerUrl,routeId:currentRouteId,serviceId:routeServiceName,upstreamId:selectedUpstream.upstream_id,stage:'selected'}) ?? [];
        for (const owner of owners) retainOwner(owner.pluginName, owner.scopeKey);
        for (const owner of scopedRegistry?.getBoundControlOwners?.(currentRouteId, selectedUpstream.upstream_id) ?? []) retainOwner(owner.pluginName, owner.scopeKey);
        let preparedAdmission: PreparedAdmissionAttempt[] = [];
        const identity = { requestId, keyId, routeId: currentRouteId, attemptId, upstreamId: selectedUpstream.upstream_id };
        if (owners.length > 0) observationStates.set(attemptId, { owners, identity, disabled: new Set(), incompleteReasons: new Set() });
        const selectedEvent: AttemptObservationEvent = Object.freeze({ ...identity, phase: 'selected', isActive: () => true });
        for (const owner of owners) {
          participatingObservationOwners.set(`${owner.pluginName}\0${owner.scopeKey}`, { owner, event: selectedEvent });
        }
        await notifyObservationOwners(owners, selectedEvent);
        let sent = false;
        let ended = false;
        const end = async (outcome: AttemptObservationOutcome): Promise<void> => {
          if (ended) return;
          ended = true;
          pendingAttemptEnds.delete(attemptId);
          await notifyObservationOwners(owners, Object.freeze({
            ...identity,
            phase: 'end' as const, outcome, sent, isActive: () => true,
          }));
          const results = await Promise.allSettled(preparedAdmission.map(prepared => prepared.onResult?.({sent,outcome})));
          for (const result of results) if (result.status === 'rejected') {
            logger.error({error:result.reason,requestId,attemptId}, 'Admission attempt result could not be settled');
          }
        };
        pendingAttemptEnds.set(attemptId, end);
        try {
          const executeProxy = () => proxyRequest(
            requestSnapshot, effectiveRoute, selectedUpstream, requestLog, config, currentRouteId,
            currentLogger, phaseAwareHooks, phase1and2Context, req.signal,
            {
              servingRevision: runtimeContext?.servingRevision,
              websocketBridge: runtimeContext?.websocketBridge,
              nativeWebSocket: runtimeContext?.transport === 'websocket' && route.websocket?.enabled === true && (dispatch.protocol ?? 'responses') === 'responses',
              attemptId,requestOverride,
              beforeSend: dataAdmission ? async (target) => {
                preparedAdmission = requireGatewayResult(await gatewayHooks().onGatewayAdmissionPrepare.promise({session:dataAdmission!,target:{...target,transport:runtimeContext?.transport,attemptId,upstreamId:selectedUpstream.upstream_id},signal:req.signal,readBody:()=>requestOverride ? Promise.resolve(requestOverride.body):readSnapshotJson(requestSnapshot,'admission-body')}), 'onGatewayAdmissionPrepare');
              } : undefined,
              onRequestDispatch: () => { sent = true; },
              observeRequest: owners.some(owner=>owner.observe?.request) ? async (rawEvent) => {
                const event = Object.freeze({ ...rawEvent, keyId });
                for (const owner of owners) {
                  participatingObservationOwners.set(`${owner.pluginName}\0${owner.scopeKey}`, { owner, event });
                }
                await notifyObservationOwners(owners, event);
              } : undefined,
              shouldObserveResponse: protocol => owners.some(owner=>protocol === 'sse' ? owner.observe?.sse : owner.observe?.response) || preparedAdmission.some(prepared=>prepared.observeResponse !== undefined),
              observeResponse: owners.length > 0 || dataAdmission ? async (rawEvent) => {
                const event = Object.freeze({ ...rawEvent, keyId });
                for (const owner of owners) {
                  participatingObservationOwners.set(`${owner.pluginName}\0${owner.scopeKey}`, { owner, event });
                }
                await notifyObservationOwners(owners, event);
                await Promise.all(preparedAdmission.map(prepared => prepared.observeResponse?.(event)));
              } : undefined,
              observeIncomplete: async (reason, detail) => notifyObservationIncomplete(attemptId, reason, detail),
            },
          );
          const result = await (scopedRegistry?.runWithRequestLeases
            ? scopedRegistry.runWithRequestLeases(ownerLeases, executeProxy) : executeProxy());
          result.attemptLogger=currentLogger;attemptLoggers.set(result,currentLogger);
          attemptEndCallbacks.set(result, end);
          return result;
        } catch (error) {
          await end(req.signal.aborted && !isDeadlineFailure(error) ? 'cancelled' : 'failed');
          if(requestOverride)await completeAttempt(currentLogger,503,{routePath,upstream:selectedUpstream.target,protocolOutcome:req.signal.aborted?'cancelled':'failed',
            protocolCode:'repair_attempt_failed',errorMessage:'repair attempt failed',success:false});
          throw error;
        }
      };
      const finishFromCompletion = async (result: ProxyRequestResult): Promise<void> => {
        try {
          const completion = await result.completion;
          await finishAttemptObservation(result, completion.status === 'completed' ? 'completed' : completion.status === 'cancelled' ? 'cancelled' : 'failed');
        } catch {
          await finishAttemptObservation(result, req.signal.aborted ? 'cancelled' : 'failed');
        }
      };
      return requireGatewayResult(await gatewayHooks().onGatewayRetry.promise({
        snapshot:requestSnapshot,route,signal:req.signal,runAttempt,finish:finishFromCompletion,
        claimRepair:()=>{if(repairClaimed)return false;repairClaimed=true;return true;},
        recordAttempt:async(result)=>{const currentLogger=attemptLoggers.get(result);if(!currentLogger)return;
          const outcome=await result.completion;await completeAttempt(currentLogger,result.response.status,{routePath,upstream:selectedUpstream.target,
            protocolOutcome:outcome.status,protocolCode:'code' in outcome?outcome.code:undefined,protocolError:'error' in outcome?outcome.error:undefined,
            success:outcome.status==='completed'&&result.response.ok});},
        cleanup:cleanupAttempt,end:(result,cancelled)=>finishAttemptObservation(result,cancelled ? 'cancelled':'failed'),
      }), 'onGatewayRetry');
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
      const selectedUpstream = requireGatewayResult(await gatewayHooks().onGatewaySelect.promise({upstreams:staticUpstreams,route:effectiveRoute,context:expressionContext,selector:upstreamSelector}), 'onGatewaySelect').upstream;
      if (!selectedUpstream) {
        logger.error({ request: requestLog }, 'No valid upstream found for route.');
        success = false;
        responseStatus = 500;
        return finalizeLocalResponse(new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 }));
      }
      upstream = selectedUpstream.target;
      transport.upstream = selectedUpstream.target;
      lastAttemptedUpstreamId = selectedUpstream.upstream_id;

      // 创建请求日志记录器（无故障转移，单次尝试，类型为 final）
      let attemptLogger = await createRequestLogger(req, {
        isFailoverAttempt: false,
        requestType: 'final'
      });
      finalAttemptLogger = attemptLogger;
      attemptLogger.inheritOriginalBody(reqLogger);
      attemptLoggerCreated = true;

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));
      if (requestSnapshot.body !== undefined && requestSnapshot.is_json_body) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      reqLogger.addStep('upstream_selected', { target: upstream });
      let result: ProxyRequestResult;
      try {
        result = await proxyWithRouteRetry(selectedUpstream, attemptLogger);
        attemptLogger=result.attemptLogger??attemptLogger;finalAttemptLogger=attemptLogger;
      } catch (error) {
        if (error instanceof DataAdmissionError || error instanceof BodyProcessingError) {
          localFailureResponse = prepareProcessingErrorResponse(error);
          if (error instanceof BodyProcessingError) {
            const body = {error:error.code,code:error.code,message:error.code,
              ...(error.limitBytes === undefined ? {} : {limit_bytes:error.limitBytes}),
              ...(error.receivedBytes === undefined ? {} : {received_bytes:error.receivedBytes})};
            attemptLogger.setResponseBody(body);attemptLogger.setResponseHeaders({'content-type':'application/json'});
            attemptLogger.addStep(error.status === 413 ? 'request_body_rejected' : 'body_processing_rejected',body);
          }
          await completeAttempt(attemptLogger,error.status,{routePath,upstream:selectedUpstream.target,protocolOutcome:'failed',protocolCode:error.code,errorMessage:error.code,success:false});
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof AttemptCleanupError) {
          success = false;
          responseStatus = 503;
          const response = finalizeLocalResponse(new Response(JSON.stringify({ error: error.message }), { status: 503 }));
          await completeAttempt(attemptLogger, 503, {
            routePath, upstream: selectedUpstream.target, errorMessage, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          return response;
        }
        if (isManagedUpstreamAccessError(error)) {
          success = false;
          responseStatus = 503;
          const response = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }));
          await completeAttempt(attemptLogger, 503, {
            routePath, upstream: selectedUpstream.target, errorMessage, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          return response;
        }
        if (isUpstreamTimeoutError(error)) {
          success = false;
          responseStatus = 504;
          const response = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Gateway Timeout' }), { status: 504 }));
          await completeAttempt(attemptLogger, 504, {
            routePath, upstream: selectedUpstream.target, errorMessage: error.message, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          return response;
        }
        if (isUpstreamPhaseFailoverSignal(error)) {
          logger.warn(
            { request: requestLog, target: selectedUpstream.target, reason: error.reason },
            'Upstream phase requested failover but no failover loop is active.'
          );
          success = false;
          responseStatus = 503;
          const response = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }));
          await completeAttempt(attemptLogger, 503, {
            routePath, upstream: selectedUpstream.target, errorMessage, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          return response;
        }
        await completeAttempt(attemptLogger, 503, {
          routePath, upstream: selectedUpstream.target, errorMessage, protocolOutcome: 'failed', success: false,
        }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
        throw error;
      }
  streamResult = result;
  finalUpstreamIdForFinally = result.response.status < 400 ? result.upstreamId : undefined;
  responseStatus = result.response.status;
  if (result.response.status >= 400) {
    success = false;
  }

      // Streaming logs are written only after the final body outcome is known.
      if (!isStreamingResponse(result.response) || !result.response.body) {
        const outcome = await result.completion;
        await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
        try {
          attemptLogger.addSteps(reqLogger.getSteps());
          await completeAttempt(attemptLogger, responseStatus, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: result.response.status >= 400 ? `Upstream returned error status: ${result.response.status}` : undefined,
            protocolOutcome: outcome.status,
            protocolCode: 'code' in outcome ? outcome.code : undefined,
            protocolError: 'error' in outcome ? outcome.error : undefined,
            success: outcome.status === 'completed' && result.response.status < 400,
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }
      }

      return finalizeStreamingResponse(
        requireGatewayResult(await gatewayHooks().onGatewayCors.promise(result.response, route.cors, req), 'onGatewayCors'),
        result,
        attemptLogger,
        async (outcome) => {
          await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
          try {
            attemptLogger.addSteps(reqLogger.getSteps());
            await completeAttempt(attemptLogger, result.response.status, {
              routePath,
              upstream: selectedUpstream.target,
              protocolOutcome: outcome.status,
              protocolCode: 'code' in outcome ? outcome.code : undefined,
              protocolError: 'error' in outcome ? outcome.error : undefined,
              success: outcome.status === 'completed' && result.response.status < 400,
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write streaming request log');
          }
        },
      );
    }

    // 使用 FailoverCoordinator 管理故障转移流程
    const baseRecoveryIntervalMs = effectiveRoute.failover?.recovery?.backoff_base_ms || 5000;
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
    const coordinator = requireGatewayResult(await gatewayHooks().onGatewayFailover.promise({
      upstreams:routeState.upstreams,route:effectiveRoute,recoveryIntervalMs:baseRecoveryIntervalMs,context:expressionContext,
    }), 'onGatewayFailover');

    let attemptCount = 0;
    let finalAttemptTimedOut = false;
    let finalAttemptHadFetchFailure = false;

    // 简化的故障转移循环：使用 coordinator 迭代器
    while (coordinator.hasNext()) {
      if (req.signal.aborted) throw req.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const decision = requireGatewayResult(await gatewayHooks().onGatewaySelect.promise({upstreams:routeState.upstreams,route:effectiveRoute,context:expressionContext,coordinator}), 'onGatewaySelect');
      const selection = decision.upstream ? {upstream:decision.upstream,shouldTransitionToHalfOpen:decision.shouldTransitionToHalfOpen} : undefined;

      if (!selection) {
        break; // 无可用 upstream
      }

      const { upstream: selectedUpstream, shouldTransitionToHalfOpen } = selection;
      attemptCount++;
      upstream = selectedUpstream.target;
      transport.upstream = selectedUpstream.target;
      lastAttemptedUpstreamId = selectedUpstream.upstream_id;
      // Lazy clone: deep clone headers and body when failover retry is needed
      if (attemptCount > 1) {
        if (!requestSnapshot.bodySource?.replayable) break;
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
      let attemptLogger = await createRequestLogger(req, {
        isFailoverAttempt: true,
        parentRequestId: reqLogger.getRequestId(),
        attemptNumber: attemptCount,
        attemptUpstream: selectedUpstream.target,
        requestType: initialRequestType
      });
      finalAttemptLogger = attemptLogger;
      attemptLogger.inheritOriginalBody(reqLogger);
      attemptLoggerCreated = true;

      // 记录原始请求头和请求体（转换前）
      attemptLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));
      if (requestSnapshot.body !== undefined && requestSnapshot.is_json_body) {
        attemptLogger.setOriginalRequestBody(requestSnapshot.body);
      }

      const stateKeyForCounter = effectiveRoute.state_key ?? effectiveRoute.service ?? effectiveRoute.path;
      const wasHalfOpenAtSelection = selectedUpstream.status === 'HALF_OPEN';
      selectedUpstream.last_used_time = Date.now();
      incrementActiveRequests(stateKeyForCounter, selectedUpstream.upstream_id);
      let counterDecrementted = false;
      let deferCounterToStream = false;
      const decrementCounter = () => {
        if (!counterDecrementted) {
          counterDecrementted = true;
          decrementActiveRequests(stateKeyForCounter, selectedUpstream.upstream_id);
          if (wasHalfOpenAtSelection) {
            releaseHalfOpenSlot(stateKeyForCounter, selectedUpstream.upstream_id);
          }
        }
      };

  let observedResult: ProxyRequestResult | undefined;
  try {
  const result = await proxyWithRouteRetry(selectedUpstream, attemptLogger);
  attemptLogger=result.attemptLogger??attemptLogger;finalAttemptLogger=attemptLogger;
  observedResult = result;
  finalAttemptTimedOut = false;
  finalAttemptHadFetchFailure = false;
  streamResult = result;
  finalUpstreamIdForFinally = result.response.status < 400 ? result.upstreamId : undefined;
  responseStatus = result.response.status;

        // 检查是否是可重试的状态码
        const isRetryableStatus = !result.repairFallback && retryableStatusMatcher ? retryableStatusMatcher(result.response.status) : false;

        // 响应内容触发检测：仅在 status 不命中 + 非最后一个 upstream + 配置了 retry_on_response 时执行
        // 已命中 retry_on 的响应走快速 failover 路径，不消费 body
        // 命中时抛 Error 进入 L1085 通用 catch（与 status-code 命中走相同的被动健康 + 断路器路径）
        const responseKeywords = effectiveRoute.failover?.retry_on_response;
        if (!result.repairFallback && !isRetryableStatus && !isLastUpstream && responseKeywords && responseKeywords.length > 0) {
          const checkResult = await checkResponseForFailover(result.response, responseKeywords);
          if (checkResult.hit) {
            throw new Error(
              `Response matched retry_on_response keyword: "${checkResult.matchedKeyword ?? ''}"`
            );
          }
          if (checkResult.response && checkResult.response !== result.response) {
            result.response = checkResult.response;
          }
        }

        // 只有在以下情况才返回响应：
        // 1. 不是可重试状态码（成功或非重试错误）
        // 2. 是可重试状态码但已经是最后一个上游
        if (!isRetryableStatus || isLastUpstream) {
          // 保存初始状态（用于后续判断 requestType）
          const initialStatus = selectedUpstream.status;

          // Streaming outcome is settled only after EOF/error/cancel.
          if (!isStreamingResponse(result.response) || !result.response.body) {
          const outcome = await result.completion;
          await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
          const neutralClientError = isNeutralClientError(result.response.status, outcome, isRetryableStatus);
          if (!neutralClientError) {
          if (outcome.status === 'failed' && outcome.code === 'upstream_http_error') {
            settleUpstreamFailure(selectedUpstream, 'upstream_http_error');
          } else {
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
                selectedUpstream.recovery_attempt_count = 0;

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
          }
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

          // Streaming logs are written after the final body outcome is known.
          if (!isStreamingResponse(result.response) || !result.response.body) {
          const outcome = await result.completion;
          await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
          try {
            // 将主请求的处理步骤复制到 attemptLogger
            attemptLogger.addSteps(reqLogger.getSteps());
            await completeAttempt(attemptLogger, responseStatus, {
              routePath,
              upstream: selectedUpstream.target,
              errorMessage: result.response.status >= 400 ? `Upstream returned error status: ${result.response.status}` : undefined,
              protocolOutcome: outcome.status,
              protocolCode: 'code' in outcome ? outcome.code : undefined,
              protocolError: 'error' in outcome ? outcome.error : undefined,
              success: outcome.status === 'completed' && result.response.status < 400,
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write request log');
          }
          }

          if (result.response.status >= 400) {
            success = false;
          }
          const finalResponse = finalizeStreamingResponse(
            requireGatewayResult(await gatewayHooks().onGatewayCors.promise(result.response, route.cors, req), 'onGatewayCors'),
            result,
            attemptLogger,
            async (outcome) => {
              await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
              const clientErrorWithoutFailover = isNeutralClientError(
                result.response.status,
                outcome,
                isRetryableStatus,
              );
              if (!clientErrorWithoutFailover && (outcome.status !== 'cancelled'
                || (!req.signal.aborted && !result.streamCompletionState?.clientCancelled))) {
                if (outcome.status === 'failed' && outcome.code === 'upstream_http_error') {
                  settleUpstreamFailure(selectedUpstream, 'upstream_http_error');
                } else {
                  settleStreamHealth(selectedUpstream, outcome.status === 'completed', result.response.status);
                }
              }
              decrementCounter();
              try {
                attemptLogger.addSteps(reqLogger.getSteps());
                await completeAttempt(attemptLogger, result.response.status, {
                  routePath,
                  upstream: selectedUpstream.target,
                  protocolOutcome: outcome.status,
                  protocolCode: 'code' in outcome ? outcome.code : undefined,
                  protocolError: 'error' in outcome ? outcome.error : undefined,
                  success: outcome.status === 'completed' && result.response.status < 400,
                });
              } catch (logError) {
                logger.error({ error: logError }, 'Failed to write streaming request log');
              }
            },
          );
          if (isStreamingResponse(finalResponse) && finalResponse.body) {
            deferCounterToStream = true;
          }
          return finalResponse;
        }

        // 是可重试状态码且还有其他上游，记录此次尝试并进入重试逻辑
        logger.warn({ request: requestLog, target: selectedUpstream.target, status: result.response.status }, 'Upstream returned a retryable status code, trying next upstream.');
        reqLogger.addStep('upstream_retry', { target: upstream, status: result.response.status });

        // 确定请求类型（非 HALF_OPEN 且非最后一个上游的失败尝试 → retry）
        if (selectedUpstream.status !== 'HALF_OPEN') {
          attemptLogger.setRequestType('retry');
        }

        // Release the attempt before waiting for a streaming completion.
        if (result.drainRetryObservation) {
          await result.drainRetryObservation();
          await result.observationCompletion;
        }
        await cleanupAttempt(result, req.signal);
        await result.observationCompletion;
        const outcome = await result.completion;
        await finishAttemptObservation(result, outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');

        // 记录此次失败尝试的日志（不影响重试逻辑）
        try {
          // 将主请求的处理步骤复制到 attemptLogger
          attemptLogger.addSteps(reqLogger.getSteps());
          await completeAttempt(attemptLogger, result.response.status, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: `Upstream returned retryable status code: ${result.response.status}`,
            protocolOutcome: outcome.status,
            protocolCode: 'code' in outcome ? outcome.code : undefined,
            protocolError: 'error' in outcome ? outcome.error : undefined,
            success: false,
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        reqLogger.addStep('upstream_failed', {
          target: selectedUpstream.target,
          error: `Upstream returned retryable status code: ${result.response.status}`,
        });
        settleUpstreamFailure(selectedUpstream, `Upstream returned retryable status code: ${result.response.status}`);
        continue;

      } catch (error) {
        if (error instanceof DataAdmissionError || error instanceof BodyProcessingError) {
          localFailureResponse = prepareProcessingErrorResponse(error);
          if (error instanceof BodyProcessingError) {
            const body = {error:error.code,code:error.code,message:error.code,
              ...(error.limitBytes === undefined ? {} : {limit_bytes:error.limitBytes}),
              ...(error.receivedBytes === undefined ? {} : {received_bytes:error.receivedBytes})};
            attemptLogger.setResponseBody(body);attemptLogger.setResponseHeaders({'content-type':'application/json'});
            attemptLogger.addStep(error.status === 413 ? 'request_body_rejected' : 'body_processing_rejected',body);
          }
          await completeAttempt(attemptLogger,error.status,{routePath,upstream:selectedUpstream.target,protocolOutcome:'failed',protocolCode:error.code,errorMessage:error.code,success:false});
          throw error;
        }
        if (observedResult) {
          await finishAttemptObservation(observedResult, req.signal.aborted && !isDeadlineFailure(error) ? 'cancelled' : 'failed');
        }
        finalAttemptTimedOut = isUpstreamTimeoutError(error);
        finalAttemptHadFetchFailure = finalAttemptTimedOut || isUpstreamNetworkError(error);
        if (req.signal.aborted && !isDeadlineFailure(error)) {
          attemptLogger.setRequestType('final');
          await completeAttempt(attemptLogger, responseStatus ?? 503, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: error instanceof Error ? error.message : String(error),
            protocolOutcome: 'cancelled',
            success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          throw error;
        }
        if (error instanceof AttemptCleanupError) {
          attemptLogger.setRequestType('final');
          success = false;
          responseStatus = 503;
          localFailureResponse = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }));
          logger.error({ request: requestLog, target: selectedUpstream.target, error }, 'Attempt cleanup failed; stopping failover');
          await completeAttempt(attemptLogger, 503, {
            routePath, upstream: selectedUpstream.target, errorMessage: error.message, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          break;
        }
        if (req.signal.aborted && !isUpstreamTimeoutError(error)) {
          attemptLogger.setRequestType('final');
          await completeAttempt(attemptLogger, responseStatus ?? 503, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: error instanceof Error ? error.message : String(error),
            protocolOutcome: 'cancelled',
            success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          throw error;
        }
        if (isManagedUpstreamAccessError(error)) {
          attemptLogger.setRequestType('final');
          success = false;
          responseStatus = 503;
          localFailureResponse = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }));
          logger.warn({ request: requestLog, target: selectedUpstream.target }, 'Managed upstream access denied closed request');
          await completeAttempt(attemptLogger, 503, {
            routePath, upstream: selectedUpstream.target, errorMessage: error.message, protocolOutcome: 'failed', success: false,
          }).catch(logError => logger.error({ error: logError }, 'Failed to write request log'));
          break;
        }
        if (isUpstreamPhaseFailoverSignal(error)) {
          logger.warn(
            { request: requestLog, target: selectedUpstream.target, reason: error.reason, isLastUpstream },
            'Upstream phase requested failover, trying next upstream.'
          );
          reqLogger.addStep('plugin_failover', { target: selectedUpstream.target, reason: error.reason });
          if (isLastUpstream) {
            attemptLogger.setRequestType('final');
            localFailureResponse = finalizeLocalResponse(new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }));
          }
          try {
            attemptLogger.addSteps(reqLogger.getSteps());
            await completeAttempt(attemptLogger, 503, {
              routePath,
              upstream: selectedUpstream.target,
              errorMessage: error.message,
              protocolOutcome: 'failed',
              success: false,
            });
          } catch (logError) {
            logger.error({ error: logError }, 'Failed to write request log');
          }
          if (isLastUpstream) {
            break;
          }
          continue;
        }

        const isTimeoutFailure = isUpstreamTimeoutError(error);
        const isUnknownPostOutcome = requestSnapshot.method === 'POST'
          && (isTimeoutFailure || isUpstreamNetworkError(error));
        const stopAfterDeadlineCancellation = req.signal.aborted && isTimeoutFailure;
        const mustStopAttempt = isUnknownPostOutcome || stopAfterDeadlineCancellation;
        const isSafeFetchFailure = isTimeoutFailure || isUpstreamNetworkError(error);
        const attemptFailureStatus = isTimeoutFailure && (isLastUpstream || mustStopAttempt) ? 504 : 503;
        logger.warn(isSafeFetchFailure
          ? { request: { requestId }, upstreamId: selectedUpstream.upstream_id, isLastUpstream }
          : { request: requestLog, target: selectedUpstream.target, error: (error as Error).message, isLastUpstream },
        'Request to upstream failed.');
        reqLogger.addStep('upstream_failed', isSafeFetchFailure
          ? { upstreamId: selectedUpstream.upstream_id, error: error.message }
          : { target: selectedUpstream.target, error: (error as Error).message });

        // 确定请求类型（异常情况）
        // 优先级：HALF_OPEN → recovery，最后一个上游 → final，其他 → retry
        if (isLastUpstream || mustStopAttempt) {
          attemptLogger.setRequestType('final');
          localFailureResponse = finalizeLocalResponse(new Response(JSON.stringify({ error: isTimeoutFailure ? 'Gateway Timeout' : 'Service Unavailable' }), { status: attemptFailureStatus }));
        } else if (selectedUpstream.status !== 'HALF_OPEN') {
            attemptLogger.setRequestType('retry');
        }

        // 记录此次失败尝试的日志（不影响 failover 逻辑）
        try {
          // 将主请求的处理步骤复制到 attemptLogger
          attemptLogger.addSteps(reqLogger.getSteps());
          await completeAttempt(attemptLogger, attemptFailureStatus, {
            routePath,
            upstream: selectedUpstream.target,
            errorMessage: (error as Error).message,
            protocolOutcome: 'failed',
            protocolCode: isTimeoutFailure ? 'upstream_timeout' : undefined,
            success: false,
          });
        } catch (logError) {
          logger.error({ error: logError }, 'Failed to write request log');
        }

        settleUpstreamFailure(selectedUpstream, (error as Error).message);

        // 如果是最后一个上游，不要继续循环，直接跳出
        if (mustStopAttempt) {
          responseStatus = attemptFailureStatus;
          success = false;
          break;
        }
        if (isLastUpstream) {
          break;
        }
      } finally {
        if (!deferCounterToStream) {
          decrementCounter();
        }
      }
    }

    // 检查是否有任何 upstream 被尝试
    if (attemptCount === 0) {
      logger.error({ request: requestLog }, 'No upstreams available (all UNHEALTHY and within recovery interval).');
      success = false;
      responseStatus = 503;
      return finalizeLocalResponse(new Response(JSON.stringify({
        error: 'Service Unavailable',
        reason: 'All upstreams are unhealthy and within recovery interval'
      }), { status: 503 }));
    }

    logger.error(finalAttemptHadFetchFailure
      ? { request: { requestId }, attemptCount }
      : { request: requestLog, attemptCount },
    'All attempted upstreams failed.');
    success = false;
    responseStatus = finalAttemptTimedOut ? 504 : 503;
    return localFailureResponse ?? finalizeLocalResponse(new Response(JSON.stringify({ error: finalAttemptTimedOut ? 'Gateway Timeout' : 'Service Unavailable' }), {
      status: responseStatus,
    }));
  } catch (error) {
    error=normalizeAdmissionError(error) ?? error;
    success = false;
    if (error instanceof DataAdmissionError) {
      responseStatus = error.status;
      return localFailureResponse ?? prepareProcessingErrorResponse(error);
    }
    if (error instanceof BodyProcessingError && !(error instanceof RequestBodyTooLargeError)) {
      responseStatus = error.status; rootProtocolOutcome = 'failed'; rootProtocolCode = error.code;
      rootErrorMessage = error.message;
      const body = {error:error.code, code:error.code, message:error.code,
        ...(error.limitBytes === undefined ? {} : {limit_bytes:error.limitBytes}),
        ...(error.receivedBytes === undefined ? {} : {received_bytes:error.receivedBytes})};
      reqLogger.addStep(error.status === 413 ? 'request_body_rejected' : 'body_processing_rejected',body);
      reqLogger.setResponseBody(body);
      reqLogger.setResponseHeaders({'content-type':'application/json'});
      return localFailureResponse ?? finalizeLocalResponse(Response.json(body,{status:error.status}));
    }
    if (error instanceof RequestBodyTooLargeError) {
      responseStatus = 413;
      rootProtocolOutcome = 'failed';
      rootProtocolCode = error.code;
      rootErrorMessage = error.message;
      const body = {
        error: 'Payload Too Large',
        code: error.code,
        message: error.message,
        limit_bytes: error.maxBytes,
        received_bytes: error.receivedBytes,
      };
      reqLogger.addStep('request_body_rejected', body);
      reqLogger.setResponseBody(body);
      reqLogger.setResponseHeaders({ 'content-type': 'application/json' });
      return finalizeLocalResponse(Response.json(body, { status: responseStatus }));
    }
    throw error;
  } finally {
    if (!deferFinallyToStream) {
      await finalizeRequest();
    }
  }
}

import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
export class HttpRequestPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayRequest.tapPromise('builtin.onGatewayRequest', executeHttpRequest);
  }
}
