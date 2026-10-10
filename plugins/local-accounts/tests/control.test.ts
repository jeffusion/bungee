import { attestManagementRequestSource, managementRequestSource } from '../../../packages/core/src/management-listener/request-source';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore } from '../../../packages/core/src/plugin-durable-state';
import type { ControlHostContext } from '../../../packages/core/src/plugin-control/contracts';
import { parsePluginManifestText } from '../../../packages/core/src/plugin-manifest-catalog/manifest-parser';
import { createControl, type LocalAccountsControl } from '../server/control';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../../../packages/core/tests/helpers/test-budgets';
const PASSWORD = 'a-secure-owner-password-2026';
const NEXT = 'a-different-secure-password-2026';
const dirs: string[] = [], dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function host(db: Database): ControlHostContext { return { signal: new AbortController().signal, durableState: new PluginDurableStateStore(db).forNamespace('local-accounts'), storage: {} as never, secretStore: {} as never }; }
async function setup(trustedSource?: (request:Request)=>string) { const dir = mkdtempSync(join(tmpdir(), 'local-accounts-')); dirs.push(dir); const path = join(dir, 'db.sqlite'); const db = new Database(path); dbs.push(db); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL); let now = 1_000_000; const c = createControl({...host(db),trustedSource}, { now: () => now }); await c.start(); await c.bootstrap({ username: 'owner', password: PASSWORD, passwordConfirmation: PASSWORD }); return { c, db, path, advance: (ms: number) => now += ms }; }
function request(path: string, method = 'POST', b?: unknown, headers: Record<string,string> = {}) { return new Request('https://example.com' + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) }); }
async function login(c: LocalAccountsControl, name = 'owner', pass = PASSWORD, transport = 'bearer') { const r = await c.login(request('/api/auth/login','POST',{ username: name, password: pass, transport }, transport === 'cookie' ? { origin: 'https://example.com' } : {})); expect(r.status).toBe(200); return { r, data: await r.json() as any }; }
async function call(c: LocalAccountsControl, path: string, method: string, token: string, b?: unknown, extra: Record<string,string> = {}) { const req = request(path, method, b, { authorization: `Bearer ${token}`, ...extra }); const subject = await c.authenticate(req); const route = c.api.find(x => x.path === path && x.methods.includes(method))!; return route.invoke({ ...hostFor(c), request: req, requestSignal: req.signal, subject: subject ?? undefined }); }
function hostFor(_c: LocalAccountsControl) { return { signal: new AbortController().signal, storage: {} as never, secretStore: {} as never }; }

