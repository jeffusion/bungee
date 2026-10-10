import { expect, test } from 'bun:test';
import { loginFailure, requireLoginSuccess } from '../../../ui/login-errors';
import manifest from '../../../manifest.json';

test('only explicit provider success can proceed to context completion', () => {
  expect(() => requireLoginSuccess({ success: true })).not.toThrow();
  for (const result of [null, undefined, true, {}, { success: 'true' }, { success: false }]) {
    expect(() => requireLoginSuccess(result)).toThrow('login_failed');
  }
  expect(() => requireLoginSuccess({ success: false, error: 'invalid_credentials' })).toThrow('invalid_credentials');
});

test('credential errors are plugin-owned and translated in both locales', () => {
  for (const code of ['invalid_credentials', 'invalid_input', 'forbidden', 'unauthorized', 'invalid_origin', 'invalid_csrf', 'login_limited', 'session_limit', 'management_provider_unavailable', 'provider_unavailable', 'control_recovering']) {
    const failure = loginFailure(new Error(code));
    expect(failure).toEqual({ key: `login.errors.${code}`, detail: code });
    for (const messages of Object.values(manifest.translations)) expect(messages[failure.key as keyof typeof messages]).toBeTruthy();
  }
  expect(loginFailure(new Error('unrecognized')).key).toBe('login.errors.unknown');
  const incomplete = new Error('management_login_initialization_failed'); incomplete.name = 'ManagementAuthenticationError';
  expect(loginFailure(incomplete).key).toBe('login.errors.session_unavailable');
});
