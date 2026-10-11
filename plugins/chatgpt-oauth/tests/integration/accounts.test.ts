import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginStateClient } from '../../../../packages/core/src/plugin-state/client';
import type { SecretStore, SecretValue } from '../../../../packages/core/src/plugin-control/contracts';
import { AccountStore } from '../../server/accounts';
import { CODEX_REDIRECT_URI } from '../../server/oauth';
import { LoginSessionManager } from '../../server/sessions';
import type { CodexTokenSet } from '../../server/oauth';

// Contract-faithful fake; the encrypted SQLite implementation is exercised by core tests.
class FakeSecretStore implements SecretStore {
  readonly namespace = 'test';
  private value: SecretValue | null = null;

  async get(): Promise<SecretValue | null> { return this.value && { ...this.value }; }
  async compareAndSet(_key: string, expectedVersion: number | null, value: string): Promise<number> {
    if ((this.value?.version ?? null) !== expectedVersion) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    const version = (this.value?.version ?? 0) + 1;
    this.value = { version, value };
    return version;
  }
  async delete(_key: string, expectedVersion: number): Promise<void> {
    if (this.value?.version !== expectedVersion) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    this.value = null;
  }
  raw(): string | undefined { return this.value?.value; }
}

const token = (overrides: Partial<CodexTokenSet> = {}): CodexTokenSet => ({
  accessToken: 'access-a', refreshToken: 'refresh-a', identity: { accountId: 'acct-a', email: 'a@example.test' },
  identityStatus: 'parsed', expiresAt: Date.now() + 3_600_000, ...overrides,
});

const roots: string[] = [];
const clients: PluginStateClient[] = [];
const material = { keyId: 'accounts-test-key', key: new Uint8Array(32).fill(7) };

async function sqliteStore(): Promise<SecretStore> {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-control-'));
  roots.push(root);
  const client = await PluginStateClient.open(join(root,'plugin-state.db'),{material,initialize:true});
  clients.push(client);
  return client.secretStores.create('chatgpt-oauth');
}

class DelayedStore implements SecretStore {
  readonly namespace: string;
  constructor(private readonly inner: SecretStore, private readonly before?: Promise<void>, private readonly after?: Promise<void>, private readonly beforeStarted?: () => void, private readonly afterStarted?: () => void) { this.namespace = inner.namespace; }
  get(key: string): Promise<SecretValue | null> { return this.inner.get(key); }
  async compareAndSet(key: string, version: number | null, value: string): Promise<number> {
    this.beforeStarted?.();
    if (this.before) await this.before;
    const next = await this.inner.compareAndSet(key, version, value);
    this.afterStarted?.();
    if (this.after) await this.after;
    return next;
  }
  delete(key: string, version: number): Promise<void> { return this.inner.delete(key, version); }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ChatGPT account aggregate', () => {
  test('deletion survives a CAS retry without losing concurrent changes to other accounts', async () => {
    const store = new FakeSecretStore(), accounts = new AccountStore(store);
    const deleted = await accounts.create('deleted', token()), retained = await accounts.create('retained', token());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const deleting = new AccountStore(new DelayedStore(store, gate, undefined, entered)).remove(deleted.id);
    await started;
    await accounts.rename(retained.id, 'updated');
    const added = await accounts.create('added', token());
    release(); await deleting;
    expect((await accounts.read()).aggregate.accounts.map(account => [account.id, account.label])).toEqual([[retained.id, 'updated'], [added.id, 'added']]);
    expect(store.raw()).not.toContain(deleted.id);
  });

  test('refresh and returning login cannot recreate an account after a conflicting deletion', async () => {
    for (const operation of ['refresh', 'login']) {
      const store = new FakeSecretStore(), accounts = new AccountStore(store);
      const account = await accounts.create('deleted', token());
      const lock = operation === 'refresh' ? await accounts.acquireRefresh(account.id, 'owner', Date.now() + 1000) : undefined;
      const fence = operation === 'login' ? await accounts.reserveRelogin(account.id) : undefined;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const delayed = new AccountStore(new DelayedStore(store, gate, undefined, entered));
      const pending = operation === 'refresh'
        ? delayed.replaceCredentials(account.id, token({ accessToken: 'late-token' }), { owner: 'owner', generation: lock!.account.generation })
        : delayed.relogin(account.id, token({ accessToken: 'late-token' }), fence!);
      await started; await accounts.remove(account.id);
      const replacement = await accounts.create('new login', token());
      release(); await expect(pending).rejects.toMatchObject({ code: 'not_found' });
      expect((await accounts.read()).aggregate.accounts.map(account => account.id)).toEqual([replacement.id]);
      expect(store.raw()).not.toContain('late-token');
    }
  });

  test('CAS retries preserve concurrent updates to different fields', async () => {
    const store = new FakeSecretStore();
    const first = new AccountStore(store);
    const account = await first.create('A', token());
    const second = new AccountStore(store);
    await Promise.all([first.rename(account.id, 'renamed'), second.setStatus(account.id, 'disabled')]);
    const saved = await first.get(account.id);
    expect(saved.label).toBe('renamed');
    expect(saved.status).toBe('disabled');
  });

