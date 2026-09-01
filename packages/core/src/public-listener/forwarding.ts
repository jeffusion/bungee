import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { parseWorkerTransportSecret } from '../config-worker/private-transport';
import { privateRequestHeaders, publicResponseHeaders, requestsUpgrade } from './headers';

export interface AdmittedWorkerSelector {
  select(): Pick<ServingConfigWorker, 'private_port'> | null;
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
  authenticatedManagement = false,
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

  const worker = options.admission.select();
  if (worker === null) return errorResponse(503);
  const originalUrl = new URL(request.url);
  const privateUrl = `http://127.0.0.1:${worker.private_port}${originalUrl.pathname}${originalUrl.search}`;
  const method = request.method.toUpperCase();
  try {
    const init = {
      method: request.method,
      headers: privateRequestHeaders(request, options.transportSecret, authenticatedManagement),
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
    return errorResponse(request.signal.aborted ? 499 : 502);
  }
}

export function forwardPublicRequest(
  request: Request,
  options: ForwardPublicRequestOptions,
): Promise<Response> {
  return forwardToSelectedWorker(request, {
    admission: options.admission,
    transportSecret: parseWorkerTransportSecret(options.transportSecret),
  });
}

export function createPublicRequestForwarder(
  options: ForwardPublicRequestOptions,
): (request: Request, authenticatedManagement?: boolean) => Promise<Response> {
  const forwardingOptions = {
    admission: options.admission,
    transportSecret: parseWorkerTransportSecret(options.transportSecret),
  } satisfies ForwardPublicRequestOptions;
  return (request, authenticatedManagement) => forwardToSelectedWorker(
    request, forwardingOptions, authenticatedManagement,
  );
}
