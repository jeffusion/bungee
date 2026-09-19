import { PLUGIN_CONTROL_HTTP_PATH } from '../plugin-control/http-protocol';
import {
  DAEMON_CONTROL_HTTP_PREFIX,
  DAEMON_SHUTDOWN_PATH,
  type DaemonControlRequestContext,
  type DaemonShutdownHandler,
} from '../daemon-control';

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const;

export type ManagementControlApi = {
  handle(request: Request): Promise<Response | null>;
};

export type InternalPluginControlHandler = {
  handle(request: Request): Promise<Response>;
};
export type MasterUIHandler = (request: Request) => Promise<Response | null>;

export type ManagementListenerOptions = {
  readonly controlApi: ManagementControlApi;
  readonly hostname: string;
  readonly port: number;
  readonly shutdownTimeoutMs?: number;
  readonly internalPluginControl?: InternalPluginControlHandler;
  readonly masterUIHandler?: MasterUIHandler;
  readonly daemonControl?: DaemonShutdownHandler;
  readonly onResponseSettlementError?: (error: unknown) => void;
};

export interface ManagementListener {
  readonly port: number | null;
  readonly hostname: string | null;
  start(): void;
  ready(): void;
  stopAccepting(): void;
  stop(): Promise<void>;
}

export class ManagementListenerLifecycleError extends Error {
  readonly name = 'ManagementListenerLifecycleError';
}

function reportSettlementError(error: unknown, reporter?: (error: unknown) => void): void {
  if (reporter !== undefined) {
    try {
      reporter(error);
      return;
    } catch {
      // Fall through to a safe warning when the error reporter itself fails.
    }
  }
  process.emitWarning('management response-settlement callback failed', {
    code: 'BUNGEE_RESPONSE_SETTLEMENT_CALLBACK',
  });
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}

function isReservedDaemonPath(pathname: string): boolean {
  const internalPrefix = '/__bungee/internal/';
  if (!pathname.startsWith(internalPrefix)) return false;
  const remainder = pathname.slice(internalPrefix.length);
  let decoded: string;
  try { decoded = decodeURIComponent(remainder); }
  catch { return true; }
  return decoded === 'daemon' || decoded.startsWith('daemon/')
    || /^(?:d|%64)(?:a|%61)(?:e|%65)(?:m|%6d)(?:o|%6f)(?:n|%6e)(?:\/|%2f|$)/i.test(decoded);
}

