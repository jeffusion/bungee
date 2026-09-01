import { randomBytes, timingSafeEqual } from 'node:crypto';

export const INTERNAL_TRANSPORT_TOKEN_HEADER = 'x-bungee-internal-transport-token';
export const INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER = 'x-bungee-internal-original-url';
export const INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER = 'x-bungee-internal-authenticated-management';

const CANONICAL_SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const MAX_ORIGINAL_URL_LENGTH = 65_536;

export type WorkerTransportRestoreResult =
  | { readonly ok: true; readonly request: Request; readonly authenticatedManagement: boolean }
  | { readonly ok: false; readonly status: 400 | 403 };

export function generateWorkerTransportSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function parseWorkerTransportSecret(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_SECRET.test(value)) {
    throw new Error('transport secret must be canonical 32-byte base64url');
  }
  return value;
}

function hasValidToken(value: string | null, expected: string): boolean {
  if (value === null) return false;
  let provided: string;
  try {
    provided = parseWorkerTransportSecret(value);
  } catch {
    return false;
  }
  const providedBytes = Buffer.from(provided, 'base64url');
  const expectedBytes = Buffer.from(expected, 'base64url');
  return providedBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(providedBytes, expectedBytes);
}

function parseOriginalUrl(value: string | null): URL | null {
  if (value === null || value.length > MAX_ORIGINAL_URL_LENGTH || /[\r\n]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  return url;
}

export function restoreWorkerTransportRequest(
  request: Request,
  transportSecret: string,
): WorkerTransportRestoreResult {
  const token = request.headers.get(INTERNAL_TRANSPORT_TOKEN_HEADER);
  const originalUrlValue = request.headers.get(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER);
  if (!hasValidToken(token, transportSecret)) return { ok: false, status: 403 };
  const originalUrl = parseOriginalUrl(originalUrlValue);
  if (originalUrl === null) return { ok: false, status: 400 };

  const headers = new Headers(request.headers);
  const authenticatedManagement = headers.get(INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER) === '1';
  headers.delete(INTERNAL_TRANSPORT_TOKEN_HEADER);
  headers.delete(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER);
  headers.delete(INTERNAL_AUTHENTICATED_MANAGEMENT_HEADER);
  const method = request.method.toUpperCase();
  try {
    return {
      ok: true,
      authenticatedManagement,
      request: new Request(originalUrl, {
        method: request.method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? null : request.body,
        signal: request.signal,
      }),
    };
  } catch {
    return { ok: false, status: 400 };
  }
}
