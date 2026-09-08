import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { ControlHostContext, ControlRpcContext, SecretStore, SecretValue } from '../../../packages/core/src/plugin-control/contracts';
import { parseNormalizeCompile } from '../../../packages/core/src/config-storage/compiler';
import { validatePluginOptions } from '../../../packages/core/src/config-storage/plugin-schema';
import { ValidationContext } from '../../../packages/core/src/config-storage/validation';
import { parsePluginManifestText } from '../../../packages/core/src/plugin-manifest-catalog';
import { AccountStore } from '../server/accounts';
import { createControl } from '../server/control';
import { LoginSessionManager } from '../server/sessions';
import { CODEX_REDIRECT_URI } from '../server/oauth';
import type { CodexTokenSet } from '../server/oauth';

// Contract-faithful fake: SQLite encryption/CAS is covered by core's integration suite;
// these tests exercise the plugin through its public API/RPC declarations.
class FakeSecretStore implements SecretStore {
  readonly namespace = 'test';
  private value: SecretValue | null = null;
  async get(): Promise<SecretValue | null> { return this.value && { ...this.value }; }
  async compareAndSet(_key: string, expectedVersion: number | null, value: string): Promise<number> {
    if ((this.value?.version ?? null) !== expectedVersion) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    const version = (this.value?.version ?? 0) + 1;
    this.value = { version, value };
    return version;
  }
  async delete(): Promise<void> { this.value = null; }
}

function token(expiresAtOrOverrides?: number | Partial<CodexTokenSet>): CodexTokenSet {
  const overrides = typeof expiresAtOrOverrides === 'object' && expiresAtOrOverrides !== null ? expiresAtOrOverrides : {};
  const expiresAt = typeof expiresAtOrOverrides === 'number' ? expiresAtOrOverrides : undefined;
  return {
    accessToken: 'old-access', refreshToken: 'old-refresh',
    ...(arguments.length === 0 ? { expiresAt: Date.now() + 1 } : expiresAt === undefined ? {} : { expiresAt }),
    identity: { accountId: 'acct-a' }, identityStatus: 'parsed',
    ...overrides,
  };
}

function host(store: SecretStore, signal = new AbortController().signal): ControlHostContext {
  return { signal, secretStore: store };
}

function rpcContext(store: SecretStore, accountRef: string, signal = new AbortController().signal): ControlRpcContext {
  return {
    ...host(store, signal),
    binding: { plugin: 'chatgpt-oauth', contributionId: 'upstream', bindingId: `binding-${accountRef}`, bindingOptions: { accountRef } },
    attempt: { attemptId: 'attempt-1', clientStreaming: false, signal, boundClient: { call: async <T>(): Promise<T> => undefined as T } },
  };
}

