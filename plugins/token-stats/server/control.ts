import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  PluginControl,
} from '../../../packages/core/src/plugin-control/contracts';
import { MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_SOURCE_URL, type ModelsDevCatalogService } from '../../models-dev/contract';
import {
  MAX_CLIENT_MODEL_PAGE,
  MAX_CLIENT_MODEL_PAGE_SIZE,
  TokenStatsRepository,
  TokenStatsRepositoryError,
  TokenStatsRepositoryLimitError,
  type AggregateDto,
  type GroupByDimension,
} from './repository';
import { TOKEN_STATS_RANGES } from '../../../packages/core/src/token-stats-window';
import { parsePriceModelMappings, isUnchangedPriceModelMapping, type PriceModelOption } from './model-mappings';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PAGE_STATS_RESPONSE_BYTES = 4 * 1024 * 1024;
const VALID_GROUP_BY = ['model', 'time'] as const;

type ControlErrorCode =
  | 'disposed'
  | 'request_cancelled'
  | 'invalid_input'
  | 'invalid_persisted_value'
  | 'response_limit'
  | 'catalog_unavailable'
  | 'storage_unavailable'
  | 'internal_error';

class ControlError extends Error {
  constructor(readonly code: ControlErrorCode) {
    super(code);
    this.name = 'TokenStatsControlError';
  }
}

