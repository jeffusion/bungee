import type { Route, Service, Upstream } from '$api/routes';
import { findRuntimeUpstream, type RuntimeUpstreamsResponse } from '$api/runtime';
import { sortBy } from 'lodash-es';

export type RouteTargetSummaryKind = 'service' | 'custom_endpoints' | 'direct_response' | 'missing_service' | 'empty';

export type RouteFeatureBadgeSection =
  | 'auth'
  | 'cors'
  | 'rateLimit'
  | 'retry'
  | 'directResponse'
  | 'plugins'
  | 'modification'
  | 'availability';

export interface RouteTargetSummary {
  kind: RouteTargetSummaryKind;
  label: string;
  serviceName?: string;
  endpointCount: number;
}

export interface RouteFeatureBadgeDescriptor {
  id: string;
  section: RouteFeatureBadgeSection;
  label: string;
  labelKey?: string;
}

export interface ServiceConsumersViewModel {
  serviceName: string;
  count: number;
  routes: Route[];
  routePaths: string[];
}

export interface ServiceHealthAggregate {
  total: number;
  healthy: number;
  halfOpen: number;
  mixed: number;
  unknown: number;
  unhealthy: number;
  disabled: number;
  state: 'healthy' | 'degraded' | 'mixed' | 'unknown' | 'unhealthy' | 'neutral' | 'empty';
}

export interface EndpointPreview {
  items: Upstream[];
  overflowCount: number;
  total: number;
}

const DEFAULT_PREVIEW_COUNT = 3;

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === null) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length > 0 && value.some((item) => hasMeaningfulValue(item));
  }

  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulValue(item));
  }

  return true;
}

function hasModificationContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null && hasMeaningfulValue(value);
}

function hasDirectResponseCapability(route: Partial<Route>): boolean {
  return Boolean(route.direct_response?.enabled || route.redirect?.enabled || route.response_rules?.some((rule) => rule.enabled));
}

function hasModificationRules(route: Partial<Route>): boolean {
  return hasModificationContainer(route.headers)
    || hasModificationContainer(route.body)
    || hasModificationContainer(route.query)
    || hasModificationContainer(route.path_rewrite);
}

export function getRouteTargetSummary(route: Partial<Route>, services: Service[] = []): RouteTargetSummary {
  if (route.service) {
    const service = services.find((item) => item.name === route.service);
    if (service) {
      return {
        kind: 'service',
        label: `service: ${service.name}`,
        serviceName: service.name,
        endpointCount: service.endpoints.length,
      };
    }

    return {
      kind: 'missing_service',
      label: `missing service: ${route.service}`,
      serviceName: route.service,
      endpointCount: 0,
    };
  }

  if (route.endpoints && route.endpoints.length > 0) {
    return {
      kind: 'custom_endpoints',
      label: `${route.endpoints.length} custom endpoint${route.endpoints.length === 1 ? '' : 's'}`,
      endpointCount: route.endpoints.length,
    };
  }

  if (hasDirectResponseCapability(route)) {
    return {
      kind: 'direct_response',
      label: 'direct response',
      endpointCount: 0,
    };
  }

  return {
    kind: 'empty',
    label: 'empty',
    endpointCount: 0,
  };
}

export function getRouteFeatureBadges(route: Partial<Route>): RouteFeatureBadgeDescriptor[] {
  const badges: RouteFeatureBadgeDescriptor[] = [];

  if (route.auth?.enabled) {
    badges.push({ id: 'auth', section: 'auth', label: 'Auth', labelKey: 'routeFeatures.auth' });
  }

  if (route.cors?.enabled) {
    badges.push({ id: 'cors', section: 'cors', label: 'CORS', labelKey: 'routeFeatures.cors' });
  }

  if (route.rate_limit?.enabled) {
    badges.push({ id: 'rate-limit', section: 'rateLimit', label: 'Rate limit', labelKey: 'routeFeatures.rateLimit' });
  }

  if (route.retry?.enabled) {
    badges.push({ id: 'retry', section: 'retry', label: 'Retry', labelKey: 'routeFeatures.retry' });
  }

  if (hasDirectResponseCapability(route)) {
    badges.push({ id: 'direct-response', section: 'directResponse', label: 'Direct response', labelKey: 'routeFeatures.directResponse' });
  }

  if (Array.isArray(route.plugins) && route.plugins.length > 0) {
    badges.push({ id: 'plugins', section: 'plugins', label: 'Plugins', labelKey: 'routeFeatures.plugins' });
  }

  if (hasModificationRules(route)) {
    badges.push({ id: 'modification', section: 'modification', label: 'Modification', labelKey: 'routeFeatures.modification' });
  }

  return badges;
}

