import { PhysicalRequestBudget, serviceById, serviceLayer, layerEndpoints, layerReferences } from '../worker/upstream/service-execution';
import { resolveReachableEndpoints, resolveReachableServices } from '../utils/endpoint-resolver';
import {executeAuxiliaryRequest} from './auxiliary-request';
import {resolveDispatchTarget} from './dispatch-plugin';
import {resolveEffectiveRoute} from './routing-plugin';
import {normalizeAdmissionError} from '../data-admission/errors';
import { hasWorkerAdmissionSession, type WorkerRequestAdmission, type PreparedAdmissionAttempt } from '../data-admission/worker';
import { DataAdmissionError } from '../data-admission/host';
/**
 * Request handler module
 * Main request processing logic including routing, authentication, and failover
 */

import { logger } from '../logger';
import { RequestLogger, type RequestLoggerDependencies, type RequestLogCompletionOptions } from '../logger/request-logger';
import type { AppConfig, RouteConfig, Service } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../worker/types';
import { selectUpstream } from '../worker/upstream/selector';
import { incrementActiveRequests, decrementActiveRequests, releaseHalfOpenSlot } from '../worker/state/runtime-state';
import { getScopedPluginRegistry, type AttemptObservationOwner, type PrecompiledHooks } from '../scoped-plugin-registry';
import { createRequestSnapshot, deriveRequestSnapshot, readSnapshotJson, RequestBodyTooLargeError } from '../worker/request/snapshot';
import {
  AttemptCleanupError, UpstreamResponseValidationError,
  isUpstreamNetworkError,
  isUpstreamTimeoutError,
  isUpstreamPhaseFailoverSignal,
  isManagedUpstreamAccessError,
  proxyRequest,
  type ProxyRequestResult,
} from '../worker/request/proxy';
import { activateSlowStart, deactivateSlowStart } from '../worker/utils/slow-start';
import { createStatusCodeMatcher } from '../worker/utils/status-code-matcher';
import { checkResponseForFailover } from '../worker/request/response-detector';
import { gatewayHooks, requireGatewayResult } from './runtime';
import {
  buildRequestLevelFinallyContext,
  cloneMutableRequestContext,
  rebaseToUpstream,
  type MutableRequestContext,
} from '../worker/request/context';
import type { MutableRequestContext as HookMutableRequestContext } from '../hooks';
import type { AttemptObservationEvent, AttemptObservationOutcome } from '../hooks/plugin-hooks';
import { getTrustedDataIdentity, getTrustedWorkerPeer } from '../config-worker/private-transport';
import { BodyProcessingError, isJsonMediaType, type BodySource } from '../worker/request/body-source';
import { analyzeExpressionDependencies } from '../utils/expression-dependencies';
import { collectPluginBodyRequirements } from '../scoped-plugin-registry';
// Every HTTP body participates in completion/drain; SSE terminal inference is separate.
function isStreamingResponse(response: Response): boolean { return response.body !== null; }

import type { RawResponseCompletion } from '../plugin-control/contracts';
import { observeTransportResponse } from './body-observation-stream';
import type { TransportType } from '../logger/transport-outcome';

