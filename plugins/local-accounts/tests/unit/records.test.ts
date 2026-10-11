import {expect, test} from 'bun:test';
import {createControl, recoverIdentity, MAX_SESSIONS} from '../../server/control';
import {AsyncFakeState} from '../fake-durable-state';
import type {ControlHostContext} from '../../../../packages/core/src/plugin-control/contracts';
import type {DurableJson} from '../../../../packages/core/src/plugin-durable-state';
const password = 'independent-account-records';
const req = (token?: string) => new Request('https://example.com/self', {headers: token ? {authorization: 'Bearer ' + token} : {}});
const loginRequest = (name = 'owner', p = password) => new Request('https://example.com/login', {method: 'POST', body: JSON.stringify({username: name, password: p, transport: 'bearer'})});
async function fixture() {
  const state = new AsyncFakeState(), host: ControlHostContext = {signal: new AbortController().signal, durableState: state, secretStore: {} as never, storage: {} as never};
  let now = 1_000_000; const control = createControl(host, {now: () => now});
  await control.start(); await control.bootstrap({username: 'owner', password, passwordConfirmation: password});
  const login = async () => { const r = await control.login(loginRequest()); expect(r.status).toBe(200); return (await r.json()).token as string; };
  return {state, host, control, login, advance: (ms: number) => {now += ms;}};
}
test('repeated authentication updates exactly one session and never the administrator, limiter or command history', async () => {
  const f = await fixture(), first = await f.login(), second = await f.login(), before = await f.state.list();
  const writes = f.state.writes.length;
  for (let i = 0; i < 20; i++) { f.advance(1); expect(await f.control.authenticate(req(first))).not.toBeNull(); }
  const after = await f.state.list(), changed = after.filter(r => r.version !== before.find(b => b.key === r.key)!.version);
  expect(changed).toHaveLength(1); expect(changed[0]!.key).toMatch(/^session:/); expect(changed[0]!.version - before.find(r => r.key === changed[0]!.key)!.version).toBe(20);
  expect(f.state.writes.slice(writes).every(keys => keys.length === 1 && keys[0] === changed[0]!.key)).toBe(true);
  expect(after.find(r => r.key === 'administrator')).toEqual(before.find(r => r.key === 'administrator'));
  expect(JSON.stringify(after)).not.toContain(first); expect(JSON.stringify(after)).not.toContain(second);
  expect(after.every(r => !r.key.includes('command') && !r.key.includes('audit'))).toBe(true);
});
test('missing, malformed, unknown, wrong-transport, expired and rollback credentials write nothing', async () => {
  const f = await fixture(), token = await f.login(), writes = f.state.writes.length;
  for (const request of [req(), req('invalid'), req('a'.repeat(43)), new Request('https://example.com/self', {headers: {cookie: 'bungee_local_session=' + token}})]) expect(await f.control.authenticate(request)).toBeNull();
  f.advance(-1); expect(await f.control.authenticate(req(token))).toBeNull(); f.advance(1 + 30 * 60_000);
  expect(await f.control.authenticate(req(token))).toBeNull(); expect(f.state.writes).toHaveLength(writes);
});
test('concurrent failure reservations across controls cannot bypass account or source limits', async () => {
  const f = await fixture(), other = createControl(f.host); await other.start();
  const responses = await Promise.all(Array.from({length: 16}, (_, i) => (i % 2 ? f.control : other).login(loginRequest('owner', 'incorrect'))));
  expect(responses.filter(r => r.status === 401)).toHaveLength(10); expect(responses.filter(r => r.status === 429)).toHaveLength(6);
  const failures = (await f.state.list()).filter(r => r.key.startsWith('failure:'));
  expect(failures).toHaveLength(2); for (const r of failures) expect((r.value as any).failure.count).toBe(10);
  expect((await f.control.login(loginRequest())).status).toBe(429);
});
test('asynchronous foreign conflict errors retry, unavailable errors fail closed, and a logout during touch never revives a session', async () => {
  const f = await fixture(), token = await f.login();
  f.state.rejectNext = Object.assign(new Error('foreign conflict constructor'), {code: 'durable_state_conflict'});
  expect(await f.control.authenticate(req(token))).not.toBeNull();
  const before = await f.state.list(); f.state.rejectNext = new Error('database unavailable');
  await expect(f.control.authenticate(req(token))).rejects.toThrow('database unavailable'); expect(await f.state.list()).toEqual(before);
  f.state.beforeTransact = async () => { expect((await f.control.logout(new Request('https://example.com/logout', {method: 'POST', headers: {authorization: 'Bearer ' + token}}))).status).toBe(200); };
  expect(await f.control.authenticate(req(token))).toBeNull(); expect(await f.control.authenticate(req(token))).toBeNull();
  const replacement = await f.login(); expect(await f.control.authenticate(req(replacement))).not.toBeNull(); expect(await f.control.authenticate(req(token))).toBeNull();
  expect((await f.state.list()).filter(r => r.key.startsWith('session:'))).toHaveLength(1);
});
test('512 live sessions enforce capacity; expired slots are reused and logout churn stays bounded', async () => {
  const f = await fixture(), first = await f.login(), existing = (await f.state.get('session:0'))!, template = (existing.value as any).session;
  for (let offset = 1; offset < MAX_SESSIONS; offset += 128) await f.state.transact(Array.from({length: Math.min(128, MAX_SESSIONS - offset)}, (_, j) => ({key: 'session:' + (offset + j), expectedVersion: 0, value: {schema: 3, session: {...template, digest: (offset + j).toString(16).padStart(64, '0')}} as DurableJson})));
  expect((await f.control.login(loginRequest())).status).toBe(429); f.advance(30 * 60_000);
  const replacement = await f.login(); expect(await f.control.authenticate(req(first))).toBeNull(); expect(await f.control.authenticate(req(replacement))).not.toBeNull();
  for (let i = 0; i < 4; i++) {
    expect((await f.control.logout(new Request('https://example.com/logout', {method: 'POST', headers: {authorization: 'Bearer ' + (i ? await f.login() : replacement)}}))).status).toBe(200);
  }
  expect((await f.state.list()).filter(r => r.key.startsWith('session:'))).toHaveLength(MAX_SESSIONS);
});
test('expired limiter slot reuse does not duplicate a second requested bucket; recovery uses epochs', async () => {
  const f = await fixture(); expect((await f.control.login(loginRequest('missing', 'incorrect'))).status).toBe(401);
  f.advance(15 * 60_000); expect((await f.control.login(loginRequest('another', 'incorrect'))).status).toBe(401);
  const failures = (await f.state.list()).filter(r => r.key.startsWith('failure:')); expect(failures).toHaveLength(2);
  const first = await f.login(), subject = await f.control.authenticate(req(first));
  await recoverIdentity({username: 'owner', password, reason: 'reset epoch'}, {durableState: f.state});
  expect(await f.control.authorize(subject!, 'config.write')).toBe(false); expect(await f.control.authenticate(req(first))).toBeNull();
  expect(await f.login()).toBeString(); expect((await f.state.list()).filter(r => r.key.startsWith('failure:')).length).toBeLessThanOrEqual(3);
});
test('1024 active limiter slots fail closed and expired slots reuse their original keys', async () => {
  const f = await fixture();
  for (let offset = 0; offset < 1024; offset += 128) await f.state.transact(Array.from({length: 128}, (_, j) => ({key: 'failure:' + (offset + j), expectedVersion: 0, value: {schema: 3, failure: {key: 'account:' + (offset + j).toString(16).padStart(64, '0'), count: 1, until: 1_000_000 + 15 * 60_000, epoch: 1}}})));
  const before = await f.state.list(); expect((await f.control.login(loginRequest('missing', 'incorrect'))).status).toBe(429); expect(await f.state.list()).toEqual(before);
  f.advance(15 * 60_000); expect((await f.control.login(loginRequest('missing', 'incorrect'))).status).toBe(401);
  const after = await f.state.list(); expect(after.filter(r => r.key.startsWith('failure:'))).toHaveLength(1024);
  expect(after.filter(r => r.version !== before.find(b => b.key === r.key)!.version)).toHaveLength(2);
});
