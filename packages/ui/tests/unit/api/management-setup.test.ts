import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { createManagementSetupContext } from '../../../src/api/management-setup';
import { restoreManagementSession } from '../../../src/api/auth';
import { authMode, isAuthenticated, logout, login, commitAuthMode } from '../../../src/stores/auth';

const originalFetch = globalThis.fetch;
const mode = { mode: 'plugin' as const, initialized: false, publicOrigin: 'https://management.example',
  provider: { name: 'user-auth', loginComponent: 'UserAuthLogin', setupComponent: 'UserAuthSetup' } };
const contexts: Array<{ dispose(): void }> = [];
function context(onCompleted = () => {}) {
  authMode.set(mode);
  const result = createManagementSetupContext({ provider: { name: mode.provider.name, publicOrigin: mode.publicOrigin }, onCompleted });
  contexts.push(result);
  return result;
}
afterEach(() => {
  for (const owned of contexts.splice(0)) owned.dispose();
  globalThis.fetch = originalFetch; logout(); authMode.set(null);
});

test('uninitialized restore stops before verification and does not authenticate', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input)); return Response.json(mode);
  }) as typeof fetch;
  login('previous-credential');
  expect(await restoreManagementSession()).toEqual(mode);
  expect(requests).toEqual(['/api/auth/mode']);
  expect(get(isAuthenticated)).toBe(false);
});

test('missing initialization state fails closed instead of opening setup', async () => {
  globalThis.fetch = (async (_input) => Response.json({ ...mode, initialized: undefined })) as typeof fetch;
  await expect(restoreManagementSession()).rejects.toThrow('management_session_provider_invalid');
  expect(get(authMode)).toBeNull();
});

test('setup posts opaque input at the pinned host endpoint and confirms readiness without logging in', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let initialized = false, completed = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (url === '/api/auth/setup' && init?.method === 'POST') { initialized = true; return Response.json({ success: true }); }
    if (url === '/api/auth/setup') return Response.json({ initialized, provider: mode.provider });
    if (url === '/api/auth/mode') return Response.json({ ...mode, initialized: true });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  login('previous-credential'); logout();
  const owned = context(() => { completed++; });
  expect(await owned.check()).toBe(false);
  const input = { username: 'owner', password: 'fixture-password', passwordConfirmation: 'fixture-password' };
  await owned.context.initialize(input);
  expect(requests.map(item => item.url)).toEqual(['/api/auth/setup', '/api/auth/setup', '/api/auth/setup', '/api/auth/mode']);
  const post = requests[1]!;
  expect(JSON.parse(post.init!.body as string)).toEqual(input);
  for (const { init } of requests) {
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-csrf-token')).toBe(false);
    expect(init?.credentials).toBe('same-origin');
  }
  expect(new Headers(post.init?.headers).get('x-bungee-auth-provider')).toBe('user-auth');
  expect(get(authMode)?.initialized).toBe(true);
  expect(get(isAuthenticated)).toBe(false);
  expect(completed).toBe(1);
});

test('failed setup reads, unready state, and a different provider cannot complete initialization', async () => {
  for (const state of [null, { initialized: false, provider: mode.provider }, { initialized: true, provider: { name: 'other' } }]) {
    let completed = 0;
    const owned = context(() => { completed++; });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') return Response.json({ success: true });
      if (state === null) throw new Error('connection lost');
      return Response.json(state);
    }) as typeof fetch;
    await expect(owned.context.initialize({})).rejects.toThrow();
    expect(get(authMode)?.initialized).toBe(false);
    expect(completed).toBe(0);
    owned.dispose();
  }
});

test('page disposal, auth revision, provider and component changes make pending responses inert', async () => {
  for (const invalidate of [
    (owned: { dispose(): void }) => owned.dispose(),
    () => logout(),
    () => commitAuthMode({ ...mode, provider: { ...mode.provider, name: 'other' } }),
    () => authMode.set({ ...mode, provider: { ...mode.provider, setupComponent: 'OtherSetup' } }),
  ]) {
    let resolvePost!: (value: Response) => void;
    const requests: string[] = [];
    globalThis.fetch = ((input) => {
      requests.push(String(input));
      return new Promise<Response>(resolve => { resolvePost = resolve; });
    }) as typeof fetch;
    let completed = 0;
    const owned = context(() => { completed++; });
    const pending = owned.context.initialize({});
    invalidate(owned);
    resolvePost(Response.json({ success: true }));
    await expect(pending).rejects.toThrow('management_setup_stale');
    expect(requests).toEqual(['/api/auth/setup']);
    expect(completed).toBe(0);
    owned.dispose();
  }
});

