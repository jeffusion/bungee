import { expect, test } from 'bun:test';
import { accountSummary, loginStatus, loginStates, terminal, verificationUrl, parseLoginStart, errorCode, errorText } from '../../../../plugins/chatgpt-oauth/ui/account-model.js';
import { ApiError } from '../api/client';

test('uses actual session union and never treats committing as success or cancellable terminal', () => {
  expect(Object.keys(loginStates)).toEqual(['pending', 'polling', 'exchanging', 'committing', 'success', 'failed', 'cancelled', 'expired']);
  for (const state of Object.keys(loginStates)) expect(loginStatus({ sessionId: 'id', state, kind: 'device', expiresAt: 1 }, 'id').state).toBe(state);
  expect(terminal('committing')).toBe(false);
  expect(() => loginStatus({ sessionId: 'other', state: 'success', kind: 'device', expiresAt: 1 }, 'id')).toThrow();
  expect(() => loginStatus({ sessionId: 'id', state: 'logged_in', kind: 'device', expiresAt: 1 }, 'id')).toThrow();
});

test('start response is parsed and whitelisted before activation, including trimmed IDs, bounded future expiry and authorization URL', () => {
  const now = 100000;
  const valid = { sessionId: 'session', userCode: 'CODE-123', verificationUri: 'https://auth.openai.com/codex/device', expiresAt: now + 300000 };
  expect(parseLoginStart({ ...valid, secret: 'not-retained' }, 'device', now)).toEqual(valid);
  const pkce = { sessionId: 'pkce', expiresAt: now + 300000, authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=safe' };
  expect(parseLoginStart(pkce, 'pkce', now)).toEqual(pkce);
  for (const override of [{ sessionId: '' }, { sessionId: ' ' }, { sessionId: ' session' }, { sessionId: 'x'.repeat(129) }, { sessionId: 'x\n' },
    { expiresAt: now }, { expiresAt: now - 1 }, { expiresAt: Infinity }, { expiresAt: NaN }, { expiresAt: now + 1800001 },
    { userCode: '' }, { userCode: ' ' }, { userCode: 42 }, { userCode: 'x'.repeat(129) },
    { verificationUri: 'http://auth.openai.com/codex/device' }, { verificationUri: 'https://evil.test' }]) {
    expect(() => parseLoginStart({ ...valid, ...override }, 'device', now)).toThrow('invalid_response');
  }
  expect(() => parseLoginStart({ ...pkce, authorizationUrl: 'javascript:alert(1)' }, 'pkce', now)).toThrow();
  expect(() => parseLoginStart(valid, 'wrong', now)).toThrow();
});

test('control errors use stable body codes rather than human HTTP messages', () => {
  for (const code of ['not_found', 'expired']) {
    const error = new ApiError(404, { error: code }, 'Request failed with status 404');
    expect(errorCode(error)).toBe(code); expect(errorText(error)).toBe(`errors.${code}`);
    expect(errorCode(new ApiError(404, { error: { code } }, 'request failed'))).toBe(code);
  }
  expect(errorText(new Error('secret-callback-code'))).toBe('errors.unknown');
});

test('allows only real authorization URL origins and paths', () => {
  expect(verificationUrl('https://auth.openai.com/codex/device', 'device')).toBe('https://auth.openai.com/codex/device');
  expect(verificationUrl('https://auth.openai.com/oauth/authorize?state=challenge', 'pkce')).not.toBeNull();
  for (const url of ['javascript:alert(1)', 'https://auth.openai.com.evil.test/codex/device', 'https://user:pass@auth.openai.com/codex/device', 'https://auth.openai.com/wrong']) expect(verificationUrl(url, 'device')).toBeNull();
});

test('account summary whitelists safe fields instead of retaining credentials', () => {
  const summary = accountSummary({ id: 'id', label: '<script>not html</script>', status: 'disabled', available: false,
    accessToken: 'secret', refreshToken: 'secret', identity: { email: 'person@example.test', planType: 'plus', userId: 'private' } });
  expect(summary.label).toBe('<script>not html</script>');
  expect(JSON.stringify(summary)).not.toContain('secret'); expect(JSON.stringify(summary)).not.toContain('private');
});

test('callback is immediately cleared and never stored or navigated', async () => {
  const source = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/ui/AccountsPage.svelte', import.meta.url)).text();
  expect(source).toContain("let callbackUrl = callback.trim(); callback = '';");
  expect(source).not.toMatch(/localStorage|sessionStorage|history\.|location\.(?:href|hash)\s*=/);
  expect(source).toContain("control('GET', `/login/status?sessionId=");
  expect(source).not.toContain("control('POST', '/login/device/complete'");
  expect(source).toContain("status === 'committing'");
});
