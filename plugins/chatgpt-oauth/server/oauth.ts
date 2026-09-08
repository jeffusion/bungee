import { createHash, randomBytes } from 'node:crypto';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CODEX_DEVICE_EXCHANGE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';
export const CODEX_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
export const CODEX_CALLBACK_TTL_MS = 5 * 60 * 1000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OAuthErrorKind =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'invalid_callback'
  | 'refresh_token_reused'
  | 'body_limit';

export class CodexOAuthError extends Error {
  readonly kind: OAuthErrorKind;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly retryable: boolean;

  constructor(kind: OAuthErrorKind, message: string, options: { status?: number; upstreamCode?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'CodexOAuthError';
    this.kind = kind;
    this.status = options.status;
    this.upstreamCode = options.upstreamCode;
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'timeout');
  }
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

export interface DeviceTokenResponse {
  authorizationCode: string;
  codeVerifier: string;
  codeChallenge?: string;
}

export interface OAuthRequestOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

function fetchOf(fetchImpl?: FetchLike): FetchLike {
  return fetchImpl ?? fetch;
}

function safeMessage(kind: OAuthErrorKind, status?: number): string {
  if (kind === 'cancelled') return 'Codex OAuth operation was cancelled';
  if (kind === 'timeout') return 'Codex OAuth operation timed out';
  if (kind === 'network') return 'Codex OAuth network request failed';
  if (kind === 'body_limit') return 'Codex OAuth response exceeded the body limit';
  if (kind === 'refresh_token_reused') return 'Codex refresh token was already used and cannot be retried';
  if (kind === 'invalid_callback') return 'Codex OAuth callback is invalid';
  if (kind === 'invalid_response') return 'Codex OAuth returned an invalid response';
  return `Codex OAuth request failed${status === undefined ? '' : ` (HTTP ${status})`}`;
}

function abortError(signal?: AbortSignal): CodexOAuthError {
  return new CodexOAuthError(signal?.reason === 'timeout' ? 'timeout' : 'cancelled', safeMessage(signal?.reason === 'timeout' ? 'timeout' : 'cancelled'));
}

function safeRequestError(error: unknown, signal?: AbortSignal): CodexOAuthError {
  if (error instanceof CodexOAuthError) return error;
  if (signal?.aborted) return abortError(signal);
  return new CodexOAuthError('network', safeMessage('network'), { retryable: true });
}

type ReadChunkResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadChunkResult> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

async function readBounded(response: Response, maxBodyBytes: number, signal?: AbortSignal): Promise<string> {
  try {
    if (!response.body) {
      const text = await awaitWithSignal(response.text(), signal);
      if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
        throw new CodexOAuthError('body_limit', safeMessage('body_limit'), { retryable: false });
      }
      return text;
    }
    const reader = response.body.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = await readChunk(reader, signal);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBodyBytes) {
          void reader.cancel().catch(() => undefined);
          throw new CodexOAuthError('body_limit', safeMessage('body_limit'), { retryable: false });
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    throw safeRequestError(error, signal);
  }
}

function jsonRecord(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Deliberately hide malformed upstream body contents.
  }
  throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
}

