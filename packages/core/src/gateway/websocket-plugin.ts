import { PhysicalRequestBudget, serviceById, serviceLayer, layerEndpoints, layerReferences } from '../worker/upstream/service-execution';
import { resolveReachableEndpoints } from '../utils/endpoint-resolver';
import { createStatusCodeMatcher } from '../worker/utils/status-code-matcher';
import type { EffectiveRouteConfig } from '../worker/types';
import type { PrecompiledHooks } from '../scoped-plugin-registry';
import { randomUUID } from 'node:crypto';
import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import type { GatewayWebSocketInput, GatewayWebSocketResult, WebSocketHandshakeContext } from './websocket-contracts';
import { gatewayHooks, requireGatewayResult } from './runtime';
import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import { getTrustedDataIdentity, getTrustedWorkerPeer } from '../config-worker/private-transport';
import { hasWorkerAdmissionSession, type WorkerRequestAdmission } from '../data-admission/worker';
import { DataAdmissionError, normalizeAdmissionError } from '../data-admission/errors';
import { isUpstreamNetworkError, isUpstreamTimeoutError } from '../worker/request/proxy';
import { incrementActiveRequests, decrementActiveRequests, releaseHalfOpenSlot } from '../worker/state/runtime-state';
import { rebaseToUpstream } from '../worker/request/context';
import type { ExpressionContext } from '../expression-engine';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import { deepMergeRules } from '../worker/rules/deep-merge';
import { WebSocketObservers } from '../websocket/observation';
import { validateWebSocketRequest } from '../websocket';
import { websocketCredential } from './websocket-credential';
import {ResponsesWebSocketSession} from './responses-websocket-session';

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
    const frames:Array<{phase:PrecompiledHooks|null;id:string;kind:'service'|'endpoint';release:()=>void;closed:boolean}>=[];
    const closeFrame=async(frame:typeof frames[number],ok:boolean)=>{
      if(frame.closed)return;frame.closed=true;
      const context={requestId:connectionId,method:'GET',originalUrl:new URL(request.url),clientIP:'unknown',
        success:ok,latencyMs:0,...(frame.kind==='service'?{serviceName:frame.id}:{upstreamId:frame.id}),headers:{},body:undefined,error:new Error('websocket_handshake_failed')};
      try{if(!ok)await frame.phase?.hooks.onError.promise(context);}
      finally{try{await frame.phase?.hooks.onFinally.promise(context);}finally{frame.release();}}
    };
    let settled = false;
    let committed = false;
    let resolveCompletion!:()=>void;
    const completion = new Promise<void>(resolve=>{resolveCompletion=resolve;});
    input.retain(completion);
    const finish = async () => {
      if (settled) return; settled=true;
      for(const frame of [...frames].reverse())await closeFrame(frame,committed);
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
      if (analyzeExpressionDependencies({request:route.request,selection:resolveReachableEndpoints(effective,config.services).map(e=>e.condition),hash:effective.load_balancing?.hash_policy?.expression,rate:route.rate_limit?.key_expression},'request').requestBody || hasBodyModification(route.request?.body)) return reject(422,'websocket_body_rules_unsupported');
      const rate = requireGatewayResult(await gatewayHooks().onGatewayAdmission.promise({route,trustedPeer:getTrustedWorkerPeer(request),context:expressionContext(),servingRevision,signal}),'onGatewayAdmission');
      if (!rate.allowed) return {response:Response.json({error:rate.retryAfterMs===undefined?'rate_limit_unavailable':'rate_limited'},{status:rate.retryAfterMs===undefined?503:429,
        headers:rate.retryAfterMs===undefined?{}:{'retry-after':String(Math.max(1,Math.ceil(rate.retryAfterMs/1000)))}})};
      const sessionMode=await registry?.getRoutePrecompiledHooks(route.path)?.hooks.onWebSocketSessionMode.promise(new URL(request.url));
      if(sessionMode==='responses'){
        for(const owner of registry?.getRoutePluginOwners(route.path) ?? [])retain(owner.pluginName,owner.scopeKey);
        const handlers=registry?.getGlobalAdmissionHandlers() ?? [];
        if(identity && hasWorkerAdmissionSession()){
          for(const handler of handlers)retain(handler.pluginName);
          admission=requireGatewayResult(await gatewayHooks().onGatewayAdmissionSession.promise({handlers,identity:{requestId:connectionId,principal:identity.principal,routeId:route.id ?? route.path,
            serviceId:null},
            invoke:(plugin,method,payload,target)=>registry!.invokeAdmissionRpc(plugin,method,payload,target,leases.get(`${plugin}\0global`)!)}),'onGatewayAdmissionSession');
          const endpoint=resolveReachableEndpoints(effective,config.services)[0];
          if(!endpoint)return reject(503,'upstream_unavailable');
          await admission.prepare({attemptId:connectionId,upstreamId:endpoint.id ?? '0',url:endpoint.target,model:null,body:undefined,transport:'websocket'},signal);
        }
        const session=new ResponsesWebSocketSession(input,gatewayHooks());
        const response=await bridge.upgradeSession(nativeRequest,server,{signal,onMessage:(transport,message)=>session.onMessage(transport,message),onClose:async()=>{session.dispose();await finish();}});
        if(response){session.dispose();return {response};}
        committed=true;return {};
      }
      const handlers=registry?.getGlobalAdmissionHandlers() ?? [];
      if(identity && hasWorkerAdmissionSession()){
        for(const handler of handlers)retain(handler.pluginName);
        admission=requireGatewayResult(await gatewayHooks().onGatewayAdmissionSession.promise({handlers,identity:{requestId:connectionId,principal:identity.principal,routeId:route.id ?? route.path,serviceId:null},
          invoke:(plugin,method,payload,target)=>registry!.invokeAdmissionRpc(plugin,method,payload,target,leases.get(`${plugin}\0global`)!)}),'onGatewayAdmissionSession');
      }
      const budget=new PhysicalRequestBudget(config,effective,signal);
      let handshake:WebSocketHandshakeContext={connectionId,routeId:route.path,upstreamId:'',url:new URL(url),headers:new Headers(headers),signal};
      for(const owner of registry?.getRoutePluginOwners(route.path) ?? [])retain(owner.pluginName,owner.scopeKey);
      const routePhase=registry?.getPrecompiledHooks(route.path).routePhase;
      if(routePhase){const run=()=>routePhase.hooks.onWebSocketHandshake.promise(handshake);handshake=registry?await registry.runWithRequestLeases(leases,run):await run();}
      const contextFor=(context:WebSocketHandshakeContext):ExpressionContext=>({headers:headerRecord(context.headers),body:undefined,request:{headers:headerRecord(context.headers)},
        url:{pathname:context.url.pathname,search:context.url.search,host:context.url.host,protocol:context.url.protocol},method:'GET',env:process.env as Record<string,string>});
      const dial=async(layer:EffectiveRouteConfig,parent:WebSocketHandshakeContext,ids:string[]):Promise<Response|undefined>=>{
        const upstreams=layerEndpoints(layer);
        const coordinator=requireGatewayResult(await gatewayHooks().onGatewayFailover.promise({upstreams,references:layerReferences(config,layer),
          route:layer,recoveryIntervalMs:layer.failover?.recovery?.backoff_base_ms ?? 5000,context:contextFor(parent)}),'onGatewayFailover');
        let last:Response|undefined;
        while(coordinator.hasNext()){
          signal.throwIfAborted();
          const selected=requireGatewayResult(await gatewayHooks().onGatewaySelect.promise({upstreams,route:layer,context:contextFor(parent),coordinator}),'onGatewaySelect');
          if(!selected.upstream && !selected.reference)break;
          let frame:typeof frames[number]|undefined;
          let release:()=>void=()=>{};
          try{
            let current:WebSocketHandshakeContext={...parent,url:new URL(parent.url),headers:new Headers(parent.headers)};
            if(selected.reference){
              const reference=selected.reference;const service=serviceById(config,reference.service_id);
              if(ids.includes(service.id))throw new DataAdmissionError(422,'service_reference_cycle');
              const phase=registry?.getPrecompiledHooks(route.path,undefined,service.id).servicePhase ?? null;
              for(const owner of registry?.getServicePluginOwners?.(route.path,service.id) ?? [])retain(owner.pluginName,owner.scopeKey);
              const key=layer.state_key ?? layer.path;incrementActiveRequests(key,reference.id);
              frame={phase,id:service.id,kind:'service',release:()=>decrementActiveRequests(key,reference.id),closed:false};frames.push(frame);
              if(phase){const run=()=>phase.hooks.onWebSocketHandshake.promise(current);current=registry?await registry.runWithRequestLeases(leases,run):await run();}
              last=await dial(serviceLayer(layer,service),current,[...ids,service.id]);
            }else{
              const upstream=selected.upstream!;
              if(selected.shouldTransitionToHalfOpen)upstream.status='HALF_OPEN';
              const stateKey=layer.state_key ?? layer.path;incrementActiveRequests(stateKey,upstream.upstream_id);
              let released=false;release=()=>{if(released)return;released=true;decrementActiveRequests(stateKey,upstream.upstream_id);releaseHalfOpenSlot(stateKey,upstream.upstream_id);};
              const rules=deepMergeRules(route.request ?? {},upstream.request ?? {});
              if(hasBodyModification(rules.body)||analyzeExpressionDependencies(rules,'request').requestBody)throw new DataAdmissionError(422,'websocket_body_rules_unsupported');
              await gatewayHooks().onGatewayHeaderRules.promise(current.headers,rules.headers,contextFor(current));
              current.url.search=requireGatewayResult(await gatewayHooks().onGatewayQueryRules.promise(current.url.searchParams,rules.query,contextFor(current),{}),'onGatewayQueryRules').toString();
              rebaseToUpstream({url:current.url,method:'GET',headers:headerRecord(current.headers)},upstream);
              current={...current,upstreamId:upstream.upstream_id};
              const owners=registry?.getWebSocketOwners(route.path,upstream.upstream_id,ids) ?? [];
              for(const owner of [...owners,...(registry?.getWebSocketHandshakeOwners(route.path,upstream.upstream_id,ids) ?? []),...(registry?.getBoundControlOwners(route.path,upstream.upstream_id) ?? [])])retain(owner.pluginName,owner.scopeKey);
              const phase=registry?.getPrecompiledHooks(route.path,upstream.upstream_id,ids).upstreamPhase ?? null;
              frame={phase,id:upstream.upstream_id,kind:'endpoint',release,closed:false};frames.push(frame);
              if(phase){const run=()=>phase.hooks.onWebSocketHandshake.promise(current);current=registry?await registry.runWithRequestLeases(leases,run):await run();}
              await admission?.prepare({attemptId:connectionId,upstreamId:upstream.upstream_id,url:current.url.href,model:null,body:undefined,transport:'websocket',serviceId:ids.at(-1) ?? null},signal);
              const acquire=()=>websocketCredential(upstream,current.url,current.headers,servingRevision,connectionId,signal);
              const outbound=registry?await registry.runWithRequestLeases(leases,acquire):await acquire();
              const target=new URL(current.url);
              if(!['http:','https:','ws:','wss:'].includes(target.protocol)||target.username||target.password||target.hash)throw new DataAdmissionError(422,'websocket_target_invalid');
              target.protocol=target.protocol==='https:'?'wss:':target.protocol==='http:'?'ws:':target.protocol;
              const attemptObservers=new WebSocketObservers({connectionId,keyId:identity?.principal.domain==='data'?identity.principal.keyId:null,routeId:route.path,
                upstreamId:upstream.upstream_id,upstreamUrl:current.url.href.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),servingRevision},owners);
              budget.take();
              last=await bridge.upgrade(nativeRequest,server,{url:target,headers:outbound,signal,
                onOpen:()=>attemptObservers.emit({phase:'open'}),
                onMessage:(direction,message)=>attemptObservers.emit({phase:'message',direction,message}),
                onClose:async(code,reason,metrics)=>{try{await attemptObservers.close({phase:'close',code,reason,metrics});}finally{await finish();}}});
            }
            if(!last)return undefined;
            release();if(frame)await closeFrame(frame,false);
            const retry=layer.failover?.enabled && layer.failover.retry_on && createStatusCodeMatcher(layer.failover.retry_on)(last.status);
            if(!retry||!coordinator.hasNext())return last;
            await last.body?.cancel();
          }catch(error){
            release();if(frame)await closeFrame(frame,false);
            const admissionError=normalizeAdmissionError(error);
            if(admissionError)throw admissionError;
            if(signal.aborted||!layer.failover?.enabled||!(isUpstreamNetworkError(error)||isUpstreamTimeoutError(error)))throw error;
            if(!coordinator.hasNext())throw error;
          }
        }
        return last ?? Response.json({error:'upstream_unavailable'},{status:503});
      };
      const response=await dial(effective,handshake,[]);
      if(response)return {response};
      committed=true;return {};
    } catch (error) {
      const admissionError=normalizeAdmissionError(error);
      return reject(admissionError?.status ?? 502,admissionError?.code ?? 'websocket_handshake_failed');
    } finally {
      // Successful upgrade transfers ownership to native close + observation cleanup.
      if (!committed) await finish();
    }

  }
}
