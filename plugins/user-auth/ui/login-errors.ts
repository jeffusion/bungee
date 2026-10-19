const loginCodes = new Set([
  'invalid_credentials', 'invalid_input', 'forbidden', 'unauthorized', 'invalid_origin',
  'invalid_csrf', 'login_limited', 'session_limit', 'management_provider_unavailable',
  'provider_unavailable', 'control_recovering', 'turnstile_required', 'turnstile_failed',
  'invalid_provider', 'invalid_microsoft_configuration', 'invalid_microsoft_tenant', 'microsoft_account_scope', 'microsoft_signing_key_issuer', 'invalid_oidc_configuration', 'invalid_oauth_identity', 'oidc_metadata_failed', 'oidc_metadata_invalid', 'oidc_metadata_limit', 'oidc_network_failed', 'oidc_pkce_unsupported', 'oidc_signing_alg_unsupported', 'preset_scopes_fixed', 'verified_identity_required', 'invalid_oidc_url', 'oidc_issuer_mismatch', 'oidc_auth_method_unsupported', 'oidc_secret_required',
  'oauth_client_rejected', 'oauth_callback_mismatch', 'oauth_code_rejected', 'oauth_email_unverified', 'oauth_token_failed',
  'unknown_identity', 'disabled_user', 'invalid_oidc_flow', 'oidc_failed', 'identity_connection_mismatch',
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
