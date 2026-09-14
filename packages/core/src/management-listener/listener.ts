import { PLUGIN_CONTROL_HTTP_PATH } from '../plugin-control/http-protocol';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

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
};

export interface ManagementListener {
  readonly port: number | null;
  start(): void;
  stopAccepting(): void;
  stop(): Promise<void>;
}

export class ManagementListenerLifecycleError extends Error {
  readonly name = 'ManagementListenerLifecycleError';
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}

function trackResponse(response: Response, release: () => void): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { release(); }
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
  options: Pick<ManagementListenerOptions, 'controlApi' | 'internalPluginControl' | 'masterUIHandler'>,
): Promise<Response> {
  if (new URL(request.url).pathname === PLUGIN_CONTROL_HTTP_PATH) {
    return options.internalPluginControl === undefined
      ? notFound()
      : options.internalPluginControl.handle(request);
  }
  const url = new URL(request.url);
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
  if (options.hostname.length === 0 || !Number.isSafeInteger(options.port)
    || options.port < 0 || options.port > 65_535
    || (options.shutdownTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0))) {
    throw new ManagementListenerLifecycleError('management listener address is invalid');
  }
  let server: ReturnType<typeof Bun.serve> | null = null;
  let started = false;
  let accepting = true;
  let stopPromise: Promise<void> | null = null;
  const activeRequests = new Set<AbortController>();
  const drainWaiters = new Set<() => void>();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const waitForDrain = (): Promise<void> => activeRequests.size === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => drainWaiters.add(resolve));

  return {
    get port() { return server?.port ?? null; },
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
            const response = await handleManagementRequest(new Request(request, { signal: combined.signal }), options);
            return trackResponse(response, release);
          } catch (error) {
            release();
            throw error;
          }
        },
      });
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
