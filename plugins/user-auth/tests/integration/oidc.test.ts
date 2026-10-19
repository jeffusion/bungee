import { afterEach, expect, test } from 'bun:test';
import { authFixture, PUBLIC_ORIGIN, request } from '../helpers/auth-fixture';
import { startIdentityProvider } from '../fixtures/oidc-provider';
import { createControl } from '../../server/control';

const providers: ReturnType<typeof startIdentityProvider>[] = [];
afterEach(() => { for (const idp of providers.splice(0)) idp.stop(); });
function expectFailure(response: Response) {expect(response.status).toBe(302);expect(response.headers.get('location')).toStartWith(PUBLIC_ORIGIN+'/#/login?oidcError=');expect(response.headers.getSetCookie().some(v=>v.startsWith('bungee_user_session='))).toBe(false);}
async function fixture(authMethod: 'client_secret_post' | 'client_secret_basic' = 'client_secret_post', advertiseMethod = true) {
  const idp = startIdentityProvider(authMethod, advertiseMethod); providers.push(idp);
  const f = await authFixture(), owner = await f.login();
  const response = await f.call(owner, '/login-connections', 'POST', {id: crypto.randomUUID(), label: 'Fixture OIDC', provider: 'oidc', configuration: {mode: 'issuer', issuer: idp.issuer}, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', enabled: true });
  expect(response.status).toBe(201);
  const connection = (await response.json() as { connection: { id: string; version: number; label: string; issuer: string; clientId: string; scopes: string[]; enabled: boolean } }).connection;
  const start = async (connectionId = connection.id) => {
    const response = await f.control.beginLogin(request('/api/auth/login/start', 'POST', { methodId: connectionId }, { origin: PUBLIC_ORIGIN }));
    expect(response.status).toBe(200);
    const result = await response.json() as { authorizationUrl: string; flowId: string };
    const authorization = new URL(result.authorizationUrl);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const redirect = await fetch(authorization, { redirect: 'manual' });
    return { url: redirect.headers.get('location')!, cookie: response.headers.get('set-cookie')!.split(';')[0]!, flowId: result.flowId, authorization };
  };
  const callback = async (flow: Awaited<ReturnType<typeof start>>, url = flow.url) => f.control.completeLogin(new Request(url, { headers: { cookie: flow.cookie } }));
  const auto = async (enabled = true) => { const settings = await (await f.call(owner, '/login-settings')).json() as { version: number }; expect((await f.call(owner, '/login-settings', 'PUT', { version: settings.version, autoCreateUsers: enabled })).status).toBe(200); };
  return { ...f, idp, owner, connection, start, callback, auto };
}

test('signed code flow enforces PKCE, nonce and state; JIT uses the global switch without storing tokens', async () => {
  const f = await fixture();
  expect(await (await f.control.loginOptions(request('/options'))).json()).toMatchObject({ local: { enabled: true }, methods: [{ id: f.connection.id }] });
  const unknown = await f.start(); expectFailure(await f.callback(unknown));
  await f.auto(); const flow = await f.start();
  const bad = new URL(flow.url); bad.searchParams.set('state', 'wrong-state'); expectFailure(await f.callback(flow, bad.href));
  const result = await f.callback(flow); expect(result.status).toBe(302); expect(result.headers.get('location')).toBe(PUBLIC_ORIGIN + '/#/');
  const cookie = result.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { cookie }))).not.toBeNull();
  expectFailure(await f.callback(flow));
  const records = JSON.stringify(await f.state.list());
  for (const secret of ['fixture-client-secret', 'not-persisted-access-token', 'not-persisted-refresh-token']) expect(records).not.toContain(secret);
  expect((await f.state.list()).filter(r => r.key.startsWith('identity:'))).toHaveLength(1);
});

for (const invalid of ['nonce', 'issuer', 'audience', 'expired', 'signature'] as const) {
  test(`OIDC rejects invalid ${invalid} from a real signing server`, async () => {
    const f = await fixture(); await f.auto();
    if (invalid === 'nonce') f.idp.mutation.nonce = 'incorrect-nonce';
    if (invalid === 'issuer') f.idp.mutation.issuer = 'https://wrong.example';
    if (invalid === 'audience') f.idp.mutation.audience = 'wrong-client';
    if (invalid === 'expired') f.idp.mutation.expired = true;
    if (invalid === 'signature') f.idp.mutation.invalidSignature = true;
    expectFailure(await f.callback(await f.start()));
    expect((await f.state.list()).filter(r => r.key.startsWith('identity:'))).toHaveLength(0);
  });
}

