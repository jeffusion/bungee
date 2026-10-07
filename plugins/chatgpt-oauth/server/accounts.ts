import { randomUUID } from 'node:crypto';
import type { SecretStore } from '@jeffusion/bungee-core/plugin';
import type { CodexIdentity, CodexTokenSet } from './oauth';
import type { ResetCredit } from './usage';
import { validSiwcMetadata } from './siwc';

export interface AutoResetAttempt {
  creditId: string;
  redeemRequestId: string;
  expiresAt?: number;
  completed: boolean;
}

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
  siwc?: CodexTokenSet['siwc'];
  refreshLock?: { owner: string; until: number };
  loginFence: number;
  credentialValid: boolean;
  autoResetCredits?: boolean;
  autoResetAttempts?: AutoResetAttempt[];
}

interface AccountAggregate {
  schema: typeof ACCOUNT_SCHEMA_VERSION;
  accounts: StoredAccount[];
}

export interface AccountListItem {
  readonly authType: 'siwc' | 'codex';
  readonly id: string;
  readonly label: string;
  readonly status: AccountStatus;
  readonly available: boolean;
  readonly reason?: string;
  readonly expiresAt?: number;
  readonly identity?: Readonly<CodexIdentity>;
  readonly autoResetCredits: boolean;
  readonly pendingAutoReset?: Readonly<AutoResetAttempt>;
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
  | 'disposed'
  | 'unsupported_operation';

const MAX_ACCOUNTS = 128;
const MAX_TEXT = 512;
const MAX_TOKEN = 32_768;
const MAX_AUTO_RESET_ATTEMPTS = 256;

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
  return { ...value, siwc: value.siwc && { ...value.siwc, scopes: [...value.siwc.scopes] }, identity: copyIdentity(value.identity), refreshLock: value.refreshLock && { ...value.refreshLock },
    autoResetAttempts: value.autoResetAttempts?.map(item => ({ ...item })) };
}

function validAutoResetAttempts(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= MAX_AUTO_RESET_ATTEMPTS && value.every(item =>
    item && typeof item.creditId === 'string' && item.creditId.length > 0 && item.creditId.length <= MAX_TEXT &&
    !/[\u0000-\u001f\u007f]/.test(item.creditId) &&
    typeof item.redeemRequestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.redeemRequestId) &&
    (item.expiresAt === undefined || (Number.isFinite(item.expiresAt) && item.expiresAt >= 0)) && typeof item.completed === 'boolean'));
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
    (account.autoResetCredits === undefined || typeof account.autoResetCredits === 'boolean') &&
    (account.siwc === undefined || validSiwcMetadata(account.siwc)) &&
    validAutoResetAttempts(account.autoResetAttempts) &&
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
  const pending = account.autoResetAttempts?.find(item => !item.completed);
  return {
    authType: account.siwc ? 'siwc' : 'codex',
    id: account.id,
    label: account.label,
    status: account.status,
    available: account.status === 'active' && account.credentialValid && Boolean(account.accessToken && account.refreshToken && Number.isFinite(account.expiresAt)),
    reason: statusReason(account),
    expiresAt: account.expiresAt,
    identity: copyIdentity(account.identity),
    autoResetCredits: !account.siwc && account.autoResetCredits === true,
    pendingAutoReset: !account.siwc && pending ? { ...pending } : undefined,
  };
}

function validateTokenIdentity(token: CodexTokenSet): void {
  if (token.identityStatus !== 'parsed' || (token.siwc === undefined ? !token.identity?.accountId : !validSiwcMetadata(token.siwc))) {
    throw new AccountControlError('invalid_identity');
  }
}

