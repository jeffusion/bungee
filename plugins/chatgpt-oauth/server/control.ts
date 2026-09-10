import { randomUUID } from 'node:crypto';
import type {
  ControlApiDeclaration,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  ControlRpcContext,
  CredentialLease,
  PluginControl,
  UpstreamDraft,
} from '../../../packages/core/src/plugin-control/contracts';
import type { FetchLike, CodexTokenSet } from './oauth';
import { refreshCodexToken } from './oauth';
import { AccountControlError, AccountStore, accountListItem, type AccountListItem, type StoredAccount } from './accounts';
import { LoginSessionError, LoginSessionManager, type LoginCommitInfo, type LoginFence, type LoginSessionDependencies } from './sessions';
import { UsageError, UsageService } from './usage';

export const CHATGPT_TARGET = 'https://chatgpt.com';
export const CONTROL_HOST_CONTRACT_GAP = 'ControlRpcContext.binding.bindingOptions.accountRef is required and host-resolved; RPC payload is never used as a fallback.';

export interface ControlDependencies extends LoginSessionDependencies { now?: () => number; timeoutMs?: number }

export class ControlError extends Error {
  readonly name = 'ControlError';
  constructor(readonly code: ControlErrorCode) { super(code); }
}

export type ControlErrorCode =
  | 'invalid_input' | 'body_limit' | 'request_cancelled' | 'not_found' | 'disabled' | 'revoked'
  | 'reauth_required' | 'identity_missing' | 'identity_mismatch' | 'invalid_identity'
  | 'refresh_failed' | 'refresh_in_progress' | 'stale_refresh' | 'binding_options_unavailable' | 'disposed'
  | 'expired' | 'cancelled' | 'busy' | 'login_failed' | 'session_error'
  | 'reset_in_progress' | 'credits_unavailable' | 'credit_unavailable' | 'upstream_unavailable';

const REFRESH_SAFETY_WINDOW_MS = 60_000;
const REFRESH_LOCK_MS = 90_000;
const MAX_BODY_BYTES = 64 * 1024;

function safeError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof AccountControlError) {
    const map: Record<string, ControlErrorCode> = {
      invalid_input: 'invalid_input',
      not_found: 'not_found', disabled: 'disabled', revoked: 'revoked', reauth_required: 'reauth_required',
      identity_mismatch: 'identity_mismatch', invalid_identity: 'invalid_identity', disposed: 'disposed',
      stale_refresh: 'stale_refresh',
    };
    return new ControlError(map[error.code] ?? 'refresh_failed');
  }
  if (error instanceof LoginSessionError) {
    const known: Record<string, ControlErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', expired: 'expired', cancelled: 'cancelled', already_consumed: 'busy', busy: 'busy', failed: 'login_failed', disposed: 'disposed' };
    return new ControlError(known[error.code] ?? 'session_error');
  }
  if (error instanceof UsageError) {
    const known: Record<string, ControlErrorCode> = {
      reauth_required: 'reauth_required', disposed: 'disposed', cancelled: 'request_cancelled',
      reset_in_progress: 'reset_in_progress', credits_unavailable: 'credits_unavailable', credit_unavailable: 'credit_unavailable',
      stale_generation: 'upstream_unavailable', upstream_unavailable: 'upstream_unavailable',
    };
    return new ControlError(known[error.code] ?? 'refresh_failed');
  }
  const kind = (error as { kind?: string }).kind;
  if (kind === 'refresh_token_reused') return new ControlError('reauth_required');
  if (typeof kind === 'string') return new ControlError('login_failed');
  return new ControlError('refresh_failed');
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function errorResponse(error: unknown): Response {
  const safe = safeError(error);
  const status = safe.code === 'not_found' ? 404 : safe.code === 'invalid_input' || safe.code === 'request_cancelled' ? 400 : safe.code === 'body_limit' ? 413 : safe.code === 'binding_options_unavailable' ? 501 : 409;
  return jsonResponse({ error: safe.code }, status);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ControlError('invalid_input');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ControlError('invalid_input');
}

function requiredText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) throw new ControlError('invalid_input');
  return value;
}