describe('ChatGPT control', () => {
  test('getCredential uses trusted binding accountRef rather than client payload', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token(Date.now() + 3_600_000));
    const first = createControl(host(store));
    const get = (control: ReturnType<typeof createControl>, context: ControlRpcContext, payload: unknown) => control.rpc.find((item) => item.name === 'getCredential')?.invoke(payload, context) as Promise<unknown>;
    await expect(get(first, rpcContext(store, account.id), { accountRef: 'evil', target: 'evil' })).resolves.toMatchObject({ headers: { Authorization: 'Bearer old-access' } });
    await first.dispose();
  });

  test('account list and draft are redacted and contain no aggregate or token', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    const control = createControl(host(store));
    const invoke = (handler: string, request: Request) => control.api.find((item) => item.handler === handler)?.invoke({ ...host(store), request, requestSignal: new AbortController().signal });
    const list = await invoke('listAccounts', new Request('http://localhost/accounts', { method: 'GET' }));
    const listText = await (list as Response).text();
    expect(listText).toContain(account.id);
    expect(listText).not.toContain('old-access');
    expect(listText).not.toContain('old-refresh');
    const draft = await invoke('createDraft', new Request('http://localhost/accounts/draft', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }));
    expect(await (draft as Response).json()).toEqual({
      target: 'https://chatgpt.com',
      bindingOptions: { accountRef: account.id },
    });
    await control.dispose();
  });

  test('createDraft output applies and compiles without a user-entered client version', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token(Date.now() + 3_600_000));
    const control = createControl(host(store));
    const handler = control.api.find((item) => item.handler === 'createDraft')!;
    const response = await handler.invoke({
      ...host(store),
      request: new Request('http://localhost/accounts/draft', {
        method: 'POST', body: JSON.stringify({ accountRef: account.id }),
      }),
      requestSignal: new AbortController().signal,
    });
    const draft = await response.json() as { target: string; bindingOptions: Record<string, string> };
    const manifest = parsePluginManifestText(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const catalog = new Map([[manifest.name, manifest.configSchema]]);
    const optionsContext = new ValidationContext();
    validatePluginOptions(manifest.name, draft.bindingOptions, 'plugins[0]', catalog, optionsContext);
    expect(optionsContext.errors).toEqual([]);

    // This is the editor's apply shape, kept local so the test does not bypass the control contract.
    const compiled = parseNormalizeCompile({
      plugins: [{ id: crypto.randomUUID(), name: manifest.name, options: draft.bindingOptions }],
    }, { pluginSchemas: catalog });
    expect(compiled.ok).toBe(true);
    for (const accountRef of [` ${account.id}`, `${account.id} `]) {
      const rejected = parseNormalizeCompile({
        plugins: [{ id: crypto.randomUUID(), name: manifest.name, options: { accountRef } }],
      }, { pluginSchemas: catalog });
      expect(rejected).toMatchObject({
        ok: false,
        errors: [{ code: 'invalid_plugin_option', path: 'plugins[0].options.accountRef' }],
      });
    }
    await control.dispose();
  });

  test('PKCE API commits a new account and callback retry is idempotent', async () => {
    const store = new FakeSecretStore();
    const idToken = `x.${Buffer.from(JSON.stringify({ email: 'a@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a' } })).toString('base64url')}.x`;
    const control = createControl(host(store), { fetchImpl: async () => new Response(JSON.stringify({ access_token: 'api-access', refresh_token: 'api-refresh', expires_in: 3600, id_token: idToken }), { status: 200 }) });
    const handler = (name: string) => control.api.find((item) => item.handler === name)!;
    const start = await handler('startPkceLogin').invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST' }), requestSignal: new AbortController().signal });
    const started = await (start as Response).json() as { sessionId: string; authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const body = JSON.stringify({ sessionId: started.sessionId, callbackUrl: `${CODEX_REDIRECT_URI}?state=${state}&code=abc` });
    const completed = await handler('completePkceLogin').invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body }), requestSignal: new AbortController().signal });
    expect(completed.status).toBe(200);
    expect((await (completed as Response).json()).account.status).toBe('active');
    const retry = await handler('completePkceLogin').invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body }), requestSignal: new AbortController().signal });
    const status = await (retry as Response).json();
    expect(status.state).toBe('success');
    expect(status.account.accountId).toBe('acct-a');
    await control.dispose();
  });

  test('PKCE session is single-consume and cancellation wins before exchange', async () => {
    const controller = new AbortController();
    const sessions = new LoginSessionManager(controller.signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 }),
    });
    const started = sessions.startPkce('account-1');
    expect(sessions.cancel(started.sessionId)).toBe(true);
    await expect(sessions.completePkce(started.sessionId, `${started.authorizationUrl}&code=abc`)).rejects.toMatchObject({ code: 'cancelled' });
    sessions.dispose();
  });

  test('dispose prevents a pending session from completing', async () => {
    const controller = new AbortController();
    const sessions = new LoginSessionManager(controller.signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' }), { status: 200 }),
    });
    const started = sessions.startPkce('account-1');
    sessions.dispose();
    await expect(sessions.completePkce(started.sessionId, `${started.authorizationUrl}&code=abc`)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('enable cannot revive a reauth-required account', async () => {
    const accounts = new AccountStore(new FakeSecretStore());
    const account = await accounts.create('A', token());
    await accounts.setStatus(account.id, 'reauth_required');
    await expect(accounts.enable(account.id)).rejects.toMatchObject({ code: 'reauth_required' });
  });

  test('createDraft requires an active available account', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    const control = createControl(host(store));
    await new AccountStore(store).setStatus(account.id, 'disabled');
    const handler = control.api.find((item) => item.handler === 'createDraft') as NonNullable<typeof control.api[number]>;
    const response = await handler.invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }), requestSignal: new AbortController().signal });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'disabled' });
    await control.dispose();
  });

  test('unknown expiry never returns an unbounded credential lease', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token(undefined));
    const control = createControl(host(store));
    const rpc = control.rpc.find((item) => item.name === 'getCredential')!;
    await expect(rpc.invoke({}, rpcContext(store, account.id))).rejects.toMatchObject({ code: 'reauth_required' });
    await control.dispose();
  });

  test('refresh without expiry stores rotation but returns controlled reauth', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    const control = createControl(host(store), { fetchImpl: async () => new Response(JSON.stringify({ access_token: 'rotated', refresh_token: 'rotated-refresh' }), { status: 200 }) });
    await expect(control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id))).rejects.toMatchObject({ code: 'reauth_required' });
    const saved = await new AccountStore(store).get(account.id);
    expect(saved.status).toBe('reauth_required');
    expect(saved.accessToken).toBe('rotated');
    await control.dispose();
  });

  test('refresh_token_reused cannot overwrite revoked state', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token());
    let resolveFetch: ((response: Response) => void) | undefined;
    const control = createControl(host(store), { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const pending = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await accounts.setStatus(account.id, 'revoked');
    resolveFetch?.(new Response(JSON.stringify({ error: 'refresh_token_reused' }), { status: 400 }));
    await expect(pending).rejects.toMatchObject({ code: 'revoked' });
    expect((await accounts.get(account.id)).status).toBe('revoked');
    await control.dispose();
  });

  test('two worker-equivalent controls perform one CAS-fenced refresh', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }), { status: 200 });
    };
    const one = createControl(host(store), { fetchImpl });
    const two = createControl(host(store), { fetchImpl });
    const p1 = one.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    const p2 = two.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    const [lease1, lease2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect((lease1 as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer fresh-access');
    expect((lease2 as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer fresh-access');
    await one.dispose(); await two.dispose();
  });

  test('one waiter cancellation does not abort the shared refresh', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    let resolveFetch: ((response: Response) => void) | undefined;
    const control = createControl(host(store), { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const firstSignal = new AbortController();
    const first = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id, firstSignal.signal));
    const second = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    firstSignal.abort();
    await expect(first).rejects.toMatchObject({ code: 'request_cancelled' });
    resolveFetch?.(new Response(JSON.stringify({ access_token: 'shared-access', refresh_token: 'shared-refresh', expires_in: 3600 }), { status: 200 }));
    await expect(second).resolves.toMatchObject({ headers: { Authorization: 'Bearer shared-access' } });
    await control.dispose();
  });

  test('old rejectAccess generation cannot fence a newer token', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token(Date.now() + 3600_000));
    const oldGeneration = account.generation;
    const lock = await accounts.acquireRefresh(account.id, 'test-owner', Date.now() + 1000);
    await accounts.replaceCredentials(account.id, token({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 }), { owner: 'test-owner', generation: lock.account.generation });
    const control = createControl(host(store));
    const rejected = await control.rpc.find((item) => item.name === 'rejectAccess')!.invoke({ version: oldGeneration }, rpcContext(store, account.id));
    expect(rejected).toEqual({ rejected: false });
    expect((await accounts.get(account.id)).accessToken).toBe('new-access');
    await control.dispose();
  });

  test('late refresh success cannot overwrite disable or newer relogin', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token());
    let resolveFetch: ((response: Response) => void) | undefined;
    const control = createControl(host(store), { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const pending = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fence = await accounts.reserveRelogin(account.id);
    await accounts.relogin(account.id, token({ accessToken: 'new-login' }), fence);
    resolveFetch?.(new Response(JSON.stringify({ access_token: 'late-refresh', refresh_token: 'late-refresh', expires_in: 3600 }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ code: 'stale_refresh' });
    expect((await accounts.get(account.id)).accessToken).toBe('new-login');
    await control.dispose();
  });

  test('late refresh failure preserves disabled terminal state', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token());
    let resolveFetch: ((response: Response) => void) | undefined;
    const control = createControl(host(store), { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const pending = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await accounts.setStatus(account.id, 'disabled');
    resolveFetch?.(new Response('upstream unavailable', { status: 503 }));
    await expect(pending).rejects.toMatchObject({ code: 'disabled' });
    expect((await accounts.get(account.id)).status).toBe('disabled');
    await control.dispose();
  });

  test('cancel wins after exchange has claimed the session', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const sessions = new LoginSessionManager(new AbortController().signal, { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const started = sessions.startPkce('account-1');
    const pending = sessions.completePkce(started.sessionId, `${CODEX_REDIRECT_URI}?state=${new URL(started.authorizationUrl).searchParams.get('state')}&code=abc`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.cancel(started.sessionId)).toBe(true);
    resolveFetch?.(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    sessions.dispose();
  });

  test('successful login is consumed exactly once', async () => {
    const sessions = new LoginSessionManager(new AbortController().signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 }),
    });
    const started = sessions.startPkce();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const callback = `${CODEX_REDIRECT_URI}?state=${state}&code=abc`;
    await sessions.completePkce(started.sessionId, callback);
    await expect(sessions.completePkce(started.sessionId, callback)).rejects.toMatchObject({ code: 'already_consumed' });
    sessions.dispose();
  });

  test('committing session cannot be cancelled or report a false rollback', async () => {
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const commitReady = new Promise<void>((resolve) => { commitStarted = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const sessions = new LoginSessionManager(new AbortController().signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 }),
    });
    const started = sessions.startPkce();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const pending = sessions.completePkce(started.sessionId, `${CODEX_REDIRECT_URI}?state=${state}&code=abc`, async (_token, _info, canCommit) => {
      commitStarted();
      await commitGate;
      if (!canCommit()) throw new Error('commit_cancelled');
      return { committed: true };
    });
    await commitReady;
    expect(sessions.status(started.sessionId).state).toBe('committing');
    expect(sessions.cancel(started.sessionId)).toBe(false);
    releaseCommit();
    await expect(pending).resolves.toMatchObject({ result: { committed: true } });
    expect(sessions.status(started.sessionId).state).toBe('success');
    sessions.dispose();
  });

  test('device session reserves its slot before its network request', async () => {
    let calls = 0;
    let resolveFetch: ((response: Response) => void) | undefined;
    const sessions = new LoginSessionManager(new AbortController().signal, { maxSessions: 1, fetchImpl: () => { calls++; return new Promise((resolve) => { resolveFetch = resolve; }); } });
    const first = sessions.startDevice();
    await expect(sessions.startDevice()).rejects.toMatchObject({ code: 'busy' });
    expect(calls).toBe(1);
    resolveFetch?.(new Response(JSON.stringify({ device_auth_id: 'secret', user_code: 'visible', interval: 0.25 }), { status: 200 }));
    expect((await first).userCode).toBe('visible');
    sessions.dispose();
  });

  test('request body limit is enforced while streaming', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token(Date.now() + 3600_000));
    const control = createControl(host(store));
    const handler = control.api.find((item) => item.handler === 'createDraft')!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); controller.close(); },
    });
    const response = await handler.invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit), requestSignal: new AbortController().signal });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'body_limit' });
    expect(account.id).toBeString();
    await control.dispose();
  });

  test('dispose aborts refresh and fences a non-cooperative late response', async () => {
    const store = new FakeSecretStore();
    const account = await new AccountStore(store).create('A', token());
    let resolveFetch: ((response: Response) => void) | undefined;
    const control = createControl(host(store), { fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    const pending = control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await control.dispose();
    resolveFetch?.(new Response(JSON.stringify({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
    expect((await new AccountStore(store).get(account.id)).accessToken).toBe('old-access');
  });

  test('reauth_required stays unusable after disable then enable', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token(Date.now() + 3600_000));
    const control = createControl(host(store));
    const rejected = await control.rpc.find((item) => item.name === 'rejectAccess')!.invoke({ version: account.generation }, rpcContext(store, account.id));
    expect(rejected).toEqual({ rejected: true });
    const disable = control.api.find((item) => item.handler === 'disableAccount')!;
    await disable.invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }), requestSignal: new AbortController().signal });
    const enable = control.api.find((item) => item.handler === 'enableAccount')!;
    const response = await enable.invoke({ ...host(store), request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }), requestSignal: new AbortController().signal });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'reauth_required' });
    await expect(control.rpc.find((item) => item.name === 'getCredential')!.invoke({}, rpcContext(store, account.id))).rejects.toMatchObject({ code: 'disabled' });
    await control.dispose();
  });

  test('background device failure is visible and not left pending', async () => {
    let call = 0;
    const sessions = new LoginSessionManager(new AbortController().signal, {
      fetchImpl: async () => call++ === 0
        ? new Response(JSON.stringify({ device_auth_id: 'secret', user_code: 'visible', interval: 0.25 }), { status: 200 })
        : new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }),
    });
    const start = await sessions.startDevice();
    await expect(sessions.completeDevice(start.sessionId)).rejects.toMatchObject({ code: 'failed' });
    expect(sessions.status(start.sessionId).state).toBe('failed');
    sessions.dispose();
  });

  test('dispose cancels an API reader that never ends', async () => {
    const store = new FakeSecretStore();
    await new AccountStore(store).create('A', token(Date.now() + 3600_000));
    const lifetime = new AbortController();
    const control = createControl({ signal: lifetime.signal, secretStore: store });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
    const handler = control.api.find((item) => item.handler === 'createDraft')!;
    const request = handler.invoke({ signal: lifetime.signal, secretStore: store, request: new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit), requestSignal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await control.dispose();
    await expect(request).resolves.toMatchObject({ status: 409 });
    expect(cancelled).toBe(true);
  });
});
