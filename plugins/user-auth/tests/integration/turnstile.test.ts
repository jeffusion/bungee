import { expect, test } from 'bun:test';
import { authFixture, PASSWORD, PUBLIC_ORIGIN, request } from '../helpers/auth-fixture';
import { createControl } from '../../server/control';

async function fixture() {
  const network: { calls: number; result: { success: boolean; hostname: string; action: string }; error?: Error; before?: () => Promise<void> } = { calls: 0, result: { success: true, hostname: 'manager.example', action: 'local-login' } };
  const f = await authFixture({ fetch: async (_input, init) => {
    network.calls++;
    const payload = new URLSearchParams(String(init?.body));
    expect(payload.get('secret')).toBe('turnstile-fixture-secret');
    expect(payload.get('response')).toBeString();
    await network.before?.();
    if (network.error) throw network.error;
    return Response.json(network.result);
  } });
  const owner = await f.login();
  const enable = await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'public-site-key', secret: 'turnstile-fixture-secret', hostnames: ['manager.example'] });
  expect(enable.status).toBe(200);
  const login = (token?: string, transport: 'cookie' | 'bearer' = 'bearer') => f.control.login(request('/login', 'POST', { username: 'owner', password: PASSWORD, transport, ...(token ? { turnstileToken: token } : {}) }, transport === 'cookie' ? { origin: PUBLIC_ORIGIN } : {}));
  return { ...f, network, owner, login };
}

test('enabled Turnstile covers cookie and bearer login; challenge tokens cannot be reused', async () => {
  const f = await fixture();
  for (const transport of ['cookie', 'bearer'] as const) {
    expect((await f.login(undefined, transport)).status).toBe(401);
    const response = await f.login('fresh-token-' + transport, transport);
    expect(response.status).toBe(200);
    expect((await f.login('fresh-token-' + transport, transport)).status).toBe(401);
  }
  expect(f.network.calls).toBe(2);
  const options = await (await f.control.loginOptions(request('/options'))).json();
  expect(options).toMatchObject({ local: { turnstile: { enabled: true, siteKey: 'public-site-key' } } });
  const text = JSON.stringify(await (await f.call(f.owner, '/turnstile')).json());
  expect(text).toContain('hasSecret'); expect(text).not.toContain('turnstile-fixture-secret'); expect(text).not.toContain('secretRef');
  expect(JSON.stringify(await f.state.list())).not.toContain('turnstile-fixture-secret');
});

for (const invalid of ['success', 'hostname', 'action', 'network'] as const) {
  test(`Turnstile fails closed on ${invalid}`, async () => {
    const f = await fixture();
    if (invalid === 'success') f.network.result.success = false;
    if (invalid === 'hostname') f.network.result.hostname = 'evil.example';
    if (invalid === 'action') f.network.result.action = 'different-action';
    if (invalid === 'network') f.network.error = new Error('network unavailable');
    expect((await f.login('fresh-token')).status).toBe(401);
  });
}

test('throttle is reserved before network verification and cannot be bypassed by token churn', async () => {
  const f = await fixture(); f.network.result.success = false;
  for (let i = 0; i < 10; i++) expect((await f.login('fresh-token-' + i)).status).toBe(401);
  expect((await f.login('one-more')).status).toBe(429); expect(f.network.calls).toBe(10);
});

test('settings changed during verification prevent login commit, even when challenge succeeds', async () => {
  const f = await fixture();
  f.network.before = async () => { f.network.before = undefined; expect((await f.call(f.owner, '/turnstile', 'PUT', { version: 2, enabled: false, siteKey: 'public-site-key', hostnames: ['manager.example'] })).status).toBe(200); };
  expect((await f.login('fresh-token')).status).toBe(409);
  expect((await f.state.list()).filter(r => r.key.startsWith('session:'))).toHaveLength(1);
});

