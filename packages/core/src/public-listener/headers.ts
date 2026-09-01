import {
  INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER,
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
} from '../config-worker/private-transport';
import { NEXT_AUTHORIZATION_HEADER } from '../master-runtime/control-api-auth';

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
  authenticatedManagement = false,
): Headers {
  const originalUrl = new URL(request.url);
  const headers = stripHopByHopHeaders(request.headers);
  headers.delete(INTERNAL_TRANSPORT_TOKEN_HEADER);
  headers.delete(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER);
  headers.delete(NEXT_AUTHORIZATION_HEADER);
  headers.delete(INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER);
  headers.set(INTERNAL_TRANSPORT_TOKEN_HEADER, transportSecret);
  headers.set(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER, request.url);
  if (authenticatedManagement) headers.set(INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER, '1');
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
