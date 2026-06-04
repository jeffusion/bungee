import { describe, test, expect } from 'bun:test';
import type { Route } from '$api/routes';
import { validateRoute } from './route-validator';

describe('validateRoute response_rules upstream requirements', () => {
  test('requires an upstream when only response_rules are enabled', async () => {
    const route: Route = {
      path: '/test',
      response_rules: [
        {
          enabled: true,
          path: '/health',
          type: 'redirect',
          url: '/ready'
        }
      ]
    };

    const errors = await validateRoute(route);
    const upstreamErrors = errors.filter(
      (error) => error.field === 'endpoints' || error.message.includes('upstream')
    );

    expect(upstreamErrors.length).toBeGreaterThan(0);
  });
});
