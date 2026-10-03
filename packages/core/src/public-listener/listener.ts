import { ANONYMOUS_PRINCIPAL, type DataPrincipal } from '../plugin-extensions';
import { createPublicRequestForwarder, type AdmittedWorkerSelector } from './forwarding';

export interface PublicListener {
  readonly port: number | null;
  start(): void;
  stop(): Promise<void>;
}

export class PublicListenerLifecycleError extends Error {
  readonly name = 'PublicListenerLifecycleError';
}

export type IngressPublicListenerOptions = {
  readonly admission: AdmittedWorkerSelector;
  readonly transportSecret: string;
  readonly authenticate?: (request: Request) => DataPrincipal | null;
  readonly hostname: string;
  readonly port: number;
};

/** Ingress has no control/API routing: every request is passed to the current worker set. */
export function createIngressPublicListener(options: IngressPublicListenerOptions): PublicListener {
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
        idleTimeout: 0,
        // The serving worker enforces its ACKed body_parser_limit while reading
        // the stream, so Bun's transport default must not reject it first.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        fetch: (request, server) => forward(request, server.requestIP(request)?.address),
      });
    },
    async stop() {
      const current = server;
      server = null;
      if (current !== null) await current.stop(false);
    },
  };
}
