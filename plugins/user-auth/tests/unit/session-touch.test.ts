import {expect, test} from 'bun:test';
import type {ControlHostContext} from '../../../../packages/core/src/plugin-control/contracts';
import type {DurableMutation, PluginDurableState} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, recoverIdentity} from '../../server/control';
import {AsyncFakeState} from '../helpers/fake-durable-state';

const password = 'session-touch-test-password';
const initialTime = 1_000_000;
const request = (token: string, method = 'GET') => new Request('https://example.com/self', {method, headers: {authorization: 'Bearer ' + token}});
function touchPhase(changes: readonly DurableMutation[]): 'prepare' | 'confirm' | undefined {
  const session = changes.find(change => change.key.startsWith('session:'))?.value as {session?: {pendingTouch?: number}} | undefined;
  return session?.session ? session.session.pendingTouch === undefined ? 'confirm' : 'prepare' : undefined;
}
async function fixture(policy?: {idleTimeoutMinutes: number; absoluteTimeoutMinutes: number}) {
  const state = new AsyncFakeState(); let now = initialTime;
  const hooks: {read?: (key: string) => Promise<void>; before?: (phase: ReturnType<typeof touchPhase>) => Promise<void>; after?: (phase: ReturnType<typeof touchPhase>) => Promise<void>} = {};
  const durableState: PluginDurableState = {
    get: async key => {const record = await state.get(key); await hooks.read?.(key); return record;},
    list: () => state.list(),
    transact: async changes => {const phase = touchPhase(changes); await hooks.before?.(phase); const saved = await state.transact(changes); await hooks.after?.(phase); return saved;},
  };
  const host: ControlHostContext = {signal: new AbortController().signal, durableState, secretStore: {} as never, storage: {} as never};
  await recoverIdentity({operation: 'reset', username: 'owner', password, passwordConfirmation: password, reason: 'test fixture'}, {durableState, now: () => now});
  if (policy) await state.transact([{key: 'session-policy', expectedVersion: 0, value: {schema: 3, policy}}]);
  const control = createControl(host, {now: () => now}); await control.start();
  const response = await control.login(new Request('https://example.com/login', {method: 'POST', body: JSON.stringify({username: 'owner', password, transport: 'bearer'})}));
  expect(response.status).toBe(200); const token = (await response.json()).token as string;
  const other = async () => {const result = createControl({...host, durableState: state}, {now: () => now}); await result.start(); return result;};
  return {state, durableState, host, hooks, control, token, other, time: () => now, setTime: (value: number) => {now = value;}};
}

for (const boundary of ['idle', 'absolute'] as const) for (const delay of ['read', 'prepare'] as const) {
  test(`${delay} crossing the ${boundary} deadline leaves no confirmed renewal, including after restart and rollback`, async () => {
    const f = await fixture(boundary === 'absolute' ? {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 1} : undefined);
    const deadline = initialTime + (boundary === 'idle' ? 30 : 1) * 60_000;
    f.setTime(deadline - 1);
    if (delay === 'read') f.hooks.read = async key => {if (key.startsWith('user:')) {f.hooks.read = undefined; f.setTime(deadline);}};
    else f.hooks.before = async phase => {if (phase === 'prepare') {f.hooks.before = undefined; f.setTime(deadline);}};
    expect(await f.control.authenticate(request(f.token))).toBeNull();
    const slot = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch?: number}};
    expect(slot.session.touched).toBe(initialTime);
    if (delay === 'prepare') expect(slot.session.pendingTouch).toBe(deadline - 1);
    f.setTime(initialTime); const restarted = await f.other();
    expect(await restarted.authenticate(request(f.token))).toBeNull();
  });
}

