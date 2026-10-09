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
  private catalog!: ModelsDevCapabilitiesService;
  constructor(options?: { models?: unknown }) { this.bindings = parseBindings(options?.models); }
  async init(context: PluginInitContext) {
    if (context.scope?.type !== 'route') throw new Error('codex_router_requires_route_scope');
    this.catalog = context.services!.consume('models-dev', MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION);
  }
  bodyRequirements(context: { method: string; url: URL }) {
    return {request:context.method === 'POST' && /\/responses$/.test(context.url.pathname) ? 'json-write' as const : 'none' as const, response: context.method === 'GET' && /\/models$/.test(context.url.pathname) ? ['json' as const] : []};
  }
  register(hooks: PluginHooks) {
    hooks.onDispatchRequest.tap('codex-router.binding', ({context,targets}) => {
      if (context.method !== 'POST' || !/\/responses$/.test(context.originalUrl.pathname)) return;
      const binding = this.bindings.find(binding => (binding.alias ?? binding.model) === context.body?.model);
      if (!binding) return;
      const target = targets.find(target => target.type === binding.target.type && target.id === binding.target.id);
      if (!target?.protocol) throw new DataAdmissionError(422,'codex_router_target_protocol_required');
      if (target.protocol !== 'responses') throw new DataAdmissionError(422,'codex_router_protocol_not_ready');
      context.body = {...context.body,model:binding.model};
      return {target:binding.target};
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
      const body = mergeCatalog(native, this.bindings, this.catalog);
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