function optionalText(value: unknown, max = 512): string | undefined { return value === undefined ? undefined : requiredText(value, max); }
function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ControlError('invalid_input');
  return value as number;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, hostSignal?: AbortSignal, lifetimeSignal?: AbortSignal): Promise<T> {
  if (hostSignal?.aborted || lifetimeSignal?.aborted) return Promise.reject(new ControlError('disposed'));
  if (signal.aborted) return Promise.reject(new ControlError('request_cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal.removeEventListener('abort', onRequestAbort); hostSignal?.removeEventListener('abort', onHostAbort); lifetimeSignal?.removeEventListener('abort', onLifetimeAbort); };
    const onRequestAbort = () => { if (!settled) { settled = true; cleanup(); reject(new ControlError('request_cancelled')); } };
    const onHostAbort = () => { if (!settled) { settled = true; cleanup(); reject(new ControlError('disposed')); } };
    const onLifetimeAbort = () => { if (!settled) { settled = true; cleanup(); reject(new ControlError('disposed')); } };
    signal.addEventListener('abort', onRequestAbort, { once: true });
    hostSignal?.addEventListener('abort', onHostAbort, { once: true });
    lifetimeSignal?.addEventListener('abort', onLifetimeAbort, { once: true });
    promise.then((value) => { if (!settled) { settled = true; cleanup(); resolve(value); } }, (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}

async function readRequestJson(request: Request, requestSignal: AbortSignal, hostSignal: AbortSignal, lifetimeSignal = hostSignal): Promise<Record<string, unknown>> {
  if (hostSignal.aborted || lifetimeSignal.aborted) throw new ControlError('disposed');
  if (requestSignal.aborted) throw new ControlError('request_cancelled');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), requestSignal, hostSignal, lifetimeSignal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ControlError('body_limit');
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ControlError) throw error;
    throw new ControlError('invalid_input');
  } finally { reader.releaseLock(); }
  if (!text) return {};
  try { return record(JSON.parse(text)); } catch { throw new ControlError('invalid_input'); }
}

function accountRefFromBinding(context: ControlRpcContext): string {
  const value = context.binding.bindingOptions?.accountRef;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || value.trim() !== value) throw new ControlError('binding_options_unavailable');
  return value;
}

function lease(account: StoredAccount): CredentialLease {
  if (account.status !== 'active') throw new ControlError(account.status);
  if (!account.accessToken) throw new ControlError('reauth_required');
  if (!account.identity?.accountId) throw new ControlError('identity_missing');
  if (!Number.isFinite(account.expiresAt)) throw new ControlError('reauth_required');
  return { version: account.generation, expiresAt: account.expiresAt as number, headers: { Authorization: `Bearer ${account.accessToken}`, 'Chatgpt-Account-Id': account.identity.accountId } };
}

function isRefreshable(account: StoredAccount, now: number): boolean {
  return account.expiresAt === undefined || account.expiresAt <= now + REFRESH_SAFETY_WINDOW_MS;
}