export function trackManagementResponse(response: Response, settle: () => void): Response {
  if (response.body === null) {
    settle();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        settle();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { settle(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function mergeManagementRequestSignals(requestSignal: AbortSignal, shutdownSignal: AbortSignal): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([requestSignal, shutdownSignal]), dispose() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener('abort', abort, { once: true });
  shutdownSignal.addEventListener('abort', abort, { once: true });
  if (requestSignal.aborted || shutdownSignal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose() {
      requestSignal.removeEventListener('abort', abort);
      shutdownSignal.removeEventListener('abort', abort);
    },
  };
}

export async function handleManagementRequest(
  request: Request,
  options: Pick<ManagementListenerOptions, 'controlApi' | 'internalPluginControl' | 'masterUIHandler' | 'daemonControl'>,
  context?: DaemonControlRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (isReservedDaemonPath(url.pathname)) {
    if (url.pathname !== DAEMON_SHUTDOWN_PATH || options.daemonControl === undefined) return notFound();
    return options.daemonControl.handle(request, context);
  }
  if (url.pathname === PLUGIN_CONTROL_HTTP_PATH) {
    return options.internalPluginControl === undefined
      ? notFound()
      : options.internalPluginControl.handle(request);
  }
  if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response(request.method === 'HEAD' ? null : '{"status":"ok"}', {
      headers: { 'content-type': 'application/json' },
    });
  }
  const handled = await options.controlApi.handle(request);
  if (handled !== null) return handled;
  const uiHandled = await options.masterUIHandler?.(request);
  if (uiHandled !== null && uiHandled !== undefined) return uiHandled;
  return notFound();
}

export function createManagementListener(options: ManagementListenerOptions): ManagementListener {
  if ((options.hostname !== '127.0.0.1' && options.hostname !== '::1') || !Number.isSafeInteger(options.port)
    || options.port < 0 || options.port > 65_535
    || (options.shutdownTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0))) {
    throw new ManagementListenerLifecycleError('management listener address is invalid');
  }
  let server: ReturnType<typeof Bun.serve> | null = null;
  let started = false;
  let accepting = false;
  let stopPromise: Promise<void> | null = null;
  const activeRequests = new Set<AbortController>();
  const drainWaiters = new Set<() => void>();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const waitForDrain = (): Promise<void> => activeRequests.size === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => drainWaiters.add(resolve));

  return {
    get port() { return server?.port ?? null; },
    get hostname() { return server?.hostname ?? null; },
    start() {
      if (started) throw new ManagementListenerLifecycleError('management listener can only start once');
      started = true;
      server = Bun.serve({
        hostname: options.hostname,
        port: options.port,
        reusePort: false,
        fetch: async (request) => {
          if (!accepting) {
            return Response.json({ error: 'service_unavailable' }, { status: 503, headers: JSON_HEADERS });
          }
          const lifetime = new AbortController();
          activeRequests.add(lifetime);
          let released = false;
          const combined = mergeManagementRequestSignals(request.signal, lifetime.signal);
          const release = () => {
            if (released) return;
            released = true;
            activeRequests.delete(lifetime);
            combined.dispose();
            if (activeRequests.size === 0) {
              for (const resolve of drainWaiters) resolve();
              drainWaiters.clear();
            }
          };
          try {
            let settled = false;
            const callbacks = new Set<{
              readonly callback: () => void | Promise<void>;
              readonly onError?: (error: unknown) => void;
            }>();
            const context: DaemonControlRequestContext = {
              onResponseSettled(callback, onError) { callbacks.add({ callback, onError }); },
            };
            const settle = () => {
              if (settled) return;
              settled = true;
              release();
              for (const pending of callbacks) {
                try {
                  const result = pending.callback();
                  void Promise.resolve(result).catch((error) => reportSettlementError(error, pending.onError ?? options.onResponseSettlementError));
                }
                catch (error) {
                  reportSettlementError(error, pending.onError ?? options.onResponseSettlementError);
                }
              }
              callbacks.clear();
            };
            const response = await handleManagementRequest(new Request(request, { signal: combined.signal }), options, context);
            return trackManagementResponse(response, settle);
          } catch (error) {
            release();
            throw error;
          }
        },
      });
    },
    ready() {
      if (!started || server === null) {
        throw new ManagementListenerLifecycleError('management listener must bind before becoming ready');
      }
      accepting = true;
    },
    stopAccepting() {
      accepting = false;
    },
    async stop() {
      if (stopPromise !== null) return stopPromise;
      const current = server;
      server = null;
      accepting = false;
      if (current === null) return;
      stopPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const drained = await Promise.race([
          waitForDrain().then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
        ]);
        if (timer !== null) clearTimeout(timer);
        if (drained) {
          await current.stop(false);
          return;
        }
        drainWaiters.clear();
        for (const request of activeRequests) request.abort('management listener shutdown timeout');
        const forced = current.stop(true);
        let forceTimer: ReturnType<typeof setTimeout> | null = null;
        const forcedCompleted = await Promise.race([
          forced.then(() => true, () => false),
          new Promise<false>((resolve) => { forceTimer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
        ]);
        if (forceTimer !== null) clearTimeout(forceTimer);
        if (!forcedCompleted) throw new ManagementListenerLifecycleError('management listener did not stop after forced shutdown');
      })();
      return stopPromise;
    },
  };
}
