import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  INTERNAL_TRUSTED_PEER_HEADER,
  INTERNAL_TRUSTED_PEER_MAC_HEADER,
  generateWorkerTransportSecret,
  getTrustedWorkerPeer,
  parseWorkerTransportSecret,
  restoreWorkerTransportRequest,
  signWorkerTransportPeer,
} from '../../src/config-worker/private-transport';
import { deriveWorkerTransportSecret } from '../../src/supervision';

const LOOPBACK_URL = 'http://127.0.0.1:41234/internal';

function transportRequest(secret: string, originalUrl?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_TRANSPORT_TOKEN_HEADER, secret);
  if (originalUrl !== undefined) headers.set(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER, originalUrl);
  return new Request(LOOPBACK_URL, { ...init, headers });
}

function requestWithUnsafeOriginalUrl(secret: string, originalUrl: string): Request {
  const request = transportRequest(secret, 'https://safe.example/');
  const headers = new Proxy(request.headers, {
    get(target, property) {
      if (property === 'get') {
        return (name: string) => name.toLowerCase() === INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER
          ? originalUrl
          : target.get(name);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(request, {
    get(target, property) {
      return property === 'headers' ? headers : Reflect.get(target, property, target);
    },
  });
}

describe('config worker private transport', () => {
  test('generates and parses canonical 32-byte base64url secrets', () => {
    const secret = generateWorkerTransportSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(secret).toHaveLength(43);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(parseWorkerTransportSecret(secret)).toBe(secret);
  });

  test('derives a stable, instance-isolated transport secret from the supervision root', () => {
    const root = new Uint8Array(32).fill(7);
    const instanceA = '11111111-1111-4111-8111-111111111111';
    const instanceB = '22222222-2222-4222-8222-222222222222';
    const secret = deriveWorkerTransportSecret(root, instanceA);

    expect(parseWorkerTransportSecret(secret)).toBe(secret);
    expect(deriveWorkerTransportSecret(root, instanceA)).toBe(secret);
    expect(deriveWorkerTransportSecret(root, instanceB)).not.toBe(secret);
  });

  test.each([
    undefined,
    '',
    'A'.repeat(42),
    `${'A'.repeat(42)}B`,
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}\n`,
  ])('rejects a non-canonical secret', (value) => {
    expect(() => parseWorkerTransportSecret(value)).toThrow('transport secret');
  });

  test('returns 403 for a missing or wrong token before URL validation', () => {
    const secret = generateWorkerTransportSecret();
    const missing = new Request(LOOPBACK_URL);
    const wrong = transportRequest(generateWorkerTransportSecret());

    expect(restoreWorkerTransportRequest(missing, secret)).toEqual({ ok: false, status: 403 });
    expect(restoreWorkerTransportRequest(wrong, secret)).toEqual({ ok: false, status: 403 });
  });

  test('restores the original URL and removes both internal headers', () => {
    const secret = generateWorkerTransportSecret();
    const originalUrl = 'https://api.example:8443/v1/messages?stream=true&model=a';
    const result = restoreWorkerTransportRequest(transportRequest(secret, originalUrl, {
      headers: { 'x-user-header': 'preserved' },
    }), secret);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected restored request');
    expect(result.request.url).toBe(originalUrl);
    expect(result.request.headers.get('x-user-header')).toBe('preserved');
    expect(result.request.headers.has(INTERNAL_TRANSPORT_TOKEN_HEADER)).toBe(false);
    expect(result.request.headers.has(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER)).toBe(false);
  });

  test('strips obsolete internal and next-authorization headers from restored requests', () => {
    const secret = generateWorkerTransportSecret();
    const valid = restoreWorkerTransportRequest(transportRequest(secret, 'https://public.example/api/plugins', {
      headers: {
        'x-bungee-internal-authenticated-management': '1',
        'x-bungee-internal-forged': '1',
        'x-bungee-next-authorization': 'Bearer old-token',
      },
    }), secret);

    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('expected restored request');
    expect(valid.request.headers.get('x-bungee-internal-authenticated-management')).toBeNull();
    expect(valid.request.headers.get('x-bungee-internal-forged')).toBeNull();
    expect(valid.request.headers.get('x-bungee-next-authorization')).toBeNull();
  });

  test('only restores a peer IP authenticated by ingress and strips spoofable transport headers', () => {
    const secret = generateWorkerTransportSecret();
    const peer = '203.0.113.8';
    const valid = transportRequest(secret, 'https://public.example/', {
      headers: {
        [INTERNAL_TRUSTED_PEER_HEADER]: peer,
        [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer(peer, 'GET', 'https://public.example/', secret),
      },
    });
    const restored = restoreWorkerTransportRequest(valid, secret);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('expected restored request');
    expect(getTrustedWorkerPeer(restored.request)).toBe(peer);
    expect(restored.request.headers.has(INTERNAL_TRUSTED_PEER_HEADER)).toBe(false);
    expect(restoreWorkerTransportRequest(transportRequest(secret, 'https://public.example/', {
      headers: { [INTERNAL_TRUSTED_PEER_HEADER]: peer, [INTERNAL_TRUSTED_PEER_MAC_HEADER]: 'hmac-sha256:forged' },
    }), secret)).toEqual({ ok: false, status: 403 });
  });

  test.each([
    ['POST', 'https://public.example/'],
    ['GET', 'https://public.example/other'],
    ['GET', 'https://other.example/'],
    ['GET', 'https://public.example/?changed=true'],
  ])('rejects a peer MAC rebound to a changed method or URL', (method, originalUrl) => {
    const secret = generateWorkerTransportSecret();
    const peer = '203.0.113.8';
    const request = transportRequest(secret, originalUrl, {
      method,
      headers: {
        [INTERNAL_TRUSTED_PEER_HEADER]: peer,
        [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer(peer, 'GET', 'https://public.example/', secret),
      },
    });
    expect(restoreWorkerTransportRequest(request, secret)).toEqual({ ok: false, status: 403 });
  });

  test.each([
    undefined,
    'not a URL',
    'ftp://example.com/path',
    'https://user:secret@example.com/path',
    'https://example.com/path#fragment',
    `https://example.com/${'a'.repeat(65_536)}`,
  ])('returns 400 for an invalid original URL', (originalUrl) => {
    const secret = generateWorkerTransportSecret();
    const result = restoreWorkerTransportRequest(transportRequest(secret, originalUrl), secret);
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test('returns 400 for CR/LF in the original URL', () => {
    const secret = generateWorkerTransportSecret();
    const request = requestWithUnsafeOriginalUrl(secret, 'https://example.com/path\r\nX-Injected: true');
    expect(restoreWorkerTransportRequest(request, secret)).toEqual({ ok: false, status: 400 });
  });

  test('moves a POST stream without buffering and propagates abort', async () => {
    const secret = generateWorkerTransportSecret();
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream-body'));
        controller.close();
      },
    });
    const originalUrl = 'https://upload.example/body';
    const request = transportRequest(secret, originalUrl, {
      method: 'POST', body, signal: abort.signal,
      headers: {
        [INTERNAL_TRUSTED_PEER_HEADER]: '203.0.113.8',
        [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer('203.0.113.8', 'POST', originalUrl, secret),
      },
    });

    const result = restoreWorkerTransportRequest(request, secret);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected restored request');
    expect(request.bodyUsed).toBe(false);
    expect(await result.request.text()).toBe('stream-body');
    abort.abort('cancelled');
    expect(result.request.signal.aborted).toBe(true);
    expect(result.request.signal.reason).toBe('cancelled');
  });

  test('omits a body when the restored method is GET', () => {
    const secret = generateWorkerTransportSecret();
    const post = transportRequest(secret, 'https://example.com/get', {
      method: 'POST', body: 'must-not-pass',
    });
    const request = new Proxy(post, {
      get(target, property) {
        return property === 'method' ? 'GET' : Reflect.get(target, property, target);
      },
    });

    const result = restoreWorkerTransportRequest(request, secret);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected restored request');
    expect(result.request.method).toBe('GET');
    expect(result.request.body).toBeNull();
  });

  test('does not invoke a handler when restore rejects', async () => {
    const secret = generateWorkerTransportSecret();
    let calls = 0;
    const dispatch = async (request: Request): Promise<Response> => {
      const restored = restoreWorkerTransportRequest(request, secret);
      if (!restored.ok) return new Response(null, { status: restored.status });
      calls += 1;
      return new Response(restored.request.url);
    };

    expect((await dispatch(new Request(LOOPBACK_URL))).status).toBe(403);
    expect(calls).toBe(0);
  });
});
