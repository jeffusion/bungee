import { get } from 'svelte/store';
import { managementLogin } from './client';
import { fetchAuthMode, fetchCookieVerifiedSession, ManagementAuthenticationError, type AuthMode } from './auth';
import {
  authMode, beginAuthenticationHandoff, commitManagementSession, getAuthStateRevision,
  isAuthenticationStateCurrent, type ManagementSubject,
} from '$stores/auth';
import type { ManagementLoginContext } from '../plugin-sdk/management-login';

export interface ManagementLoginContextOptions {
  provider: { readonly name: string; readonly publicOrigin: string };
  onAuthenticated(isCurrent: () => boolean): Promise<boolean>;
  onCompleted?(): void;
}

export class StaleManagementLoginError extends Error {
  readonly name = 'StaleManagementLoginError';
  readonly code = 'management_login_stale';
  constructor() { super('management_login_stale'); }
}

function matchesProvider(mode: AuthMode | null | undefined, provider: { name: string; publicOrigin: string }): boolean {
  return mode?.mode === 'plugin' && mode.provider?.name === provider.name && mode.publicOrigin === provider.publicOrigin;
}

/** Create one page-scoped capability; dispose it when its provider page leaves. */
export function createManagementLoginContext(options: ManagementLoginContextOptions): {
  readonly context: ManagementLoginContext;
  dispose(): void;
} {
  const provider = Object.freeze({ name: options.provider.name, publicOrigin: options.provider.publicOrigin });
  if (!provider.name || !provider.publicOrigin) throw new ManagementAuthenticationError('management_login_provider_invalid');
  const endHandoff = beginAuthenticationHandoff();
  let disposed = false;
  let loginGeneration = 0;
  let loginSucceeded = false;
  let completePromise: Promise<void> | undefined;
  let completed = false;
  let operationRevision = getAuthStateRevision();

  const isCurrent = () => !disposed && isAuthenticationStateCurrent(operationRevision)
    && matchesProvider(get(authMode), provider);
  const stale = () => new StaleManagementLoginError();

  const context: ManagementLoginContext = Object.freeze({
    provider,
    async login(input: unknown): Promise<unknown> {
      if (!isCurrent()) throw stale();
      if (completePromise || completed) throw new ManagementAuthenticationError('management_login_completing');
      if (!matchesProvider(get(authMode), provider)) throw new ManagementAuthenticationError('management_login_provider_changed');
      const generation = ++loginGeneration;
      loginSucceeded = false;
      try {
        const result = await managementLogin(provider.name, input);
        if (!isCurrent() || generation !== loginGeneration) throw stale();
        loginSucceeded = true;
        return result;
      } catch (error) {
        if (!isCurrent() || generation !== loginGeneration) throw stale();
        loginSucceeded = false;
        throw error;
      }
    },
    complete(): Promise<void> {
      if (completed) return Promise.resolve();
      if (completePromise) return completePromise;
      const pending = (async () => {
        if (!isCurrent()) throw stale();
        if (!loginSucceeded) throw new ManagementAuthenticationError('management_login_not_completed');
        if (!matchesProvider(get(authMode), provider)) throw new ManagementAuthenticationError('management_login_provider_changed');

        let mode: AuthMode;
        try {
          mode = await fetchAuthMode();
        } catch {
          if (!isCurrent()) throw stale();
          throw new ManagementAuthenticationError('management_login_read_failed');
        }
        if (!isCurrent()) throw stale();

        let verified: Awaited<ReturnType<typeof fetchCookieVerifiedSession>>;
        try {
          verified = await fetchCookieVerifiedSession();
        } catch {
          if (!isCurrent()) throw stale();
          throw new ManagementAuthenticationError('management_login_read_failed');
        }
        if (!isCurrent()) throw stale();
        if (mode.mode !== 'plugin' || mode.provider?.name !== provider.name || mode.publicOrigin !== provider.publicOrigin
          || !verified.success || verified.mode !== 'plugin'
          || !verified.subject?.id || verified.subject.provider !== provider.name) {
          throw new ManagementAuthenticationError('management_login_verify_mismatch');
        }
        if (!matchesProvider(get(authMode), provider)) throw new ManagementAuthenticationError('management_login_provider_changed');

        const beforeCommitRevision = getAuthStateRevision();
        commitManagementSession(mode, verified as { success: true; subject: ManagementSubject; csrfToken?: string });
        const committedRevision = getAuthStateRevision();
        endHandoff();
        operationRevision = getAuthStateRevision();
        if (committedRevision !== beforeCommitRevision + 1 || !isCurrent()) throw stale();
        let initialized: boolean;
        try {
          initialized = await options.onAuthenticated(isCurrent);
        } catch {
          if (!isCurrent()) throw stale();
          throw new ManagementAuthenticationError('management_login_initialization_failed');
        }
        if (!isCurrent()) throw stale();
        if (initialized !== true) throw new ManagementAuthenticationError('management_login_initialization_failed');

        try {
          options.onCompleted?.();
        } catch {
          throw new ManagementAuthenticationError('management_login_completion_failed');
        }
        completed = true;
      })();
      completePromise = pending;
      void pending.catch(() => {
        if (completePromise === pending && !completed) completePromise = undefined;
      });
      return pending;
    }
  });

  return {
    context,
    dispose() {
      if (disposed) return;
      disposed = true;
      loginGeneration++;
      endHandoff();
      if (!completed) operationRevision = -1;
    }
  };
}
