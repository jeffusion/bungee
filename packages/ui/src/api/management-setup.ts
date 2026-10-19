import { get } from 'svelte/store';
import { managementSetup, readManagementAuth } from './client';
import { fetchAuthMode, ManagementAuthenticationError, type AuthMode } from './auth';
import { authMode, beginAuthenticationHandoff, commitAuthMode, getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
import type { ManagementSetupContext } from '../plugin-sdk/management-setup';

interface SetupState { initialized: boolean; provider?: { name: string } }

/** One initialization capability belongs to one selected provider and one mounted page. */
export function createManagementSetupContext(options: {
  provider: { name: string; publicOrigin: string };
  onCompleted(): void;
}): { context: ManagementSetupContext; check(): Promise<boolean>; dispose(): void } {
  const provider = Object.freeze({ ...options.provider });
  const selected = get(authMode);
  const identity = (mode: AuthMode | null) => JSON.stringify([
    mode?.mode, mode?.provider?.name, mode?.publicOrigin,
    mode?.provider?.loginComponent, mode?.provider?.setupComponent,
  ]);
  if (selected?.mode !== 'plugin' || selected.initialized !== false
    || !provider.name || !provider.publicOrigin || selected.provider?.name !== provider.name
    || selected.publicOrigin !== provider.publicOrigin) {
    throw new ManagementAuthenticationError('management_setup_provider_invalid');
  }
  const selectedIdentity = identity(selected);
  const endHandoff = beginAuthenticationHandoff();
  const revision = getAuthStateRevision();
  let disposed = false, generation = 0, busy = false, completed = false;
  let needsConfirmation = false;
  const current = (operation: number) => !disposed && !completed && operation === generation
    && isAuthenticationStateCurrent(revision) && identity(get(authMode)) === selectedIdentity
    && get(authMode)?.initialized === false;
  const assertCurrent = (operation: number) => {
    if (!current(operation)) throw new ManagementAuthenticationError('management_setup_stale');
  };
  async function confirm(operation: number): Promise<boolean> {
    const state = await readManagementAuth<SetupState>('setup');
    assertCurrent(operation);
    if (typeof state.initialized !== 'boolean' || state.provider?.name !== provider.name) {
      throw new ManagementAuthenticationError('management_setup_verify_mismatch');
    }
    if (!state.initialized) return false;
    const mode = await fetchAuthMode();
    assertCurrent(operation);
    if (mode.initialized !== true || identity(mode) !== selectedIdentity) {
      throw new ManagementAuthenticationError('management_setup_verify_mismatch');
    }
    completed = true;
    commitAuthMode(mode);
    options.onCompleted();
    return true;
  }
  return {
    context: Object.freeze({
      provider,
      async initialize(input: unknown): Promise<void> {
        if (busy) throw new ManagementAuthenticationError('management_setup_busy');
        const operation = ++generation;
        assertCurrent(operation);
        busy = true;
        try {
          // A lost response leaves the write outcome unknown. Resolve it before another write.
          if (needsConfirmation && await confirm(operation)) return;
          needsConfirmation = true;
          let failure: unknown;
          try { await managementSetup(provider.name, input); }
          catch (error) { failure = error; }
          assertCurrent(operation);
          if (await confirm(operation)) return;
          needsConfirmation = false;
          if (failure !== undefined) throw failure;
          throw new ManagementAuthenticationError('management_setup_not_completed');
        } catch (error) {
          if (!completed) assertCurrent(operation);
          throw error;
        } finally { busy = false; }
      },
    }),
    check() {
      if (busy) return Promise.reject(new ManagementAuthenticationError('management_setup_busy'));
      const operation = ++generation;
      assertCurrent(operation);
      return confirm(operation);
    },
    dispose() { if (!disposed) { disposed = true; generation++; endHandoff(); } },
  };
}
