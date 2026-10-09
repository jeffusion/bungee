import {createHash} from 'node:crypto';
import {decodeResponsesRequest,ResponsesCodecError} from '@jeffusion/bungee-llms/plugin-api';
import {historyRpc,historyClient,type HistoryClient} from './history-rpc';
import {protocolAdapter} from './protocol';
import { definePlugin, DataAdmissionError, type Plugin, type PluginInitContext, type PluginHooks } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION, type ModelsDevCapabilitiesService } from '../../models-dev/contract';
import manifest from '../manifest.json';
import type { PluginConfigField } from '@jeffusion/bungee-core/plugin';
import { parseBindings } from './config';
import { mergeCatalog, catalogEtag } from './catalog';

export const CodexRouterPlugin = definePlugin(class implements Plugin {
  static readonly name = 'codex-router';
  static readonly version = '1.0.0';
  static readonly configSchema = manifest.configSchema as unknown as PluginConfigField[];
  private readonly bindings;
  private history!:HistoryClient;
  private targets:PluginInitContext['dispatchTargets']=[];
  private catalog!: ModelsDevCapabilitiesService;
  constructor(options?: { models?: unknown }) { this.bindings = parseBindings(options?.models); }
  async init(context: PluginInitContext) {
    if (context.scope?.type !== 'route') throw new Error('codex_router_requires_route_scope');
    this.targets=context.dispatchTargets ?? [];
    this.history=historyClient(context.services!.rpc!.consume('codex-router',historyRpc));
    this.catalog = context.services!.consume('models-dev', MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION);
  }
  bodyRequirements(context: { method: string; url: URL }) {
    return {request:context.method === 'POST' && /\/responses$/.test(context.url.pathname) ? 'json-write' as const : 'none' as const, response: context.method === 'GET' && /\/models$/.test(context.url.pathname) ? ['json' as const] : []};
  }
  register(hooks: PluginHooks) {
    hooks.onWebSocketSessionMode.tap('codex-router.session', url => /\/responses$/.test(url.pathname) ? 'responses' : undefined);
    hooks.onDispatchRequest.tapPromise('codex-router.binding', async ({context,targets,principal,servingRevision,signal}) => {
      if (context.method !== 'POST' || !/\/responses$/.test(context.originalUrl.pathname)) return;
      const binding = this.bindings.find(binding => (binding.alias ?? binding.model) === context.body?.model);
      if (!binding) return;
      const target = targets.find(target => target.type === binding.target.type && target.id === binding.target.id);
      if (!target?.protocol) throw new DataAdmissionError(422,'codex_router_target_protocol_required');
      const capabilities=this.catalog.model(binding);
      if(!capabilities)throw new DataAdmissionError(503,'codex_router_model_unavailable');
      const scope=principal?.domain !== 'anonymous' && principal?.keyId ? createHash('sha256').update(JSON.stringify([principal,context.routeId,servingRevision ?? null,this.bindings])).digest('hex') : null;
      const input=structuredClone(context.body);
      let requiredUpstreamId:string|undefined;
      let opaqueRestored=false;
      if(input.previous_response_id){
        if(!scope)throw new DataAdmissionError(422,'codex_router_history_identity_required');
        const prior=await this.history.get({scope,id:input.previous_response_id},{signal});
        if(!prior)throw new DataAdmissionError(422,'codex_router_history_missing_start_new_conversation');
        const delta=typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
        if(!Array.isArray(delta))throw new DataAdmissionError(422,'codex_router_invalid_history');
        if(prior.items.some((item:any)=>item.encrypted_content || item.type==='compaction')){
          if(target.protocol!=='responses' || JSON.stringify(prior.target)!==JSON.stringify(binding.target) || prior.origin?.provider!==binding.provider || prior.origin?.model!==binding.model || !prior.origin?.upstreamId)throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
          requiredUpstreamId=prior.origin.upstreamId;opaqueRestored=true;
        }
        input.input=[...prior.items,...delta];delete input.previous_response_id;
      }
      if(input.conversation || input.response_id)throw new DataAdmissionError(422,'codex_router_unsupported_history_reference');
      input.model=binding.model;
      const logicalInput=typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
      if(!Array.isArray(logicalInput))throw new DataAdmissionError(422,'codex_router_invalid_history');
      if(!opaqueRestored && logicalInput.some((item:any)=>item?.encrypted_content || item?.type==='compaction'))throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
      if(input.tools?.length && (!capabilities.toolCall || binding.capabilityOverrides?.tools===false))throw new DataAdmissionError(422,'codex_router_tools_unsupported');
      let toolNames;
      if(target.protocol!=='responses'){
        try {
          const decoded=decodeResponsesRequest(input,target.protocol,{omitOptionalWebSearch:true,reasoningEffort:capabilities.reasoning && binding.capabilityOverrides?.reasoningEffort===true,
            anthropicThinkingBudget:undefined,maxOutputTokens:capabilities.outputLimit ?? undefined});
          context.body=decoded.body;toolNames=decoded.toolNames;
        }catch(error){if(error instanceof ResponsesCodecError)throw new DataAdmissionError(422,`codex_router_${error.code}`);throw error;}
        context.url.pathname=context.url.pathname.replace(/\/responses$/,target.protocol==='chat_completions'?'/chat/completions':'/messages');
      }else context.body=input;
      const adapter=protocolAdapter({protocol:target.protocol==='responses'?undefined:target.protocol,model:binding.alias ?? binding.model,toolNames,signal,
        save:async(response,responseContext)=>{if(scope && typeof response.id==='string')await this.history.put({scope,id:response.id,value:{target:binding.target,origin:{provider:binding.provider,model:binding.model,upstreamId:responseContext?.upstreamId},items:[...logicalInput,...response.output]}},{signal,operationId:crypto.randomUUID()});}});
      return {target:binding.target,requiredUpstreamId,adapter};
    });
    hooks.onBeforeRequest.tap('codex-router.catalog-validator', context => {
      if (context.method === 'GET' && /\/models$/.test(context.originalUrl.pathname)) {
        for (const key of Object.keys(context.headers)) if (['if-none-match','if-modified-since'].includes(key.toLowerCase())) delete context.headers[key];
      }
      return context;
    });
    hooks.onResponse.tapPromise('codex-router.catalog', async (response, context) => {
      if (context.method !== 'GET' || !/\/models$/.test(context.originalUrl.pathname) || !response.ok) return response;
      const native = await context.bodyHandle!.json({id:'codex-router.catalog',mandatory:true});
      const bindings=this.bindings.map(binding=>{
        const protocol=this.targets?.find(target=>target.type===binding.target.type && target.id===binding.target.id)?.protocol;
        return {...binding,capabilityOverrides:{...binding.capabilityOverrides,
          ...(protocol==='anthropic_messages'?{images:false}:{}),
          ...(protocol && protocol!=='responses' ? {reasoning:protocol==='chat_completions' ? binding.capabilityOverrides?.reasoningEffort===true : false}:{}),
        }};
      });
      const body = mergeCatalog(native, bindings, this.catalog);
      const headers = new Headers(response.headers);
      for (const key of ['content-length','content-encoding','etag','last-modified']) headers.delete(key);
      headers.set('content-type','application/json');
      headers.set('cache-control','private, no-store');
      headers.set('etag', catalogEtag(body,this.catalog.status().version,context.originalUrl.searchParams.get('client_version') ?? ''));
      return new Response(JSON.stringify(body), {status:response.status,headers});
    });
  }
});
export default CodexRouterPlugin;
