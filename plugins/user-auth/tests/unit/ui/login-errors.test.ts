import { expect, test } from 'bun:test';
import { requireLoginSuccess } from '../../../ui/login-errors';

test('only explicit provider success can proceed to context completion', () => {
  expect(() => requireLoginSuccess({ success: true })).not.toThrow();
  for (const result of [null, undefined, true, {}, { success: 'true' }, { success: false }]) {
    expect(() => requireLoginSuccess(result)).toThrow('login_failed');
  }
  expect(() => requireLoginSuccess({ success: false, error: 'invalid_credentials' })).toThrow('invalid_credentials');
});
