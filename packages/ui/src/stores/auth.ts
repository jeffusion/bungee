import { get, writable } from 'svelte/store';
export interface ManagementSubject { id: string; provider: string }
export interface ManagementAuthMode {mode:'anonymous'|'plugin';initialized?:boolean;publicOrigin?:string;provider?:{name:string;loginComponent?:string}}
export const token = writable<string | null>(null);
export const csrfToken = writable<string | null>(null);
export const subject = writable<ManagementSubject | null>(null);
export const authMode = writable<ManagementAuthMode | null>(null);
export const isAuthenticated = writable(false);
// Legacy dashboard secrets must never survive in browser storage.
export function clearLegacyCredential(): void { try { globalThis.localStorage?.removeItem('bungee_auth_token'); } catch {} }
clearLegacyCredential();
export function login(newToken: string): void { authStateRevision++; clearLegacyCredential(); token.set(newToken); isAuthenticated.set(true); }
export function restoreSession(result: {success:boolean;subject?:ManagementSubject;csrfToken?:string}): void {
  authStateRevision++;
  subject.set(result.subject ?? null);
  csrfToken.set(result.csrfToken ?? null); isAuthenticated.set(result.success);
}
export function logout(): void { authStateRevision++; clearLegacyCredential(); token.set(null); csrfToken.set(null); subject.set(null); isAuthenticated.set(false); }
export function getToken(): string | null { return get(token); }
export function checkAuth():void { clearLegacyCredential(); }

// A request from an earlier authentication handoff must not clear a newer session.
let handoffEpoch = 0;
let activeHandoffs = 0;
let authStateRevision = 0;
export function getAuthStateRevision(): number { return authStateRevision; }
export function commitAuthMode(mode: ManagementAuthMode): void {
  const previous = get(authMode);
  const sameProvider = previous?.mode === mode.mode
    && previous.provider?.name === mode.provider?.name
    && previous.publicOrigin === mode.publicOrigin;
  if (!sameProvider) authStateRevision++;
  authMode.set(mode);
}
export function commitManagementSession(mode: ManagementAuthMode, result: {success:true;subject:ManagementSubject;csrfToken?:string}): void {
  authStateRevision++; authMode.set(mode); token.set(null); subject.set(result.subject); csrfToken.set(result.csrfToken ?? null); isAuthenticated.set(true);
}
export function isAuthenticationStateCurrent(revision: number): boolean { return authStateRevision === revision; }
/** Keep background/late 401s out of a host-owned authentication operation. */
export function beginAuthenticationRequestIsolation(): () => void {
  handoffEpoch++; activeHandoffs++;
  let ended = false;
  return () => { if (!ended) { ended = true; activeHandoffs--; handoffEpoch++; } };
}
export function beginAuthenticationHandoff(): () => void {
  authStateRevision++;
  const endIsolation = beginAuthenticationRequestIsolation();
  let ended = false;
  return () => { if (!ended) { ended = true; endIsolation(); authStateRevision++; } };
}
export function authenticationRequestGuard(): () => boolean {
  const epoch = handoffEpoch, duringHandoff = activeHandoffs > 0;
  return () => !duringHandoff && activeHandoffs === 0 && epoch === handoffEpoch;
}
