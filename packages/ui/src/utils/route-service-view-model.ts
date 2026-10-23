import { resolveRouteEndpoints, type Route, type Service, type Upstream } from '$api/routes';
import { findRuntimeUpstream, type RuntimeUpstreamsResponse } from '$api/runtime';
import { sortBy } from 'lodash-es';

export type RouteTargetSummaryKind = 'service' | 'custom_endpoints' | 'direct_response' | 'missing_service' | 'empty';

export type RouteFeatureBadgeSection =
  | 'websocket'
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
  serviceNames?: string[];
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
  services: Service[];
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
  return hasModificationContainer(route.request)
    || hasModificationContainer(route.response?.headers)
    || hasModificationContainer(route.response?.body)
    || hasModificationContainer(route.path_rewrite);
}

export function getRouteTargetSummary(route: Partial<Route>, services: Service[] = []): RouteTargetSummary {
  if (route.service_references?.length) {
    const targets = route.service_references.map(reference => services.find(service => service._uid === reference.service_id));
    const names = targets.map((service, index) => service?.name ?? route.service_references![index].service_id);
    const missing = targets.some(service => !service);
    return { kind: missing ? 'missing_service' : 'service', label: `${missing ? 'missing service' : 'service'}: ${names.join(', ')}`,
      serviceName: names.join(', '), serviceNames: names, endpointCount: resolveRouteEndpoints(route, services).length };
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

  if (route.websocket?.enabled) {
    badges.push({ id: 'websocket', section: 'websocket', label: 'WebSocket', labelKey: 'routeFeatures.websocket' });
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

export function getServiceConsumers(serviceId: string, routes: Route[] = [], services: Service[] = []): ServiceConsumersViewModel {
  const references = (owner: Partial<Service>) => Boolean(serviceId && owner.service_references?.some(reference => reference.service_id === serviceId));
  const matchedRoutes = routes.filter(references), matchedServices = services.filter(references);
  return { serviceName: services.find(service => service._uid === serviceId)?.name ?? serviceId,
    count: matchedRoutes.length + matchedServices.length, routes: matchedRoutes, services: matchedServices,
    routePaths: matchedRoutes.map(route => route.path) };
}

export function getServiceHealthAggregate(service: Partial<Service>, runtime: RuntimeUpstreamsResponse | null = null, services: Service[] = []): ServiceHealthAggregate {
  const aggregate: ServiceHealthAggregate = { total: 0, healthy: 0, halfOpen: 0, mixed: 0, unknown: 0, unhealthy: 0, disabled: 0, state: 'empty' };
  const collect = (owner: Partial<Service>, seen: Set<string>, disabled = false) => {
    for (const endpoint of owner.endpoints ?? []) {
      aggregate.total++;
      if (disabled || endpoint.is_disabled) { aggregate.disabled++; continue; }
      const status = findRuntimeUpstream(runtime, owner._uid ?? '', endpoint._uid)?.circuit_state ?? 'UNKNOWN';
      if (status === 'HEALTHY') aggregate.healthy++;
      else if (status === 'HALF_OPEN') aggregate.halfOpen++;
      else if (status === 'UNHEALTHY') aggregate.unhealthy++;
      else if (status === 'MIXED') aggregate.mixed++;
      else aggregate.unknown++;
    }
    for (const reference of owner.service_references ?? []) {
      const target = services.find(service => service._uid === reference.service_id);
      if (!target || seen.has(reference.service_id)) {
        aggregate.total++;
        if (disabled || reference.is_disabled) aggregate.disabled++; else aggregate.unknown++;
      } else collect(target, new Set([...seen, reference.service_id]), disabled || reference.is_disabled);
    }
  };
  collect(service, new Set(service._uid ? [service._uid] : []));
  const active = aggregate.total - aggregate.disabled;
  if (!aggregate.total) aggregate.state = 'empty';
  else if (!active) aggregate.state = 'neutral';
  else if (aggregate.healthy > 0) aggregate.state = aggregate.healthy === active ? 'healthy' : 'degraded';
  else if (aggregate.halfOpen > 0) aggregate.state = 'degraded';
  else if (aggregate.mixed > 0) aggregate.state = 'mixed';
  else if (aggregate.unknown > 0) aggregate.state = 'unknown';
  else aggregate.state = 'unhealthy';
  return aggregate;
}

export function getRouteHealthAggregate(route: Partial<Route>, services: Service[] = [], runtime: RuntimeUpstreamsResponse | null = null): ServiceHealthAggregate {
  if (!route.service_references?.length && hasDirectResponseCapability(route) && !route.endpoints?.length) {
    return { total: 0, healthy: 0, halfOpen: 0, mixed: 0, unknown: 0, unhealthy: 0, disabled: 0, state: 'neutral' };
  }
  return getServiceHealthAggregate({_uid: route._uid, name: route.path, endpoints: route.endpoints, service_references: route.service_references}, runtime, services);
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
    resolveRouteEndpoints(route, services),
    previewCount
  );

  return {
    target,
    badges,
    preview,
  };
}
