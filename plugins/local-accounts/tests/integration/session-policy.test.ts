import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore } from '../../../../packages/core/src/plugin-durable-state';
import type { ControlHostContext } from '../../../../packages/core/src/plugin-control/contracts';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../../../../packages/core/tests/helpers/test-budgets';
import { createControl, recoverIdentity } from '../../server/control';

const password = 'session-policy-password';
const resources: {db: Database; dir: string}[] = [];
afterEach(() => { for (const {db, dir} of resources.splice(0)) { db.close(); rmSync(dir, {recursive: true, force: true}); } });
const req = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Request('https://example.com' + path, {
  method, headers: {'content-type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-policy-')), path = join(dir, 'state.db'), db = new Database(path);
  resources.push({db, dir}); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('local-accounts');
  const host: ControlHostContext = {signal: new AbortController().signal, durableState: state, secretStore: {} as never, storage: {} as never};
  let now = 1_000_000;
  const control = createControl(host, {now: () => now}); await control.start();
  await control.bootstrap({username: 'owner', password, passwordConfirmation: password});
  const login = async (transport: 'bearer' | 'cookie' = 'bearer') => {
    const response = await control.login(req('/login', 'POST', {username: 'owner', password, transport}, transport === 'cookie' ? {origin: 'https://example.com'} : {}));
    expect(response.status).toBe(200);
    const data = await response.json() as {token: string; csrfToken: string; expiresIn: number | null};
    const headers: Record<string, string> = transport === 'cookie' ? {cookie: response.headers.get('set-cookie')!.split(';')[0]!} : {authorization: 'Bearer ' + data.token};
    return {response, data, headers};
  };
  const administrator = await login();
  const invoke = async (method: string, body?: unknown, headers: Record<string, string> = administrator.headers) => {
    const request = req('/session-policy', method, body, headers), subject = await control.authenticate(request);
    return control.api.find(x => x.path === '/session-policy')!.invoke({...host, request, requestSignal: request.signal, subject: subject ?? undefined});
  };
  const save = async (idleTimeoutMinutes: number, absoluteTimeoutMinutes: number) => {
    const current = await (await invoke('GET')).json() as {version: number};
    const response = await invoke('PUT', {version: current.version, policy: {idleTimeoutMinutes, absoluteTimeoutMinutes}});
    expect(response.status).toBe(200); return response.json();
  };
  return {control, db, dir, path, state, host, login, invoke, save, administrator, now: () => now, advance: (ms: number) => {now += ms;}};
}