function validateSiwcBinding(account: StoredAccount, token: CodexTokenSet): void {
  if (Boolean(account.siwc) !== Boolean(token.siwc)) throw new AccountControlError('identity_mismatch');
  if (account.siwc) {
    if (!validSiwcMetadata(token.siwc) || token.identityStatus !== 'parsed') throw new AccountControlError('invalid_identity');
    if (account.siwc.clientId !== token.siwc.clientId || account.siwc.subject !== token.siwc.subject) throw new AccountControlError('identity_mismatch');
  }
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

  async remove(id: string): Promise<void> {
    text(id, 128);
    await this.mutate(aggregate => {
      aggregate.accounts = aggregate.accounts.filter(account => account.id !== id);
    });
  }

  /** Migrate records retained by the former local deletion implementation. */
  async purgeRevoked(): Promise<void> {
    if (!(await this.read()).aggregate.accounts.some(account => account.status === 'revoked')) return;
    await this.mutate(aggregate => {
      aggregate.accounts = aggregate.accounts.filter(account => account.status !== 'revoked');
    });
  }

  async get(id: string): Promise<StoredAccount> {
    const account = (await this.read()).aggregate.accounts.find((item) => item.id === id);
    if (!account) throw new AccountControlError('not_found');
    return copyAccount(account);
  }

  async create(label: string, token: CodexTokenSet, canCommit: () => boolean = () => true): Promise<StoredAccount> {
    text(label);
    validateTokenIdentity(token);
    return this.mutate((aggregate) => {
      if (aggregate.accounts.length >= MAX_ACCOUNTS) throw new AccountControlError('invalid_input');
      const now = Date.now();
      const account: StoredAccount = {
        id: randomUUID(), label, status: token.expiresAt === undefined ? 'reauth_required' : 'active', generation: 1, loginFence: 1,
        credentialValid: token.expiresAt !== undefined, createdAt: now, updatedAt: now,
        accessToken: text(token.accessToken, MAX_TOKEN), refreshToken: text(token.refreshToken, MAX_TOKEN),
        idToken: optionalText(token.idToken, MAX_TOKEN), expiresAt: token.expiresAt,
        identity: copyIdentity(token.identity), siwc: token.siwc && { ...token.siwc, scopes: [...token.siwc.scopes] },
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
      validateSiwcBinding(account, token);
      const now = Date.now();
      account.siwc = token.siwc && { ...token.siwc, scopes: [...token.siwc.scopes] };
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
      validateTokenIdentity(token);
      validateSiwcBinding(account, token);
      if (account.identity?.accountId && token.identity?.accountId !== account.identity.accountId) {
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
      account.siwc = token.siwc && { ...token.siwc, scopes: [...token.siwc.scopes] };
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
      return copyAccount(account);
    }, canCommit);
  }

  async setStatus(id: string, status: Exclude<AccountStatus, 'active' | 'revoked'>): Promise<StoredAccount> {
    return this.mutate((aggregate) => {
      const account = aggregate.accounts.find((item) => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      account.status = status;
      account.generation += 1;
      account.updatedAt = Date.now();
      delete account.refreshLock;
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

  async setAutoResetCredits(id: string, enabled: boolean): Promise<StoredAccount> {
    if (typeof enabled !== 'boolean') throw new AccountControlError('invalid_input');
    return this.mutate(aggregate => {
      const account = aggregate.accounts.find(item => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.status === 'revoked') throw new AccountControlError('revoked');
      if (account.siwc) throw new AccountControlError('unsupported_operation');
      account.autoResetCredits = enabled;
      account.updatedAt = Date.now();
      return copyAccount(account);
    });
  }

  /** Persist before POST: a crash or unknown outcome must never create a new automatic request. */
  async claimAutoReset(id: string, credit: ResetCredit, now: number): Promise<AutoResetAttempt | undefined> {
    return this.mutate(aggregate => {
      const account = aggregate.accounts.find(item => item.id === id);
      if (!account || account.siwc || !accountListItem(account).available || account.autoResetCredits !== true) return undefined;
      const attempts = account.autoResetAttempts ?? [];
      if (attempts.some(item => !item.completed || item.creditId === credit.id)) return undefined;
      account.autoResetAttempts = attempts.filter(item => !item.completed || item.expiresAt === undefined || item.expiresAt > now);
      if (account.autoResetAttempts.length >= MAX_AUTO_RESET_ATTEMPTS || credit.expiresAt === undefined || credit.expiresAt <= now) return undefined;
      const attempt: AutoResetAttempt = { creditId: credit.id, redeemRequestId: randomUUID(), expiresAt: credit.expiresAt, completed: false };
      account.autoResetAttempts.push(attempt);
      account.updatedAt = Date.now();
      return { ...attempt };
    });
  }

  /** Manual and automatic requests share the same durable fence against automatic retries. */
  async recordResetAttempt(id: string, redeemRequestId: string, credit: ResetCredit, now: number): Promise<void> {
    await this.mutate(aggregate => {
      const account = aggregate.accounts.find(item => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (account.siwc) throw new AccountControlError('unsupported_operation');
      const attempts = account.autoResetAttempts ?? [];
      const pending = attempts.find(item => !item.completed);
      if (pending) {
        if (pending.redeemRequestId !== redeemRequestId || pending.creditId !== credit.id) throw new AccountControlError('version_conflict');
        return;
      }
      account.autoResetAttempts = attempts.filter(item => item.creditId !== credit.id && (item.expiresAt === undefined || item.expiresAt > now));
      if (account.autoResetAttempts.length >= MAX_AUTO_RESET_ATTEMPTS) throw new AccountControlError('invalid_input');
      account.autoResetAttempts.push({ creditId: credit.id, redeemRequestId, expiresAt: credit.expiresAt, completed: false });
      account.updatedAt = Date.now();
    });
  }

  async finishAutoReset(id: string, redeemRequestId: string, cancel = false): Promise<void> {
    await this.mutate(aggregate => {
      const account = aggregate.accounts.find(item => item.id === id);
      if (!account) throw new AccountControlError('not_found');
      if (cancel) account.autoResetAttempts = account.autoResetAttempts?.filter(item => item.redeemRequestId !== redeemRequestId);
      else {
        const attempt = account.autoResetAttempts?.find(item => item.redeemRequestId === redeemRequestId);
        if (attempt) attempt.completed = true;
      }
      account.updatedAt = Date.now();
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