test('a setup page opened after initialization confirms state and goes to login without another write', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return Response.json(String(input) === '/api/auth/setup'
      ? { initialized: true, provider: mode.provider } : { ...mode, initialized: true });
  }) as typeof fetch;
  let completed = 0;
  expect(await context(() => { completed++; }).check()).toBe(true);
  expect(requests).toEqual(['/api/auth/setup', '/api/auth/mode']);
  expect(completed).toBe(1); expect(get(isAuthenticated)).toBe(false);
});

test('a lost write acknowledgement and already-initialized response both confirm readiness without signing in', async () => {
  for (const response of ['lost', 'already_initialized'] as const) {
    const requests: string[] = [];
    let completed = 0;
    globalThis.fetch = (async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      if (init?.method === 'POST') {
        if (response === 'lost') throw new Error('acknowledgement lost');
        return Response.json({ error: 'already_initialized' }, { status: 409 });
      }
      return Response.json(String(input) === '/api/auth/setup'
        ? { initialized: true, provider: mode.provider } : { ...mode, initialized: true });
    }) as typeof fetch;
    await context(() => { completed++; }).context.initialize({});
    expect(requests).toEqual(['POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/mode']);
    expect(get(authMode)?.initialized).toBe(true);
    expect(get(isAuthenticated)).toBe(false);
    expect(completed).toBe(1);
  }
});

test('retry resolves an unknown result before any new write, including setup and mode read failures', async () => {
  for (const failedRead of ['setup', 'mode'] as const) {
    const requests: string[] = [];
    let unavailable = true, completed = 0;
    globalThis.fetch = (async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      if (init?.method === 'POST') return Response.json({ success: true });
      if (String(input) === `/api/auth/${failedRead}` && unavailable) {
        return Response.json({ error: 'provider_unavailable' }, { status: 503 });
      }
      return Response.json(String(input) === '/api/auth/setup'
        ? { initialized: true, provider: mode.provider } : { ...mode, initialized: true });
    }) as typeof fetch;
    const owned = context(() => { completed++; });
    await expect(owned.context.initialize({})).rejects.toThrow('provider_unavailable');
    expect(get(authMode)?.initialized).toBe(false);
    await expect(owned.context.initialize({})).rejects.toThrow('provider_unavailable');
    expect(requests.filter(request => request.startsWith('POST'))).toHaveLength(1);
    expect(completed).toBe(0);
    unavailable = false;
    await owned.context.initialize({});
    expect(requests.filter(request => request.startsWith('POST'))).toHaveLength(1);
    expect(requests.slice(-2)).toEqual(['GET /api/auth/setup', 'GET /api/auth/mode']);
    expect(completed).toBe(1);
    expect(get(isAuthenticated)).toBe(false);
  }
});

test('a confirmed uninitialized result permits a deliberate retry and preserves the provider error', async () => {
  const requests: string[] = [];
  let initialized = false, completed = 0;
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`);
    if (init?.method === 'POST') {
      if (!initialized) return Response.json({ error: 'password_confirmation' }, { status: 400 });
      return Response.json({ success: true });
    }
    return Response.json(String(input) === '/api/auth/setup'
      ? { initialized, provider: mode.provider } : { ...mode, initialized });
  }) as typeof fetch;
  const owned = context(() => { completed++; });
  await expect(owned.context.initialize({ username: 'owner', password: 'fixture-password', passwordConfirmation: 'different' })).rejects.toThrow('password_confirmation');
  expect(get(authMode)?.initialized).toBe(false);
  expect(completed).toBe(0);
  initialized = true;
  await owned.context.initialize({ username: 'owner', password: 'fixture-password', passwordConfirmation: 'fixture-password' });
  expect(requests).toEqual(['POST /api/auth/setup', 'GET /api/auth/setup',
    'POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/mode']);
  expect(completed).toBe(1);
});

test('unknown write retries can write again only after a successful uninitialized read', async () => {
  const requests: string[] = [];
  let reads = 0, writes = 0;
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`);
    if (init?.method === 'POST') {
      writes++;
      if (writes === 1) throw new Error('connection lost');
      return Response.json({ success: true });
    }
    if (String(input) === '/api/auth/setup') {
      if (++reads === 1) throw new Error('read lost');
      return Response.json({ initialized: writes === 2, provider: mode.provider });
    }
    return Response.json({ ...mode, initialized: true });
  }) as typeof fetch;
  const owned = context();
  await expect(owned.context.initialize({})).rejects.toThrow('read lost');
  await owned.context.initialize({});
  expect(requests).toEqual(['POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/setup',
    'POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/mode']);
});