describe('local accounts durable management provider', () => {
  test('manifest parses, secrets are excluded, namespace is isolated, reopen retains identities and sessions', async () => {
    parsePluginManifestText(await Bun.file(new URL('../manifest.json', import.meta.url)).text());
    const { c, db, path } = await setup(); const { data } = await login(c);
    const list = await call(c, '/self', 'GET', data.token); const text = await list.text(); expect(text).not.toContain('$argon2id'); expect(text).not.toContain('passwordHash'); expect(text).not.toContain(data.token);
    const self = await call(c, '/self', 'GET', data.token); expect(await self.text()).not.toContain('digest');
    expect(await new PluginDurableStateStore(db).forNamespace('other-plugin').get('administrator')).toBeNull();
    const stored = JSON.stringify(await new PluginDurableStateStore(db).forNamespace('local-accounts').get('administrator')); expect(stored).not.toContain(PASSWORD); expect(stored).not.toContain(data.token); expect(stored).toContain('$argon2id$v=19$m=65536,t=3');
    c.dispose(); db.close(); dbs.splice(dbs.indexOf(db), 1); const reopened = new Database(path); dbs.push(reopened); const next = createControl(host(reopened), { now: () => 1_000_001 }); await next.start(); expect(await next.hasIdentity()).toBe(true); expect(await next.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${data.token}` }))).not.toBeNull();
    await expect(next.bootstrap({ username: 'new-owner', password: PASSWORD, passwordConfirmation: PASSWORD })).rejects.toThrow('invalid_credentials');
    await next.bootstrap({ username: 'owner', password: PASSWORD, passwordConfirmation: PASSWORD });
    expect((await call(next,'/self','GET',data.token)).status).toBe(200);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
  test('missing durable capability and corrupt state fail closed', async () => {
    expect(() => createControl({ ...hostFor({} as never) })).toThrow('durable_state_required');
    const { c, db } = await setup(); const state = host(db).durableState!; const old = (await state.get('administrator'))!; await state.transact([{key: 'administrator', expectedVersion: old.version, value: {schema: 3, administrator: {id: 'bad'}}}]);
    await expect(c.authenticate(request('/self', 'GET', undefined, { authorization: `Bearer ${'a'.repeat(43)}` }))).rejects.toThrow('corrupt_state');
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
  test('single administrator has full access, spoofed identities fail and password change revokes every session', async () => {
    const { c } = await setup();
    const first = (await login(c)).data.token, second = (await login(c)).data.token;
    const subject = await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${first}` }));
    for (const capability of ['config.read','config.write','logs.body','keys.write','plugins.code','auth.mode']) expect(await c.authorize(subject!,capability)).toBe(true);
    expect(await c.authorize({ ...subject! }, 'config.write')).toBe(false);
    const self = await (await call(c,'/self','GET',first)).json() as any;
    expect(self.administrator.username).toBe('owner');
    for (const removed of ['members','member','role','subject']) expect(self[removed]).toBeUndefined();
    expect(c.api.some(route => route.path === '/members')).toBe(false);
    expect((await call(c,'/password','POST',first,{currentPassword:'wrong',password:NEXT,passwordConfirmation:NEXT})).status).toBe(401);
    expect((await call(c,'/password','POST',first,{currentPassword:PASSWORD,password:NEXT,passwordConfirmation:'mismatch'})).status).toBe(400);
    expect((await call(c,'/password','POST',first,{currentPassword:PASSWORD,password:NEXT,passwordConfirmation:NEXT})).status).toBe(200);
    for (const token of [first,second]) expect(await c.authenticate(request('/self','GET',undefined,{authorization:`Bearer ${token}`}))).toBeNull();
    expect(await c.authorize(subject!,'config.write')).toBe(false);
    expect((await c.login(request('/login','POST',{username:'owner',password:PASSWORD,transport:'bearer'}))).status).toBe(401);
    expect((await login(c,'owner',NEXT)).data.administrator).toMatchObject({username:'owner'});
    await expect(c.bootstrap({username:'another',password:NEXT,passwordConfirmation:NEXT})).rejects.toThrow('invalid_credentials');
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
  test('cookie flags, CSRF and origin, bearer transport separation, logout', async () => {
    const { c } = await setup(); const { r, data } = await login(c,'owner',PASSWORD,'cookie'); const cookies = r.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly','SameSite=Strict','Secure']) expect(cookies).toContain(flag);
    expect(data.token).toBeUndefined(); const cookieValue = cookies.split(';')[0]!; const token = cookieValue.split('=')[1]!;
    expect(await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${token}` }))).toBeNull();
    expect((await c.logout(request('/logout','POST',undefined,{ cookie: cookieValue, origin: 'https://example.com' }))).status).toBe(403);
    expect((await c.logout(request('/logout','POST',undefined,{ cookie: cookieValue, origin: 'https://evil.example', 'x-csrf-token': data.csrfToken }))).status).toBe(403);
    const selfReq = request('/self','GET',undefined,{ cookie: cookieValue }); const subject = await c.authenticate(selfReq); const selfRoute = c.api.find(x => x.path === '/self')!;
    const selfData = await (await selfRoute.invoke({ ...hostFor(c), request: selfReq, requestSignal: selfReq.signal, subject: subject! })).json() as any; expect(selfData.csrfToken).toBe(data.csrfToken);
    expect((await c.logout(request('/logout','POST',undefined,{ cookie: cookieValue, origin: 'https://example.com', 'x-csrf-token': data.csrfToken }))).status).toBe(200);
    expect(await c.authenticate(selfReq)).toBeNull();
    expect((await c.login(request('/login','POST',{ username:'owner',password:PASSWORD }))).status).toBe(403);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
  test('idle and absolute session expiry, global revocation', async () => {
    const { c, advance } = await setup(); let token = (await login(c)).data.token;
    advance(30 * 60_000); expect(await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${token}` }))).toBeNull();
    token = (await login(c)).data.token; for (let i = 0; i < 16; i++) { advance(29 * 60_000); expect(await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${token}` }))).not.toBeNull(); }
    advance(16 * 60_000); expect(await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${token}` }))).toBeNull();
    token = (await login(c)).data.token; await c.revokeSessions(); expect(await c.authenticate(request('/self','GET',undefined,{ authorization: `Bearer ${token}` }))).toBeNull();
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
  test('account and trusted source throttles ignore forwarded headers and indistinguishable bad credentials', async () => {
    const { c } = await setup();
    for (let i = 0; i < 10; i++) { const response = await c.login(request('/login','POST',{ username: i % 2 ? 'missing' : 'owner', password: 'incorrect-password', transport: 'bearer' }, { 'x-forwarded-for': `10.1.2.${i}` })); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'invalid_credentials' }); }
    expect((await c.login(request('/login','POST',{ username:'owner',password:PASSWORD,transport:'bearer' }, { 'x-forwarded-for':'127.0.0.1' }))).status).toBe(429);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
});

