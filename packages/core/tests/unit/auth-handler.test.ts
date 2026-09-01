import { afterEach, describe, expect, test } from 'bun:test';
import { AuthHandler } from '../../src/api/handlers/auth';
import { handleAPIRequest } from '../../src/api/router';
import { clearServingConfig, setServingConfig } from '../../src/api/serving-config';

describe('AuthHandler.verify', () => {
  afterEach(() => clearServingConfig());

  test('returns a quiet anonymous probe while preserving token verification', async () => {
    setServingConfig({
      routes: [],
      auth: { enabled: true, tokens: ['final-token'] },
    }, []);

    const anonymous = await AuthHandler.verify(new Request('http://localhost/__ui/api/auth/verify'));
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ success: false });

    const invalid = await AuthHandler.verify(new Request('http://localhost/__ui/api/auth/verify', {
      headers: { Authorization: 'Bearer wrong-token' },
    }));
    expect(invalid.status).toBe(401);

    const valid = await AuthHandler.verify(new Request('http://localhost/__ui/api/auth/verify', {
      headers: { Authorization: 'Bearer final-token' },
    }));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ success: true });
  });

  test('lets only the anonymous verify probe reach the handler', async () => {
    setServingConfig({
      routes: [],
      auth: { enabled: true, tokens: ['final-token'] },
    }, []);

    const verify = await handleAPIRequest(
      new Request('http://localhost/__ui/api/auth/verify'),
      '/api/auth/verify',
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ success: false });

    const protectedRequest = await handleAPIRequest(
      new Request('http://localhost/__ui/api/system'),
      '/api/system',
    );
    expect(protectedRequest.status).toBe(401);
  });
});
