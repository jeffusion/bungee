import {describe, expect, test} from 'bun:test';
import {attestManagementRequestSource, managementRequestSource, parseTrustedManagementProxies} from '../../src/management-listener/request-source';

const request = (forwarded = '203.0.113.7') => new Request('http://localhost/api/auth/login', {
  headers: {'x-forwarded-for': forwarded, 'x-real-ip': '203.0.113.8', 'forwarded': 'for=203.0.113.9'},
});
describe('management connection source attestation', () => {
  test('headers never attest a source; only the actual request retains peer evidence', () => {
    const original = request();
    expect(managementRequestSource(original)).toBe('unknown');
    attestManagementRequestSource(original, undefined);
    expect(managementRequestSource(original)).toBe('unknown');
    attestManagementRequestSource(original, '::ffff:192.0.2.4');
    expect(managementRequestSource(original)).toBe('192.0.2.4');
    expect(managementRequestSource(original.clone())).toBe('unknown');
    expect(managementRequestSource(request())).toBe('unknown');
  });
  test('only an explicitly trusted peer may forward one valid client IP', () => {
    const trusted = parseTrustedManagementProxies('::ffff:192.0.2.4, 2001:db8::4');
    expect(Object.isFrozen(trusted)).toBe(true);
    const untrusted = request(); attestManagementRequestSource(untrusted, '192.0.2.5', trusted);
    expect(managementRequestSource(untrusted)).toBe('192.0.2.5');
    const proxied = request(); attestManagementRequestSource(proxied, '192.0.2.4', trusted);
    expect(managementRequestSource(proxied)).toBe('203.0.113.7');
    const ipv6 = request('2001:db8::7'); attestManagementRequestSource(ipv6, '2001:db8::4', trusted);
    expect(managementRequestSource(ipv6)).toBe('2001:db8::7');
  });
  test.each(['203.0.113.7, 198.51.100.8', 'unknown', '203.0.113.7:80', 'client.example', ''])('trusted proxy rejects invalid/chain forwarded value %s', forwarded => {
    const req = request(forwarded);
    attestManagementRequestSource(req, '192.0.2.4', ['192.0.2.4']);
    expect(managementRequestSource(req)).toBe('192.0.2.4');
  });
  test.each(['*', '127.0.0.0/8', 'localhost', '192.0.2.4,', '192.0.2.4:80'])('rejects malformed proxy configuration %s', value => {
    expect(() => parseTrustedManagementProxies(value)).toThrow('Invalid trusted proxy IP address');
  });
});