  test('identity mismatch is rejected and deletion removes the stored account', async () => {
    const store = new FakeSecretStore();
    const accounts = new AccountStore(store);
    const account = await accounts.create('A', token());
    const lock = await accounts.acquireRefresh(account.id, 'owner', Date.now() + 1000);
    await expect(accounts.replaceCredentials(account.id, token({ identity: { accountId: 'other' } }), { owner: 'owner', generation: lock.account.generation })).rejects.toMatchObject({ code: 'identity_mismatch' });
    await accounts.remove(account.id);
    await expect(accounts.get(account.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(JSON.parse(store.raw() as string).accounts).toEqual([]);
  });

  test('a rotated token without accountId keeps the bound identity', async () => {
    const accounts = new AccountStore(new FakeSecretStore());
    const account = await accounts.create('A', token());
    const lock = await accounts.acquireRefresh(account.id, 'owner', Date.now() + 1000);
    await accounts.replaceCredentials(account.id, token({ identity: { email: 'new@example.test' } }), { owner: 'owner', generation: lock.account.generation });
    expect((await accounts.get(account.id)).identity?.accountId).toBe('acct-a');
  });

  test('malformed optional id token keeps old identity and old id token while rotating credentials', async () => {
    const accounts = new AccountStore(new FakeSecretStore());
    const account = await accounts.create('A', token({ idToken: 'old-id' }));
    const locked = await accounts.acquireRefresh(account.id, 'owner', Date.now() + 1000);
    await accounts.replaceCredentials(account.id, {
      accessToken: 'rotated-access', refreshToken: 'rotated-refresh', idToken: 'malformed',
      identityStatus: 'invalid', identity: undefined, expiresAt: Date.now() + 3600_000,
    }, { owner: 'owner', generation: locked.account.generation });
    const saved = await accounts.get(account.id);
    expect(saved.accessToken).toBe('rotated-access');
    expect(saved.refreshToken).toBe('rotated-refresh');
    expect(saved.idToken).toBe('old-id');
    expect(saved.identity?.accountId).toBe('acct-a');
  });

  test('relogin fences older sessions and never recreates a deleted account', async () => {
    const accounts = new AccountStore(new FakeSecretStore());
    const account = await accounts.create('A', token());
    const first = await accounts.reserveRelogin(account.id);
    const second = await accounts.reserveRelogin(account.id);
    await expect(accounts.relogin(account.id, token({ accessToken: 'old-login' }), first)).rejects.toMatchObject({ code: 'stale_refresh' });
    await accounts.relogin(account.id, token({ accessToken: 'new-login' }), second);
    await accounts.remove(account.id);
    await expect(accounts.relogin(account.id, token({ accessToken: 'late-login' }), { generation: 3, loginFence: second.loginFence })).rejects.toMatchObject({ code: 'not_found' });
  });

  test('commit cancellation before the SQLite CAS write prevents persistence', async () => {
    const store = await sqliteStore();
    let release!: () => void;
    let entered!: () => void;
    const before = new Promise<void>((resolve) => { release = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new DelayedStore(store, before, undefined, entered);
    const sessions = new LoginSessionManager(new AbortController().signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60, id_token: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.x` }), { status: 200 }),
    });
    const started = sessions.startPkce();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const pending = sessions.completePkce(started.sessionId, `${CODEX_REDIRECT_URI}?state=${state}&code=abc`, (fresh, _info, canCommit) => new AccountStore(delayed).create('A', fresh, canCommit));
    await enteredPromise;
    expect(sessions.cancel(started.sessionId)).toBe(false);
    expect(await store.get('accounts.v1')).toBeNull();
    release();
    await pending;
    expect(await store.get('accounts.v1')).not.toBeNull();
    sessions.dispose();
  });

  test('a real SQLite CAS may delay its acknowledgement without a false cancel', async () => {
    const store = await sqliteStore();
    let releaseAck!: () => void;
    let committed!: () => void;
    const ack = new Promise<void>((resolve) => { releaseAck = resolve; });
    const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
    const delayed = new DelayedStore(store, undefined, ack, undefined, committed);
    const sessions = new LoginSessionManager(new AbortController().signal, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60, id_token: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.x` }), { status: 200 }),
    });
    const started = sessions.startPkce();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const pending = sessions.completePkce(started.sessionId, `${CODEX_REDIRECT_URI}?state=${state}&code=abc`, (fresh, _info, canCommit) => new AccountStore(delayed).create('A', fresh, canCommit));
    await committedPromise;
    expect(await store.get('accounts.v1')).not.toBeNull();
    expect(sessions.cancel(started.sessionId)).toBe(false);
    releaseAck();
    await expect(pending).resolves.toBeTruthy();
    expect(sessions.status(started.sessionId).state).toBe('success');
    sessions.dispose();
  });
});