export interface HandleRequestRuntimeContext {
  servingRevision?: number;
  parentRequestId?:string;
  webSocketConnection?:{readonly id:string;readonly signal:AbortSignal};
  /** Core-only locked handoff: no dispatch hook or recursive preparation. */
  auxiliary?:{target:import('./contracts').GatewayDispatchTarget;parentRequestId?:string;onIdentity:(identity:import('./contracts').GatewayAuxiliaryIdentity)=>Promise<boolean>};
  onCompletion?:(completion:Promise<RawResponseCompletion>)=>void;
  /** Host-only session context, never accepted from client fields. */
  transport?: 'websocket';
  /** Inherited ingress protocol for logs; does not select the upstream transport. */
  logTransportType?: TransportType;
  websocketBridge?: import('../websocket').WebSocketBridge;
  skipEntryRate?: boolean;
  /** Host session receives the codec's logical history without re-reading the request body. */
  onCanonicalInput?: (input: readonly unknown[]) => void;
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
    authorizeResponse?: (context: MutableRequestContext) => Promise<void>;
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
    ctx.annotations = result.annotations;
  }

  if (!phase.hasInterceptCallbacks) {
    return undefined;
  }

  const interceptResult = await phase.hooks.onInterceptRequest.promise(ctx as HookMutableRequestContext);
  if (interceptResult?.action === 'respond') {
    if (interceptResult.response.ok) {
      try { await options.authorizeResponse?.(ctx); }
      catch (error) { await interceptResult.response.body?.cancel().catch(() => undefined); throw error; }
    }
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
  const transportType: TransportType = runtimeContext?.logTransportType ?? runtimeContext?.transport ?? 'http';
  const createRequestLogger = async (request: Request, options?: ConstructorParameters<typeof RequestLogger>[1]): Promise<RequestLogger> => {
    const logOptions = {...options, transportType,
      ...(runtimeContext?.auxiliary ? {parentRequestId:options?.parentRequestId ?? runtimeContext.auxiliary.parentRequestId} : {})};
    const requestLogger = requireGatewayResult(requireGatewayResult(await gatewayHooks().onGatewayLog.promise({phase:'create',request,options:logOptions,dependencies:runtimeContext?.logging}), 'onGatewayLog').logger, 'onGatewayLog');
    requestLogger.deferFileLogUntilTransportObserved();
    transport.logger = requestLogger;
    requestLoggers.push(requestLogger);
    if (config.logging?.body?.enabled) fileLogReleases.push(requestLogger.deferFileLog());
    return requestLogger;
  };
  const url = new URL(req.url);
  // Every request enters the normal pipeline and is logged before route matching.
  const reqLogger = await createRequestLogger(req,runtimeContext?.auxiliary ? {parentRequestId:runtimeContext.auxiliary.parentRequestId} : undefined);
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
  type ServiceFrame = {service:Service & {id:string};phase:PrecompiledHooks|null;context:MutableRequestContext;closed:boolean;release:()=>void};
  const enteredServiceFrames: ServiceFrame[] = [];
  let finalServiceIds: string[] = [];
  let finalDispatchAdapter:PrecompiledHooks|undefined;
  const closeServiceFrame = async (frame:ServiceFrame, ok:boolean, status?:number, error?:unknown) => {
    if(frame.closed)return;frame.closed=true;
    const context={...frame.context,body:frame.context.body,requestId,serviceName:frame.service.name,serviceId:frame.service.id,success:ok,statusCode:status,
      originalUrl:new URL(req.url),clientIP:frame.context.clientIP ?? 'unknown',latencyMs:Date.now()-startTime,error:error instanceof Error?error:new Error('service_branch_failed')};
    try {
      if(!ok)await frame.phase?.hooks.onError.promise(context);
    } finally {try{const finalContext={...context,phase:'request-level'};await frame.phase?.hooks.onFinally.promise(finalContext);}finally{frame.release();}}
  };
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
  let rootFailure:unknown;
  let rootProtocolCode: string | undefined;
  let rootPersisted = false;
  let rootPersisting: Promise<void> | undefined;
  const completedAttemptLoggers = new WeakSet<RequestLogger>();
  const completingAttemptLoggers = new WeakMap<RequestLogger, Promise<void>>();
  const participatingObservationOwners = new Map<string, { owner: AttemptObservationOwner; event: AttemptObservationEvent }>();
  const endpointFinalizers=new Map<string,(outcome:AttemptObservationOutcome)=>Promise<void>>();
  const endpointResults=new WeakMap<ProxyRequestResult,string>();
  const attemptEndCallbacks = new WeakMap<ProxyRequestResult, (outcome: AttemptObservationOutcome, observedAtMonotonicMs?:number) => Promise<void>>();
  const pendingAttemptEnds = new Map<string, (outcome: AttemptObservationOutcome, observedAtMonotonicMs?:number) => Promise<void>>();
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
    detail: Pick<AttemptObservationEvent,'direction'|'representation'|'view'|'observedAtMonotonicMs'> = {direction:'response',representation:'wire'},
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
        phase:'incomplete',reason,observedAtMonotonicMs:detail.observedAtMonotonicMs ?? performance.now(),isActive:()=>true});
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

  const finishAttemptObservation = async (result: ProxyRequestResult, outcome: AttemptObservationOutcome, preserveRequestState=false): Promise<void> => {
    const boundaryAt=performance.now();
    await result.observationCompletion;
    await attemptEndCallbacks.get(result)?.(outcome,result.observationEndedAtMonotonicMs ? result.observationEndedAtMonotonicMs() : boundaryAt);
    const id=endpointResults.get(result);
    if(id && !preserveRequestState)await endpointFinalizers.get(id)?.(outcome);
  };

  const completeAttempt = async (
    attemptLogger: RequestLogger,
    status: number,
    options: RequestLogCompletionOptions,
  ): Promise<void> => {
    if (completedAttemptLoggers.has(attemptLogger)) return;
    const inFlight = completingAttemptLoggers.get(attemptLogger);
    if (inFlight) return inFlight;
    attemptLogger.addSteps(reqLogger.getSteps());
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

  const headersForRootError=()=>{const headers:Record<string,string>={};req.headers.forEach((value,key)=>{headers[key]=value;});return headers;};
  let requestBodySource: BodySource | undefined;
  const branchDisposers=new Set<()=>void>();
  const auxiliaryDisposers=new Set<()=>void>();
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
    for(const finish of [...endpointFinalizers.values()])await finish(finalSuccess?'completed':req.signal.aborted?'cancelled':'failed');

    await Promise.all(Array.from(participatingObservationOwners.values()).map(async ({ owner, event }) => {
      const requestEnd = Object.freeze({
        requestId: event.requestId,
        keyId,
        routeId: event.routeId,
        attemptId: event.attemptId,
        upstreamId: event.upstreamId,
        phase: 'request-end' as const,
        observedAtMonotonicMs:event.observedAtMonotonicMs,
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
    } else if (finalAttemptLogger && !completedAttemptLoggers.has(finalAttemptLogger)) {
      try {
        await completeAttempt(finalAttemptLogger,responseStatus ?? 500,{
          routePath,upstream,protocolOutcome:rootProtocolOutcome ?? (finalSuccess?'completed':'failed'),
          protocolCode:rootProtocolCode,errorMessage:rootErrorMessage,success:finalSuccess,
        });
      } catch (logError) {
        logger.error({ error: logError }, 'Failed to write final attempt log');
      }
    }

    if (!routeId) {
      return;
    }

    const scopedRegistry = requestRegistry;
    const finalHooks = scopedRegistry?.getPrecompiledHooks(routeId, finalUpstreamIdForFinally, finalServiceIds) ?? null;
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

    for (const frame of [...enteredServiceFrames].reverse()) {
      try { await closeServiceFrame(frame,finalSuccess,responseStatus); }
      catch(error){logger.error({error,request:requestLog},'Failed to finish Service frame');}
    }

  const routeFinallyHooks = finalHooks?.routePrecompiled;
  if(!finalSuccess){
    const errorContext={...finallyBaseContext,headers:headersForRootError(),body:undefined,
      error:rootFailure instanceof Error?rootFailure:new Error('upstream_http_error')};
    try{await routeFinallyHooks?.hooks.onError.promise(errorContext);await finalHooks?.globalPrecompiled?.hooks.onError.promise(errorContext);await finalDispatchAdapter?.hooks.onError.promise(errorContext);}
    catch(error){logger.error({error,request:requestLog},'Failed to execute request error hooks');}
  }
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
  if(finalDispatchAdapter?.hooks.onFinally.hasCallbacks()){
    try{await finalDispatchAdapter.hooks.onFinally.promise(finallyBaseContext);}
    catch(error){logger.error({error,request:requestLog},'Failed to finish dispatch adapter');}
  }
    } finally {
      for (const requestLogger of requestLoggers) requestLogger.stopBodyLogging();
      for (const release of fileLogReleases.splice(0)) release();
      for(const dispose of auxiliaryDisposers)dispose();
      auxiliaryDisposers.clear();
      for(const dispose of branchDisposers)dispose();
      branchDisposers.clear();
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
      runtimeContext?.onCompletion?.(result.completion.then(async outcome=>{await finalizeRequest();return outcome;}));
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
    runtimeContext?.onCompletion?.(finalCompletion.then(async outcome=>{await finalizeRequest();return outcome;}));
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
    if (error instanceof DataAdmissionError) return finalizeLocalResponse(Response.json({ error: error.code, ...error.details }, {
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
    const dispatchContext = createPhaseContext(requestSnapshot,requestId,entryRoute.path,undefined);
    const dispatchHooks = requestRegistry?.getRoutePrecompiledHooks?.(entryRoute.path);
    if (runtimeContext?.auxiliary || dispatchHooks?.hooks.onDispatchRequest.hasCallbacks()) {
      await readSnapshotJson(requestSnapshot,'internal-dispatch',true);
      dispatchContext.body = structuredClone(requestSnapshot.body);
    }
    for(const owner of requestRegistry?.getRoutePluginOwners?.(entryRoute.path,true) ?? [])retainOwner(owner.pluginName,owner.scopeKey);
    const dispatchWork=()=>gatewayHooks().onGatewayDispatch.promise({config,entry:entryRoute,context:dispatchContext,
      signal:processingSignal,principal:trustedIdentity?.principal,servingRevision:runtimeContext?.servingRevision,webSocketConnection:runtimeContext?.webSocketConnection});
    let dispatch:import('./contracts').GatewayDispatchDecision;
    if(runtimeContext?.auxiliary){
      const locked=resolveDispatchTarget(config,entryRoute,runtimeContext.auxiliary.target,dispatchContext,'responses');
      dispatch={route:locked,effective:resolveEffectiveRoute(config,locked),context:dispatchContext,target:runtimeContext.auxiliary.target,entryRouteId:entryRoute.id??entryRoute.path,protocol:'responses'};
    }else dispatch=requireGatewayResult(await (requestRegistry ? requestRegistry.runWithRequestLeases(ownerLeases,dispatchWork) : dispatchWork()), 'onGatewayDispatch');
    if (dispatch.canonicalInput) runtimeContext?.onCanonicalInput?.(dispatch.canonicalInput);
    if (dispatch.diagnostics?.length) reqLogger.addStep('codex_router_conversion',{requestId,protocol:dispatch.protocol,diagnostics:dispatch.diagnostics});
    route = dispatch.route;
    if (dispatch.target) {
      requestSnapshot.body = dispatch.context.body;
      reqLogger.addStep('internal_dispatch',{entry:entryRoute.id ?? entryRoute.path,target:dispatch.target,model:dispatch.context.body?.model});
    }
    routeId = route.path;
    routeServiceName = undefined;
    const currentRouteId = route.path;
    const effectiveRoute = dispatch.effective;
    const endpoints = resolveReachableEndpoints(effectiveRoute,config.services);
    const reachableServices = resolveReachableServices(effectiveRoute,config.services);
    const physicalBudget = new PhysicalRequestBudget(config,effectiveRoute,processingSignal);
    if (trustedIdentity) {
      for (const handler of admissionHandlers) retainOwner(handler.pluginName);
      dataAdmission = requireGatewayResult(await gatewayHooks().onGatewayAdmissionSession.promise({handlers:admissionHandlers, identity:{
        requestId, principal: trustedIdentity.principal, ...(dispatch.entryRouteId ? {entryRouteId:dispatch.entryRouteId} : {}), routeId: route.id ?? currentRouteId,
        serviceId: null,
      }, invoke:(plugin, method, payload, target) => requestRegistry!.invokeAdmissionRpc(plugin, method, payload, target, ownerLeases.get(`${plugin}\0global`)!)}), 'onGatewayAdmissionSession');
    }

    if(dispatch.prepareRequest || runtimeContext?.auxiliary){
      reqLogger.addStep('request_identity',{requestId,...(runtimeContext?.auxiliary?{parentRequestId:runtimeContext.auxiliary.parentRequestId}:{})});
      const endpoint=endpoints[0];
      if(!endpoint)throw new DataAdmissionError(503,'upstream_unavailable');
      await dataAdmission?.inspect({attemptId:requestId,upstreamId:endpoint.id??'0',url:dispatch.context.url.href,
        model:typeof dispatch.context.body?.model==='string'?dispatch.context.body.model:null,body:dispatch.context.body,transport:runtimeContext?.transport},processingSignal);
      if(dispatch.prepareRequest){
        const preparation=()=>dispatch.prepareRequest!({context:dispatch.context,principal:trustedIdentity?.principal,servingRevision:runtimeContext?.servingRevision,webSocketConnection:runtimeContext?.webSocketConnection,signal:processingSignal,
          executeAuxiliary:async input=>{
            const result=await executeAuxiliaryRequest(req,config,entryRoute,{...runtimeContext,parentRequestId:requestId},input,processingSignal,requestRegistry?.getDeclaredDispatchTargets(entryRoute.path)??[]);
            // An explicit signal transfers cancellation to an aggregate caller; its own
            // request still owns admission, route deadlines and independent owner leases.
            if(result.kind==='response' && !input.signal){if(finalized)result.dispose();else auxiliaryDisposers.add(result.dispose);}
            return result;
          }});
        const prepared=await (requestRegistry?requestRegistry.runWithRequestLeases(ownerLeases,preparation):preparation());
        processingSignal.throwIfAborted();
        dispatch={...dispatch,...prepared};requestSnapshot.body=dispatch.context.body;
        if(prepared.canonicalInput)runtimeContext?.onCanonicalInput?.(prepared.canonicalInput);
        if(prepared.diagnostics?.length)reqLogger.addStep('dispatch_conversion',{requestId,protocol:dispatch.protocol,diagnostics:prepared.diagnostics});
      }
    }

    const demandHooks = requestRegistry?.getPrecompiledHooks(currentRouteId, undefined, routeServiceName, dispatch.adapter);
    const demandContext = createPhaseContext(requestSnapshot,requestId,currentRouteId,routeServiceName);
    if (dispatch.target) demandContext.url = new URL(dispatch.context.url);
    applyRoutePathRewriteToContext(demandContext,route,requestLog);
    const routeDemand = collectPluginBodyRequirements([demandHooks?.routePhase,demandHooks?.servicePhase,demandHooks?.dispatchAdapter], {
      requestId,method:req.method,url:demandContext.url,routeId:currentRouteId,serviceId:routeServiceName,stage:'route',
    });
    const selectionNeedsBody = analyzeExpressionDependencies({
      conditions:effectiveRoute.endpoints.map(endpoint=>endpoint.condition),hash:effectiveRoute.load_balancing?.hash_policy?.expression,
      rate:route.rate_limit?.key_expression,
    },'request').requestBody;
    const routeRequestDemand = isJsonMediaType(requestSnapshot.content_type) || requestBodySource?.mode === 'empty'
      ? route.request : {headers:route.request?.headers,query:route.request?.query};
    const routeNeedsBody = analyzeExpressionDependencies(routeRequestDemand,'request').requestBody
      || analyzeExpressionDependencies(route.response,'response').requestBody;
    if (routeDemand.replay || route.retry?.enabled || effectiveRoute.failover?.enabled || reachableServices.some(service => service.failover?.enabled)) await requestBodySource?.buffer('configured-replay');
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
    finalDispatchAdapter=requestPhaseHooks?.dispatchAdapter;
    const phaseContext = createPhaseContext(requestSnapshot, requestId, currentRouteId, routeServiceName);
    phaseContext.annotations = dispatch.context.annotations !== undefined ? structuredClone(dispatch.context.annotations) : undefined;
    phaseContext.bodyWrite = !!dispatch.target || routeDemand.request === 'json-write';
    if (dispatch.target) phaseContext.url = new URL(dispatch.context.url);
    phaseContext.bodyRequirements = routeDemand;
    applyRoutePathRewriteToContext(phaseContext, route, requestLog);
    // Successful local responses still require current access authorization, without
    // reserving an upstream attempt or spending provider budgets.
    const authorizePhaseResponse = async (context: MutableRequestContext) => {
      await dataAdmission?.inspect({attemptId:requestId,upstreamId:endpoints[0]?.id ?? '0',url:context.url.href,
        serviceId:context.serviceId ?? null,
        model:typeof context.body?.model === 'string' ? context.body.model : null,body:context.body,transport:runtimeContext?.transport},processingSignal);
    };
    const routePhaseResponse = await executePreFailoverPhase(requestPhaseHooks?.routePhase, phaseContext, {
      phaseName: 'route',
      requestLog,
      requestId,
      routeId: currentRouteId,
      serviceName: routeServiceName,
      authorizeResponse: authorizePhaseResponse,
    });
    if (routePhaseResponse) {
      responseStatus = routePhaseResponse.status;
      success = routePhaseResponse.status < 400;
      return finalizeRootStreamingResponse(requireGatewayResult(await gatewayHooks().onGatewayCors.promise(routePhaseResponse, route.cors, req), 'onGatewayCors'));
    }

    const phase1and2Context = cloneMutableRequestContext(phaseContext);

    const settleStreamHealth = (selected: RuntimeUpstream, protocolOk: boolean, status: number, healthRoute:EffectiveRouteConfig): void => {
      if (!healthRoute.failover?.enabled) return;
      if (protocolOk && status < 400) {
        selected.consecutive_failures = 0;
        selected.consecutive_successes++;
        if (selected.status === 'HALF_OPEN') {
          selected.status = 'HEALTHY';
          selected.last_failure_time = undefined;
          selected.recovery_attempt_count = 0;
          activateSlowStart(selected, healthRoute);
        } else if (selected.status === 'UNHEALTHY') {
          const threshold = healthRoute.failover?.passive_health?.healthy_successes || 2;
          if (selected.consecutive_successes >= threshold) {
            selected.status = 'HEALTHY';
            selected.last_failure_time = undefined;
            selected.recovery_attempt_count = 0;
            activateSlowStart(selected, healthRoute);
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
      } else if (selected.status === 'HEALTHY' && selected.consecutive_failures >= (healthRoute.failover?.passive_health?.consecutive_failures || 3)) {
        selected.status = 'UNHEALTHY';
        selected.last_failure_time = Date.now();
      } else if (selected.status === 'UNHEALTHY') {
        selected.last_failure_time = Date.now();
      }
    };

    const settleUpstreamFailure = (selected: RuntimeUpstream, reason: string, healthRoute:EffectiveRouteConfig): void => {
      if (!healthRoute.failover?.enabled) return;
      selected.consecutive_failures++;
      selected.consecutive_successes = 0;

      const auto_disable_threshold = healthRoute.failover?.passive_health?.auto_disable_threshold;
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
        const failureThreshold = healthRoute.failover?.passive_health?.consecutive_failures || 3;
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
      attemptLogger: RequestLogger,
      layer:EffectiveRouteConfig, branchContext:MutableRequestContext, serviceIds:string[]
    ): Promise<ProxyRequestResult> => {
      if(dispatch.requiredUpstreamId && selectedUpstream.upstream_id!==dispatch.requiredUpstreamId)throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
      const phaseAwareHooks = scopedRegistry?.getPrecompiledHooks(currentRouteId, selectedUpstream.upstream_id, serviceIds, dispatch.adapter) ?? null;
      const derived=deriveRequestSnapshot(requestSnapshot,branchContext,{requestId,attemptId:requestId,direction:'request',stage:'outbound-request',version:1,
        contentType:requestSnapshot.content_type,contentEncoding:requestSnapshot.headers['content-encoding'] ?? ''});
      const branchSnapshot=derived.snapshot;branchDisposers.add(derived.dispose);
      if(requestSnapshot.bodySource?.replayable)await branchSnapshot.bodySource?.buffer('branch-replay');
      const attemptLoggers=new Map<ProxyRequestResult,RequestLogger>();
      const runAttempt = async (requestOverride?:import('./contracts').GatewayRequestOverride): Promise<ProxyRequestResult> => {
        const currentLogger=requestOverride?await createRequestLogger(req,{isFailoverAttempt:true,parentRequestId:reqLogger.getRequestId(),attemptUpstream:selectedUpstream.target,requestType:'final'}):attemptLogger;
        if(requestOverride){currentLogger.inheritOriginalBody(reqLogger);currentLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));
          if(requestSnapshot.is_json_body)currentLogger.setOriginalRequestBody(requestSnapshot.body);}
        currentLogger.beginBodyLoggingAttempt();
        const attemptId = crypto.randomUUID();
        const ownerUrl=new URL(branchContext.url);rebaseToUpstream({url:ownerUrl} as MutableRequestContext,selectedUpstream);
        const owners = scopedRegistry?.getAttemptObservationOwners?.(currentRouteId, selectedUpstream.upstream_id, serviceIds,{requestId,method:req.method,url:ownerUrl,routeId:currentRouteId,serviceId:serviceIds.at(-1),upstreamId:selectedUpstream.upstream_id,stage:'selected'}) ?? [];
        for (const owner of owners) retainOwner(owner.pluginName, owner.scopeKey);
        for (const owner of scopedRegistry?.getBoundControlOwners?.(currentRouteId, selectedUpstream.upstream_id) ?? []) retainOwner(owner.pluginName, owner.scopeKey);
        let preparedAdmission: PreparedAdmissionAttempt[] = [];
        const identity = { requestId, keyId, routeId: currentRouteId, attemptId, upstreamId: selectedUpstream.upstream_id };
        if (owners.length > 0) observationStates.set(attemptId, { owners, identity, disabled: new Set(), incompleteReasons: new Set() });
        const selectedEvent: AttemptObservationEvent = Object.freeze({ ...identity, phase: 'selected', observedAtMonotonicMs:performance.now(), isActive: () => true });
        for (const owner of owners) {
          participatingObservationOwners.set(`${owner.pluginName}\0${owner.scopeKey}`, { owner, event: selectedEvent });
        }
        await notifyObservationOwners(owners, selectedEvent);
        let physicalStatus:number|undefined;let endpointErrorNotified=false;let physicalError:unknown;
        endpointFinalizers.set(attemptId,async outcome=>{
          endpointFinalizers.delete(attemptId);
          const finalContext={requestId,attemptId,routeId:currentRouteId,upstreamId:selectedUpstream.upstream_id,
            originalUrl:new URL(req.url),method:req.method,clientIP:branchContext.clientIP ?? 'unknown',
            latencyMs:Date.now()-startTime,success:outcome==='completed' && physicalStatus!==undefined && physicalStatus<400,statusCode:physicalStatus,phase:'final-upstream-level',serviceName:branchContext.serviceName};
          try{if(!finalContext.success && !endpointErrorNotified)await phaseAwareHooks?.upstreamPhase.hooks.onError.promise({...finalContext,headers:branchContext.headers,body:branchContext.body,error:physicalError instanceof Error?physicalError:new Error('upstream_http_error')});}
          finally{await phaseAwareHooks?.upstreamPhase.hooks.onFinally.promise(finalContext);}
        });
        let sent = false;
        let ended = false;
        const end = async (outcome: AttemptObservationOutcome, observedAtMonotonicMs?:number): Promise<void> => {
          if(outcome !== 'completed') observedAtMonotonicMs ??= performance.now();
          if (ended) return;
          ended = true;
          pendingAttemptEnds.delete(attemptId);
          const endEvent=Object.freeze({...identity,phase:'end' as const,outcome,sent,observedAtMonotonicMs,isActive:()=>true});
          for(const owner of owners) participatingObservationOwners.set(`${owner.pluginName}\0${owner.scopeKey}`,{owner,event:endEvent});
          await notifyObservationOwners(owners,endEvent);

          const results = await Promise.allSettled(preparedAdmission.map(prepared => prepared.onResult?.({sent,outcome})));
          for (const result of results) if (result.status === 'rejected') {
            logger.error({error:result.reason,requestId,attemptId}, 'Admission attempt result could not be settled');
          }
        };
        pendingAttemptEnds.set(attemptId, end);
        try {
          const executeProxy = () => proxyRequest(
            branchSnapshot, layer, selectedUpstream, requestLog, config, currentRouteId,
            currentLogger, phaseAwareHooks, branchContext, processingSignal,
            {
              managesRequestLifecycle:true,
              onErrorNotified:()=>{endpointErrorNotified=true;},
              takePhysicalBudget:()=>physicalBudget.take(),
              servingRevision: runtimeContext?.servingRevision,
              websocketBridge: runtimeContext?.websocketBridge,
              nativeWebSocket: runtimeContext?.transport === 'websocket' && route.websocket?.enabled === true && (dispatch.protocol ?? 'responses') === 'responses',
              attemptId,requestOverride,
              beforeReuse: runtimeContext?.auxiliary ? async (identity,target) => {
                await dataAdmission?.inspect({...target,attemptId,upstreamId:selectedUpstream.upstream_id,serviceId:serviceIds.at(-1) ?? null},processingSignal);
                const reused = await runtimeContext.auxiliary!.onIdentity(identity);
                currentLogger.addStep('auxiliary_resolution', {model:identity.model,upstreamId:identity.upstreamId,reused});
                return reused;
              } : undefined,
              beforeSend: dataAdmission ? async (target) => {
                preparedAdmission = requireGatewayResult(await gatewayHooks().onGatewayAdmissionPrepare.promise({session:dataAdmission!,target:{...target,transport:runtimeContext?.transport,attemptId,upstreamId:selectedUpstream.upstream_id,serviceId:serviceIds.at(-1) ?? null},signal:processingSignal,readBody:()=>requestOverride ? Promise.resolve(requestOverride.body):readSnapshotJson(branchSnapshot,'admission-body')}), 'onGatewayAdmissionPrepare');
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
          physicalStatus=result.response.status;
          result.attemptLogger=currentLogger;attemptLoggers.set(result,currentLogger);
          attemptEndCallbacks.set(result, end);endpointResults.set(result,attemptId);
          return result;
        } catch (error) {
          physicalError=error;
          await end(req.signal.aborted && !isDeadlineFailure(error) ? 'cancelled' : 'failed');
          await endpointFinalizers.get(attemptId)?.(req.signal.aborted?'cancelled':'failed');
          if(requestOverride)await completeAttempt(currentLogger,503,{routePath,upstream:selectedUpstream.target,protocolOutcome:req.signal.aborted?'cancelled':'failed',
            protocolCode:'repair_attempt_failed',errorMessage:'repair attempt failed',success:false});
          throw error;
        }
      };
      const finishFromCompletion = async (result: ProxyRequestResult, preserveRequestState=false): Promise<void> => {
        try {
          const completion = await result.completion;
          await finishAttemptObservation(result, completion.status === 'completed' ? 'completed' : completion.status === 'cancelled' ? 'cancelled' : 'failed',preserveRequestState);
        } catch {
          await finishAttemptObservation(result, req.signal.aborted ? 'cancelled' : 'failed');
        }
      };
      return requireGatewayResult(await gatewayHooks().onGatewayRetry.promise({
        snapshot:branchSnapshot,route,signal:processingSignal,clientSignal:req.signal,runAttempt,finish:finishFromCompletion,
        claimRepair:()=>{if(repairClaimed)return false;repairClaimed=true;return true;},
        recordAttempt:async(result)=>{const currentLogger=attemptLoggers.get(result);if(!currentLogger)return;
          const outcome=await result.completion;await completeAttempt(currentLogger,result.response.status,{routePath,upstream:selectedUpstream.target,
            protocolOutcome:outcome.status,protocolCode:'code' in outcome?outcome.code:undefined,protocolError:'error' in outcome?outcome.error:undefined,
            success:outcome.status==='completed'&&result.response.ok});},
        cleanup:cleanupAttempt,end:(result,cancelled)=>finishAttemptObservation(result,cancelled ? 'cancelled':'failed'),
      }), 'onGatewayRetry');
    };

    class LocalServiceResponse {constructor(readonly response:Response){}}
    class SelectionUnavailableError extends Error {}
    type Branch = { result:ProxyRequestResult; endpoint:RuntimeUpstream; layer:EffectiveRouteConfig;
      context:MutableRequestContext; frames:ServiceFrame[]; ownRetryable?:boolean; release:()=>void; logger:RequestLogger };
    let attemptNumber=0;
    const expressionFor=(context:MutableRequestContext):ExpressionContext=>({headers:context.headers,body:context.body,
      request:{headers:context.headers,body:context.body},url:{pathname:context.url.pathname,search:context.url.search,
      host:context.url.hostname,protocol:context.url.protocol},method:context.method,env:process.env as Record<string,string>});
    const discardBranch=async(branch:Branch,error?:unknown)=>{
      try {
        if(branch.result.drainRetryObservation)await branch.result.drainRetryObservation();
        await cleanupAttempt(branch.result,processingSignal);
        await finishAttemptObservation(branch.result,'failed');
        const outcome=await branch.result.completion;
        if(branch.endpoint.status!=='HALF_OPEN')branch.logger.setRequestType('retry');
        if(branch.ownRetryable || outcome.status==='failed' && outcome.code==='upstream_http_error' && !isNeutralClientError(branch.result.response.status,outcome,false))settleUpstreamFailure(branch.endpoint,'upstream_branch_failed',branch.layer);
        await completeAttempt(branch.logger,branch.result.response.status,{routePath,upstream:branch.endpoint.target,
          protocolOutcome:outcome.status,protocolCode:'code' in outcome?outcome.code:undefined,protocolError:'error' in outcome?outcome.error:undefined,success:false,errorMessage:'upstream branch failed'});
      }finally{
        branch.release();
        for(const frame of [...branch.frames].reverse())await closeServiceFrame(frame,false,branch.result.response.status,error);
      }
    };
    const retryableResponse=async(branch:Branch,layer:EffectiveRouteConfig,canSwitch:boolean):Promise<boolean>=>{
      if(branch.result.upstreamConnected || !layer.failover?.enabled || branch.result.repairFallback || branch.result.shortCircuitedByPlugin)return false;
      const match=layer.failover.retry_on ? createStatusCodeMatcher(layer.failover.retry_on) : undefined;
      if(match?.(branch.result.response.status)){if(branch.layer===layer)branch.ownRetryable=true;return true;}
      if(canSwitch && layer.failover.retry_on_response?.length){
        const checked=await checkResponseForFailover(branch.result.response,layer.failover.retry_on_response);
        if(checked.response)branch.result.response=checked.response;
        if(checked.hit && branch.layer===layer)branch.ownRetryable=true;
        return checked.hit;
      }
      return false;
    };
    const terminalError=(error:unknown)=>!(isUpstreamNetworkError(error)||isUpstreamTimeoutError(error)||isUpstreamPhaseFailoverSignal(error)||error instanceof UpstreamResponseValidationError||error instanceof SelectionUnavailableError) || processingSignal.aborted || error instanceof DataAdmissionError || error instanceof BodyProcessingError
      || error instanceof AttemptCleanupError || isManagedUpstreamAccessError(error)
      || (requestSnapshot.method==='POST' && (isUpstreamNetworkError(error)||isUpstreamTimeoutError(error)));
    const executeLayer=async(layer:EffectiveRouteConfig,context:MutableRequestContext,serviceIds:string[],ancestorCanSwitch=false):Promise<Branch>=>{
      processingSignal.throwIfAborted();
      const upstreams=layerEndpoints(layer);
      const coordinator=requireGatewayResult(await gatewayHooks().onGatewayFailover.promise({upstreams,
        references:layerReferences(config,layer),route:layer,recoveryIntervalMs:layer.failover?.recovery?.backoff_base_ms ?? 5000,
        context:expressionFor(context)}),'onGatewayFailover');
      const useCustomSelector=upstreamSelector!==selectUpstream && !layer.service_references?.length && !layer.failover?.enabled;
      let lastError:unknown;
      while(coordinator.hasNext()){
        processingSignal.throwIfAborted();
        const choice=requireGatewayResult(await gatewayHooks().onGatewaySelect.promise({upstreams,route:layer,
          context:expressionFor(context),coordinator:useCustomSelector?undefined:coordinator,selector:upstreamSelector}),'onGatewaySelect');
        if(!choice.upstream && !choice.reference)break;
        let branch:Branch|undefined;
        let frame:ServiceFrame|undefined;
        try{
          if(choice.reference){
            const reference=choice.reference;
            const service=serviceById(config,reference.service_id);
            if(serviceIds.includes(service.id))throw new DataAdmissionError(422,'service_reference_cycle');
            const childContext=cloneMutableRequestContext(context);
            childContext.serviceId=service.id;childContext.serviceName=service.name;
            const phase=scopedRegistry?.getPrecompiledHooks(currentRouteId,undefined,service.id).servicePhase ?? null;
            for(const owner of scopedRegistry?.getServicePluginOwners?.(currentRouteId,service.id) ?? [])retainOwner(owner.pluginName,owner.scopeKey);
            const demand=collectPluginBodyRequirements([phase],{requestId,method:req.method,url:childContext.url,
              routeId:currentRouteId,serviceId:service.id,stage:'route'});
            if(demand.replay)await requestSnapshot.bodySource?.buffer('service-replay');
            const selectionNeedsBody=analyzeExpressionDependencies({conditions:service.endpoints.map(endpoint=>endpoint.condition),hash:service.load_balancing?.hash_policy?.expression},'request').requestBody;
            if(childContext.body===undefined && (demand.request!=='none'||selectionNeedsBody))childContext.body=structuredClone(await readSnapshotJson(requestSnapshot,'service-body-demand',demand.request==='json-write'));
            childContext.bodyWrite=childContext.bodyWrite || demand.request==='json-write';
            childContext.bodyRequirements=collectPluginBodyRequirements([...(scopedRegistry?.getPrecompiledHooks(currentRouteId,undefined,serviceIds).servicePhases ?? []),phase,requestPhaseHooks?.routePhase,requestPhaseHooks?.dispatchAdapter],
              {requestId,method:req.method,url:childContext.url,routeId:currentRouteId,serviceId:service.id,stage:'route'});
            const derived=deriveRequestSnapshot(requestSnapshot,childContext,{requestId,attemptId:requestId,direction:'request',stage:'outbound-request',version:serviceIds.length+1,contentType:requestSnapshot.content_type,contentEncoding:''});
            childContext.bodyHandle=derived.snapshot.bodySource?.handle();
            incrementActiveRequests(layer.state_key ?? layer.path,reference.id);
            frame={service,phase,context:childContext,closed:false,release:()=>{derived.dispose();decrementActiveRequests(layer.state_key ?? layer.path,reference.id);}};
            enteredServiceFrames.push(frame);
            const local=await executePreFailoverPhase(phase,childContext,{phaseName:'service',requestLog,requestId,routeId:currentRouteId,serviceName:service.name,authorizeResponse:authorizePhaseResponse});
            if(local)throw new LocalServiceResponse(local);
            branch=await executeLayer(serviceLayer(layer,service),childContext,[...serviceIds,service.id],
              ancestorCanSwitch || !!layer.failover?.enabled && coordinator.hasNext());
            branch.frames.unshift(frame);
          }else{
            const endpoint=choice.upstream!;
            if(choice.shouldTransitionToHalfOpen)endpoint.status='HALF_OPEN';
            endpoint.last_used_time=Date.now();
            const stateKey=layer.state_key ?? layer.path;
            incrementActiveRequests(stateKey,endpoint.upstream_id);
            let released=false;
            const release=()=>{if(released)return;released=true;decrementActiveRequests(stateKey,endpoint.upstream_id);releaseHalfOpenSlot(stateKey,endpoint.upstream_id);};
            attemptNumber++;upstream=endpoint.target;transport.upstream=endpoint.target;lastAttemptedUpstreamId=endpoint.upstream_id;
            const recoveryAttempt=endpoint.status==='HALF_OPEN';
            const isFailoverAttempt=!!effectiveRoute.failover?.enabled || serviceIds.some(id=>serviceById(config,id).failover?.enabled) || attemptNumber>1;
            let attemptLogger=await createRequestLogger(req,{isFailoverAttempt,...(isFailoverAttempt ? {parentRequestId:reqLogger.getRequestId()}:{}),
              attemptNumber,attemptUpstream:endpoint.target,requestType:recoveryAttempt?'recovery':'final'});
            finalAttemptLogger=attemptLogger;
            attemptLogger.inheritOriginalBody(reqLogger);attemptLoggerCreated=true;
            attemptLogger.setOriginalRequestHeaders(redactRequestHeaders(originalHeaders));
            if(requestSnapshot.is_json_body)attemptLogger.setOriginalRequestBody(requestSnapshot.body);
            reqLogger.addStep('upstream_selected',{target:endpoint.target,serviceIds});
            try{
              const result=await proxyWithRouteRetry(endpoint,attemptLogger,layer,context,serviceIds);
              attemptLogger=result.attemptLogger ?? attemptLogger;
              branch={result,endpoint,layer,context,frames:[],release,logger:attemptLogger};
            }catch(caught){
              const error=normalizeAdmissionError(caught) ?? caught;
              release();
              if(!terminalError(error))settleUpstreamFailure(endpoint,error instanceof Error?error.message:'upstream_failed',layer);
              if(!terminalError(error) && (ancestorCanSwitch || layer.failover?.enabled && coordinator.hasNext()) && !recoveryAttempt)attemptLogger.setRequestType('retry');
              if(!(error instanceof DataAdmissionError) && !(error instanceof BodyProcessingError))await completeAttempt(attemptLogger,isUpstreamTimeoutError(error)?504:503,{routePath,upstream:endpoint.target,
                protocolOutcome:req.signal.aborted && !isDeadlineFailure(error)?'cancelled':'failed',success:false,
                protocolCode:isUpstreamTimeoutError(error)?'upstream_timeout':error instanceof DataAdmissionError?error.code:undefined,errorMessage:error instanceof Error?error.message:'upstream_failed'});
              throw error;
            }
          }
          const retryable=await retryableResponse(branch,layer,coordinator.hasNext());
          if(!retryable || !coordinator.hasNext() || !requestSnapshot.bodySource?.replayable)return branch;
          await discardBranch(branch);branch=undefined;
        }catch(caught){
          const error=normalizeAdmissionError(caught) ?? caught;
          if(error instanceof LocalServiceResponse)throw error;
          if(branch)await discardBranch(branch,error);
          else if(frame)await closeServiceFrame(frame,false,undefined,error);
          lastError=error;
          if(terminalError(error) || !layer.failover?.enabled || !requestSnapshot.bodySource?.replayable)throw error;
        }
      }
      throw lastError ?? new SelectionUnavailableError('upstream_unavailable');
    };
    let finalBranch:Branch;
    try{finalBranch=await executeLayer(effectiveRoute,phase1and2Context,[]);}
    catch(error){
      rootFailure=error;
      if(error instanceof LocalServiceResponse){responseStatus=error.response.status;success=responseStatus<400;return finalizeRootStreamingResponse(requireGatewayResult(await gatewayHooks().onGatewayCors.promise(error.response,route.cors,req),'onGatewayCors'));}
      if(error instanceof DataAdmissionError || error instanceof BodyProcessingError)throw error;
      if(!isUpstreamNetworkError(error) && !isUpstreamTimeoutError(error) && !isUpstreamPhaseFailoverSignal(error) && !(error instanceof SelectionUnavailableError) && !(error instanceof UpstreamResponseValidationError) && !(error instanceof AttemptCleanupError) && !isManagedUpstreamAccessError(error))throw error;
      success=false;responseStatus=isUpstreamTimeoutError(error)?504:error instanceof SelectionUnavailableError && !effectiveRoute.service_references?.length && !effectiveRoute.failover?.enabled?500:503;
      return finalizeLocalResponse(Response.json({error:responseStatus===500?'Internal server error':isUpstreamTimeoutError(error)?'Gateway Timeout':'Service Unavailable'},{status:responseStatus}));
    }
    const {result,endpoint,layer,logger:attemptLogger}=finalBranch;
    streamResult=result;finalAttemptLogger=attemptLogger;finalServiceIds=finalBranch.frames.map(frame=>frame.service.id);
    routeServiceName=finalBranch.context.serviceName;
    finalUpstreamIdForFinally=result.upstreamId;responseStatus=result.response.status;success=result.response.status<400;
    const settleFinal=async(outcome:ProtocolOutcome)=>{
      try{
        await finishAttemptObservation(result,outcome.status==='completed'?'completed':outcome.status==='cancelled'?'cancelled':'failed');
        const statusMatcher=layer.failover?.retry_on ? createStatusCodeMatcher(layer.failover.retry_on):undefined;
        if(!result.shortCircuitedByPlugin && !isNeutralClientError(result.response.status,outcome,!!statusMatcher?.(result.response.status))
          && (outcome.status!=='cancelled' || !req.signal.aborted && !result.streamCompletionState?.clientCancelled)){
          if(finalBranch.ownRetryable || outcome.status==='failed' && outcome.code==='upstream_http_error')settleUpstreamFailure(endpoint,'upstream_http_error',layer);
          else settleStreamHealth(endpoint,outcome.status==='completed',result.response.status,layer);
        }
        await completeAttempt(attemptLogger,result.response.status,{routePath,upstream:endpoint.target,protocolOutcome:outcome.status,
          protocolCode:'code' in outcome?outcome.code:undefined,protocolError:'error' in outcome?outcome.error:undefined,
          success:outcome.status==='completed'&&result.response.ok});
      }finally{finalBranch.release();}
    };
    if(!result.response.body)await settleFinal(await result.completion);
    return finalizeStreamingResponse(requireGatewayResult(await gatewayHooks().onGatewayCors.promise(result.response,route.cors,req),'onGatewayCors'),
      result,attemptLogger,settleFinal);

  } catch (error) {
    error=normalizeAdmissionError(error) ?? error;rootFailure=error;
    success = false;
    if (error instanceof DataAdmissionError) {
      responseStatus = error.status;
      rootProtocolOutcome = 'failed'; rootProtocolCode = error.code; rootErrorMessage = error.code;
      reqLogger.addStep('request_rejected',{code:error.code,...(error.details?.param?{param:error.details.param}:{})});
      return localFailureResponse ?? prepareProcessingErrorResponse(error);
    }
    if (error instanceof BodyProcessingError && !(error instanceof RequestBodyTooLargeError)) {
      responseStatus = error.status; rootProtocolOutcome = 'failed'; rootProtocolCode = error.code;
      rootErrorMessage = error.message;
      const body = {error:error.code, code:error.code, message:error.code,
        ...(error.limitBytes === undefined ? {} : {limit_bytes:error.limitBytes}),
        ...(error.receivedBytes === undefined ? {} : {received_bytes:error.receivedBytes})};
      reqLogger.addStep(error.status === 413 ? 'request_body_rejected' : 'body_processing_rejected',body);
      (finalAttemptLogger ?? reqLogger).setResponseBody(body);
      (finalAttemptLogger ?? reqLogger).setResponseHeaders({'content-type':'application/json'});
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
      (finalAttemptLogger ?? reqLogger).setResponseBody(body);
      (finalAttemptLogger ?? reqLogger).setResponseHeaders({ 'content-type': 'application/json' });
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
