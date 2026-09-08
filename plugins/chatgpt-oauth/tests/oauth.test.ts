// Deterministic protocol fixtures only: these tests never call a real account endpoint.
import { describe, expect, test } from 'bun:test';
import {
  CODEX_DEVICE_EXCHANGE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USER_CODE_URL,
  CODEX_REDIRECT_URI,
  CodexOAuthError,
  buildCodexAuthorizationUrl,
  createPKCE,
  exchangeCodexCode,
  extractCodexIdentity,
  parseCodexCallbackUrl,
  pollDeviceToken,
  refreshCodexToken,
  requestDeviceCode
} from '../server/oauth';

function response(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Codex OAuth protocol', () => {
  test('device flow accepts string interval and polls 403/404 without leaking body', async () => {
    const requests: Request[] = [];
    let pollCount = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === CODEX_DEVICE_USER_CODE_URL) return response(200, { device_auth_id: 'device-1', user_code: 'ABCD', interval: '0.25' });
      pollCount++;
      if (pollCount < 3) return response(pollCount === 1 ? 403 : 404, { access_token: 'must-not-appear' });
      return response(200, { authorization_code: 'auth-code', code_verifier: 'verifier', code_challenge: 'challenge' });
    };
    const device = await requestDeviceCode({ fetchImpl });
    expect(device.intervalMs).toBe(250);
    const token = await pollDeviceToken(device, { fetchImpl, maxDurationMs: 2000 });
    expect(token.authorizationCode).toBe('auth-code');
    expect(pollCount).toBe(3);
    expect(requests.filter((request) => request.url === CODEX_DEVICE_TOKEN_URL)).toHaveLength(3);
    expect(requests.every((request) => request.redirect === 'error')).toBe(true);
  });

  test('redirect responses are rejected without following them', async () => {
    let redirect: RequestRedirect | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      redirect = init?.redirect;
      return response(302, 'redirect-secret');
    };
    await expect(requestDeviceCode({ fetchImpl })).rejects.toMatchObject({ kind: 'http', status: 302 });
    expect(redirect).toBe('error');
  });

  test('device polling sleep removes its abort listener after resolving', async () => {
    class TrackedSignal extends EventTarget {
      aborted = false;
      reason: unknown;
      added = 0;
      removed = 0;

      override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
        this.added++;
        super.addEventListener(...args);
      }

      override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
        this.removed++;
        super.removeEventListener(...args);
      }
    }
    const signal = new TrackedSignal();
    let pollCount = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === CODEX_DEVICE_TOKEN_URL && pollCount++ === 0) return response(403, { error: 'pending' });
      return response(200, { authorization_code: 'auth-code', code_verifier: 'verifier' });
    };
    await pollDeviceToken({ deviceAuthId: 'd', userCode: 'u', intervalMs: 250 }, { fetchImpl, signal: signal as unknown as AbortSignal, maxDurationMs: 1000 });
    expect(signal.added).toBe(signal.removed);
  });

  test('device polling is bounded and cancellable', async () => {
    const controller = new AbortController();
    const fetchImpl = async (): Promise<Response> => {
      controller.abort();
      return response(403, { error: 'pending' });
    };
    await expect(pollDeviceToken({ deviceAuthId: 'd', userCode: 'u', intervalMs: 1000 }, { fetchImpl, signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  test('fetch and streaming body failures are redacted, including cancellation failures', async () => {
    const secretBodyError = new Error('BODY_SECRET');
    const bodyErrorFetch = async (): Promise<Response> => new Response(new ReadableStream({ start: (stream) => stream.error(secretBodyError) }), { status: 200 });
    let error: unknown;
    try { await requestDeviceCode({ fetchImpl: bodyErrorFetch }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CodexOAuthError);
    expect((error as Error).message).not.toContain('BODY_SECRET');

    const fetchError = async (): Promise<Response> => {
      throw new Error('FETCH_SECRET');
    };
    error = undefined;
    try { await requestDeviceCode({ fetchImpl: fetchError }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CodexOAuthError);
    expect((error as Error).message).not.toContain('FETCH_SECRET');
    for (const cancelMode of ['resolve', 'reject', 'pending'] as const) {
      const oversized = async (): Promise<Response> => new Response(new ReadableStream({
        start: (stream) => stream.enqueue(new Uint8Array([1, 2, 3])),
        cancel: () => cancelMode === 'resolve'
          ? Promise.resolve()
          : cancelMode === 'reject'
            ? Promise.reject(new Error('CANCEL_SECRET'))
            : new Promise(() => undefined)
      }), { status: 200 });
      const settled = await Promise.race([
        requestDeviceCode({ fetchImpl: oversized, maxBodyBytes: 2, timeoutMs: 10 }).catch((caught) => caught),
        new Promise((resolve) => setTimeout(() => resolve('TEST_TIMEOUT'), 80))
      ]);
      expect(settled).toMatchObject({ kind: 'body_limit' });
      expect((settled as Error).message).not.toContain('CANCEL_SECRET');
    }
  });

  test('a pending body read ends on timeout and external abort', async () => {
    const pendingBody = async (): Promise<Response> => new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    await expect(requestDeviceCode({ fetchImpl: pendingBody, timeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' });

    const controller = new AbortController();
    const abortingBody = async (): Promise<Response> => {
      setTimeout(() => controller.abort(), 5);
      return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    };
    await expect(requestDeviceCode({ fetchImpl: abortingBody, signal: controller.signal, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  test('PKCE and auth URL use S256 and Codex flags', () => {
    const pkce = createPKCE((size) => new Uint8Array(size).fill(7));
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildCodexAuthorizationUrl(pkce));
    expect(url.searchParams.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  test('callback URL validates origin, path, state, TTL and never fetches it', () => {
    const callback = parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1`, { expectedState: 'state-1', issuedAt: 1000, now: 1001 });
    expect(callback.code).toBe('abc');
    expect(() => parseCodexCallbackUrl('https://example.com/auth/callback?code=abc&state=state-1', { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1`, { expectedState: 'state-1', issuedAt: 0, now: 301_000 })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=a&code=b&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?error=access_denied&error=access_denied&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&error=access_denied&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=c&error=&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?error=&state=state-1`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=%20s%20`, { expectedState: 's' })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1&userinfo=x`, { expectedState: 'state-1' })).toThrow(CodexOAuthError);
    expect(parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?error=access_denied&error_description=secret&state=state-1`, { expectedState: 'state-1' })).toMatchObject({ error: 'access_denied', errorDescription: { present: true } });
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1`, { expectedState: 'state-1', issuedAt: Number.NaN })).toThrow(CodexOAuthError);
    expect(() => parseCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=state-1`, { expectedState: 'state-1', ttlMs: 0 })).toThrow(CodexOAuthError);
  });

  test('exchange uses device redirect and refresh preserves a rotated-away refresh field', async () => {
    const seen: { url: string; body: string; redirect?: RequestRedirect }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      seen.push({ url: request.url, body: await request.text(), redirect: init?.redirect });
      return response(200, { access_token: 'access', ...(seen.length === 1 ? { refresh_token: 'new-refresh' } : {}), id_token: jwt({ email: 'a@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' } }), expires_in: 3600 });
    };
    const exchanged = await exchangeCodexCode('code', 'verifier', { fetchImpl, redirectUri: CODEX_DEVICE_EXCHANGE_REDIRECT_URI });
    expect(exchanged.accessToken).toBe('access');
    expect(seen[0].body).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback');
    const refreshed = await refreshCodexToken('old-refresh', { fetchImpl });
    expect(refreshed.refreshToken).toBe('old-refresh');
    expect(refreshed.identity?.accountId).toBe('acct');
    expect(seen.every((request) => request.redirect === 'error')).toBe(true);
  });

  test('refresh rotation survives missing and malformed optional id tokens', async () => {
    let call = 0;
    const fetchImpl = async (): Promise<Response> => {
      call++;
      return response(200, { access_token: `access-${call}`, refresh_token: `rotated-${call}`, ...(call === 2 ? { id_token: 'malformed' } : {}), expires_in: 3600 });
    };
    const withoutIdentity = await refreshCodexToken('old-refresh', { fetchImpl });
    expect(withoutIdentity.refreshToken).toBe('rotated-1');
    expect(withoutIdentity.identityStatus).toBe('missing');
    const malformedIdentity = await refreshCodexToken(withoutIdentity.refreshToken, { fetchImpl });
    expect(malformedIdentity.refreshToken).toBe('rotated-2');
    expect(malformedIdentity.identity).toBeUndefined();
    expect(malformedIdentity.identityStatus).toBe('invalid');
  });

  test('refresh_token_reused is safe and non-retryable', async () => {
    const fetchImpl = async (): Promise<Response> => response(400, { error: 'refresh_token_reused', refresh_token: 'secret' });
    try {
      await refreshCodexToken('old-refresh', { fetchImpl });
      throw new Error('expected refresh failure');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'refresh_token_reused', retryable: false });
      expect((error as Error).message).not.toContain('secret');
    }
  });
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}