test('secret write unknown ACK is queried; failed publication preserves configuration and keeps secrets redacted', async () => {
  const f = await authFixture(), owner = await f.login();
  f.secrets.unknownNext = true;
  const configured = await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'site', secret: 'unknown-ack-secret', hostnames: ['manager.example'] });
  expect(configured.status).toBe(200); expect(await configured.text()).not.toContain('unknown-ack-secret');
  const before = await f.state.get('turnstile'); f.secrets.failNext = true;
  expect((await f.call(owner, '/turnstile', 'PUT', { version: 2, enabled: true, siteKey: 'changed', secret: 'failed-secret', hostnames: ['manager.example'] })).status).toBe(503);
  expect(await f.state.get('turnstile')).toEqual(before);
  expect((await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'changed', secret: 'unpublished-secret', hostnames: ['manager.example'] })).status).toBe(409);
  expect(f.secrets.values.size).toBe(1);
});

test('another control revoking the actor during secret write prevents publication', async () => {
  const f = await authFixture(), owner = await f.login(), other = createControl(f.host); await other.start();
  const original = f.secrets.compareAndSet.bind(f.secrets);
  f.secrets.compareAndSet = async (...args) => { const version = await original(...args); await other.revokeSessions(); return version; };
  expect((await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'site', secret: 'secret', hostnames: ['manager.example'] })).status).toBe(403);
  expect((await f.state.get('turnstile'))!.value).toMatchObject({turnstile:{enabled:false}}); expect(f.secrets.values.size).toBe(0);
});

test('an unanswered Siteverify request times out and cannot create a session', async () => {
  const f = await authFixture({ fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('Missing timeout signal')); return; }
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }), owner = await f.login();
  expect((await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'site', secret: 'secret', hostnames: ['manager.example'] })).status).toBe(200);
  const response = await f.control.login(request('/login', 'POST', { username: 'owner', password: PASSWORD, transport: 'bearer', turnstileToken: 'unanswered-token' }));
  expect(response.status).toBe(401);
  expect((await f.state.list()).filter(r => r.key.startsWith('session:'))).toHaveLength(1);
}, 15000);

test('unknown durable publication ACK keeps the confirmed secret reference and exposes committed configuration on reload', async () => {
  const f = await authFixture(), owner = await f.login(); let lose = true;
  const state = {
    get: f.state.get.bind(f.state), list: f.state.list.bind(f.state),
    transact: async (changes: readonly import('../../../../packages/core/src/plugin-durable-state').DurableMutation[]) => {
      const saved = await f.state.transact(changes);
      if (lose && changes.some(c => c.key === 'turnstile')) { lose = false; throw new Error('Publication acknowledgement lost'); }
      return saved;
    },
  };
  const control = createControl({ ...f.host, durableState: state }); await control.start();
  const changed = await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'published-site', secret: 'published-secret', hostnames: ['manager.example'] }, control);
  expect(changed.status).toBe(503);
  expect(f.secrets.values.size).toBe(1);
  const current = await f.call(owner, '/turnstile', 'GET', undefined, control);
  expect(await current.json()).toMatchObject({ version: 2, enabled: true, siteKey: 'published-site', hasSecret: true });
  expect(JSON.stringify(await f.state.list())).not.toContain('published-secret');
});

test('secret rotation reuses bounded keys while references retain their exact versions', async () => {
  const f = await authFixture({fetch: async (_url, init) => {
    expect(new URLSearchParams(String(init?.body)).get('secret')).toBe('rotation-39');
    return Response.json({success:true,hostname:'manager.example',action:'local-login'});
  }}), owner = await f.login();
  const refs = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const response = await f.call(owner, '/turnstile', 'PUT', {version:i+1,enabled:true,siteKey:'site',secret:'rotation-'+i,hostnames:['manager.example']});
    expect(response.status).toBe(200);
    refs.add(((await f.state.get('turnstile'))!.value as {turnstile:{secretRef:string}}).turnstile.secretRef);
  }
  expect(refs.size).toBe(40);
  expect(f.secrets.versions.size).toBe(2);
  expect(f.secrets.values.size).toBe(1);
  expect((await f.control.login(request('/login','POST',{username:'owner',password:PASSWORD,transport:'bearer',turnstileToken:'after-rotation'}))).status).toBe(200);
});
