import { describe, expect, test } from 'bun:test';
import { parseNormalizeCompile } from '../../src/config-storage';

const IDs = {
  service: '10000000-0000-4000-8000-000000000020',
  route: '20000000-0000-4000-8000-000000000020',
  upstream: '30000000-0000-4000-8000-000000000020',
} as const;

function completeConfig(): Record<string, unknown> {
  return {
    log_level: 'info',
    body_parser_limit: '2mb',
    auth: { enabled: true, tokens: ['token'] },
    logging: { body: { enabled: true, max_size: 1024, retention_days: 7 } },
    services: [{
      id: IDs.service,
      name: 'primary',
      timeouts: { connect_ms: 100, send_ms: 200, read_ms: 300 },
      health_check: {
        enabled: true,
        interval_ms: 1000,
        timeout_ms: 500,
        path: '/health',
        method: 'GET',
        expected_status: [200, 204],
        unhealthy_threshold: 2,
        healthy_threshold: 1,
        body: 'ok',
        content_type: 'text/plain',
        headers: { accept: 'text/plain' },
        query: { deep: 'true' },
        auto_enable_on_active_health_check: true,
      },
      failover: {
        enabled: true,
        retry_on: [429, '5xx'],
        retry_on_response: ['overloaded'],
        passive_health: { consecutive_failures: 2, healthy_successes: 1, auto_disable_threshold: 3 },
        recovery: { backoff_base_ms: 100, probe_timeout_ms: 50 },
        slow_start: { enabled: true, duration_ms: 1000, initial_weight_factor: 0.5 },
      },
      load_balancing: {
        policy: 'consistent_hash',
        hash_policy: { header: 'x-session', expression: "{{ headers['x-session'] }}" },
      },
      endpoints: [{
        id: IDs.upstream,
        target: 'https://example.com',
        weight: 100,
        priority: 1,
        is_disabled: false,
        description: 'primary endpoint',
        condition: '{{ body?.model ?? true }}',
        headers: { add: { authorization: 'token' }, replace: { accept: 'application/json' }, remove: ['x-old'] },
        body: { add: { temperature: 1 }, replace: { model: 'new' }, remove: ['old'], default: { stream: false } },
        query: { add: { key: 'value' }, replace: { old: 'new' }, remove: ['drop'], default: { page: '1' } },
      }],
    }],
    routes: [{
      id: IDs.route,
      path: '/v1',
      service_id: IDs.service,
      path_rewrite: { '^/v1': '/v2' },
      auth: { enabled: false, tokens: [] },
      timeouts: { request_ms: 1000 },
      rate_limit: { enabled: true, requests_per_second: 10, burst: 20, key_expression: '{{ headers?.["x-id"] ?? method }}' },
      cors: {
        enabled: true,
        allowed_origins: ['https://example.com'],
        allowed_methods: ['POST'],
        allowed_headers: ['authorization'],
        expose_headers: ['x-request-id'],
        allow_credentials: true,
        max_age: 60,
      },
      response_rules: [
        { enabled: true, path: '^/cached', match_type: 'regex', type: 'direct_response', status: 200, body: 'ok', content_type: 'text/plain', headers: { x: 'y' } },
        { enabled: true, path: '/old', match_type: 'prefix', type: 'redirect', url: 'https://example.com/new', preserve_path: true },
      ],
      direct_response: { enabled: false, status: 200, body: 'ok', content_type: 'text/plain', headers: { x: 'y' } },
      redirect: { enabled: false, url: 'https://example.com', status: 302, preserve_path: true },
      retry: { enabled: true, max_retries: 2, retry_on: [429, 500], per_retry_timeout_ms: 100 },
    }],
  };
}

function errorPaths(input: unknown): string[] {
  const result = parseNormalizeCompile(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ path }) => path);
}