export function getServiceFeatureBadges(service: Partial<Service>): RouteFeatureBadgeDescriptor[] {
  const badges: RouteFeatureBadgeDescriptor[] = [];

  if (service.failover?.enabled) {
    badges.push({ id: 'failover', section: 'availability', label: 'Failover', labelKey: 'serviceFeatures.failover' });
  }

  if (service.health_check?.enabled) {
    badges.push({ id: 'health-check', section: 'availability', label: 'Health Check', labelKey: 'serviceFeatures.healthCheck' });
  }

  if (service.load_balancing) {
    badges.push({ id: 'load-balancing', section: 'availability', label: 'Load Balancing', labelKey: 'serviceFeatures.loadBalancing' });
  }

  if (Array.isArray(service.plugins) && service.plugins.length > 0) {
    badges.push({ id: 'plugins', section: 'plugins', label: 'Plugins', labelKey: 'routeFeatures.plugins' });
  }

  return badges;
}

export function getServiceConsumers(serviceName: string, routes: Route[] = []): ServiceConsumersViewModel {
  const matchedRoutes = routes.filter((route) => route.service === serviceName);

  return {
    serviceName,
    count: matchedRoutes.length,
    routes: matchedRoutes,
    routePaths: matchedRoutes.map((route) => route.path),
  };
}

export function getServiceHealthAggregate(service: Partial<Service>, runtime: RuntimeUpstreamsResponse | null = null): ServiceHealthAggregate {
  const endpoints = service.endpoints ?? [];

  if (endpoints.length === 0) {
    return {
      total: 0,
      healthy: 0,
      halfOpen: 0,
      mixed: 0,
      unknown: 0,
      unhealthy: 0,
      disabled: 0,
      state: 'empty',
    };
  }

  const aggregate = endpoints.reduce<ServiceHealthAggregate>(
    (acc, endpoint) => {
      if (endpoint.is_disabled) {
        acc.disabled += 1;
        return acc;
      }

      const status = findRuntimeUpstream(runtime, service.name ?? '', endpoint._uid)?.circuit_state ?? 'UNKNOWN';
      if (status === 'UNHEALTHY') {
        acc.unhealthy += 1;
      } else if (status === 'HALF_OPEN') {
        acc.halfOpen += 1;
      } else if (status === 'HEALTHY') {
        acc.healthy += 1;
      } else if (status === 'MIXED') {
        acc.mixed += 1;
      } else {
        acc.unknown += 1;
      }

      return acc;
    },
    {
      total: endpoints.length,
      healthy: 0,
      halfOpen: 0,
      mixed: 0,
      unknown: 0,
      unhealthy: 0,
      disabled: 0,
      state: 'neutral',
    }
  );

  const activeCount = aggregate.total - aggregate.disabled;

  if (activeCount === 0) {
    aggregate.state = 'neutral';
  } else if (aggregate.unknown > 0) {
    aggregate.state = 'unknown';
  } else if (aggregate.mixed > 0) {
    aggregate.state = 'mixed';
  } else if (aggregate.unhealthy > 0) {
    aggregate.state = 'unhealthy';
  } else if (aggregate.halfOpen > 0) {
    aggregate.state = 'degraded';
  } else {
    aggregate.state = 'healthy';
  }

  return aggregate;
}

export function getRouteHealthAggregate(route: Partial<Route>, services: Service[] = [], runtime: RuntimeUpstreamsResponse | null = null): ServiceHealthAggregate {
  const target = getRouteTargetSummary(route, services);
  if (target.kind === 'direct_response') {
    return { total: 0, healthy: 0, halfOpen: 0, mixed: 0, unknown: 0, unhealthy: 0, disabled: 0, state: 'neutral' };
  }
  if (target.kind === 'service') {
    const service = services.find((s) => s.name === target.serviceName);
    if (service) return getServiceHealthAggregate(service, runtime);
    return { total: 0, healthy: 0, halfOpen: 0, mixed: 0, unknown: 0, unhealthy: 0, disabled: 0, state: 'unhealthy' };
  }
  if (target.kind === 'custom_endpoints') {
    return getServiceHealthAggregate({ name: route.path, endpoints: route.endpoints }, runtime);
  }
  return { total: 0, healthy: 0, halfOpen: 0, mixed: 0, unknown: 0, unhealthy: 0, disabled: 0, state: 'empty' };
}

export function sortEndpointsForDisplay(endpoints: Upstream[]): Upstream[] {
  return sortBy(endpoints, (endpoint) => endpoint.priority ?? 1);
}

export function getEndpointPreview(endpoints: Upstream[] = [], limit = DEFAULT_PREVIEW_COUNT): EndpointPreview {
  const visibleCount = Math.max(0, limit);
  const items = sortEndpointsForDisplay(endpoints).slice(0, visibleCount).map((endpoint) => ({ ...endpoint }));

  return {
    items,
    overflowCount: Math.max(0, endpoints.length - visibleCount),
    total: endpoints.length,
  };
}

export function getRouteDisplayViewModel(route: Partial<Route>, services: Service[] = [], previewCount = DEFAULT_PREVIEW_COUNT) {
  const target = getRouteTargetSummary(route, services);
  const badges = getRouteFeatureBadges(route);
  const preview = getEndpointPreview(
    target.kind === 'service'
      ? services.find((service) => service.name === target.serviceName)?.endpoints ?? []
      : route.endpoints ?? [],
    previewCount
  );

  return {
    target,
    badges,
    preview,
  };
}
