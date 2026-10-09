/** Typed extension stages shared by built-in and project plugins. */
import type { AppConfig, RouteConfig, CorsConfig, LLMProtocol } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';
import type { EffectiveRouteConfig, RuntimeUpstream, RequestSnapshot } from '../worker/types';
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
  readonly context: import('../hooks').MutableRequestContext;
  readonly targets: readonly (GatewayDispatchTarget & {readonly protocol?: LLMProtocol})[];
  readonly principal?: import('../plugin-extensions').DataPrincipal;
  readonly signal: AbortSignal;
  readonly servingRevision?: number;
}
export interface DispatchRequestDecision { readonly target: GatewayDispatchTarget; readonly protocol?: LLMProtocol; readonly requiredUpstreamId?: string; readonly adapter?: import('../plugin.types').Plugin }
export interface GatewayDispatchInput extends Omit<DispatchRequestInput,'targets'> { readonly config: AppConfig; readonly entry: RouteConfig }
export interface GatewayDispatchDecision {
  readonly route: RouteConfig; readonly effective: EffectiveRouteConfig;
  readonly context: import('../hooks').MutableRequestContext;
  readonly entryRouteId?: string; readonly target?: GatewayDispatchTarget; readonly requiredUpstreamId?: string; readonly protocol?: LLMProtocol; readonly adapter?: import('../plugin.types').Plugin;
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
  readonly coordinator?: FailoverCoordinator;
}
export interface GatewaySelectDecision { readonly upstream?: RuntimeUpstream; readonly shouldTransitionToHalfOpen?: boolean }
export interface GatewayFailoverInput {
  readonly upstreams: RuntimeUpstream[]; readonly route: EffectiveRouteConfig; readonly recoveryIntervalMs: number; readonly context: ExpressionContext;
}
export interface GatewayRetryInput {
  readonly snapshot: RequestSnapshot; readonly route: RouteConfig; readonly signal: AbortSignal;
  readonly runAttempt: (override?: GatewayRequestOverride) => Promise<ProxyRequestResult>;
  readonly finish: (result: ProxyRequestResult) => Promise<void>;
  readonly end: (result: ProxyRequestResult, cancelled: boolean) => Promise<void>;
  readonly cleanup: (result: ProxyRequestResult, signal: AbortSignal) => Promise<void>;
  readonly claimRepair?: () => boolean;
  readonly recordAttempt?: (result:ProxyRequestResult) => Promise<void>;
}
/** Final outbound representation: a repair attempt skips already completed request conversions. */
export interface GatewayRequestOverride {readonly url:string;readonly headers:Readonly<Record<string,string>>;readonly body:unknown}
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
