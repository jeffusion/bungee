const loginCodes = new Set([
  'invalid_credentials', 'invalid_input', 'forbidden', 'unauthorized', 'invalid_origin',
  'invalid_csrf', 'login_limited', 'session_limit', 'management_provider_unavailable',
  'provider_unavailable', 'control_recovering',
]);

/** Only the local account provider interprets its credential result. */
export function requireLoginSuccess(result: unknown): void {
  if (typeof result === 'object' && result !== null && 'success' in result && result.success === true) return;
  const code = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
    ? result.error : 'login_failed';
  throw new Error(code);
}

export function loginFailure(error: unknown): { key: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && error.name === 'ManagementAuthenticationError'
    ? 'session_unavailable' : loginCodes.has(detail) ? detail : 'unknown';
  return { key: `login.errors.${code}`, detail };
}
