import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  INTERNAL_TRUSTED_PEER_HEADER,
  INTERNAL_TRUSTED_PEER_MAC_HEADER,
  signWorkerTransportPeer,
} from '../config-worker/private-transport';

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
] as const;
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function connectionTokens(headers: Headers): readonly string[] {
  return (headers.get('connection') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => HTTP_FIELD_NAME.test(value));
}

export function stripHopByHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of connectionTokens(source)) headers.delete(name);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

export function privateRequestHeaders(
  request: Request,
  transportSecret: string,
  trustedPeer?: string,
): Headers {
  const originalUrl = new URL(request.url);
  const headers = stripHopByHopHeaders(request.headers);
  const strippedHeaders: string[] = [];
  headers.forEach((_value, name) => {
    if (name.startsWith('x-bungee-internal-') || name === 'x-bungee-next-authorization') {
      strippedHeaders.push(name);
    }
  });
  for (const name of strippedHeaders) headers.delete(name);
  headers.set(INTERNAL_TRANSPORT_TOKEN_HEADER, transportSecret);
  headers.set(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER, request.url);
  if (trustedPeer !== undefined) {
    headers.set(INTERNAL_TRUSTED_PEER_HEADER, trustedPeer);
    headers.set(INTERNAL_TRUSTED_PEER_MAC_HEADER, signWorkerTransportPeer(trustedPeer, request.method, request.url, transportSecret));
  }
  headers.set('host', originalUrl.host);
  return headers;
}

export function publicResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (name !== 'set-cookie') headers.append(name, value);
  });
  for (const cookie of source.getSetCookie()) headers.append('set-cookie', cookie);
  return stripHopByHopHeaders(headers);
}

export function requestsUpgrade(request: Request): boolean {
  return request.headers.has('upgrade') || connectionTokens(request.headers).includes('upgrade');
}
