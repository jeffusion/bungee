import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, recoverIdentity, readManagementSetup} from '../../server/control';
const oldPassword = 'previous-owner-password-2026', nextPassword = 'recovered-owner-password-2026';
function fixture() {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const durableState = new PluginDurableStateStore(db).forNamespace('local-accounts');
  const host = {signal: new AbortController().signal, durableState, secretStore: {} as never, storage: {} as never};
  return {db, durableState, host};
}
const request = (username = 'owner', password = oldPassword) => new Request('https://example.com/login', {method: 'POST', body: JSON.stringify({username, password, transport: 'bearer'})});
test('offline recovery keeps the administrator, revokes sessions, resets throttles and retains one redacted summary', async () => {
  const {db, durableState, host} = fixture();
  try {
    const control = createControl(host); await control.bootstrap({username: 'owner', password: oldPassword, passwordConfirmation: oldPassword});
    const token = (await (await control.login(request())).json()).token;
    for (let i = 0; i < 10; i++) expect((await control.login(request('owner', 'incorrect'))).status).toBe(401);
    expect((await control.login(request())).status).toBe(429);
    await expect(recoverIdentity({username: 'new', password: nextPassword, reason: 'restore access'}, {durableState})).rejects.toThrow('existing_administrator');
    const before = (await durableState.get('administrator'))!.value as any;
    const result = await recoverIdentity({username: 'owner', password: nextPassword, reason: 'restore access'}, {durableState});
    expect(result).toMatchObject({username: 'owner', id: before.administrator.id}); expect(result).not.toHaveProperty('role');
    const restored = (await durableState.get('administrator'))!.value as any;
    expect(restored.schema).toBe(3); expect(restored.administrator.failureEpoch).toBe(2);
    expect(await Bun.password.verify(nextPassword, restored.administrator.passwordHash)).toBe(true);
    expect(await Bun.password.verify(oldPassword, restored.administrator.passwordHash)).toBe(false);
    expect(await control.authenticate(new Request('https://example.com/self', {headers: {authorization: 'Bearer ' + token}}))).toBeNull();
    expect((await control.login(request('owner', nextPassword))).status).toBe(200);
    await recoverIdentity({password: nextPassword, reason: 'another recovery'}, {durableState});
    const records = await durableState.list(), summary = records.find(x => x.key === 'recovery-summary')!;
    expect(records.filter(x => x.key.startsWith('recovery'))).toHaveLength(1);
    expect(summary.version).toBe(2); expect(JSON.stringify(summary)).not.toContain('passwordHash'); expect(JSON.stringify(summary)).not.toContain('digest');
    expect(JSON.stringify(records)).not.toContain(nextPassword);
  } finally {db.close();}
});
test('legacy aggregate records are rejected without runtime conversion or writes', async () => {
  for (const schema of [1, 2]) {
    const {db, durableState, host} = fixture();
    try {
      await durableState.transact([{key: 'accounts', expectedVersion: 0, value: {schema, members: [], administrator: null, sessions: [], failures: []}}]);
      const before = await durableState.list();
      await expect(createControl(host).start()).rejects.toThrow('account_migration_required');
      await expect(readManagementSetup(durableState)).rejects.toThrow('account_migration_required');
      await expect(recoverIdentity({username: 'owner', password: nextPassword, reason: 'restore'}, {durableState})).rejects.toThrow('account_migration_required');
      expect(await durableState.list()).toEqual(before);
    } finally {db.close();}
  }
});
test('disabled administrator rejects bootstrap and recovery re-enables the same identity', async () => {
  const {db, durableState, host} = fixture();
  try {
    const control = createControl(host); await control.bootstrap({username: 'owner', password: oldPassword, passwordConfirmation: oldPassword});
    const previous = (await durableState.get('administrator'))!, value = previous.value as any; value.administrator.disabled = true;
    await durableState.transact([{key: 'administrator', expectedVersion: previous.version, value}]);
    expect(await control.hasIdentity()).toBe(false);
    await expect(control.bootstrap({username: 'owner', password: oldPassword, passwordConfirmation: oldPassword})).rejects.toThrow('invalid_credentials');
    await recoverIdentity({username: 'owner', password: nextPassword, reason: 'recover disabled identity'}, {durableState});
    expect(await control.hasIdentity()).toBe(true);
  } finally {db.close();}
});
test('forgotten username can be replaced offline without changing administrator identity', async () => {
  const {db, durableState, host} = fixture();
  try {
    expect(await readManagementSetup(durableState)).toEqual({initialized: false});
    const control = createControl(host); await control.bootstrap({username: 'forgotten', password: oldPassword, passwordConfirmation: oldPassword});
    const id = ((await durableState.get('administrator'))!.value as any).administrator.id;
    expect(await readManagementSetup(durableState)).toEqual({initialized: true});
    expect(await recoverIdentity({newUsername: 'restored', password: nextPassword, reason: 'Forgot account name'}, {durableState})).toMatchObject({id, username: 'restored'});
    expect((await control.login(request('restored', nextPassword))).status).toBe(200);
  } finally {db.close();}
});