test('late confirmation reads after lost acknowledgements cannot survive page or provider changes', async () => {
  for (const phase of ['setup', 'mode'] as const) {
    for (const invalidate of [
      (owned: { dispose(): void }) => owned.dispose(),
      () => logout(),
      () => authMode.set({ ...mode, provider: { ...mode.provider, name: 'other' } }),
      () => authMode.set({ ...mode, provider: { ...mode.provider, loginComponent: 'OtherLogin' } }),
      () => authMode.set({ ...mode, provider: { ...mode.provider, setupComponent: 'OtherSetup' } }),
      () => authMode.set({ ...mode, publicOrigin: 'https://other.example' }),
    ]) {
      let release!: (value: Response) => void, started!: () => void;
      const reading = new Promise<void>(resolve => { started = resolve; });
      const requests: string[] = [];
      globalThis.fetch = (async (input, init) => {
        requests.push(`${init?.method ?? 'GET'} ${input}`);
        if (init?.method === 'POST') throw new Error('acknowledgement lost');
        if (String(input) === `/api/auth/${phase}`) {
          started(); return new Promise<Response>(resolve => { release = resolve; });
        }
        return Response.json({ initialized: true, provider: mode.provider });
      }) as typeof fetch;
      let completed = 0;
      const owned = context(() => { completed++; });
      const pending = owned.context.initialize({});
      await reading;
      invalidate(owned);
      release(Response.json(phase === 'setup'
        ? { initialized: true, provider: mode.provider } : { ...mode, initialized: true }));
      await expect(pending).rejects.toThrow('management_setup_stale');
      expect(completed).toBe(0);
      expect(requests).not.toContain('POST /api/auth/login');
      owned.dispose();
    }
  }
});

test('ready setup still requires the same ready provider, origin and components in auth mode', async () => {
  for (const observed of [
    { ...mode, initialized: false },
    { ...mode, initialized: true, publicOrigin: 'https://other.example' },
    { ...mode, initialized: true, provider: { ...mode.provider, name: 'other' } },
    { ...mode, initialized: true, provider: { ...mode.provider, loginComponent: 'OtherLogin' } },
    { ...mode, initialized: true, provider: { ...mode.provider, setupComponent: 'OtherSetup' } },
  ]) {
    let completed = 0;
    globalThis.fetch = (async (input, init) => {
      if (init?.method === 'POST') throw new Error('acknowledgement lost');
      return Response.json(String(input) === '/api/auth/setup'
        ? { initialized: true, provider: mode.provider } : observed);
    }) as typeof fetch;
    const owned = context(() => { completed++; });
    await expect(owned.context.initialize({})).rejects.toThrow('management_setup_verify_mismatch');
    expect(get(authMode)?.initialized).toBe(false);
    expect(get(isAuthenticated)).toBe(false);
    expect(completed).toBe(0);
    owned.dispose();
  }
});

test('concurrent initialization and status checks cannot replace an active operation', async () => {
  let release!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`);
    if (init?.method === 'POST') return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(String(input) === '/api/auth/setup'
      ? { initialized: true, provider: mode.provider } : { ...mode, initialized: true });
  }) as typeof fetch;
  let completed = 0;
  const owned = context(() => { completed++; });
  const pending = owned.context.initialize({});
  await expect(owned.context.initialize({})).rejects.toThrow('management_setup_busy');
  await expect(owned.check()).rejects.toThrow('management_setup_busy');
  release(Response.json({ success: true }));
  await pending;
  expect(completed).toBe(1);
  expect(requests).toEqual(['POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/mode']);
});
