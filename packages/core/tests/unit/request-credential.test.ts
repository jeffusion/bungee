import { describe, expect, test } from 'bun:test';
import {
  assertCredentialTarget,
  applyOutboundHeaderProfile,
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

const profileManifest = {
  contributes: {
    upstreamSources: [{
      id: 'provider',
      credentialPolicy: {
        allowedOrigins: ['https://api.example.test'],
        allowedRequests: [
          {
            pathname: '/v1/chat', methods: ['POST'],
            outboundHeaders: {
              passthrough: ['User-Agent', 'Originator'],
              set: { Accept: 'application/json' },
            },
          },
          { pathname: '/v1/chat', methods: ['GET'], outboundHeaders: { passthrough: [], set: {} } },
        ],
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

  test('selects the outbound profile by pathname and method and builds a closed header set', () => {
    const policy = credentialPolicyFromManifest(profileManifest, 'provider');
    const postRule = assertCredentialTarget(
      new URL('https://api.example.test/v1/chat'),
      new URL('https://api.example.test'),
      policy,
      'POST',
    );
    expect(postRule.outboundHeaders).toEqual({
      passthrough: ['User-Agent', 'Originator'], set: { Accept: 'application/json' },
    });
    const source = new Headers({
      'user-agent': '  client-agent  ', originator: '   ', accept: 'client-accept',
      authorization: 'client-secret', 'x-api-key': 'client-key', 'x-safe': 'drop',
    });
    const outbound = applyOutboundHeaderProfile(source, postRule.outboundHeaders!);
    expect(outbound.get('user-agent')).toBe('client-agent');
    expect(outbound.get('originator')).toBeNull();
    expect(outbound.get('accept')).toBe('application/json');
    expect(outbound.get('authorization')).toBeNull();
    expect(outbound.get('x-api-key')).toBeNull();
    expect(outbound.get('x-safe')).toBeNull();

    const getRule = assertCredentialTarget(
      new URL('https://api.example.test/v1/chat'),
      new URL('https://api.example.test'),
      policy,
      'GET',
    );
    expect(getRule.outboundHeaders).toEqual({ passthrough: [], set: {} });
    expect(() => assertCredentialTarget(
      new URL('https://api.example.test/v1/other'),
      new URL('https://api.example.test'),
      policy,
      'POST',
    )).toThrow();
    expect(() => assertCredentialTarget(
      new URL('https://api.example.test/v1/chat'),
      new URL('https://api.example.test'),
      policy,
      'PUT',
    )).toThrow();
  });

  test('runtime policy validation rejects duplicate rules and unsafe outbound profiles', () => {
    const duplicate = structuredClone(profileManifest) as any;
    duplicate.contributes.upstreamSources[0].credentialPolicy.allowedRequests.push({
      pathname: '/v1/chat', methods: ['post'],
    });
    expect(() => credentialPolicyFromManifest(duplicate, 'provider')).toThrow();

    for (const profile of [
      { passthrough: ['Host'], set: {} },
      { passthrough: ['Accept-Encoding'], set: {} },
      { passthrough: ['Keep-Alive'], set: {} },
      { passthrough: ['Proxy-Authenticate'], set: {} },
      { passthrough: ['TE'], set: {} },
      { passthrough: ['Trailer'], set: {} },
      { passthrough: ['X-Forwarded-For'], set: {} },
      { passthrough: ['User-Agent'], set: { 'user-agent': 'conflict' } },
      { passthrough: [], set: { Accept: 'bad\r\nvalue' } },
      { passthrough: [], set: { Accept: 'x'.repeat(8193) } },
    ]) {
      const invalid = structuredClone(manifest) as any;
      invalid.contributes.upstreamSources[0].credentialPolicy.allowedRequests[0].outboundHeaders = profile;
      expect(() => credentialPolicyFromManifest(invalid, 'provider')).toThrow();
    }
  });

  test('runtime credential validation keeps legal auth headers and rejects unsafe lease headers', () => {
    const legal = structuredClone(manifest) as any;
    legal.contributes.upstreamSources[0].credentialPolicy.allowedHeaderNames = [
      'Authorization', 'Chatgpt-Account-Id',
    ];
    expect(credentialPolicyFromManifest(legal, 'provider').allowedHeaderNames)
      .toEqual(['Authorization', 'Chatgpt-Account-Id']);
    for (const name of [
      'Host', 'Content-Length', 'Accept-Encoding', 'Keep-Alive', 'Proxy-Authenticate',
      'Proxy-Authorization', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade',
      'Cookie', 'Set-Cookie', 'X-Forwarded-For', 'Sec-Fetch-Site',
    ]) {
      expect(() => credentialPolicyFromManifest({
        contributes: { upstreamSources: [{
          id: 'provider',
          credentialPolicy: {
            ...manifest.contributes.upstreamSources[0].credentialPolicy,
            allowedHeaderNames: [name],
          },
        }] },
      }, 'provider')).toThrow();
      expect(() => validateCredentialLease({
        version: 1,
        expiresAt: Date.now() + 10_000,
        headers: { [name]: 'secret' },
      })).toThrow(/credential header/);
    }
  });

  test('rejects an expired lease', () => {
    expect(() => validateCredentialLease({
      version: 1,
      expiresAt: 10,
      headers: { 'x-provider-key': 'TEST_SECRET' },
    }, 11)).toThrow(/expired/);
  });
});
