import { expect, test } from 'bun:test';
import { accountSummary, loginStatus, loginStates, terminal, verificationUrl } from '../../../../plugins/chatgpt-oauth/ui/account-model.js';

test('uses actual session union and never treats committing as success or cancellable terminal', () => {
  expect(Object.keys(loginStates)).toEqual(['pending', 'polling', 'exchanging', 'committing', 'success', 'failed', 'cancelled', 'expired']);
  for (const state of Object.keys(loginStates)) expect(loginStatus({ sessionId: 'id', state, kind: 'device', expiresAt: 1 }, 'id').state).toBe(state);
  expect(terminal('committing')).toBe(false);
  expect(() => loginStatus({ sessionId: 'other', state: 'success', kind: 'device', expiresAt: 1 }, 'id')).toThrow();
  expect(() => loginStatus({ sessionId: 'id', state: 'logged_in', kind: 'device', expiresAt: 1 }, 'id')).toThrow();
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
  const source = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/ui/accounts.js', import.meta.url)).text();
  expect(source).toContain("let callbackUrl = $('callback-url').value.trim(); $('callback-url').value = '';");
  expect(source).not.toMatch(/localStorage|sessionStorage|history\.|location\.(?:href|hash)\s*=/);
  expect(source).toContain("control('GET', `/login/status?sessionId=");
  expect(source).not.toContain("control('POST', '/login/device/complete'");
  expect(source).toContain("state === 'committing'");
});
