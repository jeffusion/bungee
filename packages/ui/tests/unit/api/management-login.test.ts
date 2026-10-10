import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { authMode, beginAuthenticationHandoff, commitAuthMode, getToken, isAuthenticated, logout, login, subject } from '../../../src/stores/auth';
import { createManagementLoginContext } from '../../../src/api/management-login';
import { restoreManagementSession, endSession, verifyToken } from '../../../src/api/auth';
import { isManagementLoginStaleError } from '../../../src/plugin-sdk/management-login';

const originalFetch = globalThis.fetch;
const contexts: Array<{ dispose(): void }> = [];
const providerMode = { mode: 'plugin' as const, provider: { name: 'local-accounts' }, publicOrigin: 'https://management.example' };

function setup(): void {
  authMode.set(providerMode);
}

function context(onAuthenticated: (isCurrent: () => boolean) => Promise<boolean> = async () => true, onCompleted?: () => void) {
  const created = createManagementLoginContext({
    provider: { name: providerMode.provider.name, publicOrigin: providerMode.publicOrigin },
    onAuthenticated,
    onCompleted,
  });
  contexts.push(created);
  return created;
}

function successfulFetch(calls: string[] = []): void {
  globalThis.fetch = (async (input, _init) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/auth/login') return Response.json({ accepted: true });
    if (url === '/api/auth/mode') return Response.json(providerMode);
    if (url === '/api/auth/verify') return Response.json({ success: true, mode: 'plugin', subject: { id: 'admin', provider: 'local-accounts' }, csrfToken: 'csrf' });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}

async function expectStale(operation: Promise<unknown>): Promise<void> {
  let error: unknown;
  try { await operation; } catch (caught) { error = caught; }
  expect(isManagementLoginStaleError(error)).toBe(true);
}

afterEach(() => {
  for (const item of contexts.splice(0)) item.dispose();
  globalThis.fetch = originalFetch;
  logout();
  authMode.set(null);
});

test('provider verification mismatch cannot commit an anonymous successful verify', async () => {
  setup();
  const onAuthenticated = () => Promise.resolve(true);
  const { context: capability } = context(onAuthenticated);
  globalThis.fetch = (async (input) => {
    if (String(input) === '/api/auth/login') return Response.json({ accepted: true });
    if (String(input) === '/api/auth/mode') return Response.json({ mode: 'anonymous' });
    if (String(input) === '/api/auth/verify') return Response.json({ success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous', capabilities: [] } });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;

  await capability.login({ opaque: 'plugin-owned' });
  await expect(capability.complete()).rejects.toThrow('management_login_verify_mismatch');
  expect(get(isAuthenticated)).toBe(false);
  expect(get(subject)).toBeNull();
});

test('initial restore accepts verified anonymous mode and rejects a mismatched plugin subject', async () => {
  const anonymousSubject = { id: 'anonymous', provider: 'anonymous', capabilities: [] };
  globalThis.fetch = (async input => {
    if (String(input) === '/api/auth/mode') return Response.json({ mode: 'anonymous' });
    if (String(input) === '/api/auth/verify') return Response.json({ success: true, mode: 'anonymous', subject: anonymousSubject });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;
  expect((await restoreManagementSession()).mode).toBe('anonymous');
  expect(get(isAuthenticated)).toBe(true);
  expect(get(subject)).toEqual(anonymousSubject);

  logout();
  globalThis.fetch = (async input => {
    if (String(input) === '/api/auth/mode') return Response.json({ mode: 'anonymous' });
    if (String(input) === '/api/auth/verify') return Response.json({ success: true, mode: 'anonymous' });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;
  await restoreManagementSession();
  expect(get(isAuthenticated)).toBe(true);
  expect(get(subject)).toBeNull();

  logout();
  globalThis.fetch = (async input => {
    if (String(input) === '/api/auth/mode') return Response.json(providerMode);
    if (String(input) === '/api/auth/verify') return Response.json({ success: true, mode: 'plugin', subject: { id: 'other', provider: 'different-provider' } });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;
  await expect(restoreManagementSession()).rejects.toThrow('management_session_verify_mismatch');
  expect(get(isAuthenticated)).toBe(false);
  expect(get(subject)).toBeNull();
});

test('late mode response after logout or a newer handoff cannot restore a session', async () => {
  for (const invalidate of [logout, () => { const end = beginAuthenticationHandoff(); end(); }]) {
    setup();
    let resolveMode!: (response: Response) => void;
    globalThis.fetch = ((input) => {
      if (String(input) === '/api/auth/login') return Promise.resolve(Response.json({ accepted: true }));
      if (String(input) === '/api/auth/mode') return new Promise<Response>(resolve => { resolveMode = resolve; });
      if (String(input) === '/api/auth/verify') return Promise.resolve(Response.json({ success: true, mode: 'plugin', subject: { id: 'admin', provider: 'local-accounts' } }));
      throw new Error(`Unexpected request ${String(input)}`);
    }) as typeof fetch;
    const { context: capability } = context();
    await capability.login({});
    const completion = capability.complete();
    await Promise.resolve();
    invalidate();
    resolveMode(Response.json(providerMode));
    await expectStale(completion);
    expect(get(isAuthenticated)).toBe(false);
    expect(get(subject)).toBeNull();
    expect(get(authMode)).toEqual(providerMode);
  }
});

test('disposing a provider page makes its pending successful verification inert', async () => {
  setup();
  let resolveMode!: (response: Response) => void;
  globalThis.fetch = ((input) => {
    if (String(input) === '/api/auth/login') return Promise.resolve(Response.json({ accepted: true }));
    if (String(input) === '/api/auth/mode') return new Promise<Response>(resolve => { resolveMode = resolve; });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;
  const created = context();
  await created.context.login({});
  const completion = created.context.complete();
  await Promise.resolve();
  created.dispose();
  resolveMode(Response.json(providerMode));
  await expectStale(completion);
  expect(get(isAuthenticated)).toBe(false);
  expect(get(subject)).toBeNull();
  expect(get(authMode)).toEqual(providerMode);
});

test('a successful verify arriving after a competing authentication handoff is ignored', async () => {
  setup();
  let resolveVerify!: (response: Response) => void;
  let signalVerifyStarted!: () => void;
  const verifyStarted = new Promise<void>(resolve => { signalVerifyStarted = resolve; });
  globalThis.fetch = ((input) => {
    if (String(input) === '/api/auth/login') return Promise.resolve(Response.json({ accepted: true }));
    if (String(input) === '/api/auth/mode') return Promise.resolve(Response.json(providerMode));
    if (String(input) === '/api/auth/verify') return new Promise<Response>(resolve => { resolveVerify = resolve; signalVerifyStarted(); });
    throw new Error(`Unexpected request ${String(input)}`);
  }) as typeof fetch;
  const { context: capability } = context();
  await capability.login({});
  const completion = capability.complete();
  await verifyStarted;
  const endNewHandoff = beginAuthenticationHandoff();
  resolveVerify(Response.json({ success: true, mode: 'plugin', subject: { id: 'admin', provider: 'local-accounts' } }));
  await expectStale(completion);
  endNewHandoff();
  expect(get(isAuthenticated)).toBe(false);
  expect(get(subject)).toBeNull();
  expect(get(authMode)).toEqual(providerMode);
});

test('legacy bearer to cookie login to mode/verify commit never sends old bearer', async () => {
  setup();
  login('old-bearer-secret');
  authMode.set(providerMode);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === '/api/auth/login') return Response.json({ accepted: true });
    if (url === '/api/auth/mode') return Response.json(providerMode);
    if (url === '/api/auth/verify') return Response.json({ success: true, mode: 'plugin', subject: { id: 'admin', provider: 'local-accounts' } });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  let completed = 0;
  const { context: capability } = context(async () => true, () => { completed++; });
  await capability.login({ opaquePluginInput: true });
  await capability.complete();
  expect(requests.map(({ url }) => url)).toEqual(['/api/auth/login', '/api/auth/mode', '/api/auth/verify']);
  for (const { url, init } of requests) {
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-csrf-token')).toBe(false);
    expect(init?.credentials).toBe('same-origin');
    if (url === '/api/auth/login') expect(headers.get('x-bungee-auth-provider')).toBe('local-accounts');
  }
  expect(getToken()).toBeNull();
  expect(get(isAuthenticated)).toBe(true);
  expect(completed).toBe(1);
});

test('legacy verifyToken keeps its bearer transport for existing SDK callers', async () => {
  login('legacy-sdk-token');
  let headers: Headers | undefined;
  globalThis.fetch = (async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ success: true, mode: 'plugin', subject: { id: 'admin', provider: 'local-accounts' } });
  }) as typeof fetch;
  await verifyToken();
  expect(headers?.get('authorization')).toBe('Bearer legacy-sdk-token');
  expect(getToken()).toBe('legacy-sdk-token');
});

test('browser session restore reads mode and verify with cookies only, then clears legacy bearer', async () => {
  login('legacy-browser-token');
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === '/api/auth/mode') return Response.json({ mode: 'anonymous' });
    if (url === '/api/auth/verify') return Response.json({ success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous', capabilities: [] } });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  await restoreManagementSession();
  expect(requests.map(({ url }) => url)).toEqual(['/api/auth/mode', '/api/auth/verify']);
  for (const { init } of requests) expect(new Headers(init?.headers).has('authorization')).toBe(false);
  expect(getToken()).toBeNull();
});

test('concurrent and repeated complete share one verification and protected initialization', async () => {
  setup();
  const calls: string[] = [];
  successfulFetch(calls);
  let initialized = 0;
  let navigated = 0;
  const { context: capability } = context(async () => { initialized++; return true; }, () => { navigated++; });
  await capability.login({});
  const one = capability.complete();
  const two = capability.complete();
  expect(two).toBe(one);
  await Promise.all([one, two]);
  await capability.complete();
  expect(calls.filter(url => url === '/api/auth/mode')).toHaveLength(1);
  expect(calls.filter(url => url === '/api/auth/verify')).toHaveLength(1);
  expect(initialized).toBe(1);
  expect(navigated).toBe(1);
  expect(get(isAuthenticated)).toBe(true);
  expect(get(subject)).toEqual({ id: 'admin', provider: 'local-accounts' });
});

test('same provider mode refresh does not invalidate a page-scoped context', async () => {
  setup();
  successfulFetch();
  let completed = 0;
  const { context: capability } = context(async () => true, () => { completed++; });
  commitAuthMode({ ...providerMode, initialized: true });
  await capability.login({});
  await capability.complete();
  expect(completed).toBe(1);
});

test('failed protected initialization clears pending complete and can retry without another login', async () => {
  for (const initialize of [async () => false, async () => { throw new Error('initializer failed'); }]) {
    setup();
    const requests: string[] = [];
    successfulFetch(requests);
    let initAttempts = 0;
    let navigated = 0;
    const { context: capability } = context(async () => {
      initAttempts++;
      if (initAttempts === 1) return initialize();
      return true;
    }, () => { navigated++; });
    await capability.login({});
    const completion = capability.complete();
    await expect(completion).rejects.toThrow();
    await capability.complete();
    await capability.complete();
    expect(initAttempts).toBe(2);
    expect(navigated).toBe(1);
    expect(requests.filter(url => url === '/api/auth/login')).toHaveLength(1);
  }
});

test('synchronous completion callback failure remains retryable and only successful retry becomes idempotent', async () => {
  setup();
  const requests: string[] = [];
  successfulFetch(requests);
  let completionCalls = 0;
  const { context: capability } = context(async () => true, () => {
    completionCalls++;
    if (completionCalls === 1) throw new Error('navigation callback failed');
  });
  await capability.login({});

  await expect(capability.complete()).rejects.toThrow('management_login_completion_failed');
  await capability.complete();
  await capability.complete();

  expect(completionCalls).toBe(2);
  expect(requests.filter(url => url === '/api/auth/login')).toHaveLength(1);
});

test('stale login success and failure reject with the SDK stale code', async () => {
  for (const status of [200, 401]) {
    setup();
    let resolveLogin!: (response: Response) => void;
    globalThis.fetch = Object.assign(
      () => new Promise<Response>(resolve => { resolveLogin = resolve; }),
      { preconnect: originalFetch.preconnect },
    );
    const { context: capability } = context();
    const loginRequest = capability.login({});
    await Promise.resolve();
    logout();
    resolveLogin(status === 200 ? Response.json({ accepted: true }) : Response.json({ error: 'unauthorized' }, { status }));
    await expectStale(loginRequest);
    expect(get(isAuthenticated)).toBe(false);
    expect(get(subject)).toBeNull();
  }
});

test('newest parallel session restore wins; superseded success and failure use stale code', async () => {
  const anonymousSubject = { id: 'anonymous', provider: 'anonymous', capabilities: [] };
  for (const failOld of [false, true]) {
    const modeResolvers: Array<{ resolve(value: Response): void; reject(error: Error): void }> = [];
    globalThis.fetch = ((input) => {
      if (String(input) === '/api/auth/mode') return new Promise<Response>((resolve, reject) => modeResolvers.push({ resolve, reject }));
      if (String(input) === '/api/auth/verify') return Promise.resolve(Response.json({ success: true, mode: 'anonymous', subject: anonymousSubject }));
      throw new Error(`Unexpected request ${String(input)}`);
    }) as typeof fetch;

    const oldRestore = restoreManagementSession();
    await Promise.resolve();
    const latestRestore = restoreManagementSession();
    await Promise.resolve();
    if (failOld) modeResolvers[0]!.reject(new Error('old network failure'));
    else modeResolvers[0]!.resolve(Response.json({ mode: 'anonymous' }));
    await expectStale(oldRestore);
    modeResolvers[1]!.resolve(Response.json({ mode: 'anonymous' }));
    expect((await latestRestore).mode).toBe('anonymous');
    expect(get(isAuthenticated)).toBe(true);
    expect(get(subject)).toEqual(anonymousSubject);
  }
});

test('logout, mode change, or a newer handoff during initialization blocks completion navigation', async () => {
  const invalidations: Array<() => void> = [
    () => logout(),
    () => commitAuthMode({ ...providerMode, provider: { name: 'other-provider' } }),
    () => { const end = beginAuthenticationHandoff(); end(); },
  ];
  for (const invalidate of invalidations) {
    setup();
    successfulFetch();
    let resolveInitialization!: (value: boolean) => void;
    let entered!: () => void;
    const enteredInitialization = new Promise<void>(resolve => { entered = resolve; });
    let isCurrentDuringInitialization!: () => boolean;
    let navigationCount = 0;
    const { context: capability } = context(isCurrent => {
      isCurrentDuringInitialization = isCurrent;
      entered();
      return new Promise<boolean>(resolve => { resolveInitialization = resolve; });
    }, () => { navigationCount++; });
    await capability.login({});
    const completion = capability.complete();
    await enteredInitialization;
    invalidate();
    expect(isCurrentDuringInitialization()).toBe(false);
    resolveInitialization(true);
    await expectStale(completion);
    expect(navigationCount).toBe(0);
    if (get(authMode)?.provider?.name === 'other-provider') expect(get(isAuthenticated)).toBe(true);
  }
});

test('endSession response cannot clear a session established while logout is pending', async () => {
  setup();
  login('old-session-token');
  let resolveLogout!: (response: Response) => void;
  globalThis.fetch = Object.assign(
    () => new Promise<Response>(resolve => { resolveLogout = resolve; }),
    { preconnect: originalFetch.preconnect },
  );
  const ending = endSession();
  await Promise.resolve();
  login('new-session-token');
  resolveLogout(Response.json({ ok: true }));
  await ending;
  expect(getToken()).toBe('new-session-token');
  expect(get(isAuthenticated)).toBe(true);
});
