import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  PluginControl,
} from '../../../packages/core/src/plugin-control/contracts';
import {
  getModelMappingCatalogStatus,
  refreshStoredModelMappingCatalog,
} from './catalog';

const API_ROUTES = Object.freeze([
  { path: '/catalog', methods: ['GET'], handler: 'getCatalog' },
  { path: '/catalog/refresh', methods: ['POST'], handler: 'refreshCatalog' },
] as const);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CATALOG_QUERY_BYTES = 512;
const MAX_CATALOG_PAGE = 400;
const queryEncoder = new TextEncoder();

function catalogQuery(request: Request): { provider?: string; search?: string; page: number } | null {
  const params = new URL(request.url).searchParams;
  for (const key of ['provider', 'search', 'page']) {
    if (params.getAll(key).length > 1) return null;
  }
  const provider = params.get('provider') ?? undefined;
  const search = params.get('search') ?? undefined;
  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  if ((provider !== undefined && queryEncoder.encode(provider).byteLength > MAX_CATALOG_QUERY_BYTES)
    || (search !== undefined && queryEncoder.encode(search).byteLength > MAX_CATALOG_QUERY_BYTES)
    || !Number.isSafeInteger(page) || page < 1 || page > MAX_CATALOG_PAGE) return null;
  return { provider, search, page };
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

function errorResponse(_error: unknown): Response {
  return jsonResponse({ error: 'catalog_failed' }, 502);
}

class ModelMappingControl implements PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc = [] as const;
  private disposed = false;
  private refreshInFlight: Promise<unknown> | undefined;
  private readonly disposeController = new AbortController();
  private readonly ownerAbortListener: () => void;

  constructor(private readonly host: ControlHostContext) {
    this.ownerAbortListener = () => { void this.dispose(); };
    if (host.signal.aborted) {
      this.disposed = true;
      this.disposeController.abort('disposed');
    } else {
      host.signal.addEventListener('abort', this.ownerAbortListener, { once: true });
    }
    const invoke = (handler: (context: ControlApiHandlerContext) => Promise<Response>) => async (context: ControlApiHandlerContext) => {
      if (this.disposed || this.host.signal.aborted) return jsonResponse({ error: 'inactive' }, 503);
      try {
        return await handler(context);
      } catch (error) {
        return errorResponse(error);
      }
    };

    this.api = [
      { ...API_ROUTES[0], invoke: invoke((context) => {
        const query = catalogQuery(context.request);
        if (!query) return Promise.resolve(jsonResponse({ error: 'invalid_query' }, 400));
        return getModelMappingCatalogStatus(context.storage, query).then(jsonResponse);
      }) },
      { ...API_ROUTES[1], invoke: invoke((context) => this.refresh(context.storage).then(jsonResponse)) },
    ];
  }

  start(): void {
    if (this.host.signal.aborted) throw new Error('inactive');
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeController.abort('disposed');
      this.host.signal.removeEventListener('abort', this.ownerAbortListener);
    }
    const refresh = this.refreshInFlight;
    if (refresh !== undefined) await refresh.then(() => undefined, () => undefined);
  }

  private refresh(storage: ControlHostContext['storage']): Promise<unknown> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    const ownerSignal = AbortSignal.any([this.host.signal, this.disposeController.signal]);
    const refresh = refreshStoredModelMappingCatalog(storage, ownerSignal).finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }
}

export function createControl(context: ControlHostContext): PluginControl {
  return new ModelMappingControl(context);
}

export default { createControl } satisfies ControlPlugin;
