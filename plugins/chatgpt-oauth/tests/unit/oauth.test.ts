// Deterministic protocol fixtures only: these tests never call a real account endpoint.
import { describe, expect, test } from 'bun:test';
import {
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USER_CODE_URL,
  CODEX_REDIRECT_URI,
  CODEX_TOKEN_URL,
  CodexOAuthError,
  buildCodexAuthorizationUrl,
  createPKCE,
  exchangeCodexCode,
  exchangeCodexDeviceAuthorization,
  extractCodexIdentity,
  parseCodexCallbackUrl,
  pollDeviceToken,
  refreshCodexToken,
  requestDeviceCode
} from '../../server/oauth';

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
    // Bun 1.4.2 on Windows stalls `.rejects` matchers on unsettled timer-driven
    // promises; capture the rejection with a plain await instead.
    const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
      try { await promise; } catch (error) { return error; }
      throw new Error('expected the promise to reject');
    };
    const pendingBody = async (): Promise<Response> => new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    const error = await captureRejection(requestDeviceCode({ fetchImpl: pendingBody, timeoutMs: 10 }));
    expect(error).toMatchObject({ kind: 'timeout' });

    const controller = new AbortController();
    const abortingBody = async (): Promise<Response> => {
      setTimeout(() => controller.abort(), 5);
      return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    };
    const cancelledError = await captureRejection(requestDeviceCode({ fetchImpl: abortingBody, signal: controller.signal, timeoutMs: 1000 }));
    expect(cancelledError).toMatchObject({ kind: 'cancelled' });
  });

  test('PKCE and auth URL use S256 and Codex flags', () => {
    const pkce = createPKCE((size) => new Uint8Array(size).fill(7));
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildCodexAuthorizationUrl(pkce));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      response_type: 'code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid email profile offline_access',
      state: pkce.state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true'
    });
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

  test('authorization-code exchange, device exchange and refresh use the expected OAuth form contracts', async () => {
    const seen: { url: string; method: string; accept: string | null; contentType: string | null; body: string; redirect?: RequestRedirect }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        method: request.method,
        accept: request.headers.get('accept'),
        contentType: request.headers.get('content-type'),
        body: await request.text(),
        redirect: init?.redirect
      });
      return response(200, { access_token: 'test-access-token', refresh_token: 'test-rotated-refresh-token', id_token: jwt({ email: 'a@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' } }), expires_in: 3600 });
    };
    const authCodeExchange = await exchangeCodexCode('test-authorization-code', 'test-code-verifier', { fetchImpl });
    expect(authCodeExchange.accessToken).toBe('test-access-token');
    const deviceExchange = await exchangeCodexDeviceAuthorization({
      authorizationCode: 'test-device-authorization-code',
      codeVerifier: 'test-device-code-verifier'
    }, { fetchImpl });
    expect(deviceExchange.accessToken).toBe('test-access-token');
    const refreshed = await refreshCodexToken('test-old-refresh-token', { fetchImpl });
    expect(refreshed.refreshToken).toBe('test-rotated-refresh-token');
    expect(refreshed.identity?.accountId).toBe('acct');
    expect(seen.map(({ url }) => url)).toEqual([CODEX_TOKEN_URL, CODEX_TOKEN_URL, CODEX_TOKEN_URL]);
    expect(seen.map(({ method, accept, contentType }) => ({ method, accept, contentType }))).toEqual([
      { method: 'POST', accept: 'application/json', contentType: 'application/x-www-form-urlencoded' },
      { method: 'POST', accept: 'application/json', contentType: 'application/x-www-form-urlencoded' },
      { method: 'POST', accept: 'application/json', contentType: 'application/x-www-form-urlencoded' }
    ]);
    expect(seen.map(({ body }) => Object.fromEntries(new URLSearchParams(body)))).toEqual([
      {
        grant_type: 'authorization_code',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code: 'test-authorization-code',
        redirect_uri: 'http://localhost:1455/auth/callback',
        code_verifier: 'test-code-verifier'
      },
      {
        grant_type: 'authorization_code',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code: 'test-device-authorization-code',
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        code_verifier: 'test-device-code-verifier'
      },
      {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'test-old-refresh-token',
        scope: 'openid profile email'
      }
    ]);
    expect(seen.every(({ body }) => !body.includes('test-access-token') && !body.includes('test-rotated-refresh-token'))).toBe(true);
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

  test('refresh preserves the supplied refresh token when the response omits it', async () => {
    const fetchImpl = async (): Promise<Response> => response(200, { access_token: 'test-access-token', expires_in: 3600 });
    const refreshed = await refreshCodexToken('test-existing-refresh-token', { fetchImpl });
    expect(refreshed.refreshToken).toBe('test-existing-refresh-token');
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