test('PKCE verifier is stored only in SecretStore; tampered verifier cannot redeem the code', async () => {
  const f = await fixture(); await f.auto(); const flow = await f.start();
  const record = (await f.state.list()).find(r => r.key.startsWith('flow:'))!, value = record.value as { flow: { verifierRef: string } }, key = value.flow.verifierRef.slice(0, value.flow.verifierRef.lastIndexOf(':')), secret = await f.secrets.get(key);
  expect(JSON.stringify(record)).not.toContain(secret!.value);
  await f.secrets.compareAndSet(key, secret!.version, 'wrong-verifier');
  expectFailure(await f.callback(flow));
});

test('disabling auto-create during token exchange prevents a user; connection generation revokes flows and sessions across controls', async () => {
  const f = await fixture(); await f.auto(); const flow = await f.start();
  f.idp.mutation.beforeToken = async () => { f.idp.mutation.beforeToken = undefined; await f.auto(false); };
  expectFailure(await f.callback(flow)); expect((await f.state.list()).filter(r => r.key.startsWith('user:'))).toHaveLength(1);
  await f.auto(); const logged = await f.callback(await f.start()), cookie = logged.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  const pending = await f.start();
  const updated = await f.call(f.owner, '/login-connections', 'PUT', { id:f.connection.id,version:f.connection.version,label:f.connection.label,provider: 'oidc', configuration: {mode: 'issuer', issuer: f.connection.issuer},clientId:f.connection.clientId,scopes:f.connection.scopes,enabled:false }); expect(updated.status).toBe(200);
  const version = (await updated.json() as { connection: { version: number } }).connection.version;
  expectFailure(await f.callback(pending));
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { cookie }))).toBeNull();
  expect((await f.call(f.owner, '/login-connections', 'PUT', { id:f.connection.id,version,label:f.connection.label,provider: 'oidc', configuration: {mode: 'issuer', issuer: f.connection.issuer},clientId:f.connection.clientId,scopes:f.connection.scopes,enabled:true })).status).toBe(200);
  const other = createControl(f.host); await other.start();
  expect(await other.authenticate(request('/self', 'GET', undefined, { cookie }))).toBeNull();
  expectFailure(await f.callback(pending));
});

test('multiple connections reject method mixup and per-connection autoCreateUsers; issuer+sub binds once without email merging', async () => {
  const f = await fixture();
  expect((await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(), label: 'Invalid', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', autoCreateUsers: true })).status).toBe(400);
  const secondResponse = await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(), label: 'Second connection', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', enabled: true });
  const second = (await secondResponse.json() as { connection: { id: string } }).connection;
  const flow = await f.start(); const wrong = new URL(flow.url); wrong.pathname = '/api/auth/login/callback/' + second.id;
  expectFailure(await f.callback(flow, wrong.href));
  await f.auto(); expect((await f.callback(flow)).status).toBe(302);
  expectFailure(await f.callback(await f.start(second.id)));
  f.idp.mutation.subject = 'different-subject-same-email'; expect((await f.callback(await f.start(second.id))).status).toBe(302);
  expect((await f.state.list()).filter(r => r.key.startsWith('user:'))).toHaveLength(3);
});

test('link callback never changes login; protected finish requires the initiating session and revokes the user', async () => {
  const f = await fixture(); const started = await f.call(f.owner, '/identities/link/start', 'POST', { connectionId: f.connection.id });
  expect(started.status).toBe(200); const link = await started.json() as { authorizationUrl: string; flowId: string };
  const redirect = await fetch(link.authorizationUrl, { redirect: 'manual' }), callback = await f.control.completeLogin(new Request(redirect.headers.get('location')!, { headers: { cookie: started.headers.get('set-cookie')!.split(';')[0]! } }));
  expect(callback.status).toBe(302); expect(callback.headers.get('location')).toBe(PUBLIC_ORIGIN + '/#/extensions/user-auth/profile?oidcLink=' + link.flowId);
  expect(callback.headers.getSetCookie().some(v => v.startsWith('bungee_user_session='))).toBe(false);
  const otherToken = await f.login(); expect((await f.call(otherToken, '/identities/link/finish', 'POST', { flowId: link.flowId })).status).toBe(401);
  expect((await f.call(f.owner, '/identities/link/finish', 'POST', { flowId: link.flowId })).status).toBe(200);
  for (const token of [f.owner, otherToken]) expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + token }))).toBeNull();
});