test('lost prepare ACK and concurrent readers cannot accept pending activity beyond the original deadline', async () => {
  const f = await fixture(), observer = await f.other(), prior = await f.control.authenticate(request(f.token));
  expect(prior).not.toBeNull(); const deadline = initialTime + 30 * 60_000;
  f.setTime(deadline - 1);
  let sameInstance: Promise<unknown> | undefined;
  f.hooks.after = async phase => {
    if (phase !== 'prepare') return; f.hooks.after = undefined; f.setTime(deadline);
    // This request queues behind the in-flight planner; the other control sees
    // the persisted pending slot immediately, before the first caller gets ACK.
    sameInstance = f.control.authenticate(request(f.token));
    expect(await observer.authenticate(request(f.token))).toBeNull();
    expect(await observer.sessionCookie(new Request('https://example.com/self', {headers: {cookie: 'bungee_user_session=' + f.token}}))).toBeUndefined();
    throw new Error('prepare acknowledgement lost');
  };
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('prepare acknowledgement lost');
  expect(await sameInstance).toBeNull(); expect(await f.control.authorize(prior!, 'config.write')).toBe(false);
  const saved = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch: number}};
  expect(saved.session.touched).toBe(initialTime); expect(saved.session.pendingTouch).toBe(deadline - 1);
  const restarted = await f.other(); f.setTime(initialTime);
  expect(await restarted.authenticate(request(f.token))).toBeNull();
  expect(await (await f.other()).authenticate(request(f.token))).toBeNull();
});

test('lost prepare ACK without another observer remains unconfirmed across restart', async () => {
  const f = await fixture(); f.setTime(initialTime + 30 * 60_000 - 1);
  f.hooks.after = async phase => {if (phase === 'prepare') {f.hooks.after = undefined; f.setTime(f.time() + 2); throw new Error('prepare acknowledgement lost');}};
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('prepare acknowledgement lost');
  const clock = (await f.state.get('clock'))!.value as {observedThrough: number};
  expect(clock.observedThrough).toBe(initialTime + 30 * 60_000 + 1);
  f.setTime(initialTime); const restarted = await f.other();
  expect(await restarted.authenticate(request(f.token))).toBeNull();
});

test('an unavailable clock after prepare ACK loss preserves the original authentication failure', async () => {
  const f = await fixture(); f.setTime(initialTime + 29 * 60_000);
  f.hooks.after = async phase => {
    if (phase !== 'prepare') return; f.hooks.after = undefined;
    f.hooks.read = async key => {if (key === 'clock') throw new Error('clock unavailable');};
    throw new Error('prepare acknowledgement lost');
  };
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('prepare acknowledgement lost');
  const slot = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch: number}};
  expect(slot.session.touched).toBe(initialTime); expect(slot.session.pendingTouch).toBe(initialTime + 29 * 60_000);
});

test('a late successful authentication renews from confirmation time despite an old pending marker', async () => {
  const f = await fixture(); f.setTime(initialTime + 60_000);
  f.hooks.after = async phase => {if (phase === 'prepare') {f.hooks.after = undefined; throw new Error('prepare acknowledgement lost');}};
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('prepare acknowledgement lost');
  const prepared = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch: number}};
  expect(prepared.session.touched).toBe(initialTime); expect(prepared.session.pendingTouch).toBe(initialTime + 60_000);
  f.setTime(initialTime + 29 * 60_000);
  const restarted = await f.other(), subject = await restarted.authenticate(request(f.token));
  expect(subject).not.toBeNull();
  const confirmed = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch?: number}};
  expect(confirmed.session.touched).toBe(f.time()); expect(confirmed.session.pendingTouch).toBeUndefined();
  f.setTime(initialTime + 58 * 60_000); expect(await restarted.authorize(subject!, 'config.write')).toBe(true);
  f.setTime(initialTime + 59 * 60_000); expect(await restarted.authorize(subject!, 'config.write')).toBe(false);
});

