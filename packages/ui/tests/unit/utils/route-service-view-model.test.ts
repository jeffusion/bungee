import { describe, expect, test } from 'bun:test';
import {
  getRouteTargetSummary,
  getServiceConsumers,
  getServiceHealthAggregate,
} from '../../../src/utils/route-service-view-model';
import type { Route, Service } from '$api/routes';

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;

  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }

  return value;
}

function createService(): Service {
  return {
    name: 'shared-service',
    endpoints: [
      { target: 'https://healthy.example.com', weight: 100, priority: 1 },
      { target: 'https://second.example.com', weight: 100, priority: 2 },
      { target: 'https://third.example.com', weight: 100, priority: 3 },
      { target: 'https://disabled.example.com', weight: 100, priority: 4, is_disabled: true },
    ],
  };
}

function createBaseRoute(): Route {
  return {
    path: '/demo',
    endpoints: [{ target: 'https://route.example.com', weight: 100, priority: 1 }],
  };
}

describe('route-service-view-model', () => {
  test('summarizes service-backed routes without expanding save payload semantics', () => {
    const service = createService();
    const route: Route = { path: '/service', service: service.name };
    const frozenRoute = deepFreeze(structuredClone(route));
    const frozenService = deepFreeze(structuredClone(service));

    const summary = getRouteTargetSummary(frozenRoute, [frozenService]);

    expect(summary).toMatchObject({
      kind: 'service',
      serviceName: 'shared-service',
      endpointCount: 4,
    });
    expect(frozenRoute).toEqual(route);
    expect(frozenService).toEqual(service);
  });

  test('treats direct response and response rules as direct-response capability', () => {
    const route: Route = {
      ...createBaseRoute(),
      endpoints: undefined,
      direct_response: { enabled: true, status: 204 },
      response_rules: [{ enabled: true, path: '/health', type: 'redirect', url: '/ready' }],
      cors: { enabled: true },
      rate_limit: { enabled: true },
      retry: { enabled: true },
      plugins: [{ name: 'audit-log' }],
      request: {
      headers: { add: {}, remove: [] },
      body: { add: {}, remove: [], replace: {}, default: {} },
      query: { add: {}, remove: [], replace: {}, default: {} },
      },
    };

    const summary = getRouteTargetSummary(route);

    expect(summary.kind).toBe('direct_response');

  });

  test('marks missing service and empty targets distinctly', () => {
    const missingServiceRoute: Route = { path: '/missing', service: 'ghost-service' };
    const emptyRoute: Route = { path: '/empty' };

    expect(getRouteTargetSummary(missingServiceRoute, [createService()]).kind).toBe('missing_service');
    expect(getRouteTargetSummary(emptyRoute).kind).toBe('empty');
  });

  test('computes service consumers and health aggregate from route/service inputs only', () => {
    const service = createService();
    const routes: Route[] = [
      { path: '/svc-a', service: 'shared-service' },
      { path: '/svc-b', service: 'shared-service' },
      { path: '/custom', endpoints: [{ target: 'https://custom.example.com', weight: 100, priority: 1 }] },
    ];

    const consumers = getServiceConsumers('shared-service', routes);
    const aggregate = getServiceHealthAggregate(service);

    expect(consumers.count).toBe(2);
    expect(consumers.routePaths).toEqual(['/svc-a', '/svc-b']);
    expect(aggregate).toEqual({
      total: 4,
      healthy: 0,
      halfOpen: 0,
      unhealthy: 0,
      mixed: 0,
      unknown: 3,
      disabled: 1,
      state: 'unknown',
    });
  });
});
