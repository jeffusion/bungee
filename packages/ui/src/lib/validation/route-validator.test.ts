import { describe, test, expect } from 'bun:test';
import type { Route } from '../api/routes';
import { validateRoute } from './route-validator';

function createBaseRoute(): Route {
  return {
    path: '/test',
    upstreams: [
      {
        target: 'https://example.com',
        weight: 100,
        priority: 1
      }
    ]
  };
}

describe('validateRoute failover.retryOn', () => {
  test('accepts expression-based status code rules', async () => {
    const route: Route = {
      ...createBaseRoute(),
      failover: {
        enabled: true,
        retryOn: ['>=400', '!503', '4xx', '5xx', 500, '<=599', '>199']
      }
    };

    const errors = await validateRoute(route);
    const failoverErrors = errors.filter((error) => error.field === 'failover.retryOn');
    expect(failoverErrors).toHaveLength(0);
  });

  test('accepts comma-separated retryable status code rules', async () => {
    const route: Route = {
      ...createBaseRoute(),
      failover: {
        enabled: true,
        retryOn: '>=400, !503, 5xx'
      }
    };

    const errors = await validateRoute(route);
    const failoverErrors = errors.filter((error) => error.field === 'failover.retryOn');
    expect(failoverErrors).toHaveLength(0);
  });

  test('rejects invalid retryable status code expression', async () => {
    const route: Route = {
      ...createBaseRoute(),
      failover: {
        enabled: true,
        retryOn: '>=40'
      }
    };

    const errors = await validateRoute(route);
    const failoverErrors = errors.filter((error) => error.field === 'failover.retryOn');
    expect(failoverErrors.length).toBeGreaterThan(0);
  });
});

describe('validateRoute stickySession', () => {
  test('rejects empty sticky session key expression when enabled', async () => {
    const route: Route = {
      ...createBaseRoute(),
      stickySession: {
        enabled: true,
        keyExpression: '   '
      }
    };

    const errors = await validateRoute(route);
    const stickyErrors = errors.filter((error) => error.field === 'stickySession.keyExpression');
    expect(stickyErrors.length).toBeGreaterThan(0);
  });
});
