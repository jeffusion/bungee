import { get, writable } from 'svelte/store';
export interface ManagementSubject { id: string; provider: string }
export const token = writable<string | null>(null);
export const csrfToken = writable<string | null>(null);
export const subject = writable<ManagementSubject | null>(null);
export const authMode = writable<{mode:'anonymous'|'plugin';initialized?:boolean;publicOrigin?:string;provider?:{name:string;loginComponent?:string}} | null>(null);
export const isAuthenticated = writable(false);
// Legacy dashboard secrets must never survive in browser storage.
export function clearLegacyCredential(): void { try { globalThis.localStorage?.removeItem('bungee_auth_token'); } catch {} }
clearLegacyCredential();
export function login(newToken: string): void { clearLegacyCredential(); token.set(newToken); isAuthenticated.set(true); }
export function restoreSession(result: {success:boolean;subject?:ManagementSubject;csrfToken?:string}): void {
  subject.set(result.subject ?? null);
  csrfToken.set(result.csrfToken ?? null); isAuthenticated.set(result.success);
}
export function logout(): void { clearLegacyCredential(); token.set(null); csrfToken.set(null); subject.set(null); isAuthenticated.set(false); }
export function getToken(): string | null { return get(token); }
export function checkAuth():void { clearLegacyCredential(); }

// A request from an earlier authentication handoff must not clear a newer session.
let handoffEpoch = 0;
let activeHandoffs = 0;
export function beginAuthenticationHandoff(): () => void {
  handoffEpoch++; activeHandoffs++;
  let ended = false;
  return () => { if (!ended) { ended = true; activeHandoffs--; handoffEpoch++; } };
}
export function authenticationRequestGuard(): () => boolean {
  const epoch = handoffEpoch, duringHandoff = activeHandoffs > 0;
  return () => !duringHandoff && activeHandoffs === 0 && epoch === handoffEpoch;
}
