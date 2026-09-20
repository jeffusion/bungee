import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  PluginControl,
} from '../../../packages/core/src/plugin-control/contracts';
import {
  TokenStatsRepository,
  TokenStatsRepositoryError,
  TokenStatsRepositoryLimitError,
  type AggregateDto,
  type GroupByDimension,
} from './repository';

const MAX_RESPONSE_BYTES = 256 * 1024;
const VALID_RANGES = ['1h', '12h', '24h'] as const;
const VALID_GROUP_BY = ['all', 'route', 'upstream', 'provider'] as const;

type ControlErrorCode =
  | 'disposed'
  | 'request_cancelled'
  | 'invalid_input'
  | 'invalid_persisted_value'
  | 'response_limit'
  | 'internal_error';

class ControlError extends Error {
  constructor(readonly code: ControlErrorCode) {
    super(code);
    this.name = 'TokenStatsControlError';
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
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
  const status = code === 'request_cancelled' || code === 'invalid_input' ? 400 : code === 'disposed' ? 409 : 500;
  return jsonResponse({ error: code }, status);
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
    const onRequestAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new ControlError('request_cancelled'));
      }
    };
    const onHostAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new ControlError('disposed'));
      }
    };

    requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    hostSignal.addEventListener('abort', onHostAbort, { once: true });
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      },
    );
  });
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
      path: '/stats',
      methods: ['GET'],
      handler: 'getStats',
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
        if (url.searchParams.getAll('range').length > 1
          || url.searchParams.getAll('groupBy').length > 1
          || (rawRange !== null && !(VALID_RANGES as readonly string[]).includes(rawRange))
          || (rawGroupBy !== null && !(VALID_GROUP_BY as readonly string[]).includes(rawGroupBy))) {
          throw new ControlError('invalid_input');
        }
        const range = rawRange ?? '24h';
        const groupBy = (rawGroupBy ?? 'all') as GroupByDimension;
        const payload = await abortable(
          this.repository.query(range, groupBy),
          context.requestSignal,
          context.signal,
        );
        this.assertAlive(context.requestSignal);
        return jsonResponse(payload as AggregateDto);
      }),
    }];
  }

  start(): void {
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
