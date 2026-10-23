import { serviceReference } from '../../helpers/service-references';
import { describe, expect, test } from 'bun:test';
import {
  getRouteTargetSummary,
  getServiceConsumers,
  getServiceHealthAggregate,
  getRouteHealthAggregate,
} from '../../../src/utils/route-service-view-model';
import type { Route, Service } from '$api/routes';
import type { RuntimeUpstreamsResponse } from '../../../src/api/runtime';

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
    _uid: 'shared-service',
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
    const route: Route = { path: '/service', service_references: [serviceReference(service._uid!)] };
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
    const missingServiceRoute: Route = { path: '/missing', service_references: [serviceReference('ghost-service')] };
    const emptyRoute: Route = { path: '/empty' };

    expect(getRouteTargetSummary(missingServiceRoute, [createService()]).kind).toBe('missing_service');
    expect(getRouteTargetSummary(emptyRoute).kind).toBe('empty');
  });

  test('computes service consumers and health aggregate from route/service inputs only', () => {
    const service = createService();
    const routes: Route[] = [
      { path: '/svc-a', service_references: [serviceReference('shared-service')] },
      { path: '/svc-b', service_references: [serviceReference('shared-service')] },
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

test('direct Route and Service consumers use stable IDs across service rename', () => {
  const leaf = { ...createService(), name: 'renamed' };
  const pool: Service = { _uid: 'pool', name: 'pool', endpoints: [], service_references: [serviceReference(leaf._uid!)] };
  const routes: Route[] = [{ path: '/route', service_references: [serviceReference(leaf._uid!)] }, { path: '/nested', service_references: [serviceReference('pool')] }];
  const consumers = getServiceConsumers(leaf._uid!, routes, [leaf, pool]);
  expect(consumers.routePaths).toEqual(['/route']);
  expect(consumers.services.map(service => service.name)).toEqual(['pool']);
  expect(consumers.count).toBe(2);
  expect(getRouteTargetSummary(routes[1], [leaf, pool])).toMatchObject({ kind: 'service', endpointCount: 4 });
  expect(getServiceHealthAggregate(pool, null, [leaf, pool]).state).toBe('unknown');
});

test('runtime health resolves renamed Services, nested references and direct Routes by stable owner ID', () => {
  const leaf: Service = {_uid:'leaf-id',name:'renamed leaf',endpoints:[{_uid:'leaf-endpoint',target:'https://leaf.example'}]};
  const pool: Service = {_uid:'pool-id',name:'renamed pool',endpoints:[{_uid:'pool-endpoint',target:'https://pool.example'}],service_references:[serviceReference(leaf._uid!)]};
  const direct: Route = {_uid:'route-id',path:'/renamed-route',endpoints:[{_uid:'route-endpoint',target:'https://route.example'}]};
  const records = [
    {state_key:leaf._uid!,upstream_id:'leaf-endpoint',circuit_state:'UNHEALTHY' as const},
    {state_key:pool._uid!,upstream_id:'pool-endpoint',circuit_state:'HEALTHY' as const},
    {state_key:direct._uid!,upstream_id:'route-endpoint',circuit_state:'HALF_OPEN' as const},
  ];
  const runtime: RuntimeUpstreamsResponse = {schema:'bungee-runtime-upstreams-v1',generated_at:0,availability:'complete',reason:null,admission:null,workers:{observed:[],missing:[]},
    upstreams:records.map(record=>({...record,active_request_count:0,last_used_time:null,last_used_complete:true,last_failure_time:null,last_failure_complete:true,workers:[]}))};
  expect(getServiceHealthAggregate(pool,runtime,[leaf,pool])).toMatchObject({healthy:1,unhealthy:1,unknown:0,state:'degraded'});
  expect(getRouteHealthAggregate(direct,[],runtime)).toMatchObject({halfOpen:1,unknown:0,state:'degraded'});
  expect(getRouteHealthAggregate({service_references:[serviceReference(pool._uid!)]},[leaf,pool],runtime)).toMatchObject({healthy:1,unhealthy:1,unknown:0,state:'degraded'});
});
