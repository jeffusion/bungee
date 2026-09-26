import { describe, expect, test } from 'bun:test';
import {
  getEndpointPreview,
  getRouteDisplayViewModel,
  getRouteFeatureBadges,
  getRouteTargetSummary,
  getServiceConsumers,
  getServiceHealthAggregate,
  sortEndpointsForDisplay,
} from './route-service-view-model';
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
    const display = getRouteDisplayViewModel(frozenRoute, [frozenService]);

    expect(summary).toEqual({
      kind: 'service',
      label: 'service: shared-service',
      serviceName: 'shared-service',
      endpointCount: 4,
    });
    expect(display.preview.total).toBe(4);
    expect(frozenRoute).toEqual(route);
    expect(frozenService).toEqual(service);
  });

  test('summarizes custom endpoints and endpoint preview overflow', () => {
    const route: Route = {
      path: '/custom',
      endpoints: [
        { target: 'https://a.example.com', weight: 100, priority: 1 },
        { target: 'https://b.example.com', weight: 100, priority: 2 },
        { target: 'https://c.example.com', weight: 100, priority: 3 },
        { target: 'https://d.example.com', weight: 100, priority: 4 },
      ],
    };

    const summary = getRouteTargetSummary(route);
    const preview = getEndpointPreview(route.endpoints);

    expect(summary.kind).toBe('custom_endpoints');
    expect(summary.endpointCount).toBe(4);
    expect(preview.items).toHaveLength(3);
    expect(preview.overflowCount).toBe(1);
  });

  test('sorts card, overflow, drawer and review consistently without changing endpoint positions', () => {
    const service = createService();
    service.endpoints = [
      { target: 'p4', priority: 4, _position: 0, is_disabled: true },
      { target: 'p2-first', priority: 2, _position: 1 },
      { target: 'p1', priority: 1, _position: 2 },
      { target: 'p3', priority: 3, _position: 3 },
      { target: 'p2-second', priority: 2, _position: 4 },
    ];
    const original = structuredClone(service.endpoints);
    const frozen = deepFreeze(service.endpoints);
    const full = sortEndpointsForDisplay(frozen);
    const card = getEndpointPreview(frozen);
    const review = getEndpointPreview(frozen, 5);
    const targets = ['p1', 'p2-first', 'p2-second', 'p3', 'p4'];

    expect(full.map((item) => item.target)).toEqual(targets);
    expect(card.items.map((item) => item.target)).toEqual(targets.slice(0, 3));
    expect(card.overflowCount).toBe(2);
    expect(review.items.map((item) => item.target)).toEqual(targets);
    expect(getRouteDisplayViewModel({ path: '/shared', service: service.name }, [service]).preview.items.map((item) => item.target)).toEqual(targets.slice(0, 3));
    expect(full.map((item) => item._position)).toEqual([2, 1, 4, 3, 0]);
    expect(service.endpoints).toEqual(original);
  });

  test('treats direct response and response rules as direct-response capability', () => {
    const route: Route = {
      ...createBaseRoute(),
      endpoints: undefined,
      direct_response: { enabled: true, status: 204 },
      response_rules: [{ enabled: true, path: '/health', type: 'redirect', url: '/ready' }],
      auth: { enabled: true, tokens: ['alice'] },
      cors: { enabled: true },
      rate_limit: { enabled: true },
      retry: { enabled: true },
      plugins: [{ name: 'audit-log' }],
      headers: { add: {}, remove: [] },
      body: { add: {}, remove: [], replace: {}, default: {} },
      query: { add: {}, remove: [], replace: {}, default: {} },
    };

    const summary = getRouteTargetSummary(route);
    const badges = getRouteFeatureBadges(route);

    expect(summary.kind).toBe('direct_response');
    expect(badges.map((badge) => badge.section)).toEqual([
      'auth',
      'cors',
      'rateLimit',
      'retry',
      'directResponse',
      'plugins',
    ]);
  });

  test('emits modification only for real header/body/query/path rewrite changes', () => {
    const emptyDefaults: Route = {
      path: '/defaults',
      headers: { add: {}, remove: [] },
      body: { add: {}, remove: [], replace: {}, default: {} },
      query: { add: {}, remove: [], replace: {}, default: {} },
    };

    const realModifications: Route = {
      path: '/mods',
      headers: { add: { 'x-demo': '1' }, remove: ['x-old'] },
      body: { add: { foo: 'bar' }, remove: [], replace: {}, default: {} },
      query: { add: {}, remove: [], replace: { status: 'active' }, default: {} },
      path_rewrite: { '^/api/(.*)$': '/v1/$1' },
    };

    expect(getRouteFeatureBadges(emptyDefaults).some((badge) => badge.section === 'modification')).toBe(false);
    expect(getRouteFeatureBadges(realModifications).some((badge) => badge.section === 'modification')).toBe(true);
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
