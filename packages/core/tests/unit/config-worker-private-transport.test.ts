import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  generateWorkerTransportSecret,
  parseWorkerTransportSecret,
  restoreWorkerTransportRequest,
} from '../../src/config-worker/private-transport';

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

  test('accepts the authenticated-management marker only through valid private transport and strips it', () => {
    const secret = generateWorkerTransportSecret();
    const marker = 'x-bungee-internal-authenticated-management';
    const valid = restoreWorkerTransportRequest(transportRequest(secret, 'https://public.example/__ui/api/plugins', {
      headers: { [marker]: '1' },
    }), secret);
    const forged = restoreWorkerTransportRequest(transportRequest(generateWorkerTransportSecret(),
      'https://public.example/__ui/api/plugins', { headers: { [marker]: '1' } }), secret);

    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('expected restored request');
    expect(valid.request.headers.get(marker)).toBeNull();
    expect(forged).toEqual({ ok: false, status: 403 });
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
    const request = transportRequest(secret, 'https://upload.example/body', {
      method: 'POST', body, signal: abort.signal,
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