test('valid pending activity can be helped by another control and concurrent authentication keeps sessions live', async () => {
  const f = await fixture(), observer = await f.other(); f.setTime(initialTime + 29 * 60_000);
  f.hooks.after = async phase => {
    if (phase !== 'prepare') return; f.hooks.after = undefined;
    expect(await observer.authenticate(request(f.token))).not.toBeNull();
  };
  expect(await f.control.authenticate(request(f.token))).not.toBeNull();
  f.setTime(initialTime + 58 * 60_000);
  const subjects = await Promise.all(Array.from({length: 24}, (_, index) => (index % 2 ? observer : f.control).authenticate(request(f.token))));
  expect(subjects.every(subject => subject !== null)).toBe(true);
  const slot = (await f.state.get('session:0'))!.value as {session: {touched: number; pendingTouch?: number}};
  expect(slot.session.touched).toBe(f.time()); expect(slot.session.pendingTouch).toBeUndefined();
  expect((await f.state.list()).filter(record => record.key.startsWith('session:'))).toHaveLength(1);
});

test('confirmation ACK loss preserves only activity observed committed before its old deadline', async () => {
  const f = await fixture(); f.setTime(initialTime + 29 * 60_000);
  f.hooks.after = async phase => {if (phase === 'confirm') {f.hooks.after = undefined; throw new Error('confirmation acknowledgement lost');}};
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('confirmation acknowledgement lost');
  f.setTime(initialTime + 31 * 60_000);
  expect(await (await f.other()).authenticate(request(f.token))).not.toBeNull();
});

test('read-only authorization does not confirm or extend pending activity', async () => {
  const f = await fixture(), subject = await f.control.authenticate(request(f.token)); expect(subject).not.toBeNull();
  f.setTime(initialTime + 29 * 60_000);
  f.hooks.after = async phase => {if (phase === 'prepare') {f.hooks.after = undefined; throw new Error('prepare acknowledgement lost');}};
  await expect(f.control.authenticate(request(f.token))).rejects.toThrow('prepare acknowledgement lost');
  const before = await f.state.get('session:0');
  expect(await f.control.authorize(subject!, 'config.write')).toBe(true);
  expect(await f.state.get('session:0')).toEqual(before);
  f.setTime(initialTime + 30 * 60_000);
  expect(await f.control.authorize(subject!, 'config.write')).toBe(false);
  expect(await f.state.get('session:0')).toEqual(before);
});

for (const conflict of ['logout', 'revoke', 'password', 'recovery', 'expiration'] as const) {
  test(`confirmation cannot overwrite ${conflict} observed by another control`, async () => {
    const f = await fixture(), observer = await f.other(), subject = await observer.authenticate(request(f.token));
    expect(subject).not.toBeNull(); f.setTime(initialTime + 29 * 60_000);
    f.hooks.before = async phase => {
      if (phase !== 'confirm') return; f.hooks.before = undefined;
      if (conflict === 'logout') expect((await observer.logout(request(f.token, 'POST'))).status).toBe(200);
      if (conflict === 'revoke') await observer.revokeSessions();
      if (conflict === 'recovery') await recoverIdentity({operation: 'reset', username: 'owner', password, passwordConfirmation: password, reason: 'test reset'}, {durableState: f.state, now: f.time});
      if (conflict === 'password') {
        const change = new Request('https://example.com/password', {method: 'POST', headers: {authorization: 'Bearer ' + f.token}, body: JSON.stringify({currentPassword: password, password: 'changed-session-password', passwordConfirmation: 'changed-session-password'})});
        expect((await observer.api.find(api => api.path === '/password')!.invoke({...f.host, request: change, requestSignal: change.signal, subject: subject!})).status).toBe(200);
      }
      if (conflict === 'expiration') {f.setTime(initialTime + 30 * 60_000); expect(await observer.authorize(subject!, 'config.write')).toBe(false);}
    };
    expect(await f.control.authenticate(request(f.token))).toBeNull();
    f.setTime(initialTime); expect(await (await f.other()).authenticate(request(f.token))).toBeNull();
  });
}