describe('configuration v2 domain policy validation', () => {
  test('compiles a configuration containing every retained policy shape', () => {
    const result = parseNormalizeCompile(completeConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.services[0]?.health_check?.expected_status).toEqual([200, 204]);
    expect(result.value.routes[0]?.response_rules?.map(({ type }) => type)).toEqual(['direct_response', 'redirect']);
  });

  test('rejects malformed global, logging, modification, and endpoint fields', () => {
    const config = completeConfig();
    Object.assign(config, {
      log_level: 3,
      body_parser_limit: false,
      logging: { body: { enabled: 'yes', max_size: 0, retention_days: -1, extra: true } },
    });
    const service = (config.services as Array<Record<string, unknown>>)[0]!;
    const endpoint = (service.endpoints as Array<Record<string, unknown>>)[0]!;
    Object.assign(endpoint, {
      description: 42,
      is_disabled: 'no',
      headers: { add: { bad: 1 }, replace: [], remove: ['ok', 2], extra: true },
      body: { remove: 'bad' },
      query: { default: { page: 1 } },
    });

    expect(errorPaths(config)).toEqual([
      'log_level', 'body_parser_limit', 'logging.body.extra', 'logging.body.enabled',
      'logging.body.max_size', 'logging.body.retention_days',
      'services[0].endpoints[0].description',
      'services[0].endpoints[0].headers.extra', 'services[0].endpoints[0].headers.add.bad',
      'services[0].endpoints[0].headers.replace', 'services[0].endpoints[0].headers.remove[1]',
      'services[0].endpoints[0].body.remove', 'services[0].endpoints[0].query.default.page',
      'services[0].endpoints[0].is_disabled',
    ]);
  });

  test('rejects malformed service timeout, health, failover, and load balancing fields', () => {
    const config = completeConfig();
    const service = (config.services as Array<Record<string, unknown>>)[0]!;
    Object.assign(service, {
      timeouts: { connect_ms: 'fast', extra: true },
      health_check: {
        enabled: true, path: 1, method: false, expected_status: [200, 'ok'], body: 1,
        content_type: 2, headers: { ok: 1 }, query: [], auto_enable_on_active_health_check: 'yes',
      },
      failover: {
        enabled: true, retry_on: { bad: true }, retry_on_response: ['ok', 1],
        passive_health: { consecutive_failures: 'two', extra: true },
        recovery: { probe_timeout_ms: 'fast', extra: true },
        slow_start: { enabled: 'yes', duration_ms: 0, initial_weight_factor: 2, extra: true },
      },
      load_balancing: { policy: 'consistent_hash', hash_policy: { header: 1, expression: 2, extra: true } },
    });

    expect(errorPaths(config)).toEqual([
      'services[0].timeouts.extra', 'services[0].timeouts.connect_ms',
      'services[0].health_check.path', 'services[0].health_check.method',
      'services[0].health_check.body', 'services[0].health_check.content_type',
      'services[0].health_check.expected_status[1]', 'services[0].health_check.headers.ok',
      'services[0].health_check.query', 'services[0].health_check.auto_enable_on_active_health_check',
      'services[0].failover.retry_on', 'services[0].failover.retry_on_response[1]',
      'services[0].failover.passive_health.extra', 'services[0].failover.passive_health.consecutive_failures',
      'services[0].failover.recovery.extra', 'services[0].failover.recovery.probe_timeout_ms',
      'services[0].failover.slow_start.extra', 'services[0].failover.slow_start.enabled',
      'services[0].failover.slow_start.duration_ms', 'services[0].failover.slow_start.initial_weight_factor',
      'services[0].load_balancing.hash_policy.extra', 'services[0].load_balancing.hash_policy.header',
      'services[0].load_balancing.hash_policy.expression',
    ]);
  });

  test('rejects malformed route policy structures and discriminated response requirements', () => {
    const config = completeConfig();
    const route = (config.routes as Array<Record<string, unknown>>)[0]!;
    Object.assign(route, {
      path_rewrite: { '[': 1 },
      timeouts: { request_ms: 'slow', extra: true },
      rate_limit: { enabled: 'yes', requests_per_second: 0, burst: 'many', key_expression: 1, extra: true },
      cors: { enabled: true, allowed_origins: ['ok', 1], allowed_methods: 'POST', allow_credentials: 1, max_age: -1, extra: true },
      response_rules: [
        { enabled: true, path: '[', match_type: 'regex', type: 'direct_response', status: 'ok', url: 'forbidden', extra: true },
        { enabled: true, path: '/old', type: 'redirect', status: '302' },
        'bad',
      ],
      direct_response: { enabled: 'yes', status: 99, headers: { x: 1 } },
      redirect: { enabled: true, url: '', status: 303, preserve_path: 'yes', extra: true },
      retry: { enabled: 'yes', max_retries: -1, retry_on: [500, 'bad'], per_retry_timeout_ms: 0, extra: true },
    });

    expect(errorPaths(config)).toEqual([
      'routes[0].path_rewrite.[', 'routes[0].path_rewrite.[',
      'routes[0].timeouts.extra', 'routes[0].timeouts.request_ms',
      'routes[0].rate_limit.extra', 'routes[0].rate_limit.enabled',
      'routes[0].rate_limit.requests_per_second', 'routes[0].rate_limit.burst',
      'routes[0].rate_limit.key_expression', 'routes[0].cors.extra',
      'routes[0].cors.allowed_origins[1]', 'routes[0].cors.allowed_methods',
      'routes[0].cors.allow_credentials', 'routes[0].cors.max_age',
      'routes[0].response_rules[0].extra', 'routes[0].response_rules[0].path',
      'routes[0].response_rules[0].status', 'routes[0].response_rules[0].url',
      'routes[0].response_rules[1].url', 'routes[0].response_rules[1].status',
      'routes[0].response_rules[2]', 'routes[0].direct_response.enabled',
      'routes[0].direct_response.status', 'routes[0].direct_response.headers.x',
      'routes[0].redirect.extra', 'routes[0].redirect.url', 'routes[0].redirect.status',
      'routes[0].redirect.preserve_path', 'routes[0].retry.extra',
      'routes[0].retry.enabled', 'routes[0].retry.max_retries',
      'routes[0].retry.retry_on[1]', 'routes[0].retry.per_retry_timeout_ms',
    ]);
  });
});
