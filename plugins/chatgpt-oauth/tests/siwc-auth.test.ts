import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { ControlHostContext, ControlRpcContext, PluginControl, SecretStore, SecretValue } from '../../../packages/core/src/plugin-control/contracts';
import { AccountStore } from '../server/accounts';
import { createControl } from '../server/control';
import type { CodexTokenSet, FetchLike } from '../server/oauth';
import { LoginSessionManager } from '../server/sessions';
import { buildSiwcAuthorizationUrl, exchangeSiwcCode, getSiwcHostId, parseSiwcCallbackUrl, refreshSiwcToken, SIWC_JWKS_URL, SIWC_REDIRECT_URI, SIWC_RESOURCE, SIWC_SCOPES, SIWC_TOKEN_URL, verifySiwcIdToken } from '../server/siwc';

class Store implements SecretStore {
  readonly namespace = 'siwc-test';
  readonly values = new Map<string, SecretValue>();
  async get(key: string): Promise<SecretValue | null> { const value = this.values.get(key); return value ? { ...value } : null; }
  async compareAndSet(key: string, expected: number | null, value: string): Promise<number> {
    const current = this.values.get(key);
    if ((current?.version ?? null) !== expected) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    const version = (current?.version ?? 0) + 1;
    this.values.set(key, { version, value });
    return version;
  }
  async delete(key: string, version: number): Promise<void> { if (this.values.get(key)?.version !== version) throw new Error('conflict'); this.values.delete(key); }
}

const clientId = 'oaiapp_test_client';
const hostId = 'urn:uuid:0a000000-0000-4000-8000-000000000000';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
function jwt(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { iss: 'https://auth.openai.com', aud: clientId, sub: 'subject-a', exp: Date.now() / 1000 + 3600, nonce: 'nonce', email: 'a@example.test', ...overrides };
  const input = `${encode({ alg: 'RS256', kid: 'test-key', ...header })}.${encode(payload)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> { return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, id_token: jwt(), scope: SIWC_SCOPES.join(' '), ...overrides }; }
function token(overrides: Partial<CodexTokenSet> = {}): CodexTokenSet { return { accessToken: 'access-secret', refreshToken: 'refresh-secret', idToken: jwt(), expiresAt: Date.now() + 3600_000, identityStatus: 'parsed', identity: { email: 'a@example.test' }, siwc: { clientId, subject: 'subject-a', scopes: [...SIWC_SCOPES] }, ...overrides }; }
function protocolFetch(body: Record<string, unknown> = tokenResponse(), inspect?: (request: Request) => void): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init); inspect?.(request);
    if (request.url === SIWC_JWKS_URL) return response({ keys: [publicJwk] });
    expect(request.url).toBe(SIWC_TOKEN_URL); return response(body);
  };
}
const controls: PluginControl[] = [];
const managers: LoginSessionManager[] = [];
afterEach(async () => { for (const item of controls.splice(0)) await item.dispose(); for (const item of managers.splice(0)) item.dispose(); });
function host(store: Store): ControlHostContext { return { secretStore: store, signal: new AbortController().signal, storage: {} as ControlHostContext['storage'] }; }
function control(store: Store, fetchImpl?: FetchLike): PluginControl { const value = createControl(host(store), { fetchImpl }); controls.push(value); return value; }
function rpc(store: Store, accountRef: string, contributionId: string): ControlRpcContext {
  const base = host(store);
  return { ...base, binding: { plugin: 'chatgpt-oauth', contributionId, bindingId: 'binding', bindingOptions: { accountRef } }, attempt: { signal: base.signal, attemptId: 'test', clientStreaming: false, boundClient: { call: async <T>() => undefined as T } } };
}
async function api(value: PluginControl, store: Store, name: string, body?: unknown, query = ''): Promise<Response> {
  const declaration = value.api.find(item => item.handler === name)!;
  return declaration.invoke({ ...host(store), requestSignal: new AbortController().signal, request: new Request(`http://localhost${declaration.path}${query}`, { method: declaration.methods[0], ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) });
}
function callback(state = 'state', callbackClient = clientId): string { return `${SIWC_REDIRECT_URI}?code=code&state=${state}&client_id=${callbackClient}`; }

