import { createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import type { SecretStore } from '../../../packages/core/src/plugin-control/contracts';
import { CODEX_CALLBACK_TTL_MS, CodexOAuthError, requestJson, type CodexTokenSet, type OAuthRequestOptions, type PKCE } from './oauth';

export const SIWC_AUTH_URL = 'https://auth.openai.com/api/accounts/authorize';
export const SIWC_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const SIWC_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const SIWC_ISSUER = 'https://auth.openai.com';
export const SIWC_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
export const SIWC_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] as const;
export const SIWC_REGISTRATION_KEY = 'siwc.registration.v1';
const CLIENT_ID = /^oaiapp_[A-Za-z0-9_-]{1,200}$/;
const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(kind: 'invalid_response' | 'invalid_callback' = 'invalid_response'): never {
  throw new CodexOAuthError(kind, `SIWC ${kind === 'invalid_callback' ? 'callback' : 'response'} is invalid`, { retryable: false });
}

/** Only installation identity is global. Issued client IDs belong to individual accounts. */
export async function getSiwcHostId(store: SecretStore, canWrite: () => boolean = () => true): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!canWrite()) throw new CodexOAuthError('cancelled', 'SIWC operation was cancelled', { retryable: false });
    const current = await store.get(SIWC_REGISTRATION_KEY);
    if (current) {
      try {
        const record = JSON.parse(current.value);
        if (record?.schema === 1 && typeof record.hostId === 'string' && HOST_ID.test(record.hostId)) return record.hostId;
      } catch { /* Hide invalid secret-store contents. */ }
      return invalid();
    }
    const hostId = `urn:uuid:${randomUUID()}`;
    if (!canWrite()) throw new CodexOAuthError('cancelled', 'SIWC operation was cancelled', { retryable: false });
    try {
      await store.compareAndSet(SIWC_REGISTRATION_KEY, null, JSON.stringify({ schema: 1, hostId }));
      return hostId;
    } catch (error) {
      if ((error as { code?: string }).code !== 'version_conflict') throw error;
    }
  }
  return invalid();
}

export function validSiwcMetadata(value: unknown): value is NonNullable<CodexTokenSet['siwc']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['clientId', 'subject', 'scopes'].includes(key)) &&
    typeof item.clientId === 'string' && CLIENT_ID.test(item.clientId) &&
    typeof item.subject === 'string' && item.subject.length > 0 && item.subject.length <= 512 && item.subject.trim() === item.subject && !/[\u0000-\u001f\u007f]/.test(item.subject) &&
    Array.isArray(item.scopes) && item.scopes.length <= 128 && item.scopes.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)) &&
    item.scopes.includes('resource.invoke') && item.scopes.includes('chatgpt.tokens.use.direct');
}

export function createSiwcNonce(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString('base64url');
}

export function buildSiwcAuthorizationUrl(pkce: Pick<PKCE, 'state' | 'codeChallenge'>, nonce: string, hostId: string, clientId?: string): string {
  if (!HOST_ID.test(hostId) || (clientId !== undefined && !CLIENT_ID.test(clientId)) || !nonce || !pkce.state || !pkce.codeChallenge) return invalid();
  const url = new URL(SIWC_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId ?? 'dynamic_agent_client', agent_name_hint: 'Bungee', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: SIWC_REDIRECT_URI, resource: SIWC_RESOURCE, scope: SIWC_SCOPES.join(' '),
    state: pkce.state, nonce, code_challenge: pkce.codeChallenge, code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function parseSiwcCallbackUrl(raw: string, options: { expectedState: string; expectedClientId?: string; issuedAt: number; now?: number }): { code: string; clientId: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid('invalid_callback'); }
  const expected = new URL(SIWC_REDIRECT_URI);
  const now = options.now ?? Date.now();
  if (raw.length > 4096 || raw.trim() !== raw || raw.split('?')[0] !== SIWC_REDIRECT_URI || url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash ||
      !Number.isFinite(now) || !Number.isFinite(options.issuedAt) || options.issuedAt < 0 || now < options.issuedAt || now - options.issuedAt > CODEX_CALLBACK_TTL_MS ||
      [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) || url.searchParams.has('userinfo') ||
      !options.expectedState || url.searchParams.get('state') !== options.expectedState || url.searchParams.has('error') || url.searchParams.has('error_description')) return invalid('invalid_callback');
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id');
  if (!code || code.trim() !== code || /[\u0000-\u001f\u007f]/.test(code) || !clientId || !CLIENT_ID.test(clientId) || (options.expectedClientId !== undefined && clientId !== options.expectedClientId)) return invalid('invalid_callback');
  return { code, clientId };
}

function jwtObject(part: string): Record<string, unknown> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) return invalid();
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Never expose token contents. */ }
  return invalid();
}

