import { afterEach, expect, test } from 'bun:test';
import '../helpers/data-plane-runtime';
import type { AppConfig, ModificationRules } from '@jeffusion/bungee-types';
import { generateWorkerTransportSecret, restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';
import { ANONYMOUS_PRINCIPAL, type DataPrincipal } from '../../src/plugin-extensions';
import { privateRequestHeaders } from '../../src/public-listener/headers';
import { resolveEffectiveRouteEndpoints } from '../../src/utils/endpoint-resolver';
import { proxyRequest } from '../../src/worker/request/proxy';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../../src/worker/types';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

const principals: DataPrincipal[] = [ANONYMOUS_PRINCIPAL, { domain: 'data', keyId: 'key-1', credentialVersion: 1 }];
for (const principal of principals) {
  test.each(['none', 'route', 'service', 'remove', 'replace', 'expression'] as const)(`${principal.domain} admission respects %s authorization header rules`, async (source) => {
    const secret = generateWorkerTransportSecret();
    const incoming = new Request('http://proxy.test/v1/chat', {
      headers: { Authorization: 'Bearer CLIENT_SECRET', 'x-safe': 'preserved' },
    });
    const headers = privateRequestHeaders(incoming, secret, undefined, { requestId: crypto.randomUUID(), principal });
    expect(headers.get('authorization')).toBe('Bearer CLIENT_SECRET');
    const restored = restoreWorkerTransportRequest(new Request('http://127.0.0.1:1234/v1/chat', { headers }), secret);
    if (!restored.ok) throw new Error('private request restoration failed');
    expect(restored.request.headers.get('authorization')).toBe('Bearer CLIENT_SECRET');

    const rules: ModificationRules['headers'] = source === 'remove'
      ? { remove: ['aUtHoRiZaTiOn'] }
      : source === 'replace'
        ? { replace: { aUtHoRiZaTiOn: 'Bearer UPSTREAM_SECRET' } }
        : { add: { aUtHoRiZaTiOn: source === 'expression' ? '{{headers.authorization}}' : 'Bearer UPSTREAM_SECRET' } };
    const config: AppConfig = {
      services: [{ name: 'provider', endpoints: [{ id: 'endpoint-1', target: 'https://upstream.test', ...(source === 'service' ? { headers: rules } : {}) }] }],
      routes: [{ path: '/v1', service: 'provider', ...(source !== 'none' && source !== 'service' ? { headers: rules } : {}) }],
    };
    const route: EffectiveRouteConfig = { ...config.routes[0], endpoints: resolveEffectiveRouteEndpoints(config.routes[0], config.services) };
    const upstream: RuntimeUpstream = {
      ...route.endpoints[0], upstream_id: 'endpoint-1', status: 'HEALTHY',
      consecutive_failures: 0, consecutive_successes: 0, recovery_attempt_count: 0,
    };
    let admitted = false;
    let fetchedHeaders: Headers | undefined;
    global.fetch = (async (_input, init) => {
      expect(admitted).toBe(true);
      fetchedHeaders = new Headers(init?.headers);
      return new Response('ok');
    }) as typeof fetch;
    const restoredHeaders: Record<string, string> = {};
    restored.request.headers.forEach((value, name) => { restoredHeaders[name] = value; });
    const result = await proxyRequest({
      method: 'GET', url: restored.request.url, headers: restoredHeaders,
      body: null, content_type: '', is_json_body: false,
    }, route, upstream, { requestId: 'request-1' }, config, '/v1', undefined, undefined, undefined, undefined, {
      attemptId: 'attempt-1', beforeSend: async () => { admitted = true; },
    });
    try {
      const expected = source === 'remove' ? null
        : source === 'none' || source === 'expression' ? 'Bearer CLIENT_SECRET' : 'Bearer UPSTREAM_SECRET';
      expect(fetchedHeaders?.get('authorization')).toBe(expected);
      expect(fetchedHeaders?.get('x-safe')).toBe('preserved');
      expect(await result.response.text()).toBe('ok');
    } finally {
      await result.cleanup?.();
    }
  });
}