test('local account deletion clears credentials, removes the list entry and never calls OpenAI', async () => {
  for (const kind of ['siwc', 'codex']) {
    const store = new Store(), accounts = new AccountStore(store);
    const account = await accounts.create('local-delete', kind === 'siwc' ? token() : token({ siwc: undefined, identity: { accountId: 'acct' } }));
    const fence = await accounts.reserveRelogin(account.id);
    let calls = 0;
    const value = control(store, async () => { calls++; throw new Error('unexpected network request'); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await api(value, store, 'deleteAccount', { accountRef: account.id });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ deleted: true });
    }
    expect((await (await api(value, store, 'listAccounts')).json()).accounts).toEqual([]);
    expect((await accounts.read()).aggregate.accounts).toEqual([]);
    await expect(accounts.get(account.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(value.rpc.find(item => item.name === 'getCredential')!.invoke({}, rpc(store, account.id, kind === 'siwc' ? 'chatgpt-siwc' : 'chatgpt'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(accounts.relogin(account.id, token(), fence)).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toBe(0);
  }
});

describe('SIWC native OAuth', () => {
  test('startup removes old deleted records while preserving live accounts and the host identity', async () => {
    const store = new Store(), accounts = new AccountStore(store);
    const hostId = await getSiwcHostId(store);
    const archived = await accounts.create('old deletion', token());
    const active = await accounts.create('retained', token());
    const current = (await store.get('accounts.v1'))!;
    const aggregate = JSON.parse(current.value);
    const old = aggregate.accounts.find((account: { id: string }) => account.id === archived.id);
    old.status = 'revoked'; old.credentialValid = false; old.remoteRevocation = 'confirmed';
    for (const field of ['accessToken', 'refreshToken', 'idToken', 'expiresAt']) delete old[field];
    await store.compareAndSet('accounts.v1', current.version, JSON.stringify(aggregate));
    const value = control(store, async () => { throw new Error('unexpected network request'); });
    await value.start!();
    expect((await accounts.read()).aggregate.accounts).toEqual([active]);
    expect((await store.get('accounts.v1'))!.value).not.toContain(archived.id);
    expect(await getSiwcHostId(store)).toBe(hostId);
    const version = (await store.get('accounts.v1'))!.version;
    await accounts.purgeRevoked();
    expect((await store.get('accounts.v1'))!.version).toBe(version);
  });

  test('CAS gives concurrent controls one stable host identity without a global account client', async () => {
    const store = new Store();
    const [one, two] = await Promise.all([getSiwcHostId(store), getSiwcHostId(store)]);
    expect(one).toBe(two); expect(await getSiwcHostId(store)).toBe(one);
    expect(one).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect([...store.values.values()][0]!.value).not.toContain('clientId');
  });

  test('authorization uses dynamic registration, PKCE, nonce, host and direct scopes', () => {
    const url = new URL(buildSiwcAuthorizationUrl({ state: 'state', codeChallenge: 'challenge' }, 'nonce', hostId));
    expect(url.pathname).toBe('/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'dynamic_agent_client', ext_agent_host_id: hostId, agent_name_hint: 'Bungee', nonce: 'nonce', resource: SIWC_RESOURCE, redirect_uri: SIWC_REDIRECT_URI, code_challenge_method: 'S256', scope: SIWC_SCOPES.join(' ') });
    expect(new URL(buildSiwcAuthorizationUrl({ state: 's', codeChallenge: 'c' }, 'n', hostId, clientId)).searchParams.get('client_id')).toBe(clientId);
  });

  test('callback rejects mismatched state/client, duplicates, wrong redirect, credentials, hash and TTL', () => {
    const options = { expectedState: 'state', issuedAt: Date.now() };
    expect(parseSiwcCallbackUrl(callback(), options)).toEqual({ code: 'code', clientId });
    for (const url of [callback('wrong'), callback() + '&state=state', callback() + '&client_id=' + clientId, callback().replace('127.0.0.1', 'localhost'), callback().replace('127.0.0.1', '127.1'), callback().replace('127.0.0.1', '@127.0.0.1'), callback().replace('127.0.0.1', 'user:password@127.0.0.1'), callback().replace('code=code', 'code=bad%00code'), callback() + '#secret', callback().replace('oaiapp_test_client', 'dynamic_agent_client'), callback() + '&extra=x&extra=y', callback() + '&error=access_denied']) {
      expect(() => parseSiwcCallbackUrl(url, options)).toThrow();
    }
    expect(() => parseSiwcCallbackUrl(callback(), { ...options, expectedClientId: 'oaiapp_other' })).toThrow();
    expect(() => parseSiwcCallbackUrl(callback(), { ...options, now: options.issuedAt + 300_001 })).toThrow();
  });

  test('JWKS validates a genuine RS256 signature and never treats sub as accountId', async () => {
    const verified = await verifySiwcIdToken(jwt(), { clientId, nonce: 'nonce' }, { fetchImpl: protocolFetch() });
    expect(verified).toEqual({ subject: 'subject-a', email: 'a@example.test' });
    const result = await exchangeSiwcCode('code', 'verifier', clientId, 'nonce', { fetchImpl: protocolFetch() });
    expect(result.siwc?.subject).toBe('subject-a'); expect(result.identity?.accountId).toBeUndefined();
  });

  test('ID token rejects bad nonce, aud, issuer, exp, subject, algorithm, key and signature', async () => {
    for (const claims of [{ nonce: 'other' }, { aud: 'oaiapp_other' }, { iss: 'https://evil.test' }, { exp: 1 }, { sub: '' }, { aud: [clientId, 'other'] }]) {
      await expect(verifySiwcIdToken(jwt(claims), { clientId, nonce: 'nonce' }, { fetchImpl: protocolFetch() })).rejects.toMatchObject({ kind: 'invalid_response' });
    }
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }, { crit: ['b64'] }]) await expect(verifySiwcIdToken(jwt({}, header), { clientId }, { fetchImpl: protocolFetch() })).rejects.toThrow();
    const parts = jwt().split('.'); parts[1] = Buffer.from(JSON.stringify({ sub: 'tampered' })).toString('base64url');
    await expect(verifySiwcIdToken(parts.join('.'), { clientId }, { fetchImpl: protocolFetch() })).rejects.toThrow();
    await expect(verifySiwcIdToken(jwt(), { clientId, subject: 'other-subject' }, { fetchImpl: protocolFetch() })).rejects.toThrow();
  });

  test('exchange sends issued client and resource, checks scopes and redacts upstream failures', async () => {
    let sent: URLSearchParams | undefined;
    await exchangeSiwcCode('code', 'verifier', clientId, 'nonce', { fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === SIWC_JWKS_URL) return response({ keys: [publicJwk] });
      sent = new URLSearchParams(await request.text());
      expect(request.redirect).toBe('error'); return response(tokenResponse());
    } });
    expect(Object.fromEntries(sent!)).toEqual({ grant_type: 'authorization_code', client_id: clientId, code: 'code', code_verifier: 'verifier', redirect_uri: SIWC_REDIRECT_URI, resource: SIWC_RESOURCE });
    for (const scope of ['openid resource.invoke', 'openid chatgpt.tokens.use.direct']) await expect(exchangeSiwcCode('code', 'v', clientId, 'nonce', { fetchImpl: protocolFetch(tokenResponse({ scope })) })).rejects.toThrow();
    try { await exchangeSiwcCode('code', 'v', clientId, 'nonce', { fetchImpl: async () => response({ error: 'invalid_grant', secret: 'DO_NOT_LEAK' }, 400) }); }
    catch (error) { expect(String(error)).not.toContain('DO_NOT_LEAK'); expect((error as { upstreamCode: string }).upstreamCode).toBe('invalid_grant'); }
  });

  test('refresh omits scope and inherits omitted refresh/id/scope fields without validating an old expired ID token', async () => {
    const previous = token({ idToken: jwt({ exp: 1 }) });
    const result = await refreshSiwcToken(previous, { fetchImpl: async (input, init) => {
      expect(String(input)).toBe(SIWC_TOKEN_URL);
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'refresh-secret', resource: SIWC_RESOURCE });
      return response({ access_token: 'rotated', expires_in: 3600 });
    } });
    expect(result.refreshToken).toBe(previous.refreshToken); expect(result.idToken).toBe(previous.idToken); expect(result.siwc).toEqual(previous.siwc);
  });

  test('refresh validates supplied signed ID token against original subject and client', async () => {
    for (const claims of [{ sub: 'other' }, { aud: 'oaiapp_other' }]) await expect(refreshSiwcToken(token(), { fetchImpl: protocolFetch(tokenResponse({ id_token: jwt(claims) })) })).rejects.toThrow();
    await expect(refreshSiwcToken(token(), { fetchImpl: protocolFetch(tokenResponse({ id_token: jwt({ nonce: undefined }) })) })).resolves.toMatchObject({ siwc: { subject: 'subject-a' } });
  });
});

