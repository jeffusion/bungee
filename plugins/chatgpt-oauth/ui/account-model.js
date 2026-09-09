export const loginStates = Object.freeze({ pending: 'login.pending', polling: 'login.polling', exchanging: 'login.exchanging', committing: 'login.committing', success: 'login.success', failed: 'login.failed', cancelled: 'login.cancelled', expired: 'login.expired' });
export const accountStates = Object.freeze({ active: 'account.active', disabled: 'account.disabled', revoked: 'account.revoked', reauth_required: 'account.reauth_required' });
/** @param {unknown} state */
export const terminal = state => typeof state === 'string' && ['success', 'failed', 'cancelled', 'expired'].includes(state);
/** @param {unknown} value @param {string} kind */
export function verificationUrl(value, kind) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const path = kind === 'device' ? '/codex/device' : '/oauth/authorize';
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== path || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}
/** Validate and whitelist start data before it can become an active UI session.
 * @param {unknown} input @param {string} kind @param {number} [now] */
export function parseLoginStart(input, kind, now = Date.now()) {
  const value = record(input);
  if (!['device', 'pkce'].includes(kind) || typeof value.sessionId !== 'string' || !value.sessionId
    || value.sessionId !== value.sessionId.trim() || value.sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(value.sessionId)
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
    || value.expiresAt > now + 30 * 60 * 1000) throw new Error('invalid_response');
  const base = { sessionId: value.sessionId, expiresAt: value.expiresAt };
  if (kind === 'device') {
    if (typeof value.userCode !== 'string' || !value.userCode || value.userCode !== value.userCode.trim()
      || value.userCode.length > 128 || /[\u0000-\u001f\u007f]/.test(value.userCode)) throw new Error('invalid_response');
    const verificationUri = verificationUrl(value.verificationUri, kind);
    if (!verificationUri) throw new Error('invalid_response');
    return { ...base, userCode: value.userCode, verificationUri };
  }
  const authorizationUrl = verificationUrl(value.authorizationUrl, kind);
  if (!authorizationUrl) throw new Error('invalid_response');
  return { ...base, authorizationUrl };
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} input @param {string} sessionId */
export function loginStatus(input, sessionId) {
  const value = record(input);
  if (value.sessionId !== sessionId || typeof value.state !== 'string' || !Object.hasOwn(loginStates, value.state)
    || typeof value.kind !== 'string' || !['device', 'pkce'].includes(value.kind) || !Number.isFinite(value.expiresAt)) throw new Error('invalid_response');
  return value;
}
/** @param {unknown} input */
export function accountSummary(input) {
  const value = record(input);
  if (typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.status !== 'string' || !Object.hasOwn(accountStates, value.status)
    || typeof value.available !== 'boolean') throw new Error('invalid_response');
  const identity = value.identity === undefined ? {} : record(value.identity);
  return { id: value.id, label: value.label, status: value.status, available: value.available,
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : undefined,
    email: typeof identity.email === 'string' ? identity.email : undefined,
    plan: typeof identity.planType === 'string' ? identity.planType : undefined };
}
const errorCodes = new Set(['invalid_input', 'invalid_response', 'not_found', 'expired', 'cancelled', 'busy', 'login_failed',
  'disabled', 'revoked', 'reauth_required', 'identity_mismatch', 'invalid_identity', 'disposed', 'version_conflict']);
/** Extract stable protocol codes, never display a server message or secret-bearing response.
 * @param {unknown} error */
export function errorCode(error) {
  if (!error || typeof error !== 'object') return 'unknown';
  const value = /** @type {{ body?: { error?: string | { code?: string }, code?: string }, code?: string, message?: string }} */ (error);
  const candidate = typeof value.body?.error === 'string' ? value.body.error : value.body?.error?.code ?? value.body?.code ?? value.code ?? value.message;
  return typeof candidate === 'string' && errorCodes.has(candidate) ? candidate : 'unknown';
}
/** Returns a translation key; protocol codes remain unchanged. @param {unknown} error */
export const errorText = error => `errors.${errorCode(error)}`;
