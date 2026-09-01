import type {
  Endpoint,
  LogicalConfigurationV2,
  PluginBindingV2,
  PluginConfig,
  RouteConfig,
  RouteV2,
  Service as BaseService,
  ServiceV2,
  UpstreamV2,
} from '@jeffusion/bungee-types';
import { v4 as uuidv4 } from 'uuid';

export type EditorPluginBinding = PluginConfig & {
  _uid?: string;
  _position?: number;
};

export type EditorUpstream = Omit<Endpoint, 'id' | 'plugins'> & {
  _uid?: string;
  _position?: number;
  plugins?: Array<EditorPluginBinding | string>;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  upstream_id?: string;
  last_failure_time?: number;
  consecutive_failures?: number;
  consecutive_successes?: number;
  recovery_attempt_count?: number;
  health_check_successes?: number;
  health_check_failures?: number;
};

export type EditorService = Omit<BaseService, 'endpoints' | 'plugins'> & {
  _uid?: string;
  _position?: number;
  description?: string;
  endpoints: EditorUpstream[];
  plugins?: Array<EditorPluginBinding | string>;
};

export type EditorRoute = Omit<RouteConfig, 'endpoints' | 'plugins'> & {
  _uid?: string;
  _position?: number;
  _serviceId?: string;
  endpoints?: EditorUpstream[];
  plugins?: Array<EditorPluginBinding | string>;
  transformer?: string | object;
};

function toEditorPlugin(binding: PluginBindingV2): EditorPluginBinding {
  return {
    _uid: binding.id,
    _position: binding.position,
    name: binding.name,
    ...(binding.options === undefined ? {} : { options: binding.options }),
    enabled: binding.enabled,
  };
}

function toV2Plugins(
  plugins: readonly (EditorPluginBinding | string)[],
  previous: readonly PluginBindingV2[],
): readonly PluginBindingV2[] {
  const used = new Set<string>();
  let nextPosition = previous.reduce((maximum, binding) => Math.max(maximum, binding.position), -1) + 1;
  return plugins.map((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin.name;
    const requestedId = typeof plugin === 'string' ? undefined : plugin._uid;
    const match = previous.find((binding) => !used.has(binding.id)
      && (binding.id === requestedId || (requestedId === undefined && binding.name === name)));
    if (match !== undefined) used.add(match.id);
    const options = typeof plugin === 'string' ? match?.options : (plugin.options ?? match?.options);
    return {
      id: match?.id ?? uuidv4(),
      position: match?.position ?? nextPosition++,
      name,
      ...(options === undefined ? {} : { options }),
      enabled: typeof plugin === 'string' ? (match?.enabled ?? true) : (plugin.enabled ?? match?.enabled ?? true),
    };
  });
}

function toV2Headers(
  headers: NonNullable<EditorUpstream['headers']>,
): NonNullable<EditorUpstream['headers']> {
  const { add, replace, remove } = headers;
  return {
    ...(add === undefined ? {} : { add }),
    ...(replace === undefined ? {} : { replace }),
    ...(remove === undefined ? {} : { remove }),
  };
}

export function toEditorUpstream(upstream: UpstreamV2): EditorUpstream {
  const { id, position, plugins, ...policy } = upstream;
  return {
    ...policy,
    _uid: id,
    _position: position,
    plugins: plugins.map(toEditorPlugin),
  };
}

function toV2Upstreams(
  upstreams: readonly EditorUpstream[],
  previous: readonly UpstreamV2[],
): readonly UpstreamV2[] {
  const used = new Set<string>();
  let nextPosition = previous.reduce((maximum, upstream) => Math.max(maximum, upstream.position), -1) + 1;
  return upstreams.map((upstream) => {
    const match = previous.find((candidate) => !used.has(candidate.id)
      && (candidate.id === upstream._uid || (upstream._uid === undefined && candidate.target === upstream.target)));
    if (match !== undefined) used.add(match.id);
    const {
      _uid, _position, plugins = [], headers, status, upstream_id, last_failure_time,
      consecutive_failures, consecutive_successes, recovery_attempt_count,
      health_check_successes, health_check_failures, ...policy
    } = upstream;
    return {
      ...policy,
      ...(headers === undefined ? {} : { headers: toV2Headers(headers) }),
      id: match?.id ?? uuidv4(),
      position: match?.position ?? nextPosition++,
      weight: upstream.weight ?? match?.weight ?? 100,
      priority: upstream.priority ?? match?.priority ?? 1,
      is_disabled: upstream.is_disabled ?? match?.is_disabled ?? false,
      plugins: toV2Plugins(plugins, match?.plugins ?? []),
    };
  });
}

export function toEditorService(service: ServiceV2): EditorService {
  const { id, position, endpoints, plugins, ...policy } = service;
  return {
    ...policy,
    _uid: id,
    _position: position,
    endpoints: endpoints.map(toEditorUpstream),
    plugins: plugins.map(toEditorPlugin),
  };
}

export function toV2Service(
  service: EditorService,
  previous: ServiceV2 | undefined,
  position: number,
): ServiceV2 {
  const { _uid, _position, description, endpoints, plugins = [], ...policy } = service;
  return {
    ...policy,
    id: previous?.id ?? uuidv4(),
    position: previous?.position ?? position,
    endpoints: toV2Upstreams(endpoints, previous?.endpoints ?? []),
    plugins: toV2Plugins(plugins, previous?.plugins ?? []),
  };
}

export function toEditorRoute(route: RouteV2, services: readonly ServiceV2[]): EditorRoute {
  if (route.service_id !== undefined) {
    const { id, position, plugins, service_id, ...servicePolicy } = route;
    return {
      ...servicePolicy,
      _uid: id,
      _position: position,
      _serviceId: service_id,
      service: services.find((service) => service.id === service_id)?.name,
      plugins: plugins.map(toEditorPlugin),
    };
  }
  const { id, position, plugins, endpoints, ...directPolicy } = route;
  return {
    ...directPolicy,
    _uid: id,
    _position: position,
    endpoints: endpoints.map(toEditorUpstream),
    plugins: plugins.map(toEditorPlugin),
  };
}

export function toV2Route(
  route: EditorRoute,
  logical: LogicalConfigurationV2,
  previous: RouteV2 | undefined,
  position: number,
): RouteV2 {
  const {
    _uid, _position, _serviceId, service, endpoints = [], plugins = [], transformer, headers, ...policy
  } = route;
  const base = {
    ...policy,
    ...(headers === undefined ? {} : { headers: toV2Headers(headers) }),
    id: previous?.id ?? uuidv4(),
    position: previous?.position ?? position,
    plugins: toV2Plugins(plugins, previous?.plugins ?? []),
  };
  if (service !== undefined) {
    const serviceId = logical.services.find((candidate) => candidate.name === service)?.id ?? _serviceId;
    if (serviceId === undefined) throw new ServiceReferenceNotFoundError(service);
    return { ...base, service_id: serviceId };
  }
  return {
    ...base,
    endpoints: toV2Upstreams(
      endpoints,
      previous !== undefined && previous.service_id === undefined ? (previous.endpoints ?? []) : [],
    ),
  };
}

export class ServiceReferenceNotFoundError extends Error {
  readonly name = 'ServiceReferenceNotFoundError';
  constructor(readonly serviceName: string) { super(`Service "${serviceName}" not found`); }
}
