import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { endSession } from './auth';
import { api } from './client';
import { authMode, beginAuthenticationHandoff, commitManagementSession, csrfToken, getAuthStateRevision, isAuthenticated, isAuthenticationStateCurrent, logout, subject, token } from '../stores/auth';

const originalFetch = globalThis.fetch;
const mode = { mode: 'plugin' as const, provider: { name: 'example-provider' }, publicOrigin: 'https://management.example' };
function setup(id = 'admin') {
  commitManagementSession(mode, { success: true, subject: { id, provider: mode.provider.name }, csrfToken: 'cookie-csrf' });
}
function respond(fn: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input, init) => Promise.resolve(fn(String(input), init))) as typeof fetch;
}
afterEach(() => { globalThis.fetch = originalFetch; logout(); authMode.set(null); });

test('host logout is cookie-only with CSRF; only verified revocation clears state', async () => {
  setup(); token.set('legacy-bearer');
  const calls: string[] = [];
  respond((url, init) => {
    calls.push(url);
    expect(init?.credentials).toBe('same-origin');
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    if (url === '/api/auth/logout') {
      expect(init?.method).toBe('POST');
      expect(headers.get('x-csrf-token')).toBe('cookie-csrf');
      expect(get(isAuthenticated)).toBe(true);
      return Response.json({ providerSpecificResult: 'revoked' });
    }
    expect(url).toBe('/api/auth/verify');
    expect(headers.has('x-csrf-token')).toBe(false);
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  });
  expect(await endSession()).toBe(getAuthStateRevision());
  expect(calls).toEqual(['/api/auth/logout', '/api/auth/verify']);
  expect(get(isAuthenticated)).toBe(false);
  expect(get(subject)).toBeNull(); expect(get(csrfToken)).toBeNull(); expect(get(token)).toBeNull();
});

test('network, provider and CSRF failures preserve the session and do not verify', async () => {
  for (const status of [0, 403, 503]) {
    setup(); let calls = 0;
    respond(() => { calls++; if (!status) throw new Error('network unavailable'); return Response.json({ error: 'failed' }, { status }); });
    await expect(endSession()).rejects.toThrow();
    expect(calls).toBe(1); expect(get(isAuthenticated)).toBe(true); expect(get(csrfToken)).toBe('cookie-csrf');
  }
});

test('logout success is insufficient if cookie remains authenticated or verification is unavailable', async () => {
  for (const result of ['authenticated', 'anonymous', 'unavailable']) {
    setup();
    respond(url => url === '/api/auth/logout' ? Response.json({ ok: true })
      : result === 'unavailable' ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ success: true, mode: result === 'anonymous' ? 'anonymous' : 'plugin' }));
    await expect(endSession()).rejects.toThrow();
    expect(get(isAuthenticated)).toBe(true);
  }
});

test('an already expired cookie settles only after cookie verification rejects it', async () => {
  setup();
  respond(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  expect(await endSession()).toBe(getAuthStateRevision()); expect(get(isAuthenticated)).toBe(false);
});

test('deleted cookie verifies as HTTP 200 with explicit unauthenticated plugin mode', async () => {
  setup();
  respond(url => Response.json(url === '/api/auth/logout' ? { ok: true } : { success: false, mode: 'plugin' }));
  expect(await endSession()).toBe(getAuthStateRevision()); expect(get(isAuthenticated)).toBe(false);
});

test('host completion runs synchronously before a newly mounted login handoff invalidates the settled revision', async () => {
  setup();
  respond(url => Response.json(url === '/api/auth/logout' ? { ok: true } : { success: false, mode: 'plugin' }));
  let completed = 0;
  const settled = await endSession({ onCompleted: revision => {
    expect(get(isAuthenticated)).toBe(false);
    expect(isAuthenticationStateCurrent(revision)).toBe(true);
    completed++;
    queueMicrotask(() => { const end = beginAuthenticationHandoff(); end(); });
  } });
  expect(completed).toBe(1); expect(isAuthenticationStateCurrent(settled!)).toBe(false);
});

test('malformed or anonymous unauthenticated verification never counts as confirmed logout', async () => {
  for (const body of [{}, { success: false }, { success: false, mode: 'anonymous' }, { success: false, mode: 'plugin', subject: { id: 'admin', provider: mode.provider.name } }]) {
    setup(); respond(url => Response.json(url === '/api/auth/logout' ? { ok: true } : body));
    await expect(endSession()).rejects.toThrow('management_logout_verify_failed'); expect(get(isAuthenticated)).toBe(true);
  }
});

test('parallel logout calls share one operation; late success cannot clear a newer session', async () => {
  setup(); let resolve!: (response: Response) => void; let calls = 0;
  respond(() => { calls++; return new Promise<Response>(done => { resolve = done; }); });
  let completed = 0;
  const first = endSession({ onCompleted: () => { completed++; } }); const second = endSession(); expect(first).toBe(second);
  setup('new-admin'); resolve(Response.json({ ok: true }));
  expect(await first).toBeNull(); expect(calls).toBe(1); expect(get(subject)?.id).toBe('new-admin'); expect(completed).toBe(0);
});

test('late verification cannot clear a new session or changed provider', async () => {
  for (const change of [() => setup('new-admin'), () => { authMode.set({ mode: 'anonymous' }); logout(); }]) {
    setup(); let resolve!: (response: Response) => void;
    let entered!: () => void; const verifying = new Promise<void>(done => { entered = done; });
    respond(url => url === '/api/auth/logout' ? Response.json({ ok: true })
      : new Promise<Response>(done => { resolve = done; entered(); }));
    const pending = endSession(); await verifying; change(); const revision = getAuthStateRevision();
    resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
    expect(await pending).toBeNull(); expect(getAuthStateRevision()).toBe(revision);
  }
});

test('background and late 401s cannot destroy state during logout, isolation releases on failure', async () => {
  setup(); const replies: Record<string, (response: Response) => void> = {};
  respond(url => new Promise<Response>(done => { replies[url] = done; }));
  const before = api.get('/before').catch(() => {});
  const ending = endSession();
  const during = api.get('/during').catch(() => {});
  replies['/api/before'](Response.json({ error: 'unauthorized' }, { status: 401 })); await before;
  expect(get(isAuthenticated)).toBe(true);
  replies['/api/auth/logout'](Response.json({ error: 'unavailable' }, { status: 503 }));
  await expect(ending).rejects.toThrow();
  replies['/api/during'](Response.json({ error: 'unauthorized' }, { status: 401 })); await during;
  expect(get(isAuthenticated)).toBe(true);
  respond(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  await api.get('/after').catch(() => {}); expect(get(isAuthenticated)).toBe(false);
});

test('anonymous mode never attempts logout', async () => {
  authMode.set({ mode: 'anonymous' }); let calls = 0;
  respond(() => { calls++; return Response.json({ ok: true }); });
  await expect(endSession()).rejects.toThrow('management_logout_unavailable'); expect(calls).toBe(0);
});