describe('SIWC accounts and control isolation', () => {
  test('SIWC accounts persist without accountId; refresh and relogin cannot change auth type, client or subject', async () => {
    const store = new Store(); const accounts = new AccountStore(store);
    const account = await accounts.create('SIWC', token());
    expect((await accounts.list())[0]).toMatchObject({ authType: 'siwc', available: true, autoResetCredits: false });
    const lock = await accounts.acquireRefresh(account.id, 'owner', Date.now() + 1000);
    for (const bad of [token({ siwc: undefined, identity: { accountId: 'legacy' } }), token({ siwc: { clientId: 'oaiapp_other', subject: 'subject-a', scopes: [...SIWC_SCOPES] } }), token({ siwc: { clientId, subject: 'other', scopes: [...SIWC_SCOPES] } })]) {
      await expect(accounts.replaceCredentials(account.id, bad, { owner: 'owner', generation: lock.account.generation })).rejects.toMatchObject({ code: 'identity_mismatch' });
      const fence = await accounts.reserveRelogin(account.id);
      await expect(accounts.relogin(account.id, bad, fence)).rejects.toMatchObject({ code: 'identity_mismatch' });
    }
    await expect(accounts.create('bad', token({ siwc: { clientId: 'dynamic_agent_client', subject: 'subject-a', scopes: [] } }))).rejects.toMatchObject({ code: 'invalid_identity' });
    const snapshot = await store.get('accounts.v1');
    const aggregate = JSON.parse(snapshot!.value); aggregate.accounts[0].siwc.clientId = 'evil';
    await store.compareAndSet('accounts.v1', snapshot!.version, JSON.stringify(aggregate));
    await expect(accounts.read()).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('credential leases enforce source kind and SIWC exposes Authorization only', async () => {
    const store = new Store(); const accounts = new AccountStore(store);
    const siwc = await accounts.create('SIWC', token());
    const legacy = await accounts.create('Codex', token({ siwc: undefined, identity: { accountId: 'acct-codex' } }));
    const value = control(store); const get = value.rpc.find(item => item.name === 'getCredential')!;
    expect(await get.invoke({}, rpc(store, siwc.id, 'chatgpt-siwc'))).toMatchObject({ headers: { Authorization: 'Bearer access-secret' } });
    expect(Object.keys((await get.invoke({}, rpc(store, siwc.id, 'chatgpt-siwc')) as { headers: object }).headers)).toEqual(['Authorization']);
    expect(await get.invoke({}, rpc(store, legacy.id, 'chatgpt'))).toMatchObject({ headers: { 'Chatgpt-Account-Id': 'acct-codex' } });
    for (const [id, source] of [[siwc.id, 'chatgpt'], [siwc.id, 'upstream'], [legacy.id, 'chatgpt-siwc'], [legacy.id, 'unknown']]) await expect(get.invoke({}, rpc(store, id!, source!))).rejects.toMatchObject({ code: 'source_mismatch' });
    const reject = value.rpc.find(item => item.name === 'rejectAccess')!;
    await expect(reject.invoke({ version: 1 }, rpc(store, siwc.id, 'chatgpt'))).rejects.toMatchObject({ code: 'source_mismatch' });
    expect((await accounts.get(siwc.id)).status).toBe('active');
  });

  test('filtered account lists and drafts cannot select the other kind or leak credentials', async () => {
    const store = new Store(); const accounts = new AccountStore(store);
    const siwc = await accounts.create('SIWC', token());
    const legacy = await accounts.create('Codex', token({ siwc: undefined, identity: { accountId: 'acct' } }));
    const value = control(store);
    for (const [handler, expected] of [['listSiwcAccounts', siwc.id], ['listCodexAccounts', legacy.id]]) {
      const result = await (await api(value, store, handler!)).json();
      expect(result.accounts.map((item: { id: string }) => item.id)).toEqual([expected]); expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(await (await api(value, store, 'createSiwcDraft', { accountRef: siwc.id })).json()).toEqual({ target: 'https://api.openai.com', bindingOptions: { accountRef: siwc.id } });
    for (const [handler, id] of [['createDraft', siwc.id], ['createSiwcDraft', legacy.id], ['startPkceLogin', siwc.id], ['startDeviceLogin', siwc.id], ['startSiwcLogin', legacy.id]]) expect(await (await api(value, store, handler!, { accountRef: id })).json()).toEqual({ error: 'source_mismatch' });
  });

  test('SIWC usage/reset/auto-reset are rejected without upstream requests or scheduler eligibility', async () => {
    const store = new Store(); const accounts = new AccountStore(store); const account = await accounts.create('SIWC', token());
    let calls = 0; const value = control(store, async () => { calls++; throw new Error('must not fetch'); });
    for (const [handler, body, query] of [['getAccountUsage', undefined, `?accountRef=${account.id}`], ['resetAccountUsage', { accountRef: account.id }, ''], ['setAutoResetCredits', { accountRef: account.id, enabled: true }, '']] as const) {
      expect(await (await api(value, store, handler, body, query)).json()).toEqual({ error: 'unsupported_operation' });
    }
    expect(calls).toBe(0);
    expect(await accounts.claimAutoReset(account.id, { id: 'credit', status: 'available', resetType: 'codex', grantedAt: Date.now(), expiresAt: Date.now() + 1000 }, Date.now())).toBeUndefined();
    const snapshot = await store.get('accounts.v1'); const aggregate = JSON.parse(snapshot!.value); aggregate.accounts[0].autoResetCredits = true;
    await store.compareAndSet('accounts.v1', snapshot!.version, JSON.stringify(aggregate));
    expect((await accounts.list())[0]!.autoResetCredits).toBe(false);
  });

  test('SIWC shared callback flow reuses account registration on relogin, new adds use dynamic registration', async () => {
    const store = new Store(); let nonce = '';
    const value = control(store, async (input) => String(input) === SIWC_JWKS_URL ? response({ keys: [publicJwk] }) : response(tokenResponse({ id_token: jwt({ nonce }) })));
    const started = await (await api(value, store, 'startSiwcLogin', {})).json();
    const authorization = new URL(started.authorizationUrl); nonce = authorization.searchParams.get('nonce')!;
    expect((await (await api(value, store, 'getLoginStatus', undefined, `?sessionId=${started.sessionId}`)).json()).kind).toBe('siwc');
    const completed = await api(value, store, 'completePkceLogin', { sessionId: started.sessionId, callbackUrl: callback(authorization.searchParams.get('state')!) });
    const account = (await completed.json()).account; expect(account.authType).toBe('siwc'); expect(account.available).toBe(true);
    const relogin = await (await api(value, store, 'startSiwcLogin', { accountRef: account.id })).json();
    const reused = new URL(relogin.authorizationUrl); expect(reused.searchParams.get('client_id')).toBe(clientId); expect(reused.searchParams.get('ext_agent_host_id')).toBe(authorization.searchParams.get('ext_agent_host_id')); expect(reused.searchParams.get('nonce')).not.toBe(nonce);
    nonce = reused.searchParams.get('nonce')!;
    expect((await api(value, store, 'completePkceLogin', { sessionId: relogin.sessionId, callbackUrl: callback(reused.searchParams.get('state')!) })).status).toBe(200);
    const additional = await (await api(value, store, 'startSiwcLogin', {})).json();
    expect(new URL(additional.authorizationUrl).searchParams.get('client_id')).toBe('dynamic_agent_client');
  });

  test('two controls perform a single CAS-fenced SIWC refresh and preserve omitted metadata', async () => {
    const store = new Store(); const accounts = new AccountStore(store); const account = await accounts.create('SIWC', token({ expiresAt: Date.now() + 1 }));
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return response({ access_token: 'fresh', expires_in: 3600 }); };
    const one = control(store, fetchImpl); const two = control(store, fetchImpl);
    const invoke = (value: PluginControl) => value.rpc.find(item => item.name === 'getCredential')!.invoke({}, rpc(store, account.id, 'chatgpt-siwc'));
    const results = await Promise.all([invoke(one), invoke(two)]);
    expect(calls).toBe(1); for (const result of results) expect(result).toMatchObject({ headers: { Authorization: 'Bearer fresh' } });
    expect((await accounts.get(account.id)).siwc).toEqual(account.siwc); expect((await accounts.get(account.id)).refreshToken).toBe(account.refreshToken);
  });

  test('invalid grant/reused refresh fences reauth and never retries on subsequent credential calls', async () => {
    for (const error of ['invalid_grant', 'refresh_token_reused']) {
      const store = new Store(); const accounts = new AccountStore(store); const account = await accounts.create('SIWC', token({ expiresAt: Date.now() + 1 }));
      let calls = 0; const value = control(store, async () => { calls++; return response({ error, secret: 'never log me' }, 400); });
      const get = value.rpc.find(item => item.name === 'getCredential')!;
      for (let i = 0; i < 2; i++) await expect(get.invoke({}, rpc(store, account.id, 'chatgpt-siwc'))).rejects.toMatchObject({ code: 'reauth_required' });
      expect(calls).toBe(1); expect((await accounts.get(account.id)).status).toBe('reauth_required');
    }
  });

  test('SIWC session cancellation, wrong reused client and expiry prevent token exchange/commit', async () => {
    let calls = 0; let now = Date.now();
    const sessions = new LoginSessionManager(new AbortController().signal, { now: () => now, fetchImpl: async () => { calls++; return response({}); } }); managers.push(sessions);
    const cancelled = sessions.startSiwc(hostId); sessions.cancel(cancelled.sessionId);
    await expect(sessions.completeSiwc(cancelled.sessionId, callback())).rejects.toMatchObject({ code: 'cancelled' });
    const mismatch = sessions.startSiwc(hostId, 'account', clientId);
    await expect(sessions.completeSiwc(mismatch.sessionId, callback(new URL(mismatch.authorizationUrl).searchParams.get('state')!, 'oaiapp_other'))).rejects.toMatchObject({ code: 'failed' });
    const expired = sessions.startSiwc(hostId); now += 300_001;
    await expect(sessions.completeSiwc(expired.sessionId, callback())).rejects.toMatchObject({ code: 'expired' });
    expect(calls).toBe(0);
  });

  test('cancelling an exchanging SIWC session prevents account persistence', async () => {
    const store = new Store(); const accounts = new AccountStore(store);
    let entered!: () => void; let release!: () => void;
    const startedFetch = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let nonce = '';
    const sessions = new LoginSessionManager(new AbortController().signal, { fetchImpl: async input => {
      if (String(input) === SIWC_JWKS_URL) return response({ keys: [publicJwk] });
      entered(); await gate; return response(tokenResponse({ id_token: jwt({ nonce }) }));
    } }); managers.push(sessions);
    const started = sessions.startSiwc(hostId); const url = new URL(started.authorizationUrl); nonce = url.searchParams.get('nonce')!;
    const pending = sessions.completeSiwc(started.sessionId, callback(url.searchParams.get('state')!), (fresh, _info, guard) => accounts.create('SIWC', fresh, guard));
    await startedFetch; expect(sessions.cancel(started.sessionId)).toBe(true); release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); expect(await accounts.list()).toEqual([]);
  });

  test('SIWC commit has the original non-cancellable CAS boundary and older relogins stay fenced', async () => {
    const store = new Store(); const accounts = new AccountStore(store);
    let entered!: () => void; let release!: () => void; let nonce = '';
    const committing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sessions = new LoginSessionManager(new AbortController().signal, { fetchImpl: async input => String(input) === SIWC_JWKS_URL ? response({ keys: [publicJwk] }) : response(tokenResponse({ id_token: jwt({ nonce }) })) }); managers.push(sessions);
    const started = sessions.startSiwc(hostId); const url = new URL(started.authorizationUrl); nonce = url.searchParams.get('nonce')!;
    const pending = sessions.completeSiwc(started.sessionId, callback(url.searchParams.get('state')!), async (fresh, _info, guard) => { entered(); await gate; return accounts.create('SIWC', fresh, guard); });
    await committing; expect(sessions.cancel(started.sessionId)).toBe(false); expect(sessions.status(started.sessionId).state).toBe('committing'); release();
    const completed = await pending; expect(sessions.status(started.sessionId).state).toBe('success');
    const account = completed.result!;
    const older = await accounts.reserveRelogin(account.id); const latest = await accounts.reserveRelogin(account.id);
    await expect(accounts.relogin(account.id, token({ accessToken: 'older-login' }), older)).rejects.toMatchObject({ code: 'stale_refresh' });
    await accounts.relogin(account.id, token({ accessToken: 'latest-login' }), latest);
    expect((await accounts.get(account.id)).accessToken).toBe('latest-login');
  });

  test('late SIWC refresh cannot overwrite disabled accounts', async () => {
    const store = new Store(); const accounts = new AccountStore(store); const account = await accounts.create('SIWC', token({ expiresAt: Date.now() + 1 }));
    let entered!: () => void; let release!: () => void;
    const fetched = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const value = control(store, async () => { entered(); await gate; return response({ access_token: 'late-access', expires_in: 3600 }); });
    const pending = value.rpc.find(item => item.name === 'getCredential')!.invoke({}, rpc(store, account.id, 'chatgpt-siwc'));
    await fetched; await accounts.setStatus(account.id, 'disabled'); release();
    await expect(pending).rejects.toMatchObject({ code: 'stale_refresh' });
    expect((await accounts.get(account.id)).status).toBe('disabled'); expect((await accounts.get(account.id)).accessToken).toBe('access-secret');
  });
});
