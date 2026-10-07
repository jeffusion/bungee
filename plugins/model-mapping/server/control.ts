import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  PluginControl,
} from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CATALOG_SERVICE_ID, type ModelsDevCatalogService } from '../../models-dev/contract';
import { buildModelCatalogStatus, catalogQueryIsValid, type ModelCatalogStatus } from './catalog';

const API_ROUTES = Object.freeze([
  { path: '/catalog', methods: ['GET'], handler: 'getCatalog' },
] as const);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CATALOG_PAGE = 400;

function catalogQuery(request: Request): { provider?: string; search?: string; page: number } | null {
  const params = new URL(request.url).searchParams;
  for (const key of ['provider', 'search', 'page']) {
    if (params.getAll(key).length > 1) return null;
  }
  const provider = params.get('provider') ?? undefined;
  const search = params.get('search') ?? undefined;
  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  const query = { provider, search, page };
  if (page > MAX_CATALOG_PAGE || !catalogQueryIsValid(query)) return null;
  return query;
}

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    return new Response(JSON.stringify({ error: 'response_limit' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

class ModelMappingControl implements PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc = [] as const;
  private disposed = false;
  private readonly abortListener: () => void;

  constructor(private readonly host: ControlHostContext) {
    this.abortListener = () => { void this.dispose(); };
    if (host.signal.aborted) this.disposed = true;
    else host.signal.addEventListener('abort', this.abortListener, { once: true });
    const invoke = (handler: (context: ControlApiHandlerContext) => Promise<Response> | Response) => async (context: ControlApiHandlerContext) => {
      try {
        if (this.disposed || this.host.signal.aborted) return jsonResponse({ error: 'inactive' }, 503);
        return await handler(context);
      } catch {
        return jsonResponse({ error: 'catalog_unavailable' }, 502);
      }
    };
    this.api = [
      { ...API_ROUTES[0], invoke: invoke((context) => {
        const query = catalogQuery(context.request);
        if (!query) return jsonResponse({ error: 'invalid_query' }, 400);
        const services = this.host.services;
        if (services === undefined) return jsonResponse({ error: 'catalog_unavailable' }, 503);
        let service: ModelsDevCatalogService;
        try {
          service = services.consume<ModelsDevCatalogService>(
            'models-dev', MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION,
          );
        } catch { return jsonResponse({ error: 'catalog_unavailable' }, 503); }
        return jsonResponse(buildModelCatalogStatus(service, query) satisfies ModelCatalogStatus);
      }) },
    ];
  }

  start(): void {
    if (this.host.signal.aborted) throw new Error('inactive');
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.host.signal.removeEventListener('abort', this.abortListener);
    }
  }
}

export function createControl(context: ControlHostContext): PluginControl {
  return new ModelMappingControl(context);
}

export default { createControl } satisfies ControlPlugin;
