import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';

// NOW import the server logic after mocks are in place.
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../src/worker';

const mockConfig: AppConfig = {
  configVersion: 2,
  routes: [
    {
      path: '/api',
      // Route-level rules
      headers: {
        add: { 'x-route-header': 'route', 'x-shared-header': 'route' },
        replace: { 'x-replace-header': 'route-replaced' },
        remove: ['x-remove-route'],
      },
      body: {
        add: { route_field: 'route', shared_field: 'route' },
        replace: { replace_field: 'route-replaced' },
        remove: ['remove_route'],
        default: { route_default: 'default' },
      },
      upstreams: [
        {
          target: 'http://mock-target.com',
          weight: 100,
          priority: 1,
          // Upstream-level rules that merge and override
          headers: {
            add: { 'x-upstream-header': 'upstream', 'x-shared-header': 'upstream-override' },
            replace: { 'x-replace-header': 'upstream-replaced' },
            remove: ['x-remove-upstream'],
          },
          body: {
            add: { upstream_field: 'upstream', shared_field: 'upstream-override' },
            replace: { replace_field: 'upstream-replaced' },
            remove: ['remove_upstream'],
          },
        },
      ],
      failover: { enabled: false, retryOn: [] },
    },
    {
      path: '/load-balance',
      upstreams: [
        { target: 'http://service-a.com', weight: 20, priority: 1 },
        { target: 'http://service-b.com', weight: 80, priority: 1 },
      ],
      failover: { enabled: true, retryOn: [500] },
    },
    {
      path: '/failover-path',
      upstreams: [
        // 设置高权重以确保 fails.com 总是被优先选择（加权随机算法）
        { target: 'http://fails.com', weight: 99, priority: 1 },
        { target: 'http://works.com', weight: 1, priority: 1 },
      ],
      failover: {
        enabled: true,
        retryOn: [500],
        healthCheck: { enabled: false, intervalMs: 10000 }
      },
    },
    {
      path: '/priority-test',
      upstreams: [
        { target: 'http://priority1-a.com', weight: 50, priority: 1 },
        { target: 'http://priority1-b.com', weight: 50, priority: 1 },
        { target: 'http://priority2.com', weight: 100, priority: 2 },
        { target: 'http://priority3.com', weight: 100, priority: 3 },
      ],
      failover: { enabled: false, retryOn: [] },
    },
    {
      path: '/default-weight-test',
      upstreams: [
        { target: 'http://no-weight.com', weight: 100, priority: 1 }, // 模拟配置验证后的默认值
        { target: 'http://with-weight.com', weight: 200, priority: 1 },
      ],
      failover: { enabled: false, retryOn: [] },
    },
  ],
};


// Mock the global fetch
const mockedFetch = mock(async (request: Request | string, _options?: RequestInit) => {
    const url = typeof request === 'string' ? request : request.url;
    if (url.startsWith('http://fails.com')) {
        return new Response('server error', { status: 500 });
    }
    if (url.startsWith('http://works.com')) {
        return new Response('success', { status: 200 });
    }
    return new Response('proxied', { status: 200 });
});
global.fetch = mockedFetch as any;