class ChatgptControl implements PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc: readonly { name: string; handler: string; invoke: (payload: unknown, context: ControlRpcContext) => unknown | Promise<unknown> }[];
  private readonly accounts: AccountStore;
  private readonly sessions: LoginSessionManager;
  private readonly now: () => number;
  private readonly workerOwner = `chatgpt-control-${randomUUID()}`;
  private readonly inFlight = new Map<string, Promise<StoredAccount>>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly apiLifetime = new AbortController();
  private readonly usage: UsageService;
  private disposed = false;
  private readonly abortListener: () => void;

  constructor(private readonly host: ControlHostContext, private readonly deps: ControlDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.accounts = new AccountStore(host.secretStore, () => !this.disposed && !host.signal.aborted);
    this.sessions = new LoginSessionManager(host.signal, deps);
    this.usage = new UsageService({
      fetchImpl: deps.fetchImpl,
      now: this.now,
      timeoutMs: deps.timeoutMs,
      hostSignal: host.signal,
      credential: (id, signal) => this.credential(id, signal),
      rejectAccess: (id, version) => this.accounts.rejectAccess(id, version),
    });
    this.abortListener = () => { void this.dispose(); };
    if (host.signal.aborted) this.disposed = true;
    else host.signal.addEventListener('abort', this.abortListener, { once: true });
    this.api = this.buildApi();
    this.rpc = this.buildRpc();
  }

  private assertAlive(signal?: AbortSignal): void {
    if (this.disposed || this.host.signal.aborted) throw new ControlError('disposed');
    if (signal?.aborted) throw new ControlError('request_cancelled');
  }

  async start(): Promise<void> {
    this.assertAlive();
    await this.accounts.read();
    this.assertAlive();
  }

  private async refresh(id: string, signal: AbortSignal): Promise<StoredAccount> {
    for (let attempt = 0; attempt < 120; attempt++) {
      this.assertAlive(signal);
      const current = await this.accounts.get(id);
      this.assertAlive(signal);
      if (current.status !== 'active') throw new ControlError(current.status);
      if (!isRefreshable(current, this.now())) return current;
      if (!current.refreshToken) throw new ControlError('reauth_required');
      const lock = await this.accounts.acquireRefresh(id, this.workerOwner, this.now() + REFRESH_LOCK_MS);
      this.assertAlive(signal);
      if (!lock.acquired) {
        await abortable(new Promise<void>((resolve) => setTimeout(resolve, 25)), signal, this.host.signal);
        continue;
      }
      const generation = lock.account.generation;
      try {
        const token = await refreshCodexToken(lock.account.refreshToken as string, { fetchImpl: this.deps.fetchImpl, signal });
        this.assertAlive(signal);
        const updated = await this.accounts.replaceCredentials(id, token, { owner: this.workerOwner, generation });
        this.assertAlive(signal);
        return updated;
      } catch (error) {
        if (this.disposed || this.host.signal.aborted) throw new ControlError('disposed');
        const oauthCode = (error as { kind?: string }).kind;
        if (oauthCode === 'refresh_token_reused') {
          const fenced = await this.accounts.failRefreshReauth(id, this.workerOwner, generation).catch(() => false);
          if (!fenced) {
            const latest = await this.accounts.get(id).catch(() => undefined);
            if (latest?.status === 'revoked') throw new ControlError('revoked');
            if (latest?.status === 'disabled') throw new ControlError('disabled');
          }
          throw new ControlError('reauth_required');
        }
        if (error instanceof AccountControlError) {
          await this.accounts.releaseRefresh(id, this.workerOwner, generation);
          throw safeError(error);
        }
        const released = await this.accounts.releaseRefresh(id, this.workerOwner, generation);
        if (!released) {
          const latest = await this.accounts.get(id).catch(() => undefined);
          if (latest?.status === 'revoked') throw new ControlError('revoked');
          if (latest?.status === 'disabled') throw new ControlError('disabled');
          if (latest?.generation !== generation) throw new ControlError('stale_refresh');
        }
        if (error instanceof ControlError) throw error;
        throw new ControlError('refresh_failed');
      }
    }
    throw new ControlError('refresh_in_progress');
  }

  private async credential(id: string, signal: AbortSignal): Promise<CredentialLease> {
    this.assertAlive(signal);
    const account = await this.accounts.get(id);
    this.assertAlive(signal);
    if (account.status !== 'active') throw new ControlError(account.status);
    if (!isRefreshable(account, this.now())) { this.assertAlive(signal); return lease(account); }
    let shared = this.inFlight.get(id);
    if (!shared) {
      const controller = new AbortController();
      const onHostAbort = () => controller.abort('disposed');
      this.host.signal.addEventListener('abort', onHostAbort, { once: true });
      this.refreshControllers.set(id, controller);
      shared = this.refresh(id, controller.signal).finally(() => {
        this.host.signal.removeEventListener('abort', onHostAbort);
        this.refreshControllers.delete(id);
        this.inFlight.delete(id);
      });
      this.inFlight.set(id, shared);
    }
    const updated = await abortable(shared, signal, this.host.signal);
    this.assertAlive(signal);
    return lease(updated);
  }

  private async commitLogin(token: CodexTokenSet, info: LoginCommitInfo, canCommit: () => boolean): Promise<AccountListItem> {
    this.assertAlive();
    if (!canCommit()) throw new ControlError('session_error');
    const account = info.accountRef === undefined
      ? await this.accounts.create(token.identity?.email ?? 'ChatGPT', token, () => canCommit())
      : await this.accounts.relogin(info.accountRef, token, info.fence as LoginFence, () => canCommit());
    if (!canCommit()) throw new ControlError('session_error');
    this.usage.invalidateAccount(account.id);
    return accountListItem(account);
  }

  private async loginFence(accountRef: string | undefined): Promise<LoginFence | undefined> {
    return accountRef === undefined ? undefined : await this.accounts.reserveRelogin(accountRef);
  }

  private readJson(context: ControlApiHandlerContext): Promise<Record<string, unknown>> {
    return readRequestJson(context.request, context.requestSignal, context.signal, this.apiLifetime.signal);
  }

  private async startDevice(accountRef: string | undefined): Promise<unknown> {
    const started = await this.sessions.startDevice(accountRef, () => this.loginFence(accountRef));
    void this.sessions.completeDevice(started.sessionId, (token, info, guard) => this.commitLogin(token, info, guard)).catch(() => undefined);
    return started;
  }

  private accountRefQuery(request: Request): string {
    const url = new URL(request.url);
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== 'accountRef') throw new ControlError('invalid_input');
    return requiredText(entries[0][1], 128);
  }

  private buildApi(): readonly ControlApiDeclaration[] {
    const invoke = (handler: (context: ControlApiHandlerContext) => Promise<Response> | Response) => async (context: ControlApiHandlerContext) => {
      try { this.assertAlive(context.requestSignal); return await handler(context); } catch (error) { return errorResponse(error); }
    };
    return [
      { path: '/accounts', methods: ['GET'], handler: 'listAccounts', invoke: invoke(async () => jsonResponse({ accounts: await this.accounts.list() })) },
      { path: '/accounts/usage', methods: ['GET'], handler: 'getAccountUsage', invoke: invoke(async (context) => jsonResponse(await this.usage.get(this.accountRefQuery(context.request), context.requestSignal))) },
      { path: '/accounts/usage/reset', methods: ['POST'], handler: 'resetAccountUsage', invoke: invoke(async (context) => {
        const body = await this.readJson(context);
        exactKeys(body, ['accountRef', 'redeemRequestId', 'creditId']);
        const accountRef = requiredText(body.accountRef, 128);
        const redeemRequestId = requiredText(body.redeemRequestId, 128);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(redeemRequestId)) throw new ControlError('invalid_input');
        const creditId = requiredText(body.creditId, 512);
        if (/[\0\r\n]/.test(creditId)) throw new ControlError('invalid_input');
        return jsonResponse(await this.usage.consume(accountRef, redeemRequestId, creditId, context.requestSignal));
      }) },
      { path: '/accounts/draft', methods: ['POST'], handler: 'createDraft', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        const account = await this.accounts.get(requiredText(body.accountRef, 128));
        if (!accountListItem(account).available) throw new ControlError(account.status === 'active' ? 'reauth_required' : account.status);
        const draft: UpstreamDraft = { target: CHATGPT_TARGET, bindingOptions: { accountRef: account.id } };
        return jsonResponse(draft);
      }) },
      { path: '/login/device', methods: ['POST'], handler: 'startDeviceLogin', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        return jsonResponse(await this.startDevice(optionalText(body.accountRef, 128)));
      }) },
      { path: '/login/pkce', methods: ['POST'], handler: 'startPkceLogin', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        const accountRef = optionalText(body.accountRef, 128);
        const started = this.sessions.startPkce(accountRef);
        try { if (accountRef !== undefined) this.sessions.setFence(started.sessionId, await this.loginFence(accountRef) as LoginFence); }
        catch (error) { this.sessions.cancel(started.sessionId); throw error; }
        return jsonResponse(started);
      }) },
      { path: '/login/status', methods: ['GET'], handler: 'getLoginStatus', invoke: invoke(async (context) => {
        const url = new URL(context.request.url);
        const values = url.searchParams.getAll('sessionId');
        if (values.length !== 1) throw new ControlError('invalid_input');
        return jsonResponse(this.sessions.status(requiredText(values[0], 128)));
      }) },
      { path: '/login/callback', methods: ['POST'], handler: 'completePkceLogin', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['sessionId', 'callbackUrl']);
        const sessionId = requiredText(body.sessionId, 128);
        const status = this.sessions.status(sessionId);
        if (status.state !== 'pending') return jsonResponse(status);
        const result = await this.sessions.completePkce(sessionId, requiredText(body.callbackUrl, 4096), (token, info, guard) => this.commitLogin(token, info, guard));
        return jsonResponse({ account: result.result });
      }) },
      { path: '/login/device/complete', methods: ['POST'], handler: 'completeDeviceLogin', invoke: invoke(async (context) => {
        const body = await this.readJson(context);
        exactKeys(body, ['sessionId']);
        const status = this.sessions.status(requiredText(body.sessionId, 128));
        if (status.state !== 'pending') return jsonResponse(status);
        const result = await this.sessions.completeDevice(requiredText(body.sessionId, 128), (token, info, guard) => this.commitLogin(token, info, guard));
        return jsonResponse({ account: result.result });
      }) },
      { path: '/login/cancel', methods: ['POST'], handler: 'cancelLogin', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['sessionId']);
        return jsonResponse({ cancelled: this.sessions.cancel(requiredText(body.sessionId, 128)) });
      }) },
      { path: '/accounts/disable', methods: ['POST'], handler: 'disableAccount', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        const accountRef = requiredText(body.accountRef, 128);
        const account = await this.accounts.setStatus(accountRef, 'disabled');
        this.usage.invalidateAccount(accountRef);
        return jsonResponse({ account: accountListItem(account) });
      }) },
      { path: '/accounts/enable', methods: ['POST'], handler: 'enableAccount', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        const accountRef = requiredText(body.accountRef, 128);
        const account = await this.accounts.enable(accountRef);
        this.usage.invalidateAccount(accountRef);
        return jsonResponse({ account: accountListItem(account) });
      }) },
      { path: '/accounts/rename', methods: ['POST'], handler: 'updateAccount', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef', 'label']);
        return jsonResponse({ account: accountListItem(await this.accounts.rename(requiredText(body.accountRef, 128), requiredText(body.label))) });
      }) },
      { path: '/accounts/delete', methods: ['POST'], handler: 'deleteAccount', invoke: invoke(async (context) => {
        const body = await this.readJson(context); exactKeys(body, ['accountRef']);
        const accountRef = requiredText(body.accountRef, 128);
        const account = await this.accounts.setStatus(accountRef, 'revoked');
        this.usage.invalidateAccount(accountRef);
        return jsonResponse({ account: accountListItem(account) });
      }) },
    ];
  }

  private buildRpc(): readonly { name: string; handler: string; invoke: (payload: unknown, context: ControlRpcContext) => unknown | Promise<unknown> }[] {
    return [
      { name: 'getCredential', handler: 'getCredential', invoke: async (_payload, context) => {
        try { this.assertAlive(context.attempt.signal); return await this.credential(accountRefFromBinding(context), context.attempt.signal); } catch (error) { throw safeError(error); }
      } },
      { name: 'rejectAccess', handler: 'rejectAccess', invoke: async (payload, context) => {
        try {
          this.assertAlive(context.attempt.signal);
          const body = record(payload); exactKeys(body, ['version']);
          return { rejected: await this.accounts.rejectAccess(accountRefFromBinding(context), requiredVersion(body.version)) };
        } catch (error) { throw safeError(error); }
      } },
    ];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.apiLifetime.abort('disposed');
    this.host.signal.removeEventListener('abort', this.abortListener);
    for (const controller of this.refreshControllers.values()) controller.abort('disposed');
    this.sessions.dispose();
    this.usage.dispose();
    this.inFlight.clear();
  }
}