test('host-attested sources isolate login throttles while forged forwarding headers cannot select a bucket',async()=>{
 const {c}=await setup(managementRequestSource);
 for(let i=0;i<10;i++) {
  const req=request('/login','POST',{username:'missing'+i,password:'incorrect-password',transport:'bearer'},{'x-forwarded-for':'198.51.100.'+i});
  attestManagementRequestSource(req,'203.0.113.1');
  expect((await c.login(req)).status).toBe(401);
 }
 const blocked=request('/login','POST',{username:'owner',password:PASSWORD,transport:'bearer'});
 attestManagementRequestSource(blocked,'203.0.113.1');expect((await c.login(blocked)).status).toBe(429);
 const other=request('/login','POST',{username:'owner',password:PASSWORD,transport:'bearer'});
 attestManagementRequestSource(other,'203.0.113.2');expect((await c.login(other)).status).toBe(200);
}, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

test('passwords enforce 6–64 Unicode characters for creation and changes', async () => {
  const {db} = await setup();
  const c = createControl({...host(db), durableState:new PluginDurableStateStore(db).forNamespace('password-boundaries')});
  await c.start();
  for (const short of ['12345', '😀😀😀😀😀', 'x'.repeat(65)]) await expect(c.bootstrap({username:'owner',password:short,passwordConfirmation:short})).rejects.toThrow('invalid_password');
  await c.bootstrap({username:'owner',password:'123456',passwordConfirmation:'123456'});
  const first = (await login(c,'owner','123456')).data.token;
  const long = '😀'.repeat(64);
  expect((await call(c,'/password','POST',first,{currentPassword:'123456',password:long,passwordConfirmation:long})).status).toBe(200);
  const second = (await login(c,'owner',long)).data.token;
  expect((await c.login(request('/login','POST',{username:'owner',password:long + 'different',transport:'bearer'}))).status).toBe(401);
  await c.bootstrap({username:'owner',password:long,passwordConfirmation:long});
  expect((await call(c,'/password','POST',second,{currentPassword:long,password:'x'.repeat(65),passwordConfirmation:'x'.repeat(65)})).status).toBe(400);
  expect((await call(c,'/password','POST',second,{currentPassword:long,password:'abcdef',passwordConfirmation:'abcdef'})).status).toBe(200);
  expect((await login(c,'owner','abcdef')).r.status).toBe(200);
}, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