describe('configurable local management session policy', () => {
  test('an independently bundled control provider recognizes host-side SQLite version conflicts', async () => {
    const f = await fixture();
    const build = await Bun.build({entrypoints: [fileURLToPath(new URL('../../server/control.ts', import.meta.url))], target: 'bun', format: 'esm'});
    expect(build.success).toBe(true);
    const moduleUrl = URL.createObjectURL(new Blob([await build.outputs[0]!.text()], {type: 'text/javascript'}));
    try {
      const module = await import(moduleUrl) as {createControl: typeof createControl};
      const control = module.createControl(f.host, {now: f.now}); await control.start();
      await f.save(0, 0);
      const request = req('/session-policy', 'PUT', {version: 0, policy: {idleTimeoutMinutes: 1, absoluteTimeoutMinutes: 1}}, f.administrator.headers);
      const subject = await control.authenticate(request);
      const response = await control.api.find(x => x.path === '/session-policy')!.invoke({...f.host, request, requestSignal: request.signal, subject: subject!});
      expect(response.status).toBe(409); expect(await response.json()).toEqual({error: 'version_conflict'});
      expect((await f.state.get('session-policy'))!.value).toEqual({idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0});
      control.dispose();
    } finally {URL.revokeObjectURL(moduleUrl);}
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('default settings and versioned updates reject invalid inputs and stale editors without mutation', async () => {
    const f = await fixture();
    expect(await (await f.invoke('GET')).json()).toEqual({version: 0, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}});
    for (const policy of [null, [], {}, {idleTimeoutMinutes: -1, absoluteTimeoutMinutes: 480}, {idleTimeoutMinutes: 0.5, absoluteTimeoutMinutes: 480},
      {idleTimeoutMinutes: '30', absoluteTimeoutMinutes: 480}, {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: Number.MAX_SAFE_INTEGER},
      {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480, other: 1}]) {
      expect((await f.invoke('PUT', {version: 0, policy})).status).toBe(400);
    }
    expect(await f.state.get('session-policy')).toBeNull();
    expect(await f.save(0, 30 * 24 * 60)).toEqual({version: 1, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 43200}});
    expect((await f.invoke('PUT', {version: 0, policy: {idleTimeoutMinutes: 1, absoluteTimeoutMinutes: 1}})).status).toBe(409);
    expect((await f.invoke('GET')).status).toBe(200);
    expect((await f.state.get('session-policy'))!.version).toBe(1);
    expect((await f.invoke('PUT', {version: -1, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0}})).status).toBe(400);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('custom timeouts use exact boundaries and activity only renews the idle deadline', async () => {
    const f = await fixture(); await f.save(60, 120); const session = await f.login();
    f.advance(60 * 60_000 - 1); expect(await f.control.authenticate(req('/self', 'GET', undefined, session.headers))).not.toBeNull();
    f.advance(60 * 60_000 - 1); expect(await f.control.authenticate(req('/self', 'GET', undefined, session.headers))).not.toBeNull();
    f.advance(2); expect(await f.control.authenticate(req('/self', 'GET', undefined, session.headers))).toBeNull();
    const idle = await f.login(); f.advance(60 * 60_000);
    expect(await f.control.authenticate(req('/self', 'GET', undefined, idle.headers))).toBeNull();
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('each timeout can be disabled independently, or both disabled, without losing revocation', async () => {
    const f = await fixture(); await f.save(0, 720); const noIdle = await f.login();
    f.advance(9 * 60 * 60_000); expect(await f.control.authenticate(req('/self', 'GET', undefined, noIdle.headers))).not.toBeNull();
    f.advance(3 * 60 * 60_000); expect(await f.control.authenticate(req('/self', 'GET', undefined, noIdle.headers))).toBeNull();
    // The original administrator session has now expired; use a new one for subsequent settings.
    const admin = await f.login();
    const current = await (await f.invoke('GET', undefined, admin.headers)).json() as {version: number};
    expect((await f.invoke('PUT', {version: current.version, policy: {idleTimeoutMinutes: 600, absoluteTimeoutMinutes: 0}}, admin.headers)).status).toBe(200);
    const noAbsolute = await f.login(); expect(noAbsolute.data.expiresIn).toBeNull();
    for (let i = 0; i < 4; i++) { f.advance(9 * 60 * 60_000); expect(await f.control.authenticate(req('/self', 'GET', undefined, noAbsolute.headers))).not.toBeNull(); }
    const policy = await (await f.invoke('GET', undefined, noAbsolute.headers)).json() as {version: number};
    expect((await f.invoke('PUT', {version: policy.version, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0}}, noAbsolute.headers)).status).toBe(200);
    const unlimited = await f.login(); f.advance(800 * 24 * 60 * 60_000);
    expect(await f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).not.toBeNull();
    await f.control.revokeSessions(); expect(await f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).toBeNull();
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('settings only affect new sessions; legacy sessions without a snapshot retain old defaults', async () => {
    const f = await fixture(); const old = await f.login();
    for (const record of (await f.state.list()).filter(r => r.key.startsWith('session:'))) {
      const value = record.value as any; if (value.session) delete value.session.policy;
      await f.state.transact([{key: record.key, expectedVersion: record.version, value}]);
    }
    await f.save(0, 0); const unlimited = await f.login();
    f.advance(30 * 60_000);
    expect(await f.control.authenticate(req('/self', 'GET', undefined, old.headers))).toBeNull();
    expect(await f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).not.toBeNull();
    const settings = await (await f.invoke('GET', undefined, unlimited.headers)).json() as {version: number};
    expect((await f.invoke('PUT', {version: settings.version, policy: {idleTimeoutMinutes: 1, absoluteTimeoutMinutes: 1}}, unlimited.headers)).status).toBe(200);
    const short = await f.login(); f.advance(60_000);
    expect(await f.control.authenticate(req('/self', 'GET', undefined, short.headers))).toBeNull();
    expect(await f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).not.toBeNull();
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('persistent policy and per-session snapshots survive reopening the database', async () => {
    const f = await fixture(); await f.save(0, 0); const session = await f.login();
    f.control.dispose(); f.db.close(); resources.splice(resources.findIndex(r => r.db === f.db), 1);
    const reopened = new Database(f.path); resources.push({db: reopened, dir: f.dir});
    const state = new PluginDurableStateStore(reopened).forNamespace('local-accounts');
    const control = createControl({...f.host, durableState: state}, {now: () => f.now() + 365 * 24 * 60 * 60_000}); await control.start();
    expect((await state.get('session-policy'))!.value).toEqual({idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0});
    expect(await control.authenticate(req('/self', 'GET', undefined, session.headers))).not.toBeNull();
    expect(JSON.stringify(await state.list())).not.toContain(session.data.token);
    await recoverIdentity({username: 'owner', password: 'recovered-session-password', reason: 'test recovery'}, {durableState: state});
    expect(await control.authenticate(req('/self', 'GET', undefined, session.headers))).toBeNull();
    expect((await state.get('session-policy'))!.value).toEqual({idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0});
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('cookie age matches custom lifetime, renewal preserves the absolute deadline and unlimited uses a browser lease', async () => {
    const f = await fixture(); await f.save(0, 60); const finite = await f.login('cookie');
    expect(finite.response.headers.get('set-cookie')).toContain('Max-Age=3600');
    f.advance(15 * 60_000);
    expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, finite.headers))).toContain('Max-Age=2700');
    f.advance(45 * 60_000 - 1001);
    expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, finite.headers))).toContain('Max-Age=1');
    f.advance(2); expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, finite.headers))).toContain('Max-Age=0');
    f.advance(998); expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, finite.headers))).toContain('Max-Age=0');
    f.advance(1); expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, finite.headers))).toBeUndefined();
    const admin = await f.login();
    const settings = await (await f.invoke('GET', undefined, admin.headers)).json() as {version: number};
    expect((await f.invoke('PUT', {version: settings.version, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0}}, admin.headers)).status).toBe(200);
    const infinite = await f.login('cookie'); expect(infinite.response.headers.get('set-cookie')).toContain('Max-Age=34560000');
    f.advance(30 * 24 * 60 * 60_000);
    const renewed = await f.control.sessionCookie(req('/verify', 'GET', undefined, infinite.headers))!;
    for (const flag of ['Max-Age=34560000', 'HttpOnly', 'SameSite=Strict', 'Secure']) expect(renewed).toContain(flag);
    expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, admin.headers))).toBeUndefined();
    expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, {cookie: 'bungee_local_session=' + 'x'.repeat(43)}))).toBeUndefined();
    const logout = await f.control.logout(req('/logout', 'POST', undefined, {...infinite.headers, origin: 'https://example.com', 'x-csrf-token': infinite.data.csrfToken}));
    expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await f.control.sessionCookie(req('/verify', 'GET', undefined, infinite.headers))).toBeUndefined();
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('policy writes require a live issued subject, correct origin and CSRF', async () => {
    const f = await fixture(); const session = await f.login('cookie');
    const change = {version: 0, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 0}};
    expect((await f.invoke('GET', undefined, {})).status).toBe(403);
    expect((await f.invoke('PUT', change, session.headers)).status).toBe(403);
    expect((await f.invoke('PUT', change, {...session.headers, origin: 'https://evil.example', 'x-csrf-token': session.data.csrfToken})).status).toBe(403);
    expect(await f.state.get('session-policy')).toBeNull();
    expect((await f.invoke('PUT', change, {...session.headers, origin: 'https://example.com', 'x-csrf-token': session.data.csrfToken})).status).toBe(200);
    const request = req('/session-policy', 'PUT', {...change, version: 1}, f.administrator.headers);
    const subject = await f.control.authenticate(request); await f.control.revokeSessions();
    expect((await f.control.api.find(x => x.path === '/session-policy')!.invoke({...f.host, request, requestSignal: request.signal, subject: subject!})).status).toBe(403);
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('corrupt persisted policy or session snapshot fails closed; clock rollback is not an unlimited-session bypass', async () => {
    const f = await fixture(); await f.save(0, 0); const unlimited = await f.login();
    f.advance(-1); expect(await f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).toBeNull(); f.advance(1);
    const policy = (await f.state.get('session-policy'))!;
    await f.state.transact([{key: 'session-policy', expectedVersion: policy.version, value: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: -1}}]);
    await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');
    expect((await f.control.login(req('/login', 'POST', {username: 'owner', password, transport: 'bearer'}))).status).toBe(503);
    const tokenDigest = createHash('sha256').update(unlimited.data.token).digest('hex');
    const record = (await f.state.list()).find(r => r.key.startsWith('session:') && (r.value as any).session?.digest === tokenDigest)!, value = record.value as any; value.session.policy = {idleTimeoutMinutes: 0};
    await f.state.transact([{key: record.key, expectedVersion: record.version, value}]);
    await expect(f.control.authenticate(req('/self', 'GET', undefined, unlimited.headers))).rejects.toThrow('corrupt_state');
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
});