export function createControl(context: ControlHostContext, dependencies: ControlDependencies = {}): PluginControl { return new ChatgptControl(context, dependencies); }

export const api = Object.freeze([
  { path: '/accounts', methods: ['GET'], handler: 'listAccounts' },
  { path: '/accounts/usage', methods: ['GET'], handler: 'getAccountUsage' },
  { path: '/accounts/usage/reset', methods: ['POST'], handler: 'resetAccountUsage' },
  { path: '/accounts/draft', methods: ['POST'], handler: 'createDraft' },
  { path: '/login/device', methods: ['POST'], handler: 'startDeviceLogin' },
  { path: '/login/pkce', methods: ['POST'], handler: 'startPkceLogin' },
  { path: '/login/status', methods: ['GET'], handler: 'getLoginStatus' },
  { path: '/login/callback', methods: ['POST'], handler: 'completePkceLogin' },
  { path: '/login/device/complete', methods: ['POST'], handler: 'completeDeviceLogin' },
  { path: '/login/cancel', methods: ['POST'], handler: 'cancelLogin' },
  { path: '/accounts/disable', methods: ['POST'], handler: 'disableAccount' },
  { path: '/accounts/enable', methods: ['POST'], handler: 'enableAccount' },
  { path: '/accounts/rename', methods: ['POST'], handler: 'updateAccount' },
  { path: '/accounts/delete', methods: ['POST'], handler: 'deleteAccount' },
] as const);
export const rpc = Object.freeze([{ name: 'getCredential', handler: 'getCredential' }, { name: 'rejectAccess', handler: 'rejectAccess' }] as const);
export const controlApi = api;
export const controlRpc = rpc;
export default { createControl } satisfies ControlPlugin;
