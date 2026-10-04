import { api, ApiError, readManagementAuth } from './client';
import {
  commitAuthMode, commitManagementSession, getAuthStateRevision,
  isAuthenticationStateCurrent, logout, restoreSession, token,
  type ManagementSubject,
} from '$stores/auth';

export interface LoginResponse { success:boolean; mode?:'anonymous'|'plugin'; error?:string; subject?:ManagementSubject; csrfToken?:string }
export interface AuthMode { mode:'anonymous'|'plugin'; initialized?:boolean; publicOrigin?:string; provider?:{name:string;loginComponent?:string} }
let modeReadGeneration = 0;
let verifyGeneration = 0;
let restoreGeneration = 0;

function staleRestoreError(): Error & { code: 'management_login_stale' } {
  return Object.assign(new Error('management_login_stale'), { code: 'management_login_stale' as const });
}
function isStaleRestoreError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'management_login_stale';
}

/** Side-effect-free read used by guarded authentication flows. */
export function fetchAuthMode(): Promise<AuthMode> { return readManagementAuth<AuthMode>('mode'); }

/** Side-effect-free verification used by guarded authentication flows. */
export function fetchVerifiedSession(): Promise<LoginResponse> {
  return api.get<LoginResponse>('/auth/verify', { preserveSessionOnUnauthorized: true });
}

/** Cookie-only verification for the new management restore/login lane. */
export function fetchCookieVerifiedSession(): Promise<LoginResponse> {
  return readManagementAuth<LoginResponse>('verify');
}

/** Compatibility API: reads and commits the current mode. */
export async function readAuthMode(): Promise<AuthMode> {
  const generation = ++modeReadGeneration;
  const revision = getAuthStateRevision();
  // Keep the legacy API's bearer transport; the new restore/context lane uses fetchAuthMode().
  const mode = await api.get<AuthMode>('/auth/mode');
  if (generation === modeReadGeneration && isAuthenticationStateCurrent(revision)) commitAuthMode(mode);
  return mode;
}

/** Compatibility API: verifies and updates the current session stores. */
export async function verifyToken(options: {preserveSessionOnFailure?:boolean} = {}):Promise<LoginResponse> {
  const generation = ++verifyGeneration;
  const revision = getAuthStateRevision();
  const result = await fetchVerifiedSession();
  if (generation === verifyGeneration && isAuthenticationStateCurrent(revision)
    && (result.success || !options.preserveSessionOnFailure)) restoreSession(result);
  return result;
}

export class ManagementAuthenticationError extends Error {
  readonly name = 'ManagementAuthenticationError';
  constructor(readonly code: string) { super(code); }
}

/** Restore auth without exposing a partially verified session to application stores. */
export async function restoreManagementSession(): Promise<AuthMode> {
  const generation = ++restoreGeneration;
  const revision = getAuthStateRevision();
  const current = () => generation === restoreGeneration && isAuthenticationStateCurrent(revision);
  const guarded = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      const value = await operation;
      if (!current()) throw staleRestoreError();
      return value;
    } catch (error) {
      if (!current()) throw staleRestoreError();
      throw error;
    }
  };
  let mode: AuthMode;
  try {
    mode = await guarded(fetchAuthMode());
  } catch (error) {
    if (isStaleRestoreError(error)) throw error;
    throw new ManagementAuthenticationError('management_session_read_failed');
  }
  let result: LoginResponse;
  try {
    result = await guarded(fetchCookieVerifiedSession());
  } catch (error) {
    if (!current()) throw staleRestoreError();
    if (!(error instanceof ApiError) || error.status !== 401) {
      if (isStaleRestoreError(error)) throw error;
      throw new ManagementAuthenticationError('management_session_read_failed');
    }
    result = { success: false };
  }
  if (!current()) throw staleRestoreError();

  if (mode.mode === 'anonymous') {
    const anonymousSubject = result.subject;
    if (!result.success || result.mode !== 'anonymous'
      || (anonymousSubject !== undefined && (anonymousSubject.id !== 'anonymous' || anonymousSubject.provider !== 'anonymous'))) {
      throw new ManagementAuthenticationError('management_session_verify_mismatch');
    }
    commitAuthMode(mode);
    token.set(null);
    restoreSession({ success: true, subject: anonymousSubject, csrfToken: result.csrfToken });
    return mode;
  }

  if (mode.mode !== 'plugin' || !mode.provider?.name) throw new ManagementAuthenticationError('management_session_provider_invalid');
  if (!result.success) {
    // Keep plugin mode so the provider login component can render; do not downgrade to anonymous.
    commitAuthMode(mode);
    token.set(null);
    restoreSession({ success: false });
    return mode;
  }
  if (result.mode !== 'plugin' || result.subject?.provider !== mode.provider.name || !result.subject.id) {
    throw new ManagementAuthenticationError('management_session_verify_mismatch');
  }
  commitManagementSession(mode, { success: true, subject: result.subject, csrfToken: result.csrfToken });
  return mode;
}

export async function endSession():Promise<void> {
  const revision = getAuthStateRevision();
  try { await api.post('/auth/logout',{}, { preserveSessionOnUnauthorized: true }); }
  finally { if (isAuthenticationStateCurrent(revision)) logout(); }
}
