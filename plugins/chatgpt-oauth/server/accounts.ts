import { randomUUID } from 'node:crypto';
import type { SecretStore } from '../../../packages/core/src/plugin-control/contracts';
import type { CodexIdentity, CodexTokenSet } from './oauth';

export const ACCOUNT_STORE_KEY = 'accounts.v1';
export const ACCOUNT_SCHEMA_VERSION = 1;

export type AccountStatus = 'active' | 'disabled' | 'reauth_required' | 'revoked';

export interface StoredAccount {
  id: string;
  label: string;
  status: AccountStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  identity?: CodexIdentity;
  refreshLock?: { owner: string; until: number };
  loginFence: number;
  credentialValid: boolean;
}

interface AccountAggregate {
  schema: typeof ACCOUNT_SCHEMA_VERSION;
  accounts: StoredAccount[];
}

export interface AccountListItem {
  readonly id: string;
  readonly label: string;
  readonly status: AccountStatus;
  readonly available: boolean;
  readonly reason?: string;
  readonly expiresAt?: number;
  readonly identity?: Readonly<CodexIdentity>;
}

export class AccountControlError extends Error {
  readonly name = 'AccountControlError';
  constructor(readonly code: AccountErrorCode) {
    super(code);
  }
}

export type AccountErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'version_conflict'
  | 'identity_mismatch'
  | 'disabled'
  | 'revoked'
  | 'reauth_required'
  | 'stale_refresh'
  | 'invalid_identity'
  | 'disposed';

const MAX_ACCOUNTS = 128;
const MAX_TEXT = 512;
const MAX_TOKEN = 32_768;

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new AccountControlError('invalid_input');
  }
  return value;
}

function optionalText(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined;
  return text(value, max);
}

function identity(value: unknown): CodexIdentity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AccountControlError('invalid_input');
  const input = value as Record<string, unknown>;
  const keys = new Set(['email', 'accountId', 'planType', 'userId']);
  if (Object.keys(input).some((key) => !keys.has(key))) throw new AccountControlError('invalid_input');
  const result: CodexIdentity = {};
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) (result as Record<string, string>)[key] = text(value);
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function copyIdentity(value: CodexIdentity | undefined): CodexIdentity | undefined {
  return value === undefined ? undefined : { ...value };
}

function copyAccount(value: StoredAccount): StoredAccount {
  return { ...value, identity: copyIdentity(value.identity), refreshLock: value.refreshLock && { ...value.refreshLock } };
}

function validStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const account = value as Record<string, unknown>;
  return typeof account.id === 'string' && account.id.length > 0 && account.id.length <= 128 &&
    typeof account.label === 'string' && account.label.length > 0 && account.label.length <= MAX_TEXT &&
    ['active', 'disabled', 'reauth_required', 'revoked'].includes(account.status as string) &&
    Number.isSafeInteger(account.generation) && (account.generation as number) > 0 &&
    (account.loginFence === undefined || (Number.isSafeInteger(account.loginFence) && (account.loginFence as number) > 0)) &&
    (account.credentialValid === undefined || typeof account.credentialValid === 'boolean') &&
    Number.isFinite(account.createdAt) && Number.isFinite(account.updatedAt);
}

function decode(value: string | undefined): AccountAggregate {
  if (value === undefined) return { schema: ACCOUNT_SCHEMA_VERSION, accounts: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const aggregate = parsed as Record<string, unknown>;
    if (aggregate.schema !== ACCOUNT_SCHEMA_VERSION || !Array.isArray(aggregate.accounts) || aggregate.accounts.length > MAX_ACCOUNTS ||
        !aggregate.accounts.every(validStoredAccount)) throw new Error();
    return { schema: ACCOUNT_SCHEMA_VERSION, accounts: aggregate.accounts.map((item) => ({
      ...copyAccount(item), loginFence: item.loginFence ?? 1,
      credentialValid: item.credentialValid ?? item.status !== 'reauth_required',
    })) };
  } catch {
    throw new AccountControlError('invalid_input');
  }
}

function encode(value: AccountAggregate): string {
  return JSON.stringify(value);
}

function statusReason(account: StoredAccount): string | undefined {
  if (account.status === 'disabled') return 'disabled';
  if (account.status === 'reauth_required') return 'reauth_required';
  if (account.status === 'revoked') return 'revoked';
  return undefined;
}