function safeUpstreamCode(text: string): string | undefined {
  const safeCodes = new Set(['refresh_token_reused', 'invalid_grant', 'authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_request']);
  const find = (value: unknown, depth: number): string | undefined => {
    if (depth > 2 || value === null || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, item] of Object.entries(value)) {
      if (['error', 'error_code', 'code'].includes(key) && typeof item === 'string' && safeCodes.has(item.toLowerCase())) return item.toLowerCase();
      const found = find(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  try {
    const value: unknown = JSON.parse(text);
    return find(value, 0);
  } catch {
    // Do not expose or inspect arbitrary response text.
  }
  return undefined;
}

function responseError(status: number, body: string, refresh = false): CodexOAuthError {
  const code = safeUpstreamCode(body);
  if (refresh && code?.toLowerCase() === 'refresh_token_reused') {
    return new CodexOAuthError('refresh_token_reused', safeMessage('refresh_token_reused'), {
      status,
      upstreamCode: 'refresh_token_reused',
      retryable: false
    });
  }
  return new CodexOAuthError('http', safeMessage('http', status), {
    status,
    upstreamCode: code,
    retryable: status >= 500 || status === 408 || status === 429
  });
}

async function requestJson(url: string, init: RequestInit, options: OAuthRequestOptions, refresh = false): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const combined = combinedSignal(options.signal, timeoutMs);
  try {
    if (combined.signal.aborted) throw abortError(combined.signal);
    let response: Response;
    try {
      response = await fetchOf(options.fetchImpl)(url, { ...init, redirect: 'error', signal: combined.signal });
    } catch (error) {
      throw safeRequestError(error, combined.signal);
    }
    const body = await readBounded(response, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, combined.signal);
    if (!response.ok) throw responseError(response.status, body, refresh);
    return jsonRecord(body);
  } catch (error) {
    throw safeRequestError(error, combined.signal);
  } finally {
    combined.dispose();
  }
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (typeof record[name] === 'string' && record[name].trim()) return record[name].trim();
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export async function requestDeviceCode(options: OAuthRequestOptions = {}): Promise<DeviceCode> {
  const body = await requestJson(CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  }, options);
  const deviceAuthId = stringField(body, 'device_auth_id');
  const userCode = stringField(body, 'user_code', 'usercode');
  if (!deviceAuthId || !userCode) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  const seconds = positiveNumber(body.interval) ?? 5;
  return { deviceAuthId, userCode, intervalMs: Math.max(250, Math.round(seconds * 1000)) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollDeviceToken(
  device: Pick<DeviceCode, 'deviceAuthId' | 'userCode' | 'intervalMs'>,
  options: OAuthRequestOptions & { maxDurationMs?: number } = {}
): Promise<DeviceTokenResponse> {
  if (!device.deviceAuthId.trim() || !device.userCode.trim()) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  const maxDurationMs = Math.min(options.maxDurationMs ?? CODEX_DEVICE_TIMEOUT_MS, CODEX_DEVICE_TIMEOUT_MS);
  const deadline = Date.now() + Math.max(1, maxDurationMs);
  const intervalMs = Math.max(250, device.intervalMs || 5000);
  for (;;) {
    if (Date.now() >= deadline) throw new CodexOAuthError('timeout', 'Codex device authentication timed out after 15 minutes', { retryable: false });
    const remaining = deadline - Date.now();
    const body = JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode });
    let response: Response;
    const combined = combinedSignal(options.signal, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining));
    try {
      try {
        response = await fetchOf(options.fetchImpl)(CODEX_DEVICE_TOKEN_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: combined.signal
        });
      } catch (error) {
        throw safeRequestError(error, combined.signal);
      }
      const text = await readBounded(response, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, combined.signal);
      if (response.status === 403 || response.status === 404) {
        // OpenAI uses both statuses for a still-pending device authorization. Any
        // other non-2xx status is a terminal protocol error, not a polling state.
        if (Date.now() >= deadline) throw new CodexOAuthError('timeout', 'Codex device authentication timed out after 15 minutes', { retryable: false });
        await sleep(Math.min(intervalMs, deadline - Date.now()), options.signal);
        continue;
      }
      if (!response.ok) throw responseError(response.status, text);
      const parsed = jsonRecord(text);
      const authorizationCode = stringField(parsed, 'authorization_code');
      const codeVerifier = stringField(parsed, 'code_verifier');
      if (!authorizationCode || !codeVerifier) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
      return { authorizationCode, codeVerifier, codeChallenge: stringField(parsed, 'code_challenge') };
    } catch (error) {
      throw safeRequestError(error, combined.signal);
    } finally {
      combined.dispose();
    }
  }
}

export interface PKCE {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function createPKCE(random?: (size: number) => Uint8Array): PKCE {
  const bytes = random ?? ((size) => randomBytes(size));
  const codeVerifier = base64Url(bytes(32));
  const state = base64Url(bytes(32));
  const codeChallenge = base64Url(new Uint8Array(createHash('sha256').update(codeVerifier).digest()));
  return { state, codeVerifier, codeChallenge };
}

export function buildCodexAuthorizationUrl(pkce: Pick<PKCE, 'state' | 'codeChallenge'>): string {
  const url = new URL(CODEX_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT_URI,
    scope: 'openid email profile offline_access',
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true'
  }).toString();
  return url.toString();
}

export interface CallbackParseOptions {
  expectedState: string;
  issuedAt?: number;
  now?: number;
  ttlMs?: number;
  expectedOrigin?: string;
  expectedPath?: string;
}

export interface OAuthCallback {
  code?: string;
  state: string;
  error?: string;
  errorDescription?: { present: true };
}

const SAFE_CALLBACK_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable'
]);