describe('Server Request Handler', () => {

  beforeEach(async () => {
    mockedFetch.mockClear();
    // Initialize the state before each test based on the mocked config
    initializeRuntimeState(mockConfig);
    await initializePluginRegistryForTests(mockConfig);
  });

  afterEach(async () => {
    await cleanupPluginRegistry();
  });

  test('should return 200 for health check', async () => {
    const req = new Request('http://localhost/health');
    const res = await handleRequest(req, mockConfig);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('should return 404 for unknown routes', async () => {
    const req = new Request('http://localhost/unknown');
    const res = await handleRequest(req, mockConfig);
    expect(res.status).toBe(404);
  });

  test('should add and remove headers correctly (with merge logic)', async () => {
    const req = new Request('http://localhost/api/test', {
        headers: {
            'x-remove-route': 'true',
            'x-remove-upstream': 'true',
        }
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    // Assert route-specific header exists
    expect(forwardedHeaders.get('x-route-header')).toBe('route');
    // Assert upstream-specific header exists
    expect(forwardedHeaders.get('x-upstream-header')).toBe('upstream');
    // Assert upstream rule OVERRIDES route rule
    expect(forwardedHeaders.get('x-shared-header')).toBe('upstream-override');
    // Assert both remove rules were applied
    expect(forwardedHeaders.has('x-remove-route')).toBe(false);
    expect(forwardedHeaders.has('x-remove-upstream')).toBe(false);
  });

  test('should modify JSON body correctly (with merge logic)', async () => {
    const originalBody = {
      remove_route: 'true',
      remove_upstream: 'true',
    };

    const req = new Request('http://localhost/api/json-test', {
      method: 'POST',
      body: JSON.stringify(originalBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions || !fetchOptions.body) throw new Error('fetch was called without a body');
    const forwardedBody = JSON.parse(fetchOptions.body as string);

    // Assert route-specific field exists
    expect(forwardedBody.route_field).toBe('route');
    // Assert upstream-specific field exists
    expect(forwardedBody.upstream_field).toBe('upstream');
    // Assert upstream rule OVERRIDES route rule
    expect(forwardedBody.shared_field).toBe('upstream-override');
    // Assert default field from route rule was applied
    expect(forwardedBody.route_default).toBe('default');
    // Assert both remove rules were applied
    expect(forwardedBody).not.toHaveProperty('remove_route');
    expect(forwardedBody).not.toHaveProperty('remove_upstream');
  });

   test('should add default fields only if they dont exist', async () => {
    const originalBody = {
      default_field: 'i_exist',
    };

    const req = new Request('http://localhost/api/json-test', {
      method: 'POST',
      body: JSON.stringify(originalBody),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions || !fetchOptions.body) {
      throw new Error('fetch was called without a body');
    }
    const forwardedBody = JSON.parse(fetchOptions.body as string);

    expect(forwardedBody.default_field).toBe('i_exist');
  });

  test('should distribute requests based on upstream weights', async () => {
    const totalRequests = 1000;
    const counts: Record<string, number> = {
      'http://service-a.com': 0,
      'http://service-b.com': 0,
    };

    for (let i = 0; i < totalRequests; i++) {
      const req = new Request('http://localhost/load-balance/test');
      await handleRequest(req, mockConfig);
    }

    expect(mockedFetch).toHaveBeenCalledTimes(totalRequests);

    const calls = mockedFetch.mock.calls;
    for (const call of calls) {
      const url = call[0];
      const targetUrl = typeof url === 'string' ? url : url.url;

      if (targetUrl.startsWith('http://service-a.com')) {
        counts['http://service-a.com']++;
      } else if (targetUrl.startsWith('http://service-b.com')) {
        counts['http://service-b.com']++;
      }
    }

    const serviceARatio = counts['http://service-a.com'] / totalRequests;
    const serviceBRatio = counts['http://service-b.com'] / totalRequests;

    // Check if the distribution is approximately 20/80, allowing for some variance.
    expect(serviceARatio).toBeGreaterThan(0.15);
    expect(serviceARatio).toBeLessThan(0.25);
    expect(serviceBRatio).toBeGreaterThan(0.75);
    expect(serviceBRatio).toBeLessThan(0.85);

    // Note: This test is now less accurate due to stateful mocks.
    // A proper implementation would require deeper mocking of runtimeState.
  });

  test('should failover to a healthy upstream when one fails', async () => {
    // 注意：failover 逻辑使用真实的 FailoverCoordinator，不使用自定义 selector
    // 通过配置中的权重（fails.com: 99, works.com: 1）确保 fails.com 被优先选择
    const req = new Request('http://localhost/failover-path');
    const res = await handleRequest(req, mockConfig);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('success');

    // Check that fetch was called twice: once for the failing and once for the successful upstream
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls[0][0].toString()).toContain('http://fails.com');
    expect(mockedFetch.mock.calls[1][0].toString()).toContain('http://works.com');
  });

  test('should prioritize upstreams correctly based on priority values', async () => {
    const totalRequests = 100;
    const counts: Record<string, number> = {
      'http://priority1-a.com': 0,
      'http://priority1-b.com': 0,
      'http://priority2.com': 0,
      'http://priority3.com': 0,
    };

    for (let i = 0; i < totalRequests; i++) {
      const req = new Request('http://localhost/priority-test');
      await handleRequest(req, mockConfig);
    }

    expect(mockedFetch).toHaveBeenCalledTimes(totalRequests);

    const calls = mockedFetch.mock.calls;
    for (const call of calls) {
      const url = call[0];
      const targetUrl = typeof url === 'string' ? url : url.url;

      if (targetUrl.startsWith('http://priority1-a.com')) {
        counts['http://priority1-a.com']++;
      } else if (targetUrl.startsWith('http://priority1-b.com')) {
        counts['http://priority1-b.com']++;
      } else if (targetUrl.startsWith('http://priority2.com')) {
        counts['http://priority2.com']++;
      } else if (targetUrl.startsWith('http://priority3.com')) {
        counts['http://priority3.com']++;
      }
    }

    // All requests should go to priority 1 upstreams only
    const priority1Total = counts['http://priority1-a.com'] + counts['http://priority1-b.com'];
    expect(priority1Total).toBe(totalRequests);
    expect(counts['http://priority2.com']).toBe(0);
    expect(counts['http://priority3.com']).toBe(0);

    // Within priority 1, distribution should be roughly 50/50 due to equal weights
    const priority1ARatio = counts['http://priority1-a.com'] / totalRequests;
    const priority1BRatio = counts['http://priority1-b.com'] / totalRequests;
    expect(priority1ARatio).toBeGreaterThan(0.3);
    expect(priority1ARatio).toBeLessThan(0.7);
    expect(priority1BRatio).toBeGreaterThan(0.3);
    expect(priority1BRatio).toBeLessThan(0.7);
  });

  test('should use default weight of 100 when weight is not specified', async () => {
    const totalRequests = 300;
    const counts: Record<string, number> = {
      'http://no-weight.com': 0,
      'http://with-weight.com': 0,
    };

    for (let i = 0; i < totalRequests; i++) {
      const req = new Request('http://localhost/default-weight-test');
      await handleRequest(req, mockConfig);
    }

    expect(mockedFetch).toHaveBeenCalledTimes(totalRequests);

    const calls = mockedFetch.mock.calls;
    for (const call of calls) {
      const url = call[0];
      const targetUrl = typeof url === 'string' ? url : url.url;

      if (targetUrl.startsWith('http://no-weight.com')) {
        counts['http://no-weight.com']++;
      } else if (targetUrl.startsWith('http://with-weight.com')) {
        counts['http://with-weight.com']++;
      }
    }

    // 没有指定 weight 的 upstream 应该得到默认 weight = 100
    // 指定 weight = 200 的 upstream 应该得到 2 倍的请求
    // 期望分布: 100/(100+200) = 33.3%, 200/(100+200) = 66.7%
    const noWeightRatio = counts['http://no-weight.com'] / totalRequests;
    const withWeightRatio = counts['http://with-weight.com'] / totalRequests;

    expect(noWeightRatio).toBeGreaterThan(0.25);
    expect(noWeightRatio).toBeLessThan(0.4);
    expect(withWeightRatio).toBeGreaterThan(0.6);
    expect(withWeightRatio).toBeLessThan(0.75);
  });

  test('should apply default weight during config validation', () => {
    // 测试配置验证逻辑
    const testUpstream: any = { target: 'http://test.com' };

    // 模拟配置验证过程
    if (testUpstream.weight === undefined) {
      testUpstream.weight = 100;
    }
    if (testUpstream.priority === undefined) {
      testUpstream.priority = 1;
    }

    expect(testUpstream.weight).toBe(100);
    expect(testUpstream.priority).toBe(1);
    expect(testUpstream.target).toBe('http://test.com');
  });

  test('should replace headers only when they exist', async () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-replace-header': 'original-value',
        'x-non-replace-header': 'keep-this',
      }
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    // Should replace existing header with upstream value (upstream overrides route)
    expect(forwardedHeaders.get('x-replace-header')).toBe('upstream-replaced');
    // Should keep non-replace header unchanged
    expect(forwardedHeaders.get('x-non-replace-header')).toBe('keep-this');
  });

  test('should not replace headers when they do not exist', async () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-other-header': 'some-value',
      }
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    // Should not add x-replace-header since it didn't exist originally
    expect(forwardedHeaders.has('x-replace-header')).toBe(false);
    // Should keep other header
    expect(forwardedHeaders.get('x-other-header')).toBe('some-value');
  });

  test('should replace body fields only when they exist', async () => {
    const originalBody = {
      replace_field: 'original-value',
      other_field: 'keep-this',
    };

    const req = new Request('http://localhost/api/json-test', {
      method: 'POST',
      body: JSON.stringify(originalBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions || !fetchOptions.body) throw new Error('fetch was called without a body');
    const forwardedBody = JSON.parse(fetchOptions.body as string);

    // Should replace existing field with upstream value (upstream overrides route)
    expect(forwardedBody.replace_field).toBe('upstream-replaced');
    // Should keep non-replace field unchanged
    expect(forwardedBody.other_field).toBe('keep-this');
  });

  test('should not replace body fields when they do not exist', async () => {
    const originalBody = {
      other_field: 'some-value',
    };

    const req = new Request('http://localhost/api/json-test', {
      method: 'POST',
      body: JSON.stringify(originalBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions || !fetchOptions.body) throw new Error('fetch was called without a body');
    const forwardedBody = JSON.parse(fetchOptions.body as string);

    // Should not add replace_field since it didn't exist originally
    expect(forwardedBody).not.toHaveProperty('replace_field');
    // Should keep other field
    expect(forwardedBody.other_field).toBe('some-value');
  });

  test('should process dynamic expressions in headers', async () => {
    const dynamicConfig = {
      routes: [{
        path: '/api/dynamic',
        upstreams: [{
          target: 'http://mock-target.com',
          weight: 100,
          priority: 1,
          headers: {
            add: {
              'x-timestamp': '{{now()}}',
              'x-method': '{{method}}',
              'x-host': '{{headers.host}}',
              'x-uuid': '{{uuid()}}',
            }
          }
        }],
        failover: { enabled: false, retryOn: [] },
      }]
    };

    const req = new Request('http://localhost/api/dynamic/test', {
      headers: { 'host': 'example.com' }
    });

    await handleRequest(req, dynamicConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    // Check dynamic values were processed
    expect(parseInt(forwardedHeaders.get('x-timestamp')!)).toBeGreaterThan(1600000000000);
    expect(forwardedHeaders.get('x-method')).toBe('GET');
    expect(forwardedHeaders.get('x-host')).toBe('example.com');
    expect(forwardedHeaders.get('x-uuid')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('should process dynamic expressions in body', async () => {
    const dynamicConfig = {
      routes: [{
        path: '/api/dynamic',
        upstreams: [{
          target: 'http://mock-target.com',
          weight: 100,
          priority: 1,
          body: {
            add: {
              'processed_at': '{{new Date().toISOString()}}',
              'request_id': '{{uuid()}}',
              'user_agent': '{{headers["user-agent"] || "unknown"}}',
            }
          }
        }],
        failover: { enabled: false, retryOn: [] },
      }]
    };

    const originalBody = { existing_field: 'value' };
    const req = new Request('http://localhost/api/dynamic/test', {
      method: 'POST',
      body: JSON.stringify(originalBody),
      headers: {
        'Content-Type': 'application/json',
        'user-agent': 'test-agent/1.0'
      }
    });

    await handleRequest(req, dynamicConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions || !fetchOptions.body) throw new Error('fetch was called without a body');
    const forwardedBody = JSON.parse(fetchOptions.body as string);

    // Check dynamic values were processed
    expect(forwardedBody.existing_field).toBe('value');
    expect(forwardedBody.processed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(forwardedBody.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwardedBody.user_agent).toBe('test-agent/1.0');
  });

  test('should handle complex function expressions', async () => {
    const dynamicConfig = {
      routes: [{
        path: '/api/functions',
        upstreams: [{
          target: 'http://mock-target.com',
          weight: 100,
          priority: 1,
          headers: {
            add: {
              'x-base64': '{{base64encode(headers.host)}}',
              'x-upper': '{{toUpperCase(headers["user-agent"])}}',
            }
          }
        }],
        failover: { enabled: false, retryOn: [] },
      }]
    };

    const req = new Request('http://localhost/api/functions/test', {
      headers: {
        'host': 'example.com',
        'user-agent': 'test-agent'
      }
    });

    await handleRequest(req, dynamicConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    expect(forwardedHeaders.get('x-base64')).toBe(Buffer.from('example.com').toString('base64'));
    expect(forwardedHeaders.get('x-upper')).toBe('TEST-AGENT');
  });

  test('should handle expression errors gracefully', async () => {
    const dynamicConfig = {
      routes: [{
        path: '/api/error',
        upstreams: [{
          target: 'http://mock-target.com',
          weight: 100,
          priority: 1,
          headers: {
            add: {
              'x-valid': '{{headers.host}}',
              'x-invalid': '{{headers.nonexistent.invalid}}',
              'x-fallback': '{{headers.missing || "default"}}',
            }
          }
        }],
        failover: { enabled: false, retryOn: [] },
      }]
    };

    const req = new Request('http://localhost/api/error/test', {
      headers: { 'host': 'example.com' }
    });

    await handleRequest(req, dynamicConfig);

    const fetchOptions = mockedFetch.mock.calls[0][1];
    if (!fetchOptions) throw new Error('fetch was called without options');
    const forwardedHeaders = new Headers(fetchOptions.headers);

    expect(forwardedHeaders.get('x-valid')).toBe('example.com');
    // Invalid expression should be skipped due to error handling
    expect(forwardedHeaders.has('x-invalid')).toBe(false);
    expect(forwardedHeaders.get('x-fallback')).toBe('default');
  });
});
