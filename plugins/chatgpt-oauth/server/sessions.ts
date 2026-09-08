import { randomUUID } from 'node:crypto';
import {
  CODEX_CALLBACK_TTL_MS,
  CODEX_DEVICE_TIMEOUT_MS,
  CODEX_DEVICE_URL,
  type FetchLike,
  type CodexTokenSet,
  buildCodexAuthorizationUrl,
  createPKCE,
  exchangeCodexCode,
  exchangeCodexDeviceAuthorization,
  parseCodexCallbackUrl,
  pollDeviceToken,
  requestDeviceCode,
  type OAuthRequestOptions,
} from './oauth';

export type LoginKind = 'device' | 'pkce';
export type LoginState = 'pending' | 'polling' | 'exchanging' | 'committing' | 'cancelled' | 'failed' | 'success';

export interface DeviceLoginStart {
  readonly sessionId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
}

export interface PkceLoginStart {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}

export interface LoginStatus {
  readonly sessionId: string;
  readonly kind: LoginKind;
  readonly state: LoginState | 'expired';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly accountRef?: string;
  readonly errorCode?: 'login_failed' | 'cancelled' | 'expired';
  readonly account?: { readonly id: string; readonly label: string; readonly status: string; readonly available: boolean; readonly accountId?: string };
}

export interface LoginFence {
  readonly generation: number;
  readonly loginFence: number;
}

export class LoginSessionError extends Error {
  readonly name = 'LoginSessionError';
  constructor(readonly code: LoginSessionErrorCode) {
    super(code);
  }
}

export type LoginSessionErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'expired'
  | 'cancelled'
  | 'already_consumed'
  | 'busy'
  | 'failed'
  | 'disposed';

interface LoginSession {
  id: string;
  kind: LoginKind;
  state: LoginState;
  issuedAt: number;
  expiresAt: number;
  accountRef?: string;
  fence?: LoginFence;
  stateValue?: string;
  codeVerifier?: string;
  device?: { deviceAuthId: string; userCode: string; intervalMs: number };
  controller: AbortController;
  unlinkHost: () => void;
  expiryTimer: ReturnType<typeof setTimeout>;
  errorCode?: 'login_failed' | 'cancelled' | 'expired';
  account?: LoginStatus['account'];
  expiredDuringCommit?: boolean;
}

export interface LoginSessionDependencies {
  fetchImpl?: FetchLike;
  now?: () => number;
  random?: (size: number) => Uint8Array;
  maxSessions?: number;
}

export interface LoginCommitInfo {
  readonly accountRef?: string;
  readonly fence?: LoginFence;
}

export type LoginCommit<TResult = unknown> = (
  token: CodexTokenSet,
  info: LoginCommitInfo,
  canCommit: () => boolean,
) => Promise<TResult>;

function safeOptions(deps: LoginSessionDependencies, signal: AbortSignal): OAuthRequestOptions {
  return { fetchImpl: deps.fetchImpl, signal };
}

export class LoginSessionManager {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private disposed = false;
  private readonly onHostAbort: () => void;

  constructor(private readonly hostSignal: AbortSignal, private readonly deps: LoginSessionDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.maxSessions = Math.min(128, Math.max(1, deps.maxSessions ?? 64));
    this.onHostAbort = () => this.dispose();
    if (hostSignal.aborted) this.dispose();
    else hostSignal.addEventListener('abort', this.onHostAbort, { once: true });
  }

  private newSession(kind: LoginKind, accountRef: string | undefined, fence: LoginFence | undefined, ttl: number): LoginSession {
    if (this.disposed || this.hostSignal.aborted) throw new LoginSessionError('disposed');
    this.cleanup();
    if (this.sessions.size >= this.maxSessions) throw new LoginSessionError('busy');
    const controller = new AbortController();
    const onHostAbort = () => controller.abort(this.hostSignal.reason);
    this.hostSignal.addEventListener('abort', onHostAbort, { once: true });
    const issuedAt = this.now();
    const session: LoginSession = {
      id: randomUUID(), kind, state: 'pending', issuedAt, expiresAt: issuedAt + ttl,
      accountRef, fence, controller, unlinkHost: () => this.hostSignal.removeEventListener('abort', onHostAbort),
      expiryTimer: setTimeout(() => this.expire(session.id), Math.max(1, ttl)),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private expire(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.state === 'success' || session.state === 'failed') { this.remove(id); return; }
    if (session.state === 'cancelled') return;
    if (session.state === 'committing') { session.expiredDuringCommit = true; return; }
    session.state = 'cancelled';
    session.controller.abort('expired');
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if ((session.state === 'cancelled' || session.state === 'success' || session.state === 'failed') && session.expiresAt <= now) this.remove(id);
    }
  }