function jsonResponse(value: unknown, status = 200, maxBytes = MAX_RESPONSE_BYTES): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    return new Response(JSON.stringify({ error: 'response_limit' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(error: unknown): Response {
  const code = error instanceof ControlError
    ? error.code
    : error instanceof TokenStatsRepositoryLimitError
      ? 'response_limit'
    : error instanceof TokenStatsRepositoryError
      ? 'invalid_persisted_value'
      : 'internal_error';
  const status = code === 'request_cancelled' || code === 'invalid_input' ? 400
    : code === 'disposed' ? 409
    : code === 'catalog_unavailable' || code === 'storage_unavailable' ? 503
    : 500;
  return jsonResponse({ error: code }, status);
}

async function readSettings(request: Request, maxBytes = 4096): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ControlError('invalid_input');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ControlError('invalid_input'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

function abortable<T>(promise: Promise<T>, requestSignal: AbortSignal, hostSignal: AbortSignal): Promise<T> {
  if (hostSignal.aborted) return Promise.reject(new ControlError('disposed'));
  if (requestSignal.aborted) return Promise.reject(new ControlError('request_cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      requestSignal.removeEventListener('abort', onRequestAbort);
      hostSignal.removeEventListener('abort', onHostAbort);
    };
    const onRequestAbort = () => { if (!settled) { settled = true; cleanup(); reject(new ControlError('request_cancelled')); } };
    const onHostAbort = () => { if (!settled) { settled = true; cleanup(); reject(new ControlError('disposed')); } };
    requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    hostSignal.addEventListener('abort', onHostAbort, { once: true });
    promise.then(
      (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } },
      (error) => { if (!settled) { settled = true; cleanup(); reject(error); } },
    );
  });
}

function parseModelQuery(request: Request): { provider?: string; search?: string; page?: number; pageSize?: number } | null {
  const params = new URL(request.url).searchParams;
  for (const key of ['provider', 'search', 'page', 'pageSize']) if (params.getAll(key).length > 1) return null;
  const provider = params.get('provider') ?? undefined;
  const search = params.get('search') ?? undefined;
  const page = params.get('page') === null ? 1 : Number(params.get('page'));
  const pageSize = params.get('pageSize') === null ? 50 : Number(params.get('pageSize'));
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_CLIENT_MODEL_PAGE_SIZE) return null;
  return { ...(provider === undefined ? {} : { provider }), ...(search === undefined ? {} : { search }), page, pageSize };
}

class TokenStatsControl implements PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc = [] as const;
  private readonly repository: TokenStatsRepository;
  private disposed = false;
  private readonly abortListener: () => void;

  constructor(private readonly host: ControlHostContext) {
    this.repository = new TokenStatsRepository(host.storage);
    this.abortListener = () => { this.dispose(); };
    if (host.signal.aborted) this.disposed = true;
    else host.signal.addEventListener('abort', this.abortListener, { once: true });
    this.api = this.buildApi();
  }

  private assertAlive(signal?: AbortSignal): void {
    if (this.disposed || this.host.signal.aborted) throw new ControlError('disposed');
    if (signal?.aborted) throw new ControlError('request_cancelled');
  }

  private catalogService(): ModelsDevCatalogService {
    const services = this.host.services;
    if (services === undefined) throw new ControlError('catalog_unavailable');
    try {
      return services.consume<ModelsDevCatalogService>(
        'models-dev', MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION,
      );
    } catch { throw new ControlError('catalog_unavailable'); }
  }

  private buildApi(): readonly ControlApiDeclaration[] {
    const invoke = (handler: (context: ControlApiHandlerContext) => Promise<Response> | Response) =>
      async (context: ControlApiHandlerContext): Promise<Response> => {
        try {
          this.assertAlive(context.requestSignal);
          return await handler(context);
        } catch (error) {
          return errorResponse(error);
        }
      };

    return [{
      path: '/stats', methods: ['GET'], handler: 'getStats',
      invoke: invoke(async (context) => {
        if (context.request.method !== 'GET') {
          return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
            status: 405,
            headers: { allow: 'GET', 'content-type': 'application/json; charset=utf-8' },
          });
        }
        this.assertAlive(context.requestSignal);
        const url = new URL(context.request.url);
        const rawRange = url.searchParams.get('range');
        const rawGroupBy = url.searchParams.get('groupBy');
        const timeZone = url.searchParams.get('timeZone') ?? undefined;
        const keyId = url.searchParams.get('keyId') ?? undefined;
        if (url.searchParams.getAll('range').length > 1
          || url.searchParams.getAll('groupBy').length > 1
          || url.searchParams.getAll('timeZone').length > 1
          || url.searchParams.getAll('keyId').length > 1
          || (keyId !== undefined && (!keyId || keyId.length > 128))
          || (rawRange !== null && !(TOKEN_STATS_RANGES as readonly string[]).includes(rawRange))
          || (rawGroupBy !== null && !(VALID_GROUP_BY as readonly string[]).includes(rawGroupBy))) {
          throw new ControlError('invalid_input');
        }
        if (timeZone !== undefined) {
          try {
            if (!timeZone || timeZone.length > 100) throw new Error('invalid time zone');
            new Intl.DateTimeFormat('en-US', { timeZone });
          } catch { throw new ControlError('invalid_input'); }
        }
        const range = rawRange ?? '24h';
        const groupBy = (rawGroupBy ?? 'model') as GroupByDimension;
        const payload = await abortable(
          this.repository.query(range, groupBy, Date.now(), timeZone, keyId),
          context.requestSignal,
          context.signal,
        );
        this.assertAlive(context.requestSignal);
        const maxBytes = ['1h', '12h', '24h'].includes(range) ? MAX_RESPONSE_BYTES : MAX_PAGE_STATS_RESPONSE_BYTES;
        return jsonResponse(payload as AggregateDto, 200, maxBytes);
      }),
    }, {
      path: '/pricing', methods: ['GET'], handler: 'getPricing',
      invoke: invoke(async () => {
        const status = this.catalogService().status();
        return jsonResponse({ ...status, source: MODELS_DEV_SOURCE_URL });
      }),
    }, {
      path: '/pricing/models', methods: ['GET'], handler: 'getPricingModels',
      invoke: invoke(async (context) => {
        const query = parseModelQuery(context.request);
        if (query === null) return jsonResponse({ error: 'invalid_input' }, 400);
        const result = this.catalogService().modelOptions(query);
        const models: PriceModelOption[] = result.models.map(model => ({
          provider: model.provider, providerName: model.providerName, model: model.model, name: model.name,
        }));
        return jsonResponse({ models, total: result.total, page: result.page, pageSize: result.pageSize }, 200, MAX_PAGE_STATS_RESPONSE_BYTES);
      }),
    }, {
      path: '/pricing/mappings', methods: ['GET'], handler: 'getPricingMappings',
      invoke: invoke(async () => jsonResponse({ mappings: await this.repository.mappings() })),
    }, {
      path: '/pricing/mappings', methods: ['PUT'], handler: 'configurePricingMappings',
      invoke: invoke(async (context) => {
        let mappings;
        try { mappings = parsePriceModelMappings(await readSettings(context.request, MAX_RESPONSE_BYTES)); }
        catch { throw new ControlError('invalid_input'); }
        const service = this.catalogService();
        const existing = await this.repository.mappings();
        if (mappings.some(mapping => service.resolveModel({ model: mapping.model, pricingProvider: mapping.provider }) === null
          && !isUnchangedPriceModelMapping(mapping, existing))) throw new ControlError('invalid_input');
        this.assertAlive(context.requestSignal);
        await this.repository.configureMappings(mappings);
        return jsonResponse({ mappings });
      }),
    }, {
      // Deliverable: real client/attempt model names for the free-input picker.
      path: '/models', methods: ['GET'], handler: 'getClientModels',
      invoke: invoke(async (context) => {
        const query = parseModelQuery(context.request);
        if (query === null) return jsonResponse({ error: 'invalid_input' }, 400);
        let page;
        try {
          page = await this.repository.listClientModels({
            ...(query.search === undefined ? {} : { keyword: query.search }),
            page: query.page,
            pageSize: query.pageSize,
          });
        } catch (error) {
          if (error instanceof TokenStatsRepositoryError) throw new ControlError('storage_unavailable');
          throw error;
        }
        this.assertAlive(context.requestSignal);
        return jsonResponse(page);
      }),
    }];
  }

  async start(): Promise<void> {
    this.assertAlive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.signal.removeEventListener('abort', this.abortListener);
  }
}

export function createControl(context: ControlHostContext): PluginControl {
  return new TokenStatsControl(context);
}

export default { createControl } satisfies ControlPlugin;