test('OIDC requires an explicit public origin and refuses unsafe return paths and remote HTTP issuers', async () => {
  const f = await fixture();
  const missing = createControl({ ...f.host, managementOrigin: undefined }); await missing.start();
  expect((await missing.beginLogin(request('/start', 'POST', { methodId: f.connection.id }, { origin: PUBLIC_ORIGIN }))).status).toBe(503);
  for (const returnTo of ['//evil.example/', '/\\evil.example/', 'https://evil.example/']) expect((await f.control.beginLogin(request('/start', 'POST', { methodId: f.connection.id, returnTo }, { origin: PUBLIC_ORIGIN }))).status).toBe(400);
  expect((await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(), label: 'Invalid', provider: 'oidc', configuration: {mode: 'issuer', issuer: 'http://remote.example'}, clientId: 'client' })).status).toBe(400);
});

test('manual binding revokes target sessions; disabled identities cannot recreate users and unbinding revokes OIDC sessions', async () => {
  const f = await fixture();
  const targetResponse = await f.call(f.owner, '/users', 'POST', { username: 'target', password: 'Target password', passwordConfirmation: 'Target password' });
  const target = (await targetResponse.json() as { user: { id: string; username: string; displayName: string } }).user, local = await f.login('target', 'Target password');
  expect((await f.call(f.owner, '/identities', 'POST', { userId: target.id, connectionId: f.connection.id, subject: 'subject-one' })).status).toBe(200);
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + local }))).toBeNull();
  const result = await f.callback(await f.start()), cookie = result.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  const bindings = await (await f.call(f.owner, '/identities?userId=' + target.id)).json() as { identities: { id: string }[] };
  expect((await f.call(f.owner, '/identities', 'DELETE', { id: bindings.identities[0]!.id })).status).toBe(200);
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { cookie }))).toBeNull();
  expect((await f.call(f.owner, '/identities', 'POST', { userId: target.id, connectionId: f.connection.id, subject: 'subject-one' })).status).toBe(200);
  await f.auto();
  expect((await f.call(f.owner, '/users/update', 'PUT', {id:target.id,username:target.username,displayName:target.displayName,disabled:true})).status).toBe(200);
  expectFailure(await f.callback(await f.start()));
  expect((await f.state.list()).filter(r => r.key.startsWith('user:'))).toHaveLength(2);
});

test('concurrent callbacks across controls atomically create one identity and consume each flow once', async () => {
  const f = await fixture(); await f.auto(); const first = await f.start(), second = await f.start();
  const other = createControl(f.host, { now: f.now }); await other.start();
  const results = await Promise.all([f.callback(first), other.completeLogin(new Request(second.url, { headers: { cookie: second.cookie } }))]);
  expect(results.map(r => r.status)).toEqual([302, 302]);
  expect((await f.state.list()).filter(r => r.key.startsWith('user:'))).toHaveLength(2);
  expect((await f.state.list()).filter(r => r.key.startsWith('identity:'))).toHaveLength(1);
  expectFailure(await f.callback(first));
});

