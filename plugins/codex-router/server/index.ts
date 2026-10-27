import {createHash} from 'node:crypto';
import {ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,CONVERSION_VERSION,historyRpc,historyClient,type HistoryClient,type ConversionService,type CollaborationRelay} from '../../llm-protocol-adapter/contract';
import {protocolAdapter} from './protocol';
import { definePlugin, DataAdmissionError, type Plugin, type PluginInitContext, type PluginHooks, type DispatchRequestPreparationInput } from '@jeffusion/bungee-core/plugin';
import manifest from '../manifest.json';
import type { PluginConfigField } from '@jeffusion/bungee-core/plugin';
import { parseBindings, parseCollaborationRelay, bindingSource } from './config';
import { mergeCatalog, catalogEtag, CatalogSnapshots, type CatalogSnapshot } from './catalog';
import { catalogValidatorsClient } from '../contract';
import { catalogKeys } from './catalog-validators';

export const CodexRouterPlugin = definePlugin(class implements Plugin {
  static readonly name = 'codex-router';
  static readonly version = '1.0.0';
  static readonly configSchema = manifest.configSchema as unknown as PluginConfigField[];
  private readonly bindings;
  private readonly relay?:CollaborationRelay;
  private history!:HistoryClient;
  private validators?: ReturnType<typeof catalogValidatorsClient>;
  private readonly catalogRequests = new Map<string, {key: string; snapshotKey: string; signal: AbortSignal; snapshot?: CatalogSnapshot}>();
  private readonly snapshots = new CatalogSnapshots();
  private conversion!:ConversionService;
  constructor(options?: { models?: unknown; collaborationRelay?: unknown }) { this.bindings = parseBindings(options?.models); this.relay = parseCollaborationRelay(options?.collaborationRelay); }
  async init(context: PluginInitContext) {
    if (context.scope?.type !== 'route') throw new Error('codex_router_requires_route_scope');
    this.history=historyClient(context.services!.rpc!.consume(ADAPTER_PLUGIN,historyRpc));
    this.conversion=context.services!.consume(ADAPTER_PLUGIN,CONVERSION_SERVICE_ID,CONVERSION_VERSION);
    try { this.validators = catalogValidatorsClient(context.services!); } catch { /* Optional notification state must not block generation. */ }
    context.services!.onDispose?.(() => { this.catalogRequests.clear(); this.snapshots.clear(); });
  }
  bodyRequirements(context: { method: string; url: URL }) {
    return {request:context.method === 'POST' && /\/responses$/.test(context.url.pathname) ? 'json-write' as const : 'none' as const, response: context.method === 'GET' && /\/models$/.test(context.url.pathname) ? ['json' as const] : []};
  }
  register(hooks: PluginHooks) {
    hooks.onWebSocketSessionMode.tap('codex-router.session', url => /\/responses$/.test(url.pathname) ? 'responses' : undefined);
    hooks.onDispatchRequest.tap('codex-router.catalog-identity', input => {
      const keys = catalogKeys(input, this.bindings);
      if (keys) this.catalogRequests.set(input.context.requestId, {key: keys.validator, snapshotKey: keys.snapshot, signal: input.signal});
    });
    hooks.onDispatchRequest.tapPromise('codex-router.binding', async ({context,targets}) => {
      if (context.method !== 'POST' || !/\/responses$/.test(context.originalUrl.pathname)) return;
      const binding = this.bindings.find(binding => bindingSource(binding) === context.body?.model);
      if (!binding) return;
      // The final route does not run entry finally hooks. Transfer ownership to
      // the per-request dispatch adapter before validation/preparation can fail.
      const notification = this.catalogRequests.get(context.requestId);
      this.catalogRequests.delete(context.requestId);
      if (!targets.some(target => target.type === binding.target.type && target.id === binding.target.id)) throw new DataAdmissionError(422,'codex_router_target_unavailable');
      const protocol = binding.target.protocol;
      const capabilities=this.conversion.resolveCapabilities({provider:binding.provider,model:binding.model,targetProtocol:protocol,restrictions:binding.capabilityOverrides});
      if(!capabilities || capabilities.contextWindow === null || !capabilities.inputModalities.includes('text'))throw new DataAdmissionError(503,'codex_router_model_unavailable');
      context.body={...context.body,model:binding.model};
      return {target:binding.target,protocol,prepareRequest:async ({context,principal,servingRevision,signal,executeAuxiliary,webSocketConnection}:DispatchRequestPreparationInput)=>{
      const entryScope=createHash('sha256').update(JSON.stringify([context.routeId,servingRevision ?? null,this.bindings,this.relay])).digest('hex');
      const scope=principal?.domain !== 'anonymous' && principal?.keyId ? createHash('sha256').update(JSON.stringify([principal,entryScope])).digest('hex') : null;
      let input=structuredClone(context.body);
      let requiredUpstreamId:string|undefined;
      let opaqueRestored=false;
      if(input.previous_response_id){
        if(!scope)throw new DataAdmissionError(422,'codex_router_history_identity_required');
        const prior=await this.history.get({scope,id:input.previous_response_id},{signal});
        if(!prior)throw new DataAdmissionError(422,'codex_router_history_missing_start_new_conversation');
        const delta=typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
        if(!Array.isArray(delta))throw new DataAdmissionError(422,'codex_router_invalid_history');
        if(protocol!=='gemini_generate_content' && prior.items.some((item:any)=>item.encrypted_content || item.type==='compaction')){
          if(protocol!=='responses' || JSON.stringify(prior.target)!==JSON.stringify(binding.target) || prior.origin?.provider!==binding.provider || prior.origin?.model!==binding.model || !prior.origin?.upstreamId)throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
          requiredUpstreamId=prior.origin.upstreamId;opaqueRestored=true;
        }
        input.input=[...prior.items,...delta];delete input.previous_response_id;
      }
      if(input.conversation || input.response_id)throw new DataAdmissionError(422,'codex_router_unsupported_history_reference');
      input.model=binding.model;
      let logicalInput=typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
      if(!Array.isArray(logicalInput))throw new DataAdmissionError(422,'codex_router_invalid_history');
      if(protocol!=='responses' && protocol!=='gemini_generate_content' && !opaqueRestored && logicalInput.some((item:any)=>item?.encrypted_content || item?.type==='compaction'))throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
      const hasTools=input.tools?.length || logicalInput.some((item:any)=>item?.type==='additional_tools' && item.tools?.length);
      if(hasTools && (!capabilities.toolCall || binding.capabilityOverrides?.tools===false))throw new DataAdmissionError(422,'codex_router_tools_unsupported');
      let relayDiagnostics:any[]=[];
      if(protocol!=='responses') {
        try {
          const inspected=this.conversion.inspectAgentMessages(input);
          for(const message of inspected.messages)if(message.encryptedContents.length>1)throw new DataAdmissionError(422,'llm_adapter_agent_message_multiple_encrypted_blocks',undefined,{param:message.encryptedContents[1].param,message:'Multiple encrypted agent blocks cannot be restored losslessly'});
          const replacements=[];
          for(const message of inspected.messages)for(const encrypted of message.encryptedContents) {
            if(!this.relay)throw new DataAdmissionError(422,'llm_adapter_agent_message_relay_required',undefined,{param:encrypted.param,message:'Encrypted agent content requires a configured relay'});
            const text=await this.conversion.relayAgentMessage({message:input.input[message.inputIndex],contentIndex:encrypted.contentIndex,param:encrypted.param,relay:this.relay,entryScope,scope,requestId:context.requestId,signal,executeAuxiliary,webSocketConnection});
            replacements.push({param:encrypted.param,text});
          }
          if(replacements.length){const replaced=this.conversion.replaceAgentMessageEncryptedContent(input,replacements);input=replaced.body;relayDiagnostics=replaced.diagnostics;}
        } catch(error) {const e=error as any;if(typeof e.code==='string' && e.name!=='DataAdmissionError')throw new DataAdmissionError(422,`llm_adapter_${e.code}`,undefined,{message:'Agent message cannot be converted',param:e.param});throw error;}
      }
      let diagnostics;
      let session;
      try {session=this.conversion.createSession({sourceProtocol:'responses',targetProtocol:protocol,model:binding.model,responseModel:bindingSource(binding),provider:binding.provider,profile:capabilities,restrictions:binding.capabilityOverrides,selectedEffort:input.reasoning?.effort,...(protocol!=='responses'?{agentMessageDelivery:'plaintext' as const}:{})});} catch(error) {const e=error as any;if(typeof e.code==='string')throw new DataAdmissionError(422,`llm_adapter_${e.code}`,undefined,{message:e.message,param:e.param});throw error;}
      try {
        const decoded=session.convertRequest(input);context.body=structuredClone(decoded.body);
        if(protocol!=='responses')logicalInput=structuredClone(decoded.canonicalHistory);
        // Host logs may flush after the consumer lease is revoked during drain.
        diagnostics=structuredClone([...relayDiagnostics,...decoded.diagnostics]);
      } catch(error) {session.dispose();const e=error as any;if(typeof e.code==='string')throw new DataAdmissionError(422,`llm_adapter_${e.code}`,undefined,{message:e.message,param:e.param});throw error;}
      const converted=protocolAdapter({session,protocol,model:bindingSource(binding),signal,
        save:async(response,responseContext)=>{if(scope && typeof response.id==='string')await this.history.put({scope,id:response.id,value:{target:binding.target,origin:{provider:binding.provider,model:binding.model,upstreamId:responseContext?.upstreamId},items:[...logicalInput,...response.output]}},{signal,operationId:crypto.randomUUID()});}});
      const adapter: Plugin = {bodyRequirements: converted.bodyRequirements.bind(converted), register: hooks => {
        converted.register(hooks);
        hooks.onRawResponse.tapPromise('codex-router.catalog-notification', async result => {
          await this.rewriteCatalogNotification(result.response, notification);
          return result;
        });
      }};
      return {requiredUpstreamId,adapter,...(protocol!=='responses'?{canonicalInput:logicalInput,diagnostics}:{})};
      }};
    });
    hooks.onBeforeRequest.tap('codex-router.catalog-validator', context => {
      if (context.method === 'GET' && /\/models$/.test(context.originalUrl.pathname)) {
        for (const key of Object.keys(context.headers)) if (['if-none-match','if-modified-since'].includes(key.toLowerCase())) delete context.headers[key];
        const record = this.catalogRequests.get(context.requestId);
        if (record) {
          record.snapshot = this.snapshots.get(record.snapshotKey);
          if (record.snapshot?.upstreamEtag) context.headers['if-none-match'] = record.snapshot.upstreamEtag;
        }
      }
      return context;
    });
    hooks.onInterceptRequest.tapPromise('codex-router.catalog-cache', async context => {
      if (context.method !== 'GET' || !/\/models$/.test(context.originalUrl.pathname)) return;
      const record = this.catalogRequests.get(context.requestId);
      const revalidate = Object.entries(context.headers).some(([key, value]) => key.toLowerCase() === 'cache-control' && /(?:^|,)\s*(?:no-cache|max-age=0)\s*(?:,|$)/i.test(value));
      if (!record?.snapshot || !this.snapshots.fresh(record.snapshot) || revalidate) return;
      const response = await this.catalogResponse(record.snapshot.native, new Headers(), record);
      return {action: 'respond' as const, response};
    });
    hooks.onRawResponse.tapPromise('codex-router.catalog-notification', async (result, context) => {
      if (context.method === 'GET' && /\/models$/.test(context.originalUrl.pathname)) {
        const record = this.catalogRequests.get(context.requestId);
        if (record && [401, 403].includes(result.response.status)) this.snapshots.invalidate(record.snapshotKey);
        if (result.response.status === 304) {
          if (!record?.snapshot?.upstreamEtag) throw new DataAdmissionError(502, 'codex_router_catalog_without_snapshot');
          const headers = new Headers(result.response.headers);
          for (const key of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(key);
          headers.set('content-type', 'application/json');
          headers.set('etag', headers.get('etag') ?? record.snapshot.upstreamEtag);
          return {...result, response: new Response(JSON.stringify(record.snapshot.native), {headers})};
        }
      }
      if (context.method === 'POST' && /\/responses$/.test(context.originalUrl.pathname)) {
        await this.rewriteCatalogNotification(result.response, this.catalogRequests.get(context.requestId));
      }
      return result;
    });
    hooks.onResponse.tapPromise('codex-router.catalog', async (response, context) => {
      const record = this.catalogRequests.get(context.requestId);
      if (context.method !== 'GET' || !/\/models$/.test(context.originalUrl.pathname) || !response.ok) return response;
      const native = await context.bodyHandle!.json({id:'codex-router.catalog',mandatory:true});
      const merged = await this.catalogResponse(native, response.headers, record, response.status);
      if (record && !record.signal.aborted) this.snapshots.put(record.snapshotKey, native, response.headers.get('etag'));
      return merged;
    });
    hooks.onFinally.tap('codex-router.catalog-cleanup', context => { this.catalogRequests.delete(context.requestId); });
  }
  private async catalogResponse(native: unknown, sourceHeaders: Headers, record?: {key: string; signal: AbortSignal}, status = 200) {
    const body = JSON.stringify(mergeCatalog(native, this.bindings, this.conversion));
    const etag = catalogEtag(body);
    const headers = new Headers(sourceHeaders);
    for (const key of ['content-length','content-encoding','etag','last-modified']) headers.delete(key);
    headers.set('content-type', 'application/json');
    headers.set('cache-control', 'private, no-store');
    headers.set('etag', etag);
    if (record && this.validators) {
      try { await this.validators.put({key: record.key, etag}, {signal: record.signal, timeoutMs: 1000, operationId: crypto.randomUUID()}); }
      catch { /* Directory delivery does not depend on transient notification state. */ }
    }
    return new Response(body, {status, headers});
  }
  private async rewriteCatalogNotification(response: Response, record?: {key: string; signal: AbortSignal}) {
    response.headers.delete('x-models-etag');
    if (record && this.validators) {
      try {
        const etag = await this.validators.get({key: record.key}, {signal: record.signal, timeoutMs: 1000});
        if (etag && !record.signal.aborted) response.headers.set('x-models-etag', etag);
      } catch { /* Missing/shared-state failures leave the generation body untouched. */ }
    }
  }
  reset() { this.catalogRequests.clear(); this.snapshots.clear(); }
});
export default CodexRouterPlugin;
