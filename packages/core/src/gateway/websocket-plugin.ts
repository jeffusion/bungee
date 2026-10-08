import { randomUUID } from 'node:crypto';
import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import type { GatewayWebSocketInput, GatewayWebSocketResult, WebSocketHandshakeContext } from './websocket-contracts';
import { gatewayHooks, requireGatewayResult } from './runtime';
import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import { getTrustedDataIdentity, getTrustedWorkerPeer } from '../config-worker/private-transport';
import { hasWorkerAdmissionSession, type WorkerRequestAdmission } from '../data-admission/worker';
import { DataAdmissionError } from '../data-admission/errors';
import { runtimeState, incrementActiveRequests, decrementActiveRequests, releaseHalfOpenSlot } from '../worker/state/runtime-state';
import type { RuntimeUpstream } from '../worker/types';
import { rebaseToUpstream } from '../worker/request/context';
import type { ExpressionContext } from '../expression-engine';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import { deepMergeRules } from '../worker/rules/deep-merge';
import { WebSocketObservers } from '../websocket/observation';
import { validateWebSocketRequest } from '../websocket';
import { websocketCredential } from './websocket-credential';
import { logger } from '../logger';

function headerRecord(headers:Headers):Record<string,string> {const result:Record<string,string>={};headers.forEach((value,name)=>{result[name]=value;});return result;}
const reject = (status:number,error:string):GatewayWebSocketResult=>({response:Response.json({error},{status})});
/** WebSocket is a registered gateway provider, with handshake and read-only message hooks. */
export class WebSocketGatewayPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayWebSocket.tapPromise('builtin.websocket', input=>this.upgrade(input));
  }
  private async upgrade(input: GatewayWebSocketInput): Promise<GatewayWebSocketResult> {
    const {request,config,bridge,nativeRequest,server,servingRevision} = input;
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(bridge.limits.handshakeTimeoutMs)]);
    const invalid = validateWebSocketRequest(request);
    if (invalid) return {response:invalid};
    const identity = getTrustedDataIdentity(request);
    if (hasWorkerAdmissionSession() && !identity) return reject(401,'unauthorized');
    const connectionId = identity?.requestId ?? randomUUID();
    const registry = getScopedPluginRegistry();
    const leases = new Map<string,()=>void>();
    const retain = (plugin:string,scope='global') => {
      const key = `${plugin}\0${scope}`;
      if (!leases.has(key) && registry?.serviceHost) leases.set(key,registry.serviceHost.acquireLease(plugin,scope));
    };
    let admission: WorkerRequestAdmission | undefined;
    let releaseActive: (()=>void) | undefined;
    let observers: WebSocketObservers | undefined;
    let settled = false;
    let committed = false;
    let resolveCompletion!:()=>void;
    const completion = new Promise<void>(resolve=>{resolveCompletion=resolve;});
    input.retain(completion);
    const finish = async () => {
      if (settled) return; settled=true;
      releaseActive?.();
      try { await admission?.release(); }
      finally { for (const release of leases.values()) release(); resolveCompletion(); }
    };
    try {
      const decision = requireGatewayResult(await gatewayHooks().onGatewayRoute.promise({request,config}),'onGatewayRoute');
      const route = decision.route;
      if (!route) return reject(404,'route_not_found');
      if (route.websocket?.enabled!==true) return reject(426,'websocket_disabled');
      if (decision.response) return {response:decision.response};
      const effective = requireGatewayResult(decision.effective,'onGatewayRoute');
      const headers = new Headers(request.headers);
      const url = new URL(request.url);
      for (const [pattern,replacement] of Object.entries(route.path_rewrite ?? {})) {
        const expression = new RegExp(pattern);
        if (expression.test(url.pathname)) {url.pathname=url.pathname.replace(expression,replacement);break;}
      }
      const expressionContext = (): ExpressionContext => ({headers:headerRecord(headers),body:undefined,request:{headers:headerRecord(headers)},
        url:{pathname:url.pathname,search:url.search,host:url.host,protocol:url.protocol},method:'GET',env:process.env as Record<string,string>});
      if (analyzeExpressionDependencies({request:route.request,selection:effective.endpoints.map(e=>e.condition),hash:effective.load_balancing?.hash_policy?.expression,rate:route.rate_limit?.key_expression},'request').requestBody || hasBodyModification(route.request?.body)) return reject(422,'websocket_body_rules_unsupported');
      const rate = requireGatewayResult(await gatewayHooks().onGatewayAdmission.promise({route,trustedPeer:getTrustedWorkerPeer(request),context:expressionContext(),servingRevision,signal}),'onGatewayAdmission');
      if (!rate.allowed) return {response:Response.json({error:rate.retryAfterMs===undefined?'rate_limit_unavailable':'rate_limited'},{status:rate.retryAfterMs===undefined?503:429,
        headers:rate.retryAfterMs===undefined?{}:{'retry-after':String(Math.max(1,Math.ceil(rate.retryAfterMs/1000)))}})};
      const upstreams = runtimeState.get(route.service ?? route.path)?.upstreams ?? effective.endpoints.map((endpoint,index)=>({...endpoint,upstream_id:endpoint.id ?? String(index),status:'HEALTHY',consecutive_failures:0,consecutive_successes:0,recovery_attempt_count:0} as RuntimeUpstream));
      const upstream = requireGatewayResult(await gatewayHooks().onGatewaySelect.promise({upstreams,route:effective,context:expressionContext()}),'onGatewaySelect').upstream;
      if (!upstream) return reject(503,'upstream_unavailable');
      const stateKey = route.service ?? route.path;
      incrementActiveRequests(stateKey,upstream.upstream_id);
      releaseActive=()=>{decrementActiveRequests(stateKey,upstream.upstream_id);releaseHalfOpenSlot(stateKey,upstream.upstream_id);};
      const rules = deepMergeRules(route.request ?? {},upstream.request ?? {});
      if (hasBodyModification(rules.body) || analyzeExpressionDependencies(rules,'request').requestBody) return reject(422,'websocket_body_rules_unsupported');
      await gatewayHooks().onGatewayHeaderRules.promise(headers,rules.headers,expressionContext());
      const query = requireGatewayResult(await gatewayHooks().onGatewayQueryRules.promise(url.searchParams,rules.query,expressionContext(),{}),'onGatewayQueryRules');
      url.search=query.toString();
      const rebased = {url,method:'GET',headers:headerRecord(headers)};
      rebaseToUpstream(rebased,upstream);
      const owners=registry?.getWebSocketOwners(route.path,upstream.upstream_id,route.service) ?? [];
      for (const owner of [...owners,...(registry?.getWebSocketHandshakeOwners(route.path,upstream.upstream_id,route.service) ?? []),...(registry?.getBoundControlOwners(route.path,upstream.upstream_id) ?? [])]) retain(owner.pluginName,owner.scopeKey);
      const handlers=registry?.getGlobalAdmissionHandlers() ?? [];
      if (identity && hasWorkerAdmissionSession()) {
        for (const handler of handlers) retain(handler.pluginName);
        admission=requireGatewayResult(await gatewayHooks().onGatewayAdmissionSession.promise({handlers,identity:{requestId:connectionId,principal:identity.principal,routeId:route.id ?? route.path,
          serviceId:(route as {service_id?:string}).service_id ?? (config.services?.find(s=>s.name===route.service) as {id?:string}|undefined)?.id ?? null},
          invoke:(plugin,method,payload,target)=>registry!.invokeAdmissionRpc(plugin,method,payload,target,leases.get(`${plugin}\0global`)!)}),'onGatewayAdmissionSession');
      }
      const phases=registry?.getPrecompiledHooks(route.path,upstream.upstream_id,route.service);
      let handshake:WebSocketHandshakeContext={connectionId,routeId:route.path,upstreamId:upstream.upstream_id,url,headers,signal};
      for (const phase of [phases?.routePhase,phases?.servicePhase,phases?.upstreamPhase]) if (phase) {
        const run=()=>phase.hooks.onWebSocketHandshake.promise(handshake);
        handshake=registry ? await registry.runWithRequestLeases(leases,run) : await run();
      }
      if (admission) await admission.prepare({attemptId:connectionId,upstreamId:upstream.upstream_id,url:handshake.url.href,model:null,body:undefined,transport:'websocket'},signal);
      const acquire = ()=>websocketCredential(upstream,handshake.url,handshake.headers,servingRevision,connectionId,signal);
      const outboundHeaders = registry ? await registry.runWithRequestLeases(leases,acquire) : await acquire();
      const target=new URL(handshake.url);
      if (!['http:','https:','ws:','wss:'].includes(target.protocol) || target.username || target.password || target.hash) return reject(422,'websocket_target_invalid');
      target.protocol=target.protocol==='https:'?'wss:':target.protocol==='http:'?'ws:':target.protocol;
      observers=new WebSocketObservers({connectionId,keyId:identity?.principal.domain==='data'?identity.principal.keyId:null,routeId:route.path,
        upstreamId:upstream.upstream_id,upstreamUrl:handshake.url.href.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),servingRevision},owners);
      // Install observation context before dialing; early upstream events are ordered after open below.
      const result = await bridge.upgrade(nativeRequest,server,{url:target,headers:outboundHeaders,signal,
        onOpen:()=>observers!.emit({phase:'open'}),
        onMessage:(direction,message)=>observers!.emit({phase:'message',direction,message}),
        onClose:async(code,reason,metrics)=>{
          try {await observers!.close({phase:'close',code,reason,metrics});
            logger.info({websocket:{connection_id:connectionId,route:route.path,upstream_id:upstream.upstream_id,serving_revision:servingRevision,code,...metrics}},'WebSocket connection closed');}
          finally {await finish();}
        },
      });
      if (result) return {response:result};
      committed=true;
      return {};
    } catch (error) {
      return reject(error instanceof DataAdmissionError ? error.status : 502,error instanceof DataAdmissionError ? error.code : 'websocket_handshake_failed');
    } finally {
      // Successful upgrade transfers ownership to native close + observation cleanup.
      if (!committed) await finish();
    }

  }
}
