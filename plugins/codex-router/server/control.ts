import type { ControlHostContext, PluginControl, ControlPlugin } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION, type ModelsDevCatalogService, type ModelsDevCapabilitiesService } from '../../models-dev/contract';
export function createControl(host: ControlHostContext): PluginControl {
  return {
    rpc:[], start() {}, async dispose() {},
    api:[{path:'/catalog', methods:['GET'], handler:'getCatalog', invoke:async ({request}) => {
      if (host.signal.aborted) return Response.json({error:'inactive'},{status:503});
      const params = new URL(request.url).searchParams;
      const page = Number(params.get('page') ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 400
        || ['provider','search','page'].some(key => params.getAll(key).length > 1 || (params.get(key)?.length ?? 0) > 512)) return Response.json({error:'invalid_query'},{status:400});
      const catalog = host.services!.consume<ModelsDevCatalogService>('models-dev',MODELS_DEV_CATALOG_SERVICE_ID,MODELS_DEV_CATALOG_CONTRACT_VERSION);
      const capabilities = host.services!.consume<ModelsDevCapabilitiesService>('models-dev',MODELS_DEV_CAPABILITIES_SERVICE_ID,MODELS_DEV_CAPABILITIES_CONTRACT_VERSION);
      const result = catalog.modelOptions({provider:params.get('provider') ?? undefined,search:params.get('search') ?? undefined,page,pageSize:50});
      return Response.json({...result,providers:catalog.providers(),status:catalog.status(),models:result.models.map(model => ({...model,capabilities:capabilities.model(model)}))});
    }}],
  };
}
export default {createControl} satisfies ControlPlugin;