export function accountListItem(account: StoredAccount): AccountListItem {
  return {
    id: account.id,
    label: account.label,
    status: account.status,
    available: account.status === 'active' && account.credentialValid && Boolean(account.accessToken && account.refreshToken && Number.isFinite(account.expiresAt)),
    reason: statusReason(account),
    expiresAt: account.expiresAt,
    identity: copyIdentity(account.identity),
  };
}

export class AccountStore {
  constructor(private readonly secretStore: SecretStore, private readonly canWrite: () => boolean = () => true) {}

  async read(): Promise<{ aggregate: AccountAggregate; version: number | null }> {
    const value = await this.secretStore.get(ACCOUNT_STORE_KEY);
    return { aggregate: decode(value?.value), version: value?.version ?? null };
  }

  private async mutate<T>(mutator: (aggregate: AccountAggregate) => T, canCommit: () => boolean = () => true): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!this.canWrite() || !canCommit()) throw new AccountControlError('disposed');
      const current = await this.read();
      const next: AccountAggregate = { schema: ACCOUNT_SCHEMA_VERSION, accounts: current.aggregate.accounts.map(copyAccount) };
      const result = mutator(next);
      if (!this.canWrite() || !canCommit()) throw new AccountControlError('disposed');
      try {
        await this.secretStore.compareAndSet(ACCOUNT_STORE_KEY, current.version, encode(next));
        return result;
      } catch (error) {
        if ((error as { code?: string }).code !== 'version_conflict') throw error;
      }
    }
    throw new AccountControlError('version_conflict');
  }

  async list(): Promise<AccountListItem[]> {
    return (await this.read()).aggregate.accounts.map(accountListItem);
  }

  async get(id: string): Promise<StoredAccount> {
    const account = (await this.read()).aggregate.accounts.find((item) => item.id === id);
    if (!account) throw new AccountControlError('not_found');
    return copyAccount(account);
  }

  async create(label: string, token: CodexTokenSet, canCommit: () => boolean = () => true): Promise<StoredAccount> {
    text(label);
    if (token.identityStatus !== 'parsed' || !token.identity?.accountId) throw new AccountControlError('invalid_identity');
    return this.mutate((aggregate) => {
      if (aggregate.accounts.length >= MAX_ACCOUNTS) throw new AccountControlError('invalid_input');
      const now = Date.now();
      const account: StoredAccount = {
        id: randomUUID(), label, status: token.expiresAt === undefined ? 'reauth_required' : 'active', generation: 1, loginFence: 1,
        credentialValid: token.expiresAt !== undefined, createdAt: now, updatedAt: now,
        accessToken: text(token.accessToken, MAX_TOKEN), refreshToken: text(token.refreshToken, MAX_TOKEN),
        idToken: optionalText(token.idToken, MAX_TOKEN), expiresAt: token.expiresAt,
        identity: copyIdentity(token.identity),
      };
      aggregate.accounts.push(account);
      return copyAccount(account);
    }, canCommit);
  }

  async replaceCredentials(
    id: string,
    token: CodexTokenSet,
    options: { owner?: string; generation?: number } = {},
  ): Promise<StoredAccount> {
    if (options.owner === undefined || options.generation === undefined) throw new AccountControlError('stale_refresh');
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.generation !== options.generation) throw new AccountControlError('stale_refresh');
      if (account.refreshLock?.owner !== options.owner) throw new AccountControlError('stale_refresh');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      if (account.status === 'disabled') throw new AccountControlError('disabled');
      if (token.identity?.accountId && account.identity?.accountId && token.identity.accountId !== account.identity.accountId) {
        throw new AccountControlError('identity_mismatch');
      }
      const now = Date.now();
      account.accessToken = text(token.accessToken, MAX_TOKEN);
      account.refreshToken = text(token.refreshToken, MAX_TOKEN);
      if (token.idToken !== undefined && token.identityStatus !== 'invalid') account.idToken = text(token.idToken, MAX_TOKEN);
      if (token.expiresAt !== undefined) account.expiresAt = token.expiresAt;
      else delete account.expiresAt;
      // A refresh response may omit the account id. Never let that optional
      // metadata silently replace an already-bound identity.
      if (token.identityStatus !== 'invalid' && token.identity !== undefined &&
          (account.identity?.accountId === undefined || token.identity.accountId !== undefined)) {
        account.identity = copyIdentity(token.identity);
      }
      account.credentialValid = token.expiresAt !== undefined;
      account.status = token.expiresAt === undefined ? 'reauth_required' : 'active';
      account.generation += 1;
      account.updatedAt = now;
      delete account.refreshLock;
      return copyAccount(account);
    });
  }

  async reserveRelogin(id: string): Promise<{ generation: number; loginFence: number }> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      account.loginFence += 1;
      account.updatedAt = Date.now();
      return { generation: account.generation, loginFence: account.loginFence };
    });
  }

  async relogin(
    id: string,
    token: CodexTokenSet,
    expected: { generation: number; loginFence: number },
    canCommit: () => boolean = () => true,
  ): Promise<StoredAccount> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      if (account.generation !== expected.generation || account.loginFence !== expected.loginFence) {
        throw new AccountControlError('stale_refresh');
      }
      if (token.identityStatus !== 'parsed' || !token.identity?.accountId) throw new AccountControlError('invalid_identity');
      if (account.identity?.accountId && token.identity.accountId !== account.identity.accountId) {
        throw new AccountControlError('identity_mismatch');
      }
      account.accessToken = text(token.accessToken, MAX_TOKEN);
      account.refreshToken = text(token.refreshToken, MAX_TOKEN);
      if (token.idToken !== undefined) account.idToken = text(token.idToken, MAX_TOKEN);
      if (token.expiresAt === undefined) {
        delete account.expiresAt;
        account.credentialValid = false;
        account.status = 'reauth_required';
      } else {
        account.expiresAt = token.expiresAt;
        account.credentialValid = true;
        account.status = 'active';
      }
      account.identity = copyIdentity(token.identity);
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
      return copyAccount(account);
    }, canCommit);
  }

  async setStatus(id: string, status: Exclude<AccountStatus, 'active'>): Promise<StoredAccount> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') {
        if (status === 'revoked') return copyAccount(account);
        throw new AccountControlError('revoked');
      }
      account.status = status;
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
      if (status === 'revoked') {
        delete account.accessToken;
        delete account.refreshToken;
        delete account.idToken;
        delete account.expiresAt;
        account.credentialValid = false;
      }
      return copyAccount(account);
    });
  }

  async rename(id: string, label: string): Promise<StoredAccount> {
    text(label);
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      account.label = label;
      account.updatedAt = Date.now();
      return copyAccount(account);
    });
  }

  async enable(id: string): Promise<StoredAccount> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      if (account.status !== 'disabled') throw new AccountControlError('reauth_required');
      if (!account.accessToken || !account.credentialValid) throw new AccountControlError('reauth_required');
      account.status = 'active';
      account.generation += 1;
      account.updatedAt = Date.now();
      return copyAccount(account);
    });
  }

  async rejectAccess(id: string, generation: number): Promise<boolean> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.generation !== generation || account.status !== 'active') return false;
      account.status = 'reauth_required';
      account.credentialValid = false;
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
      return true;
    });
  }

  async acquireRefresh(id: string, owner: string, until: number): Promise<{ acquired: boolean; account: StoredAccount }> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status !== 'active') throw new AccountControlError(account.status);
      if (account.refreshLock && account.refreshLock.owner !== owner && account.refreshLock.until > Date.now()) {
        return { acquired: false, account: copyAccount(account) };
      }
      account.refreshLock = { owner, until };
      account.updatedAt = Date.now();
      return { acquired: true, account: copyAccount(account) };
    });
  }

  async releaseRefresh(id: string, owner: string, generation: number): Promise<boolean> {
    try {
      return await this.mutate((aggregate) => {
        const account = aggregate.accounts.find((item) => item.id === id);
        if (account?.generation === generation && account.refreshLock?.owner === owner && account.status === 'active') {
          delete account.refreshLock;
          account.updatedAt = Date.now();
          return true;
        }
        return false;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'not_found' && (error as { code?: string }).code !== 'disposed') throw error;
      return false;
    }
  }

  async failRefreshReauth(id: string, owner: string, generation: number): Promise<boolean> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account || account.status !== 'active' || account.generation !== generation || account.refreshLock?.owner !== owner) return false;
      account.status = 'reauth_required';
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
      return true;
    });
  }
}
