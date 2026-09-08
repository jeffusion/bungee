import { describe, expect, test } from 'bun:test';
import {
  assertCredentialTarget,
  credentialPolicyFromManifest,
  stripCredentialHeaders,
  validateCredentialLease,
} from '../../src/worker/request/credential';

const manifest = {
  contributes: {
    upstreamSources: [{
      id: 'provider',
      credentialPolicy: {
        allowedOrigins: ['https://api.example.test'],
        allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'] }],
        allowedHeaderNames: ['authorization', 'x-api-key'],
      },
    }],
  },
};

describe('request credential boundary', () => {
  test('requires the verified contribution policy and never falls back', () => {
    expect(credentialPolicyFromManifest(manifest, 'provider').allowedHeaderNames).toEqual(['authorization', 'x-api-key']);
    expect(() => credentialPolicyFromManifest({}, 'provider')).toThrow();
    expect(() => credentialPolicyFromManifest({ contributes: { upstreamSources: [{ id: 'provider' }] } }, 'provider')).toThrow();
  });

  test('scrubs client credentials and rejects a changed target', () => {
    const policy = credentialPolicyFromManifest(manifest, 'provider');
    const headers = new Headers({
      authorization: 'TEST_SECRET',
      cookie: 'session=TEST_SECRET',
      'x-api-key': 'client-secret',
      'x-request-id': 'safe',
    });
    stripCredentialHeaders(headers, policy);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('x-request-id')).toBe('safe');
    expect(() => assertCredentialTarget(
      new URL('https://api.example.test/v1/other'),
      new URL('https://api.example.test/v1/chat'),
      policy,
      'POST',
      '/v1/chat',
    )).toThrow();
  });

  test('rejects an expired lease', () => {
    expect(() => validateCredentialLease({
      version: 1,
      expiresAt: 10,
      headers: { 'x-provider-key': 'TEST_SECRET' },
    }, 11)).toThrow(/expired/);
  });
});