export async function verifySiwcIdToken(idToken: string, expected: { clientId: string; nonce?: string; subject?: string; now?: number }, options: OAuthRequestOptions = {}): Promise<{ subject: string; email?: string }> {
  if (!CLIENT_ID.test(expected.clientId) || idToken.length > 32_768) return invalid();
  const parts = idToken.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return invalid();
  const header = jwtObject(parts[0]!);
  const payload = jwtObject(parts[1]!);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined) return invalid();
  const jwks = await requestJson(SIWC_JWKS_URL, { method: 'GET', headers: { accept: 'application/json' } }, options);
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 128) return invalid();
  const keys = jwks.keys.filter(key => key && typeof key === 'object' && key.kid === header.kid && key.kty === 'RSA' &&
    (key.alg === undefined || key.alg === 'RS256') && (key.use === undefined || key.use === 'sig') &&
    (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) && key.d === undefined);
  if (keys.length !== 1) return invalid();
  try {
    const publicKey = createPublicKey({ key: keys[0] as JsonWebKey, format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) return invalid();
  } catch { return invalid(); }
  const aud = payload.aud;
  const now = expected.now ?? Date.now();
  if (payload.iss !== SIWC_ISSUER || !(aud === expected.clientId || (Array.isArray(aud) && aud.every(item => typeof item === 'string') && aud.includes(expected.clientId))) ||
      (Array.isArray(aud) && aud.length > 1 && payload.azp !== expected.clientId) || (payload.azp !== undefined && payload.azp !== expected.clientId) ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || !Number.isFinite(now) || payload.exp * 1000 <= now ||
      (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf * 1000 > now)) ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 || payload.sub.trim() !== payload.sub || /[\u0000-\u001f\u007f]/.test(payload.sub) ||
      (expected.nonce !== undefined && payload.nonce !== expected.nonce) || (expected.subject !== undefined && payload.sub !== expected.subject)) return invalid();
  return { subject: payload.sub, email: typeof payload.email === 'string' && payload.email.length <= 512 && !/[\u0000-\u001f\u007f]/.test(payload.email) ? payload.email : undefined };
}

function tokenString(record: Record<string, unknown>, key: string, fallback?: string): string {
  if (record[key] === undefined && fallback !== undefined) return fallback;
  const value = record[key];
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 32_768 || /[\r\n\0]/.test(value)) return invalid();
  return value;
}

async function siwcTokenSet(record: Record<string, unknown>, expected: { clientId: string; nonce?: string; subject?: string }, options: OAuthRequestOptions, previous?: CodexTokenSet): Promise<CodexTokenSet> {
  const accessToken = tokenString(record, 'access_token');
  const refreshToken = tokenString(record, 'refresh_token', previous?.refreshToken);
  const idToken = tokenString(record, 'id_token', previous?.idToken);
  if (record.token_type !== undefined && (typeof record.token_type !== 'string' || record.token_type.toLowerCase() !== 'bearer')) return invalid();
  if (typeof record.expires_in !== 'number' || !Number.isFinite(record.expires_in) || record.expires_in <= 0 || record.expires_in * 1000 > Number.MAX_SAFE_INTEGER - Date.now()) return invalid();
  const scopes = record.scope === undefined && previous?.siwc ? [...previous.siwc.scopes] : tokenString(record, 'scope').split(/\s+/);
  const verified = record.id_token === undefined && previous?.siwc
    ? { subject: previous.siwc.subject, email: previous.identity?.email }
    : await verifySiwcIdToken(idToken, expected, options);
  const siwc = { clientId: expected.clientId, subject: verified.subject, scopes };
  if (!validSiwcMetadata(siwc)) return invalid();
  return { accessToken, refreshToken, idToken, expiresIn: record.expires_in, expiresAt: Date.now() + record.expires_in * 1000,
    tokenType: 'Bearer', identity: { email: verified.email }, identityStatus: 'parsed', siwc };
}

export async function exchangeSiwcCode(code: string, codeVerifier: string, clientId: string, nonce: string, options: OAuthRequestOptions = {}): Promise<CodexTokenSet> {
  if (!code || !codeVerifier || !nonce || !CLIENT_ID.test(clientId)) return invalid();
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: codeVerifier, redirect_uri: SIWC_REDIRECT_URI, resource: SIWC_RESOURCE });
  const record = await requestJson(SIWC_TOKEN_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, options);
  return siwcTokenSet(record, { clientId, nonce }, options);
}

export async function refreshSiwcToken(previous: CodexTokenSet, options: OAuthRequestOptions = {}): Promise<CodexTokenSet> {
  if (!validSiwcMetadata(previous.siwc) || !previous.refreshToken) return invalid();
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.siwc.clientId, refresh_token: previous.refreshToken, resource: SIWC_RESOURCE });
  const record = await requestJson(SIWC_TOKEN_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, options, true);
  return siwcTokenSet(record, { clientId: previous.siwc.clientId, subject: previous.siwc.subject }, options, previous);
}
