/** Typed extension stages shared by built-in and project plugins. */
import type { AppConfig, RouteConfig, CorsConfig, LLMProtocol } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream, RuntimeServiceReference, RuntimeCandidate, RequestSnapshot } from '../worker/types';
import type { HandleRequestRuntimeContext } from './request-plugin';
import type { PhaseAwareHooks, InboundChain } from '../scoped-plugin-registry';
import type { MutableRequestContext } from '../worker/request/context';
import type { PluginHooks, RequestContext } from '../hooks';
import type { ModificationRules, ResponseModificationRules } from '@jeffusion/bungee-types';
import type { BodySource } from '../worker/request/body-source';
import type { ProxyAttemptOptions, ProxyRequestResult } from './forward-plugin';
import type { StreamCompletionState } from './response-plugin';

import type { RequestLogger, RequestLoggerDependencies, RequestLogCompletionOptions } from '../logger/request-logger';
import type { WorkerRequestAdmission, WorkerAdmissionPlugin } from '../data-admission/worker';
import type { FailoverCoordinator } from '../worker/upstream/failover-coordinator';

export type GatewayBodyArguments = ConstructorParameters<typeof BodySource>;
export type GatewaySelector = (upstreams:RuntimeUpstream[],route?:EffectiveRouteConfig,context?:ExpressionContext)=>RuntimeUpstream|undefined;
export type GatewayRequestArguments = [request:Request,config:AppConfig,runtimeContextOrSelector?:HandleRequestRuntimeContext|GatewaySelector,selector?:GatewaySelector];
export type GatewayForwardArguments = [snapshot:RequestSnapshot,route:EffectiveRouteConfig,upstream:RuntimeUpstream,requestLog:any,config:AppConfig,routeId:string,logger?:RequestLogger,phases?:PhaseAwareHooks|null,phaseContext?:MutableRequestContext,signal?:AbortSignal,options?:ProxyAttemptOptions];
export type GatewayResponseRuleArguments = [response:Response,rules:ResponseModificationRules,context:ExpressionContext,requestLog:any,logger?:RequestLogger,config?:AppConfig,hooks?:PluginHooks,streamContext?:RequestContext,state?:StreamCompletionState,inbound?:InboundChain,streamCallbacks?:boolean,strict?:boolean,signal?:AbortSignal,owners?:Array<{dispose():void}>,source?:BodySource,modified?:boolean];
export type GatewayBodyRuleArguments = [body:Record<string,any>,rules:ModificationRules['body'],context:ExpressionContext,requestLog:any];
export type GatewayHeaderRuleArguments = [headers:Headers,rules:ModificationRules['headers'],context:ExpressionContext];
export type GatewayCorsArguments = [response:Response,cors:CorsConfig|undefined,request:Request];
export type GatewayQueryRuleArguments = [params:URLSearchParams,rules:ModificationRules['query'],context:ExpressionContext,requestLog:any];
export interface GatewayDispatchTarget { readonly type: 'route' | 'service'; readonly id: string }
export interface DispatchRequestInput {
  /** Trusted host metadata, never client headers or message metadata. */
  readonly webSocketConnection?:{readonly id:string;readonly signal:AbortSignal};
  readonly context: import('../hooks').MutableRequestContext;
  readonly targets: readonly GatewayDispatchTarget[];
  readonly principal?: import('../plugin-extensions').DataPrincipal;
  readonly signal: AbortSignal;
  readonly servingRevision?: number;
}
export interface DispatchConversionDiagnostic {readonly param:string;readonly action:'mapped'|'omitted';readonly reason:string}
export interface GatewayAuxiliaryIdentity { readonly scope: string | null; readonly model: string; readonly upstreamId: string }
export interface GatewayAuxiliaryRequest {
  readonly target: GatewayDispatchTarget; readonly protocol: 'responses'; readonly model: string; readonly body: unknown;
  /** Explicit aggregate signal replaces parent cancellation; absent means parent-owned lifetime. */
  readonly signal?: AbortSignal;
  /** Null scope requires caller-owned local isolation and cannot identify a shared account cache. */
  readonly reuse?: (identity: GatewayAuxiliaryIdentity) => Promise<unknown | undefined>;
}
export type GatewayAuxiliaryResult =
  | {readonly kind:'response'; readonly status:number; readonly bodyHandle:import('./body-contracts').BodyHandle;
     readonly completion:Promise<import('../plugin-control/contracts').RawResponseCompletion>; readonly identity:GatewayAuxiliaryIdentity;
     readonly requestId:string; dispose():void}
  | {readonly kind:'reused'; readonly value:unknown; readonly identity:GatewayAuxiliaryIdentity};
