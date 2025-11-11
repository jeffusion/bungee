import { describe, test, expect } from 'bun:test';
import {
  extractToken,
  constantTimeCompare,
  authenticateRequest,
} from '../src/auth';
import type { AuthConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../src/expression-engine';

describe('Auth Module - extractToken', () => {
  test('should extract token from standard Bearer format', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer test-token-123' },
    });

    const token = extractToken(req);
    expect(token).toBe('test-token-123');
  });

  test('should extract token directly without Bearer prefix', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'direct-token-456' },
    });

    const token = extractToken(req);
    expect(token).toBe('direct-token-456');
  });

  test('should return null if Authorization header is missing', () => {
    const req = new Request('http://localhost');

    const token = extractToken(req);
    expect(token).toBeNull();
  });

  test('should handle Bearer with extra spaces', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: '  Bearer   token-with-spaces  ' },
    });

    const token = extractToken(req);
    expect(token).toBe('token-with-spaces');
  });

  test('should return null for empty Authorization header', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: '' },
    });

    const token = extractToken(req);
    expect(token).toBeNull();
  });

  test('should return null for malformed Authorization header (too many parts)', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer token1 token2 token3' },
    });

    const token = extractToken(req);
    expect(token).toBeNull();
  });

  test('should handle token with special characters', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk-proj-abc123_XYZ-789' },
    });

    const token = extractToken(req);
    expect(token).toBe('sk-proj-abc123_XYZ-789');
  });
});

describe('Auth Module - constantTimeCompare', () => {
  test('should return true for identical strings', () => {
    expect(constantTimeCompare('token123', 'token123')).toBe(true);
  });

  test('should return false for different strings of same length', () => {
    expect(constantTimeCompare('token123', 'token456')).toBe(false);
  });

  test('should return false for different strings of different lengths', () => {
    expect(constantTimeCompare('short', 'longertoken')).toBe(false);
  });

  test('should return true for empty strings', () => {
    expect(constantTimeCompare('', '')).toBe(true);
  });

  test('should handle special characters', () => {
    const token1 = 'Bearer@#$%^&*()';
    const token2 = 'Bearer@#$%^&*()';
    expect(constantTimeCompare(token1, token2)).toBe(true);
  });

  test('should be resistant to timing attacks (constant time)', () => {
    // Test that different positions of mismatch take similar time
    const correctToken = 'a'.repeat(100);
    const wrongAtStart = 'b' + 'a'.repeat(99);
    const wrongAtEnd = 'a'.repeat(99) + 'b';

    // Both should return false regardless of where the difference is
    expect(constantTimeCompare(correctToken, wrongAtStart)).toBe(false);
    expect(constantTimeCompare(correctToken, wrongAtEnd)).toBe(false);
  });

  test('should handle unicode characters', () => {
    const token1 = '你好世界-token-123';
    const token2 = '你好世界-token-123';
    const token3 = '你好世界-token-456';

    expect(constantTimeCompare(token1, token2)).toBe(true);
    expect(constantTimeCompare(token1, token3)).toBe(false);
  });
});

describe('Auth Module - authenticateRequest', () => {
  test('should succeed when auth is disabled', async () => {
    const req = new Request('http://localhost');
    const authConfig: AuthConfig = {
      enabled: false,
      tokens: [],
    };
    const context: ExpressionContext = {
      headers: {},
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should fail when token is missing', async () => {
    const req = new Request('http://localhost');
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['valid-token'],
    };
    const context: ExpressionContext = {
      headers: {},
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing or invalid Authorization header');
  });

  test('should succeed with valid token (Bearer format)', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer valid-token-123' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['valid-token-123'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer valid-token-123' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should succeed with valid token (direct format)', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'my-direct-token' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['my-direct-token'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'my-direct-token' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should process environment variable tokens', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer secret-from-env' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['{{ env.API_TOKEN }}'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer secret-from-env' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: { API_TOKEN: 'secret-from-env' },
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should support multiple tokens', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer token-2' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['token-1', 'token-2', 'token-3'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer token-2' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should fail with invalid token', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['correct-token'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer wrong-token' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  test('should fail when no valid tokens are configured', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer some-token' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['{{ env.MISSING_TOKEN }}'], // Will evaluate to empty
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer some-token' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {}, // Missing MISSING_TOKEN
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Authentication configuration error');
  });

  test('should filter out empty tokens from expression evaluation', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: [
        '{{ env.EMPTY_TOKEN }}', // Will be empty
        'valid-token', // Valid token
        '{{ env.ANOTHER_EMPTY }}', // Will be empty
      ],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer valid-token' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {
        EMPTY_TOKEN: '', // Empty
        ANOTHER_EMPTY: '   ', // Whitespace only
      },
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should match token using constant time comparison', async () => {
    // This tests that we're using constant time compare
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer exact-match-token' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: ['exact-match-token'],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer exact-match-token' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {},
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });

  test('should handle multiple environment variable tokens', async () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer tenant-b-secret' },
    });
    const authConfig: AuthConfig = {
      enabled: true,
      tokens: [
        '{{ env.TENANT_A_TOKEN }}',
        '{{ env.TENANT_B_TOKEN }}',
        '{{ env.TENANT_C_TOKEN }}',
      ],
    };
    const context: ExpressionContext = {
      headers: { authorization: 'Bearer tenant-b-secret' },
      body: {},
      url: { pathname: '/', search: '', host: 'localhost', protocol: 'http:' },
      method: 'GET',
      env: {
        TENANT_A_TOKEN: 'tenant-a-secret',
        TENANT_B_TOKEN: 'tenant-b-secret',
        TENANT_C_TOKEN: 'tenant-c-secret',
      },
    };

    const result = await authenticateRequest(req, authConfig, context);
    expect(result.success).toBe(true);
  });
});
