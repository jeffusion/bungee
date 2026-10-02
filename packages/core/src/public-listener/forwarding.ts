import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { parseWorkerTransportSecret } from '../config-worker/private-transport';
import { privateRequestHeaders, publicResponseHeaders, requestsUpgrade } from './headers';

export interface AdmittedWorkerSelector {
  acquire(): {
    readonly worker: Pick<ServingConfigWorker, 'private_port'> | null;
    release(): void;
  };
}

export type ForwardPublicRequestOptions = {
  readonly admission: AdmittedWorkerSelector;
  readonly transportSecret: string;
};

type BunForwardRequestInit = RequestInit & {
  readonly maxRedirects: 0;
  readonly decompress: false;
  readonly timeout: false;
  readonly duplex: 'half';
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function errorResponse(status: 499 | 502 | 503): Response {
  const error = status === 503 ? 'service_unavailable' : status === 502 ? 'bad_gateway' : 'client_closed_request';
  const headers = new Headers(JSON_HEADERS);
  if (status === 503) headers.set('retry-after', '1');
  return Response.json({ error }, { status, headers });
}

function responseBodyAllowed(method: string, status: number): boolean {
  return method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
}

async function forwardToSelectedWorker(
  request: Request,
  options: ForwardPublicRequestOptions,
  trustedPeer?: string,
): Promise<Response> {
  if (request.method.toUpperCase() === 'CONNECT') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: JSON_HEADERS });
  }
  if (requestsUpgrade(request)) {
    return Response.json({ error: 'upgrade_required' }, {
      status: 426,
      headers: { ...JSON_HEADERS, upgrade: 'websocket' },
    });
  }

  const lease = options.admission.acquire();
  const worker = lease.worker;
  if (worker === null) {
    lease.release();
    return errorResponse(503);
  }
  const method = request.method.toUpperCase();
  const startedAt = performance.now();
  try {
    const originalUrl = new URL(request.url);
    const privateUrl = `http://127.0.0.1:${worker.private_port}${originalUrl.pathname}${originalUrl.search}`;
    const init = {
      method: request.method,
      headers: privateRequestHeaders(request, options.transportSecret, trustedPeer),
      body: method === 'GET' || method === 'HEAD' ? null : request.body,
      signal: request.signal,
      redirect: 'manual',
      maxRedirects: 0,
      decompress: false,
      timeout: false,
      duplex: 'half',
    } satisfies BunForwardRequestInit;
    const response = await Bun.fetch(privateUrl, init);
    return new Response(responseBodyAllowed(method, response.status) ? response.body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: publicResponseHeaders(response.headers),
    });
  } catch {
    const errorCode = request.signal.aborted ? 'client_closed_request' : 'bad_gateway';
    try {
      logger.warn({ ingressForwarding: {
        phase: 'private_response_headers',
        correlation_id: randomUUID(),
        error_code: errorCode,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      } }, 'Ingress private request forwarding failed');
    } catch { /* diagnostics must not alter the controlled proxy response */ }
    return errorResponse(request.signal.aborted ? 499 : 502);
  } finally {
    // Release at response headers: the worker has accepted the request, while its body may
    // continue streaming during the subsequent graceful drain.
    lease.release();
  }
}

export function createPublicRequestForwarder(
  options: ForwardPublicRequestOptions,
): (request: Request, trustedPeer?: string) => Promise<Response> {
  const forwardingOptions = {
    admission: options.admission,
    transportSecret: parseWorkerTransportSecret(options.transportSecret),
  } satisfies ForwardPublicRequestOptions;
  return (request, trustedPeer) => forwardToSelectedWorker(
    request, forwardingOptions, trustedPeer,
  );
}
