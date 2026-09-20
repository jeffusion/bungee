import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const INTERNAL_TRANSPORT_TOKEN_HEADER = 'x-bungee-internal-transport-token';
export const INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER = 'x-bungee-internal-original-url';
export const INTERNAL_TRUSTED_PEER_HEADER = 'x-bungee-internal-trusted-peer';
export const INTERNAL_TRUSTED_PEER_MAC_HEADER = 'x-bungee-internal-trusted-peer-mac';

const CANONICAL_SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const MAX_ORIGINAL_URL_LENGTH = 65_536;

export type WorkerTransportRestoreResult =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly status: 400 | 403 };

const trustedPeers = new WeakMap<Request, string>();

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

function peerMac(peer: string, method: string, originalUrl: string, secret: string): string {
  return `hmac-sha256:${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(JSON.stringify(['bungee-worker-transport/v1/peer', peer, method.toUpperCase(), originalUrl]), 'utf8').digest('hex')}`;
}

export function signWorkerTransportPeer(peer: string, method: string, originalUrl: string, secret: string): string {
  if (isIP(peer) === 0) throw new Error('trusted peer must be an IP address');
  return peerMac(peer, method, originalUrl, parseWorkerTransportSecret(secret));
}

function trustedPeer(request: Request, originalUrl: string, secret: string): string | null | false {
  const peer = request.headers.get(INTERNAL_TRUSTED_PEER_HEADER);
  const mac = request.headers.get(INTERNAL_TRUSTED_PEER_MAC_HEADER);
  if (peer === null && mac === null) return null;
  if (peer === null || mac === null || isIP(peer) === 0) return false;
  const expected = peerMac(peer, request.method, originalUrl, secret);
  const provided = Buffer.from(mac, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return provided.byteLength === expectedBytes.byteLength && timingSafeEqual(provided, expectedBytes) ? peer : false;
}

export function getTrustedWorkerPeer(request: Request): string | null {
  return trustedPeers.get(request) ?? null;
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
  const peer = trustedPeer(request, originalUrlValue!, transportSecret);
  if (peer === false) return { ok: false, status: 403 };

  const headers = new Headers(request.headers);
  const strippedHeaders: string[] = [];
  headers.forEach((_value, name) => {
    if (name.startsWith('x-bungee-internal-') || name === 'x-bungee-next-authorization') {
      strippedHeaders.push(name);
    }
  });
  for (const name of strippedHeaders) headers.delete(name);
  const method = request.method.toUpperCase();
  try {
    const restored = new Request(originalUrl, {
      method: request.method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? null : request.body,
      signal: request.signal,
    });
    if (peer !== null) trustedPeers.set(restored, peer);
    return { ok: true, request: restored };
  } catch {
    return { ok: false, status: 400 };
  }
}