test.each(['update', 'delete'] as const)('connection %s during discovery cannot publish a reusable flow', async operation => {
  const f = await fixture();
  const fetcher: NonNullable<import('../../server/control').Dependencies['fetch']> = async (input, init) => {
    if (String(input).includes('.well-known')) {
      expect((await f.call(f.owner, '/login-connections', operation === 'delete' ? 'DELETE' : 'PUT', operation === 'delete' ? {id: f.connection.id, version: f.connection.version} : {id: f.connection.id, version: f.connection.version, label: f.connection.label, provider: 'oidc', configuration: {mode: 'issuer', issuer: f.connection.issuer}, clientId: f.connection.clientId, enabled: false})).status).toBe(200);
    }
    return fetch(input, init);
  };
  const control = createControl(f.host, { fetch: fetcher }); await control.start();
  expect((await control.beginLogin(request('/start', 'POST', { methodId: f.connection.id }, { origin: PUBLIC_ORIGIN }))).status).toBe(409);
  expect((await f.state.list()).filter(r => r.key.startsWith('flow:'))).toHaveLength(0);
  expect(f.secrets.values.size).toBe(operation === 'delete' ? 0 : 1);
});

test('completed OIDC flows reuse secret keys without reusing secret versions', async () => {
  const f = await fixture(); await f.auto();
  for (let i=0;i<12;i++) {
    if (i===10) f.advance(15*60000);
    const flow = await f.start();
    const response = await f.callback(flow);
    expect(response.headers.getSetCookie().some(v=>v.startsWith('bungee_user_session='))).toBe(true);
  }
  expect(f.secrets.versions.size).toBe(2);
  expect(f.secrets.values.size).toBe(1);
});

test.each([true,false])('OIDC supports Basic client authentication, including the discovery default (%s)', async advertise => {
  const f = await fixture('client_secret_basic',advertise); await f.auto();
  const response = await f.callback(await f.start());
  expect(response.headers.getSetCookie().some(v=>v.startsWith('bungee_user_session='))).toBe(true);
  expect(f.idp.tokenRequests()).toBe(1);
});


test('deleting a connection revokes its sessions and flows, keeps users and clears bindings, and reuses bounded storage with a fresh ID', async () => {
  const f = await fixture(); await f.auto();
  const signedIn = await f.callback(await f.start());
  const cookie = signedIn.headers.getSetCookie().find(value => value.startsWith('bungee_user_session='))!.split(';')[0]!;
  const pending = await f.start();
  const beforeUsers = await (await f.call(f.owner, '/users')).json();
  const deletion = {id: f.connection.id, version: f.connection.version};
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {...deletion, version: 0})).status).toBe(400);
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {...deletion, version: deletion.version + 1})).status).toBe(409);
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {...deletion, autoCreateUsers: true})).status).toBe(400);
  expect(await f.control.authenticate(request('/self', 'GET', undefined, {cookie}))).not.toBeNull();
  expect(await (await f.call(f.owner, '/login-connections', 'DELETE', deletion)).json()).toEqual({ok: true, sessionRevoked: false});
  expect(await (await f.call(f.owner, '/login-connections')).json()).toEqual({publicOrigin:PUBLIC_ORIGIN, connections: []});
  expect(await (await f.call(f.owner, '/users')).json()).toEqual(beforeUsers);
  expect(await (await f.call(f.owner, '/identities')).json()).toEqual({identities: []});
  expect((await (await f.control.loginOptions(request('/options'))).json() as {methods: unknown[]}).methods).toEqual([]);
  expect(await f.control.authenticate(request('/self', 'GET', undefined, {cookie}))).toBeNull();
  expectFailure(await f.callback(pending));
  expect(f.secrets.values.size).toBe(0);
  for (let index = 0; index < 35; index++) {
    const response = await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(),label: 'Replacement', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', enabled: true});
    expect(response.status).toBe(201);
    const {connection} = await response.json() as {connection: {id: string; version: number}};
    expect(connection.id).not.toBe(f.connection.id);
    const edited = await f.call(f.owner, '/login-connections', 'PUT', {id: connection.id, version: connection.version, label: 'Edited replacement', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', enabled: true});
    expect(edited.status).toBe(200);
    connection.version = (await edited.json() as {connection: {version: number}}).connection.version;
    if (index === 0) {
      const signedInAgain = await f.callback(await f.start(connection.id));
      expect(signedInAgain.headers.getSetCookie().some(v => v.startsWith('bungee_user_session='))).toBe(true);
      const restarted = createControl(f.host, {now: f.now}); await restarted.start();
      expect(await restarted.authenticate(request('/self', 'GET', undefined, {cookie}))).toBeNull();
    }
    expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: connection.id, version: connection.version})).status).toBe(200);
  }
  expect((await f.state.list()).filter(record => record.key.startsWith('connection:'))).toHaveLength(1);
  expect(f.secrets.values.size).toBe(0);
});