  private remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.expiryTimer);
    session.unlinkHost();
    this.sessions.delete(id);
  }

  private get(id: string): LoginSession {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128) throw new LoginSessionError('invalid_input');
    const session = this.sessions.get(id);
    if (!session) throw new LoginSessionError('not_found');
    if (session.expiresAt <= this.now() && session.state !== 'committing') {
      this.expire(id);
      throw new LoginSessionError('expired');
    }
    return session;
  }

  async startDevice(accountRef?: string, fenceOrProvider?: LoginFence | (() => Promise<LoginFence | undefined>)): Promise<DeviceLoginStart> {
    if (accountRef !== undefined && (typeof accountRef !== 'string' || accountRef.length < 1 || accountRef.length > 128)) {
      throw new LoginSessionError('invalid_input');
    }
    const session = this.newSession('device', accountRef, typeof fenceOrProvider === 'function' ? undefined : fenceOrProvider, CODEX_DEVICE_TIMEOUT_MS);
    try {
      if (typeof fenceOrProvider === 'function') session.fence = await fenceOrProvider();
      const device = await requestDeviceCode(safeOptions(this.deps, session.controller.signal));
      if (!this.canCommit(session)) throw new LoginSessionError('cancelled');
      session.device = device;
      return { sessionId: session.id, userCode: device.userCode, verificationUri: CODEX_DEVICE_URL, expiresAt: session.expiresAt };
    } catch (error) {
      session.state = 'cancelled';
      session.controller.abort();
      this.remove(session.id);
      throw error;
    }
  }

  startPkce(accountRef?: string, fence?: LoginFence): PkceLoginStart {
    if (accountRef !== undefined && (typeof accountRef !== 'string' || accountRef.length < 1 || accountRef.length > 128)) {
      throw new LoginSessionError('invalid_input');
    }
    const pkce = createPKCE(this.deps.random);
    const session = this.newSession('pkce', accountRef, fence, CODEX_CALLBACK_TTL_MS);
    session.stateValue = pkce.state;
    session.codeVerifier = pkce.codeVerifier;
    return { sessionId: session.id, authorizationUrl: buildCodexAuthorizationUrl(pkce), expiresAt: session.expiresAt };
  }

  setFence(id: string, fence: LoginFence): void {
    const session = this.get(id);
    if (session.state !== 'pending') throw new LoginSessionError('busy');
    session.fence = fence;
  }

  status(id: string): LoginStatus {
    const session = this.sessions.get(id);
    if (!session) throw new LoginSessionError('not_found');
    return {
      sessionId: session.id, kind: session.kind,
      state: session.state === 'committing' ? 'committing' : session.expiresAt <= this.now() ? 'expired' : session.state,
      issuedAt: session.issuedAt, expiresAt: session.expiresAt, accountRef: session.accountRef,
      errorCode: session.state === 'committing' ? undefined : session.expiresAt <= this.now() ? 'expired' : session.errorCode,
      account: session.account,
    };
  }

  private canCommit(session: LoginSession): boolean {
    return !this.disposed && !this.hostSignal.aborted && !session.controller.signal.aborted &&
      session.state !== 'cancelled' && session.state !== 'failed' && session.state !== 'committing' && session.expiresAt > this.now();
  }

  private claim(id: string, kind: LoginKind): LoginSession {
    const session = this.get(id);
    if (session.kind !== kind) throw new LoginSessionError('invalid_input');
    if (session.state === 'cancelled') throw new LoginSessionError(session.expiresAt <= this.now() ? 'expired' : 'cancelled');
    if (session.state === 'success') throw new LoginSessionError('already_consumed');
    if (session.state === 'failed') throw new LoginSessionError('failed');
    if (session.state === 'polling' || session.state === 'exchanging' || session.state === 'committing') throw new LoginSessionError('busy');
    session.state = kind === 'device' ? 'polling' : 'exchanging';
    return session;
  }

  private async finish<TResult>(session: LoginSession, token: CodexTokenSet, commit?: LoginCommit<TResult>): Promise<{ token: CodexTokenSet; accountRef?: string; result?: TResult }> {
    if (!this.canCommit(session)) throw new LoginSessionError('cancelled');
    // This is the linearization point. Cancellation/TTL/dispose cannot claim
    // that an in-flight CAS was rolled back after this synchronous transition.
    session.state = 'committing';
    let result: TResult | undefined;
    try {
      result = commit === undefined ? undefined : await commit(token, { accountRef: session.accountRef, fence: session.fence }, () => session.state === 'committing');
    } catch (error) {
      session.state = 'failed';
      session.errorCode = 'login_failed';
      throw error;
    }
    session.account = this.accountSummary(result);
    session.state = 'success';
    if (session.expiredDuringCommit || session.expiresAt <= this.now()) this.remove(session.id);
    return { token, accountRef: session.accountRef, result };
  }

  private accountSummary(value: unknown): LoginStatus['account'] {
    if (typeof value !== 'object' || value === null) return undefined;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.status !== 'string' || typeof item.available !== 'boolean') return undefined;
    const identity = typeof item.identity === 'object' && item.identity !== null ? item.identity as Record<string, unknown> : undefined;
    return { id: item.id, label: item.label, status: item.status, available: item.available, accountId: typeof identity?.accountId === 'string' ? identity.accountId : undefined };
  }

  async completeDevice<TResult = unknown>(id: string, commit?: LoginCommit<TResult>): Promise<{ token: CodexTokenSet; accountRef?: string; result?: TResult }> {
    const session = this.claim(id, 'device');
    try {
      const device = session.device;
      if (!device) throw new LoginSessionError('busy');
      const token = await pollDeviceToken(device, { ...safeOptions(this.deps, session.controller.signal), maxDurationMs: Math.max(1, session.expiresAt - this.now()) });
      if (!this.canCommit(session)) throw new LoginSessionError('cancelled');
      session.state = 'exchanging';
      const exchanged = await exchangeCodexDeviceAuthorization(token, safeOptions(this.deps, session.controller.signal));
      return await this.finish(session, exchanged, commit);
    } catch (error) {
      if (session.controller.signal.aborted && session.state === 'cancelled') throw new LoginSessionError('cancelled');
      if (session.state === 'polling' || session.state === 'exchanging') {
        session.state = session.controller.signal.aborted ? 'cancelled' : 'failed';
        session.errorCode = session.controller.signal.aborted ? 'cancelled' : 'login_failed';
        if (session.state === 'failed') throw new LoginSessionError('failed');
      }
      throw error;
    }
  }

  async completePkce<TResult = unknown>(id: string, callbackUrl: string, commit?: LoginCommit<TResult>): Promise<{ token: CodexTokenSet; accountRef?: string; result?: TResult }> {
    const session = this.claim(id, 'pkce');
    try {
      if (typeof callbackUrl !== 'string' || callbackUrl.length > 4096) throw new LoginSessionError('invalid_input');
      const callback = parseCodexCallbackUrl(callbackUrl, { expectedState: session.stateValue as string, issuedAt: session.issuedAt, now: this.now(), ttlMs: CODEX_CALLBACK_TTL_MS });
      if (!callback.code) throw new LoginSessionError('cancelled');
      const token = await exchangeCodexCode(callback.code, session.codeVerifier as string, safeOptions(this.deps, session.controller.signal));
      return await this.finish(session, token, commit);
    } catch (error) {
      if (session.controller.signal.aborted && session.state === 'cancelled') throw new LoginSessionError('cancelled');
      if (session.state === 'exchanging') {
        session.state = session.controller.signal.aborted ? 'cancelled' : 'failed';
        session.errorCode = session.controller.signal.aborted ? 'cancelled' : 'login_failed';
        if (session.state === 'failed') throw new LoginSessionError('failed');
      }
      throw error;
    }
  }

  cancel(id: string): boolean {
    const session = this.get(id);
    if (session.state === 'success' || session.state === 'cancelled' || session.state === 'failed' || session.state === 'committing') return false;
    session.state = 'cancelled';
    session.controller.abort('cancelled');
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hostSignal.removeEventListener('abort', this.onHostAbort);
    for (const session of this.sessions.values()) {
      if (session.state !== 'committing') session.state = 'cancelled';
      if (session.state !== 'committing') session.controller.abort('disposed');
      session.unlinkHost();
      clearTimeout(session.expiryTimer);
    }
    for (const [id, session] of this.sessions) if (session.state !== 'committing') this.remove(id);
  }
}
