import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parsePluginManifestText } from '../../../../../packages/core/src/plugin-manifest-catalog/manifest-parser';
import { accountSummary, accountSourceId, canQueryUsage, loginMethods, loginStatus, parseLoginStart, verificationUrl } from '../../../ui/account-model.js';

const base = { id: 'test-account', label: 'Test account', status: 'active', available: true };
const now = 1900000000000;
const authorizationUrl = 'https://auth.openai.com/api/accounts/authorize?state=test-state&nonce=test-nonce';

test('accepts SIWC authorization URL only for SIWC, with strict origin and path', () => {
  expect(verificationUrl(authorizationUrl, 'siwc')).toBe(authorizationUrl);
  expect(verificationUrl(authorizationUrl, 'pkce')).toBeNull();
  expect(verificationUrl('https://auth.openai.com/oauth/authorize?state=test', 'pkce')).toBeTruthy();
  for (const url of ['https://auth.openai.com/oauth/authorize', 'https://auth.openai.com/api/accounts/authorize/extra', 'https://auth.openai.com.evil.test/api/accounts/authorize', 'http://auth.openai.com/api/accounts/authorize', 'https://user@auth.openai.com/api/accounts/authorize', authorizationUrl + '#secret', ' ' + authorizationUrl, authorizationUrl + '\n']) expect(verificationUrl(url, 'siwc')).toBeNull();
  expect(verificationUrl(authorizationUrl, 'unknown')).toBeNull();
  expect(parseLoginStart({ sessionId: 'test-session', expiresAt: now + 10000, authorizationUrl, accessToken: 'never-display' }, 'siwc', now)).toEqual({ sessionId: 'test-session', expiresAt: now + 10000, authorizationUrl });
  expect(() => parseLoginStart({ sessionId: 'test-session', expiresAt: now + 10000, authorizationUrl: 'https://auth.openai.com/oauth/authorize' }, 'siwc', now)).toThrow('invalid_response');
});

test('accepts SIWC login status and enforces the expected session kind', () => {
  const value = { sessionId: 'test-session', state: 'pending', kind: 'siwc', expiresAt: now + 10000 };
  expect(loginStatus(value, 'test-session', 'siwc').kind).toBe('siwc');
  expect(() => loginStatus(value, 'test-session', 'pkce')).toThrow('invalid_response');
  expect(() => loginStatus({ ...value, kind: 'unknown' }, 'test-session')).toThrow('invalid_response');
});

test('preserves old account family, defaults new login to SIWC and locks SIWC reauthentication', () => {
  const legacy = accountSummary(base), siwc = accountSummary({ ...base, authType: 'siwc', autoResetCredits: true });
  expect(legacy.authType).toBe('codex');
  expect(accountSourceId(legacy)).toBe('chatgpt');
  expect(accountSourceId(siwc)).toBe('chatgpt-siwc');
  expect(loginMethods()).toEqual(['siwc', 'device', 'pkce']);
  expect(loginMethods(legacy)).toEqual(['device', 'pkce']);
  expect(loginMethods(siwc)).toEqual(['siwc']);
  expect(siwc.autoResetCredits).toBe(false);
  expect(canQueryUsage(legacy)).toBe(true);
  expect(canQueryUsage(siwc)).toBe(false);
  expect(canQueryUsage({ ...legacy, status: 'disabled' })).toBe(false);
  for (const authType of ['api', null, 0]) expect(() => accountSummary({ ...base, authType })).toThrow('invalid_response');
});

test('declares separate credential policies and unique control endpoints for each source', () => {
  const manifest = parsePluginManifestText(readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf8'));
  const codex = manifest.contributes!.upstreamSources!.find(source => source.id === 'chatgpt')!;
  const siwc = manifest.contributes!.upstreamSources!.find(source => source.id === 'chatgpt-siwc')!;
  expect(codex.credentialPolicy.allowedOrigins).toEqual(['https://chatgpt.com']);
  expect(codex.listAccounts).toBe('listCodexAccounts');
  expect(siwc.credentialPolicy.allowedOrigins).toEqual(['https://api.openai.com']);
  expect(siwc.credentialPolicy.allowedHeaderNames).toEqual(['Authorization']);
  expect(siwc.credentialPolicy.allowedRequests.map(request => [request.pathname, request.methods])).toEqual([['/v1/responses', ['POST']], ['/v1/responses', ['GET']], ['/v1/models', ['GET']]]);
  for (const request of siwc.credentialPolicy.allowedRequests) {
    expect(request.outboundHeaders!.passthrough).toEqual(request.pathname==='/v1/responses' && request.methods.includes('GET') ? ['OpenAI-Beta','Origin'] : []);
    expect(request.outboundHeaders!.set['User-Agent']).toBe('Bungee/5.11.0');
    expect(request.outboundHeaders!.set.Originator).toBe('Bungee');
  }
  for (const source of [codex, siwc]) {
    for (const [action, method] of [['listAccounts', 'GET'], ['createDraft', 'POST']] as const) {
      const endpoints = manifest.contributes!.api!.filter(endpoint => endpoint.handler === source[action] && endpoint.execution === 'control' && endpoint.methods.includes(method));
      expect(endpoints).toHaveLength(1);
    }
  }
  expect(manifest.contributes!.api!).toContainEqual({ path: '/login/siwc', methods: ['POST'], capability: 'config.write', handler: 'startSiwcLogin', execution: 'control' });
});