test('deletion during token exchange cannot create an account and deleting the current OIDC connection reports session revocation', async () => {
  const f = await fixture(); await f.auto(); const pending = await f.start();
  f.idp.mutation.beforeToken = async () => {
    f.idp.mutation.beforeToken = undefined;
    expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(200);
  };
  expectFailure(await f.callback(pending));
  expect((await f.state.list()).filter(record => record.key.startsWith('user:'))).toHaveLength(1);
  const g = await fixture(); await g.auto();
  const logged = await g.callback(await g.start()), cookie = logged.headers.getSetCookie().find(value => value.startsWith('bungee_user_session='))!.split(';')[0]!;
  const req = request('/login-connections', 'DELETE', {id: g.connection.id, version: g.connection.version}, {cookie, origin: PUBLIC_ORIGIN});
  const subject = (await g.control.authenticate(req))!;
  const handler = g.control.api.find(route => route.path === '/login-connections')!;
  expect((await handler.invoke({...g.host, request: req, requestSignal: req.signal, subject})).status).toBe(403);
  const csrfToken = g.control.csrfToken(req)!;
  const crossOrigin = request('/login-connections', 'DELETE', {id: g.connection.id, version: g.connection.version}, {cookie, origin: 'https://evil.example', 'x-csrf-token': csrfToken});
  expect((await handler.invoke({...g.host, request: crossOrigin, requestSignal: crossOrigin.signal, subject})).status).toBe(403);
  const valid = request('/login-connections', 'DELETE', {id: g.connection.id, version: g.connection.version}, {cookie, origin: PUBLIC_ORIGIN, 'x-csrf-token': csrfToken});
  expect(await (await handler.invoke({...g.host, request: valid, requestSignal: valid.signal, subject})).json()).toEqual({ok: true, sessionRevoked: true});
  expect(await g.control.authenticate(request('/self', 'GET', undefined, {cookie}))).toBeNull();
  expect((await g.call(g.owner, '/login-connections')).status).toBe(200);
});

test('concurrent connection edits defeat a stale deletion and a lost deletion ACK can be confirmed by reading', async () => {
  const f = await fixture();
  const other = createControl(f.host, {now: f.now}); await other.start();
  const original = f.state.transact.bind(f.state); let conflict = true, loseAck = false;
  f.state.transact = async mutations => {
    const deleting = mutations.some(mutation => mutation.key.startsWith('connection:') && !!(mutation.value as {connection?: {deleting?: unknown}})?.connection?.deleting);
    if (deleting && conflict) {
      conflict = false;
      expect((await f.call(f.owner, '/login-connections', 'PUT', {id: f.connection.id, version: f.connection.version, label: 'Changed', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.connection.issuer}, clientId: f.connection.clientId, scopes: f.connection.scopes, enabled: true}, other)).status).toBe(200);
    }
    const result = await original(mutations);
    if (deleting && loseAck) { loseAck = false; throw new Error('deletion acknowledgement lost'); }
    return result;
  };
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(409);
  const {connections} = await (await f.call(f.owner, '/login-connections')).json() as {connections: {id: string; version: number; label: string}[]};
  expect(connections[0]!.label).toBe('Changed'); expect(f.secrets.values.size).toBe(1);
  loseAck = true;
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: connections[0]!.version})).status).toBe(503);
  expect(await (await f.call(f.owner, '/login-connections')).json()).toEqual({publicOrigin:PUBLIC_ORIGIN, connections: []});
  expect(f.secrets.values.size).toBe(0);
});


test('deleting a connection clears all 128 flow slots in bounded transactions', async () => {
  const f = await fixture(); let source = 0;
  const other = createControl(f.host, {now: f.now, trustedSource: () => 'flow-source-' + source++}); await other.start();
  for (let index = 0; index < 128; index++) {
    expect((await other.beginLogin(request('/start', 'POST', {methodId: f.connection.id}, {origin: PUBLIC_ORIGIN}))).status).toBe(200);
  }
  expect(f.secrets.values.size).toBe(129);
  const before = f.state.writes.length;
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(200);
  const commits = f.state.writes.slice(before);
  expect(commits.every(keys => keys.length <= 256)).toBe(true);
  expect(commits.flat().filter(key => key.startsWith('flow:'))).toHaveLength(128);
  expect(f.secrets.values.size).toBe(0);
});

