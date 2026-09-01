import { createPublicRequestForwarder, type AdmittedWorkerSelector } from './forwarding';

export type PublicListenerOptions = {
  readonly admission: AdmittedWorkerSelector;
  readonly transportSecret: string;
  readonly hostname: string;
  readonly port: number;
  readonly controlApi?: {
    handle(request: Request): Promise<Response | null>;
    authorizeForward?(request: Request): Promise<boolean | Response>;
  };
};

export interface PublicListener {
  readonly port: number | null;
  start(): void;
  stop(): Promise<void>;
}

export class PublicListenerLifecycleError extends Error {
  readonly name = 'PublicListenerLifecycleError';
}

export function createPublicListener(options: PublicListenerOptions): PublicListener {
  if (options.hostname.length === 0 || !Number.isSafeInteger(options.port)
    || options.port < 0 || options.port > 65_535) {
    throw new PublicListenerLifecycleError('public listener address is invalid');
  }
  const forward = createPublicRequestForwarder(options);
  let server: ReturnType<typeof Bun.serve> | null = null;
  let started = false;

  return {
    get port() { return server?.port ?? null; },
    start() {
      if (started) throw new PublicListenerLifecycleError('public listener can only start once');
      started = true;
      server = Bun.serve({
        hostname: options.hostname,
        port: options.port,
        reusePort: false,
        fetch: async (request) => {
          if (options.controlApi === undefined) return forward(request);
          const handled = await options.controlApi.handle(request);
          if (handled !== null) return handled;
          const authorization = await options.controlApi.authorizeForward?.(request) ?? false;
          return authorization instanceof Response
            ? authorization
            : forward(request, authorization);
        },
      });
    },
    async stop() {
      const current = server;
      server = null;
      if (current !== null) await current.stop(false);
    },
  };
}