export function parseCodexCallbackUrl(raw: string, options: CallbackParseOptions): OAuthCallback {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const expectedUrl = new URL(CODEX_REDIRECT_URI);
  if (
    (options.expectedOrigin !== undefined && options.expectedOrigin !== expectedUrl.origin) ||
    (options.expectedPath !== undefined && options.expectedPath !== expectedUrl.pathname) ||
    url.origin !== expectedUrl.origin ||
    url.pathname !== expectedUrl.pathname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const duplicate = ['state', 'code', 'error', 'error_description'].some((name) => url.searchParams.getAll(name).length > 1);
  if (duplicate || url.searchParams.has('userinfo')) {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const state = url.searchParams.get('state') ?? '';
  if (!state || state !== options.expectedState) throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? CODEX_CALLBACK_TTL_MS;
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0 || (options.issuedAt !== undefined && (!Number.isFinite(options.issuedAt) || options.issuedAt < 0 || now < options.issuedAt || now - options.issuedAt > ttl))) {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const hasCode = url.searchParams.has('code');
  const hasError = url.searchParams.has('error');
  if (hasCode && hasError) throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  const code = url.searchParams.get('code')?.trim() || undefined;
  const rawError = url.searchParams.get('error')?.trim() || undefined;
  if ((hasCode && !code) || (hasError && !rawError)) {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const error = rawError ? (SAFE_CALLBACK_ERRORS.has(rawError) ? rawError : 'unknown_error') : undefined;
  const hasErrorDescription = rawError !== undefined && url.searchParams.has('error_description');
  if (rawError === undefined && url.searchParams.has('error_description')) {
    throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  }
  const result: OAuthCallback = {
    state,
    code,
    error,
    errorDescription: hasErrorDescription ? { present: true } : undefined
  };
  if (!result.code && !result.error) throw new CodexOAuthError('invalid_callback', safeMessage('invalid_callback'), { retryable: false });
  return result;
}

export interface CodexTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: number;
  identity?: CodexIdentity;
  identityStatus: 'missing' | 'parsed' | 'invalid';
}

function tokenSet(record: Record<string, unknown>, previousRefreshToken?: string): CodexTokenSet {
  const accessToken = stringField(record, 'access_token');
  const refreshToken = stringField(record, 'refresh_token') ?? previousRefreshToken;
  if (!accessToken || !refreshToken) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  const expiresIn = positiveNumber(record.expires_in);
  const idToken = stringField(record, 'id_token');
  let identity: CodexIdentity | undefined;
  let identityStatus: CodexTokenSet['identityStatus'] = 'missing';
  if (idToken) {
    try {
      identity = extractCodexIdentity(idToken);
      identityStatus = 'parsed';
    } catch {
      // Identity is optional metadata. Never discard newly rotated credentials.
      identityStatus = 'invalid';
    }
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    tokenType: stringField(record, 'token_type'),
    expiresIn,
    expiresAt: expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000,
    identity,
    identityStatus
  };
}

export async function exchangeCodexCode(
  code: string,
  codeVerifier: string,
  options: OAuthRequestOptions & { redirectUri?: string } = {}
): Promise<CodexTokenSet> {
  if (!code.trim() || !codeVerifier.trim()) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  const redirectUri = options.redirectUri ?? CODEX_REDIRECT_URI;
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: codeVerifier });
  const response = await requestJson(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, options);
  return tokenSet(response);
}

export async function exchangeCodexDeviceAuthorization(
  deviceToken: Pick<DeviceTokenResponse, 'authorizationCode' | 'codeVerifier'>,
  options: OAuthRequestOptions = {}
): Promise<CodexTokenSet> {
  return exchangeCodexCode(deviceToken.authorizationCode, deviceToken.codeVerifier, {
    ...options,
    redirectUri: CODEX_DEVICE_EXCHANGE_REDIRECT_URI
  });
}

export async function refreshCodexToken(
  refreshToken: string,
  options: OAuthRequestOptions = {}
): Promise<CodexTokenSet> {
  if (!refreshToken.trim()) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  const body = new URLSearchParams({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' });
  const response = await requestJson(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, { ...options }, true);
  return tokenSet(response, refreshToken);
}

export interface CodexIdentity {
  email?: string;
  accountId?: string;
  planType?: string;
  userId?: string;
}

export interface CodexJwtPayload {
  email?: unknown;
  exp?: unknown;
  sub?: unknown;
  [key: string]: unknown;
}

export function parseJwtPayload(idToken: string): CodexJwtPayload {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('not an object');
    return payload as CodexJwtPayload;
  } catch {
    throw new CodexOAuthError('invalid_response', safeMessage('invalid_response'), { retryable: false });
  }
}

export function extractCodexIdentity(idToken: string): CodexIdentity {
  const payload = parseJwtPayload(idToken);
  const auth = payload['https://api.openai.com/auth'];
  const authRecord = typeof auth === 'object' && auth !== null && !Array.isArray(auth) ? auth as Record<string, unknown> : {};
  return {
    email: typeof payload.email === 'string' ? payload.email : undefined,
    accountId: typeof authRecord.chatgpt_account_id === 'string' ? authRecord.chatgpt_account_id : undefined,
    planType: typeof authRecord.chatgpt_plan_type === 'string' ? authRecord.chatgpt_plan_type : undefined,
    userId: typeof authRecord.user_id === 'string' ? authRecord.user_id : undefined
  };
}
