import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { handleRequest, runtimeState, initializeRuntimeState } from '../src/worker';
import type { AppConfig } from '@jeffusion/bungee-types';

// Mock upstream server
let mockUpstreamPort: number;
let mockUpstreamServer: any;

beforeAll(() => {
  // This ensures the test file is properly initialized
});

afterAll(() => {
  // Cleanup
});

// Create a fresh mock server for each test to avoid port conflicts
beforeEach(() => {
  // Clear global runtime state to avoid pollution between tests
  runtimeState.clear();

  // Restore original Bun fetch (in case other tests mocked it)
  // @ts-ignore - Bun.fetch is the original fetch implementation
  global.fetch = Bun.fetch.bind(Bun);

  mockUpstreamServer = Bun.serve({
    port: 0, // Random available port
    fetch: (req) => {
      // Return headers to verify auth headers were removed
      const receivedHeaders: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        receivedHeaders[key] = value;
      });

      return new Response(
        JSON.stringify({
          message: 'Success',
          receivedHeaders,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    },
  });

  mockUpstreamPort = mockUpstreamServer.port;
});

afterEach(() => {
  if (mockUpstreamServer) {
    mockUpstreamServer.stop();
  }
});

describe('Auth Integration - Global Auth Config', () => {
  test('should authenticate request with global auth config', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token-123'],
      },
      routes: [
        {
          path: '/api',
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer global-token-123' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.message).toBe('Success');
  });

  test('should reject request without auth token (global auth)', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token-123'],
      },
      routes: [
        {
          path: '/api',
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test');

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  test('should reject request with invalid token (global auth)', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token-123'],
      },
      routes: [
        {
          path: '/api',
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(401);
  });

  test('should support direct token format without Bearer prefix', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['direct-token-456'],
      },
      routes: [
        {
          path: '/api',
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'direct-token-456' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);
  });
});

describe('Auth Integration - Route-Level Auth Config', () => {
  test('should use route-level auth config over global config', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token'],
      },
      routes: [
        {
          path: '/admin',
          auth: {
            enabled: true,
            tokens: ['admin-token-only'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    initializeRuntimeState(config);

    // Route-level token should work
    const reqWithRouteToken = new Request('http://localhost:8088/admin/users', {
      headers: { Authorization: 'Bearer admin-token-only' },
    });

    const response1 = await handleRequest(reqWithRouteToken, config);
    expect(response1.status).toBe(200);

    // Global token should NOT work (route config overrides)
    const reqWithGlobalToken = new Request('http://localhost:8088/admin/users', {
      headers: { Authorization: 'Bearer global-token' },
    });

    const response2 = await handleRequest(reqWithGlobalToken, config);
    expect(response2.status).toBe(401);
  });

  test('should disable auth at route level even with global auth enabled', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token'],
      },
      routes: [
        {
          path: '/public',
          auth: { enabled: false, tokens: [] },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    // Request without token should succeed
    const req = new Request('http://localhost:8088/public/data');

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);
  });

  test('should inherit global auth when route has no auth config', async () => {
    const config: AppConfig = {
      auth: {
        enabled: true,
        tokens: ['global-token'],
      },
      routes: [
        {
          path: '/api',
          // No auth config - should inherit global
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    initializeRuntimeState(config);

    // Global token should work
    const reqWithToken = new Request('http://localhost:8088/api/endpoint', {
      headers: { Authorization: 'Bearer global-token' },
    });

    const response1 = await handleRequest(reqWithToken, config);
    expect(response1.status).toBe(200);

    // No token should fail
    const reqWithoutToken = new Request('http://localhost:8088/api/endpoint');

    const response2 = await handleRequest(reqWithoutToken, config);
    expect(response2.status).toBe(401);
  });
});

describe('Auth Integration - Automatic Header Removal', () => {
  test('should automatically remove Authorization header when auth is enabled', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['test-token'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer test-token' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    // Authorization header should NOT be present (automatically removed)
    expect(data.receivedHeaders['authorization']).toBeUndefined();
  });

  test('should preserve Authorization header when auth is disabled', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: false,
            tokens: [],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer some-token' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    // Authorization header SHOULD be present (not removed when auth is disabled)
    expect(data.receivedHeaders['authorization']).toBe('Bearer some-token');
  });

  test('should preserve other headers when auth is enabled', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['test-token'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: {
        Authorization: 'Bearer test-token',
        'X-Custom-Header': 'should-stay',
        'Content-Type': 'application/json',
      },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    // Authorization should be removed
    expect(data.receivedHeaders['authorization']).toBeUndefined();
    // Other headers should be preserved
    expect(data.receivedHeaders['x-custom-header']).toBe('should-stay');
    expect(data.receivedHeaders['content-type']).toBe('application/json');
  });

  test('should not remove Authorization header when no auth is configured', async () => {
    const config: AppConfig = {
      // No global auth
      routes: [
        {
          path: '/api',
          // No route-level auth
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer some-random-token' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    // Authorization header SHOULD be present (no auth configured)
    expect(data.receivedHeaders['authorization']).toBe('Bearer some-random-token');
  });
});

describe('Auth Integration - Multiple Tokens', () => {
  test('should accept any valid token from the list', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['token-1', 'token-2', 'token-3'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    initializeRuntimeState(config);

    // Test each token
    for (const token of ['token-1', 'token-2', 'token-3']) {
      const req = new Request('http://localhost:8088/api/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const response = await handleRequest(req, config);
      expect(response.status).toBe(200);
    }
  });

  test('should reject token not in the list', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['token-1', 'token-2'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer token-3' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(401);
  });

  test('should support mixed Bearer and direct token formats', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['bearer-format-token', 'direct-format-token'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    initializeRuntimeState(config);

    // Test Bearer format
    const reqBearer = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer bearer-format-token' },
    });
    const responseBearer = await handleRequest(reqBearer, config);
    expect(responseBearer.status).toBe(200);

    // Test direct format
    const reqDirect = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'direct-format-token' },
    });
    const responseDirect = await handleRequest(reqDirect, config);
    expect(responseDirect.status).toBe(200);
  });
});

describe('Auth Integration - No Auth Config', () => {
  test('should work without any auth config', async () => {
    const config: AppConfig = {
      // No global auth
      routes: [
        {
          path: '/api',
          // No route-level auth
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test');

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);
  });

  test('should pass through any headers when auth is not configured', async () => {
    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: {
        Authorization: 'Bearer random-token',
        'X-Custom': 'value',
      },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.receivedHeaders['authorization']).toBe('Bearer random-token');
    expect(data.receivedHeaders['x-custom']).toBe('value');
  });
});

describe('Auth Integration - Environment Variables', () => {
  test('should support tokens from environment variables', async () => {
    // Set environment variable
    process.env.TEST_API_TOKEN = 'secret-from-env-var';

    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: ['{{ env.TEST_API_TOKEN }}'],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    const req = new Request('http://localhost:8088/api/test', {
      headers: { Authorization: 'Bearer secret-from-env-var' },
    });

    initializeRuntimeState(config);
    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    // Cleanup
    delete process.env.TEST_API_TOKEN;
  });

  test('should support multiple environment variable tokens', async () => {
    // Set environment variables
    process.env.TENANT_A = 'tenant-a-token';
    process.env.TENANT_B = 'tenant-b-token';
    process.env.TENANT_C = 'tenant-c-token';

    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          auth: {
            enabled: true,
            tokens: [
              '{{ env.TENANT_A }}',
              '{{ env.TENANT_B }}',
              '{{ env.TENANT_C }}',
            ],
          },
          upstreams: [{ target: `http://localhost:${mockUpstreamPort}` }],
        },
      ],
    };

    initializeRuntimeState(config);

    // Test each tenant token
    for (const token of ['tenant-a-token', 'tenant-b-token', 'tenant-c-token']) {
      const req = new Request('http://localhost:8088/api/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const response = await handleRequest(req, config);
      expect(response.status).toBe(200);
    }

    // Cleanup
    delete process.env.TENANT_A;
    delete process.env.TENANT_B;
    delete process.env.TENANT_C;
  });
});