export type ExecuteGatewayAuxiliary = (input:GatewayAuxiliaryRequest)=>Promise<GatewayAuxiliaryResult>;
export interface DispatchRequestPreparationInput {
  readonly webSocketConnection?:{readonly id:string;readonly signal:AbortSignal};
  readonly context:import('../hooks').MutableRequestContext; readonly principal?:import('../plugin-extensions').DataPrincipal;
  readonly servingRevision?:number; readonly signal:AbortSignal; readonly executeAuxiliary:ExecuteGatewayAuxiliary;
}
export interface DispatchRequestPreparationResult {
  readonly requiredUpstreamId?:string;
  readonly adapter?:import('../plugin.types').Plugin; readonly canonicalInput?:readonly unknown[];
  readonly diagnostics?:readonly DispatchConversionDiagnostic[];
}
export interface DispatchRequestDecision extends DispatchRequestPreparationResult {
  readonly target:GatewayDispatchTarget; readonly protocol?:LLMProtocol; readonly requiredUpstreamId?:string;
  readonly prepareRequest?:(input:DispatchRequestPreparationInput)=>Promise<DispatchRequestPreparationResult>;
}
export interface GatewayDispatchInput extends Omit<DispatchRequestInput,'targets'> { readonly config: AppConfig; readonly entry: RouteConfig }
export interface GatewayDispatchDecision {
  readonly route: RouteConfig; readonly effective: EffectiveRouteConfig;
  readonly context: import('../hooks').MutableRequestContext;
  readonly entryRouteId?: string; readonly target?: GatewayDispatchTarget; readonly requiredUpstreamId?: string; readonly protocol?: LLMProtocol; readonly adapter?: import('../plugin.types').Plugin;
  readonly canonicalInput?: readonly unknown[];
  readonly diagnostics?: readonly DispatchConversionDiagnostic[];
  readonly prepareRequest?:DispatchRequestDecision['prepareRequest'];
}
export interface GatewayRouteInput { readonly request: Request; readonly config: AppConfig }
export interface GatewayRouteDecision { readonly route?: RouteConfig; readonly effective?: EffectiveRouteConfig; readonly response?: Response; readonly responseKind?: 'rule' | 'local' }
export interface GatewayAdmissionInput {
  readonly route: RouteConfig; readonly trustedPeer: string | null; readonly context: ExpressionContext;
  readonly servingRevision?: number; readonly signal: AbortSignal;
}
export type GatewayAdmissionDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs?: number };
export interface GatewayAdmissionSessionInput {
  readonly handlers: readonly WorkerAdmissionPlugin[];
  readonly identity: ConstructorParameters<typeof WorkerRequestAdmission>[1];
  readonly invoke: ConstructorParameters<typeof WorkerRequestAdmission>[2];
}
export interface GatewayAdmissionPrepareInput {
  readonly session: WorkerRequestAdmission;
  readonly target: Parameters<WorkerRequestAdmission['prepare']>[0];
  readonly signal: AbortSignal;
  readonly readBody: Parameters<WorkerRequestAdmission['prepare']>[2];
}
export interface GatewaySelectInput {
  readonly upstreams: RuntimeUpstream[]; readonly route: EffectiveRouteConfig; readonly context: ExpressionContext;
  readonly selector?: (upstreams: RuntimeUpstream[], route?: EffectiveRouteConfig, context?: ExpressionContext) => RuntimeUpstream | undefined;
  readonly references?: RuntimeServiceReference[];
  readonly coordinator?: FailoverCoordinator<RuntimeCandidate>;
}
export interface GatewaySelectDecision { readonly reference?: RuntimeServiceReference; readonly upstream?: RuntimeUpstream; readonly shouldTransitionToHalfOpen?: boolean }
export interface GatewayFailoverInput {
  readonly references?: RuntimeServiceReference[];
  readonly upstreams: RuntimeUpstream[]; readonly route: EffectiveRouteConfig; readonly recoveryIntervalMs: number; readonly context: ExpressionContext;
}
export interface GatewayRetryInput {
  readonly snapshot: RequestSnapshot; readonly route: RouteConfig; readonly signal: AbortSignal;
  /** Caller cancellation stays terminal even when a buffered repair fallback survives the shared deadline. */
  readonly clientSignal?: AbortSignal;
  readonly runAttempt: (override?: GatewayRequestOverride) => Promise<ProxyRequestResult>;
  readonly finish: (result: ProxyRequestResult, preserveRequestState?:boolean) => Promise<void>;
  readonly end: (result: ProxyRequestResult, cancelled: boolean) => Promise<void>;
  readonly cleanup: (result: ProxyRequestResult, signal: AbortSignal) => Promise<void>;
  readonly claimRepair?: () => boolean;
  readonly recordAttempt?: (result:ProxyRequestResult) => Promise<void>;
}
/** Final outbound representation: a repair attempt skips already completed request conversions. */
export interface GatewayRequestOverride {readonly url:string;readonly headers:Readonly<Record<string,string>>;readonly body:unknown;readonly annotations?:Readonly<Record<string,import('../plugin.types').PluginConfigValue>>}
export type GatewayLogInput =
  | { readonly phase: 'create'; readonly request: Request; readonly options?: ConstructorParameters<typeof RequestLogger>[1]; readonly dependencies?: RequestLoggerDependencies }
  | { readonly phase: 'complete' | 'root'; readonly logger: RequestLogger; readonly status: number; readonly options: RequestLogCompletionOptions };
export interface GatewayLogResult { readonly logger?: RequestLogger }

/** Provider stages are fixed, required, and registered exactly once at startup. */
export const GATEWAY_PROVIDER_STAGES = [
  'onGatewayWebSocket','onGatewayBody','onGatewayRequest', 'onGatewayRoute', 'onGatewayDispatch', 'onGatewayAdmission', 'onGatewayAdmissionSession',
  'onGatewayAdmissionPrepare', 'onGatewaySelect', 'onGatewayFailover', 'onGatewayRetry',
  'onGatewayForward', 'onGatewayHeaderRules', 'onGatewayCors', 'onGatewayBodyRules', 'onGatewayQueryRules', 'onGatewayResponseRules', 'onGatewayLog',
] as const;