test('deletion racing with verified identity binding prevents a partial binding commit', async () => {
  const f = await fixture(), started = await f.call(f.owner, '/identities/link/start', 'POST', {connectionId: f.connection.id});
  const link = await started.json() as {authorizationUrl: string; flowId: string};
  const redirect = await fetch(link.authorizationUrl, {redirect: 'manual'});
  expect((await f.control.completeLogin(new Request(redirect.headers.get('location')!, {headers: {cookie: started.headers.get('set-cookie')!.split(';')[0]!}}))).status).toBe(302);
  const other = createControl(f.host, {now: f.now}); await other.start();
  const original = f.state.transact.bind(f.state); let once = true;
  f.state.transact = async mutations => {
    if (once && mutations.some(mutation => mutation.key.startsWith('identity:'))) {
      once = false;
      expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version}, other)).status).toBe(200);
    }
    return original(mutations);
  };
  expect((await f.call(f.owner, '/identities/link/finish', 'POST', {flowId: link.flowId})).status).toBe(401);
  expect(await (await f.call(f.owner, '/identities')).json()).toEqual({identities: []});
  expect((await f.call(f.owner, '/self')).status).toBe(200);
});

test('connection deletion removes only its bindings, revokes every affected user session, and preserves users and local passwords', async () => {
  const f = await fixture();
  const created = await f.call(f.owner, '/users', 'POST', {username: 'target', password: 'Target password', passwordConfirmation: 'Target password'});
  const target = (await created.json() as {user: {id: string}}).user;
  const second = (await (await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(),label: 'Other', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', enabled: true})).json() as {connection: {id: string}}).connection;
  for (const [connectionId, subject] of [[f.connection.id, 'subject-one'], [second.id, 'subject-two']]) {
    expect((await f.call(f.owner, '/identities', 'POST', {userId: target.id, connectionId, subject})).status).toBe(200);
  }
  const local = await f.login('target', 'Target password');
  const firstLogin = await f.callback(await f.start());
  const cookie = firstLogin.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  f.idp.mutation.subject = 'subject-two';
  const secondLogin = await f.callback(await f.start(second.id));
  const otherCookie = secondLogin.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  const beforeUsers = await (await f.call(f.owner, '/users')).json();
  expect(await (await f.call(local, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).json()).toEqual({ok: true, sessionRevoked: true});
  expect(await (await f.call(f.owner, '/users')).json()).toEqual(beforeUsers);
  const remaining = await (await f.call(f.owner, '/identities')).json() as {identities: {userId: string; connectionId: string}[]};
  expect(remaining.identities).toHaveLength(1);
  expect(remaining.identities[0]).toMatchObject({userId: target.id, connectionId: second.id});
  const sessions: Record<string, string>[] = [{authorization: 'Bearer ' + local}, {cookie}, {cookie: otherCookie}];
  for (const headers of sessions) {
    expect(await f.control.authenticate(request('/self', 'GET', undefined, headers))).toBeNull();
  }
  expect((await f.call(f.owner, '/self')).status).toBe(200);
  expect((await f.call(await f.login('target', 'Target password'), '/self')).status).toBe(200);
  const replacement = (await (await f.call(f.owner, '/login-connections', 'POST', {id: crypto.randomUUID(),label: 'Replacement', provider: 'oidc', configuration: {mode: 'issuer', issuer: f.idp.issuer}, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', enabled: true})).json() as {connection: {id: string}}).connection;
  f.idp.mutation.subject = 'subject-one';
  expectFailure(await f.callback(await f.start(replacement.id)));
  expect((await f.call(f.owner, '/identities', 'POST', {userId: target.id, connectionId: replacement.id, subject: 'subject-one'})).status).toBe(200);
  const relogged = await f.callback(await f.start(replacement.id));
  expect(relogged.headers.getSetCookie().some(v => v.startsWith('bungee_user_session='))).toBe(true);
  expect(await (await f.call(f.owner, '/users')).json()).toEqual(beforeUsers);
});

test.each(['fence-ack', 'cleanup-write', 'cleanup-ack', 'final-ack'] as const)('connection deletion resumes after %s failure without restoring bindings or sessions', async phase => {
  const f = await fixture(); await f.auto();
  const signedIn = await f.callback(await f.start());
  const cookie = signedIn.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  const beforeUsers = await (await f.call(f.owner, '/users')).json();
  const original = f.state.transact.bind(f.state); let failed = false;
  f.state.transact = async mutations => {
    const fence = mutations.some(m => m.key.startsWith('connection:') && (m.value as {connection?: {deleting?: unknown}}).connection?.deleting);
    const cleanup = mutations.some(m => m.key.startsWith('identity:'));
    const final = mutations.some(m => m.key.startsWith('connection:') && (m.value as {connection?: unknown}).connection === null);
    const inject = !failed && (phase === 'fence-ack' ? fence : phase === 'final-ack' ? final : cleanup);
    if (inject) failed = true;
    if (inject && phase === 'cleanup-write') throw new Error('cleanup storage unavailable');
    const result = await original(mutations);
    if (inject) throw new Error('acknowledgement lost');
    return result;
  };
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(503);
  expect(failed).toBe(true);
  const restarted = createControl(f.host, {now: f.now}); await restarted.start();
  expect(await restarted.authenticate(request('/self', 'GET', undefined, {cookie}))).toBeNull();
  expect(await (await f.call(f.owner, '/identities', 'GET', undefined, restarted)).json()).toEqual({identities: []});
  expect(await (await f.call(f.owner, '/login-connections', 'GET', undefined, restarted)).json()).toEqual({publicOrigin:PUBLIC_ORIGIN, connections: []});
  expect(await (await f.call(f.owner, '/users', 'GET', undefined, restarted)).json()).toEqual(beforeUsers);
  expect(f.secrets.values.size).toBe(0);
});

test('deletion of 512 bindings across 128 users resumes between batches and revokes each user exactly once', async () => {
  const f = await fixture();
  const ownerId = (await (await f.call(f.owner, '/self')).json() as {administrator: {id: string}}).administrator.id;
  const ids = [ownerId];
  for (let i = 1; i < 128; i++) {
    const created = await f.call(f.owner, '/users', 'POST', {username: 'user-' + i});
    expect(created.status).toBe(201);
    ids.push((await created.json() as {user: {id: string}}).user.id);
  }
  let owner = f.owner;
  for (let i = 0; i < 512; i++) {
    const userId = ids[i % ids.length]!;
    expect((await f.call(owner, '/identities', 'POST', {userId, connectionId: f.connection.id, subject: 'subject-' + i})).status).toBe(200);
    if (userId === ownerId) owner = await f.login();
  }
  const before = await f.state.list();
  const beforeUsers = await (await f.call(owner, '/users')).json();
  const original = f.state.transact.bind(f.state); let interrupted = false;
  f.state.transact = async mutations => {
    expect(mutations.length).toBeLessThanOrEqual(256);
    const result = await original(mutations);
    if (!interrupted && mutations.filter(m => m.key.startsWith('identity:')).length === 255) {
      interrupted = true;
      throw new Error('process interrupted after cleanup batch committed');
    }
    return result;
  };
  expect((await f.call(owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(503);
  expect(interrupted).toBe(true);
  expect((await f.state.list()).filter(r => r.key.startsWith('identity:') && (r.value as {identity: unknown}).identity !== null)).toHaveLength(257);
  const restarted = createControl(f.host, {now: f.now}); await restarted.start();
  expect(await restarted.authenticate(request('/self', 'GET', undefined, {authorization: 'Bearer ' + owner}))).toBeNull();
  const after = await f.state.list();
  expect(after.filter(r => r.key.startsWith('identity:')).every(r => (r.value as {identity: unknown}).identity === null)).toBe(true);
  expect(after.filter(r => r.key.startsWith('connection:')).every(r => (r.value as {connection: unknown}).connection === null)).toBe(true);
  for (const record of after.filter(r => r.key.startsWith('user:'))) {
    const user = (record.value as {user: {generation: number}}).user;
    const prior = (before.find(r => r.key === record.key)!.value as {user: {generation: number}}).user;
    expect(user).toEqual({...prior, generation: prior.generation + 1});
  }
  const fresh = await f.login();
  expect(await (await f.call(fresh, '/users')).json()).toEqual(beforeUsers);
  expect(f.secrets.values.size).toBe(0);
}, 120_000);

test('a binding committed concurrently with deletion is included in cleanup and user revocation', async () => {
  const f = await fixture();
  const target = (await (await f.call(f.owner, '/users', 'POST', {username: 'target', password: 'Target password', passwordConfirmation: 'Target password'})).json() as {user: {id: string}}).user;
  const other = createControl(f.host, {now: f.now}); await other.start();
  const original = f.state.transact.bind(f.state); let once = true, local = '';
  f.state.transact = async mutations => {
    if (once && mutations.some(m => m.key.startsWith('connection:') && (m.value as {connection?: {deleting?: unknown}}).connection?.deleting)) {
      once = false;
      expect((await f.call(f.owner, '/identities', 'POST', {userId: target.id, connectionId: f.connection.id, subject: 'concurrent-subject'}, other)).status).toBe(200);
      const login = await other.login(request('/login', 'POST', {username: 'target', password: 'Target password', transport: 'bearer'}));
      expect(login.status).toBe(200);
      local = (await login.json() as {token: string}).token;
    }
    return original(mutations);
  };
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(200);
  expect(once).toBe(false);
  expect(await (await f.call(f.owner, '/identities')).json()).toEqual({identities: []});
  expect(await other.authenticate(request('/self', 'GET', undefined, {authorization: 'Bearer ' + local}))).toBeNull();
  expect((await f.call(f.owner, '/self')).status).toBe(200);
});

test.each(['read', 'delete', 'delete-ack'] as const)('secret %s failure retains deletion progress until restart confirms cleanup', async operation => {
  const f = await fixture(); await f.auto();
  const signedIn = await f.callback(await f.start());
  const cookie = signedIn.headers.getSetCookie().find(v => v.startsWith('bungee_user_session='))!.split(';')[0]!;
  await f.start();
  const originalGet = f.secrets.get.bind(f.secrets), originalDelete = f.secrets.delete.bind(f.secrets);
  let fail = true;
  f.secrets.get = async key => {
    if (fail && operation === 'read') throw new Error('secret read unavailable');
    return originalGet(key);
  };
  f.secrets.delete = async (key, version) => {
    if (fail && operation === 'delete') throw new Error('secret deletion unavailable');
    await originalDelete(key, version);
    if (fail && operation === 'delete-ack') throw new Error('secret deletion acknowledgement lost');
  };
  expect((await f.call(f.owner, '/login-connections', 'DELETE', {id: f.connection.id, version: f.connection.version})).status).toBe(503);
  const progress = (await f.state.list()).find(r => r.key.startsWith('connection:'))!.value as {connection: {enabled: boolean; deleting: {secretRefs: string[]}}};
  expect(progress.connection.enabled).toBe(false);
  expect(progress.connection.deleting.secretRefs).toHaveLength(2);
  expect((await f.state.list()).filter(r => r.key.startsWith('identity:')).every(r => (r.value as {identity: unknown}).identity === null)).toBe(true);
  fail = false;
  let reusedKey: string | undefined;
  if (operation === 'delete-ack') {
    const ref = progress.connection.deleting.secretRefs[0]!;
    reusedKey = ref.slice(0, ref.lastIndexOf(':'));
    expect(await f.secrets.get(reusedKey)).toBeNull();
    await f.secrets.compareAndSet(reusedKey, null, 'Unrelated prepared secret');
  }
  const restarted = createControl(f.host, {now: f.now}); await restarted.start();
  expect(await restarted.authenticate(request('/self', 'GET', undefined, {cookie}))).toBeNull();
  expect(await (await f.call(f.owner, '/login-connections', 'GET', undefined, restarted)).json()).toEqual({publicOrigin:PUBLIC_ORIGIN, connections: []});
  expect(f.secrets.values.size).toBe(reusedKey ? 1 : 0);
  if (reusedKey) expect((await f.secrets.get(reusedKey))!.value).toBe('Unrelated prepared secret');
});
