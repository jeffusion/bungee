import { expect, test } from 'bun:test';
import { authFixture, PASSWORD, request } from '../helpers/auth-fixture';
import { createControl, recoverIdentity, readManagementSetup } from '../../server/control';

type User = { id: string; username: string; displayName: string; disabled: boolean; hasLocalPassword: boolean };
const create = (username: string, password?: string) => ({ username, displayName: username, ...(password ? { password, passwordConfirmation: password } : {}) });

test('users share full management access; password reset, disabled users and last local account protection', async () => {
  const f = await authFixture(), owner = await f.login();
  const created = await f.call(owner, '/users', 'POST', create('Second', 'Second password'));
  expect(created.status).toBe(201); const second = (await created.json() as { user: User }).user;
  expect(second).toMatchObject({ username: 'second', hasLocalPassword: true });
  const token = await f.login('second', 'Second password'), subject = await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + token }));
  expect(await f.control.authorize(subject!, 'plugins.code')).toBe(true);
  expect((await f.call(owner, '/users/update', 'PUT', { ...second, hasLocalPassword: undefined, requiresPasswordChange: undefined, disabled: true })).status).toBe(200);
  expect(await f.control.authorize(subject!, 'config.write')).toBe(false);
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + token }))).toBeNull();
  const users = await (await f.call(owner, '/users')).json() as { users: User[] }, first = users.users.find(u => u.username === 'owner')!;
  expect((await f.call(owner, '/users/update', 'PUT', { id: first.id, username: first.username, displayName: first.displayName, disabled: true })).status).toBe(409);
  expect((await f.call(owner, '/users/password', 'POST', { id: second.id, password: 'Reset password', passwordConfirmation: 'Reset password' })).status).toBe(200);
  expect((await f.call(owner, '/users/update', 'PUT', { id: second.id, username: second.username, displayName: second.displayName, disabled: false })).status).toBe(200);
  expect(await f.login('second', 'Reset password')).toBeString();
  expect((await f.call(owner, '/users', 'POST', create('SECOND'))).status).toBe(409);
  f.control.dispose();
});

test('one user login does not reuse another user live session; local-password creation supports SSO-only users', async () => {
  const f = await authFixture(), owner = await f.login();
  const sso = (await (await f.call(owner, '/users', 'POST', create('sso-user'))).json() as { user: User }).user;
  expect(sso.hasLocalPassword).toBe(false);
  expect((await f.control.login(request('/login', 'POST', { username: 'sso-user', password: PASSWORD, transport: 'bearer' }))).status).toBe(401);
  expect((await f.call(owner, '/users/password', 'POST', { id: sso.id, password: 'SSO user password', passwordConfirmation: 'SSO user password' })).status).toBe(200);
  const token = await f.login('sso-user', 'SSO user password');
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + owner }))).not.toBeNull();
  expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + token }))).not.toBeNull();
  expect((await f.state.list()).filter(r => r.key.startsWith('session:'))).toHaveLength(2);
});

test('offline anchor reset preserves other users and settings, revokes every session and optionally disables Turnstile', async () => {
  const f = await authFixture(), owner = await f.login();
  await f.call(owner, '/users', 'POST', create('second', 'Second password'));
  const second = await f.login('second', 'Second password'), anchor = await f.state.get('recovery-anchor');
  await f.call(owner, '/login-settings', 'PUT', { version: 1, autoCreateUsers: true });
  await f.call(owner, '/turnstile', 'PUT', { version: 1, enabled: true, siteKey: 'site-key', secret: 'turnstile-secret', hostnames: ['manager.example'] });
  await recoverIdentity({ operation: 'reset', username: 'recovered', password: PASSWORD, passwordConfirmation: PASSWORD, reason: 'Forgot username', disableTurnstile: '' }, { durableState: f.state, now: f.now });
  expect((await f.state.get('recovery-anchor'))!.value).toEqual(anchor!.value);
  expect((await f.state.get('turnstile'))!.value).toMatchObject({ turnstile: { enabled: true } });
  expect((await f.state.get('login-settings'))!.value).toMatchObject({ settings: { autoCreateUsers: true } });
  expect((await f.state.list()).filter(r => r.key.startsWith('user:'))).toHaveLength(2);
  for (const token of [owner, second]) expect(await f.control.authenticate(request('/self', 'GET', undefined, { authorization: 'Bearer ' + token }))).toBeNull();
  await recoverIdentity({ operation: 'reset', username: 'recovered', password: PASSWORD, passwordConfirmation: PASSWORD, reason: 'Disable challenge explicitly', disableTurnstile: 'yes' }, { durableState: f.state, now: f.now });
  expect(await f.login('recovered')).toBeString(); expect(await f.login('second', 'Second password')).toBeString();
});

test.each([1, 2])('schema %s cannot start, initialize, recover or silently reopen', async schema => {
  const f = await authFixture(); const record = (await f.state.get('setup'))!;
  await f.state.transact([{ key: 'setup', expectedVersion: record.version, value: { schema, setup: { phase: 'ready' } } }]);
  await expect(readManagementSetup(f.state)).rejects.toThrow('corrupt_state');
  await expect(createControl(f.host).start()).rejects.toThrow('corrupt_state');
  await expect(recoverIdentity({ operation: 'reset', username: 'owner', password: PASSWORD, passwordConfirmation: PASSWORD, reason: 'Invalid schema' }, { durableState: f.state })).rejects.toThrow('corrupt_state');
});

test('failed authentication audit contains only bounded actor, action, result and time fields', async () => {
  const f = await authFixture();
  const response = await f.control.login(request('/login', 'POST', { username: 'owner', password: 'Secret incorrect password', transport: 'bearer' }));
  expect(response.status).toBe(401);
  const records = (await f.state.list()).filter(r => r.key.startsWith('audit:'));
  expect(records).toHaveLength(1);
  expect(records[0]!.value).toMatchObject({ audit: { actor: 'anonymous', action: 'local.login', result: 'invalid_credentials' } });
  expect(JSON.stringify(records)).not.toContain('Secret incorrect password');
  expect(Object.keys((records[0]!.value as {audit: object}).audit).sort()).toEqual(['action', 'actor', 'at', 'result']);
});

for (const missing of ['turnstile', 'login-settings']) {
  test(`missing ${missing} after initialization fails closed instead of restoring defaults`, async () => {
    const f = await authFixture(), token = await f.login();
    const state = {
      get: (key:string) => key === missing ? Promise.resolve(null) : f.state.get(key),
      list: async () => (await f.state.list()).filter(r=>r.key!==missing),
      transact: f.state.transact.bind(f.state),
    };
    const broken = createControl({...f.host,durableState:state});
    await expect(broken.start()).rejects.toThrow('corrupt_state');
    expect((await broken.login(request('/login','POST',{username:'owner',password:PASSWORD,transport:'bearer'}))).status).toBe(503);
    await expect(broken.authenticate(request('/verify','GET',undefined,{authorization:'Bearer '+token}))).rejects.toThrow('corrupt_state');
  });
}
