import type {
  AppConfig,
  CommittedConfigurationSnapshotV2,
  Endpoint,
  PluginBindingV2,
  PluginConfig,
  RouteConfig,
  RouteV2,
  Service,
  ServiceV2,
  Sha256Digest,
  UpstreamV2,
} from '@jeffusion/bungee-types';

export type RuntimeConfigCompileErrorCode =
  | 'duplicate_plugin_activation'
  | 'duplicate_service_id'
  | 'unknown_service';

export class RuntimeConfigCompileError extends Error {
  readonly name = 'RuntimeConfigCompileError';

  constructor(
    readonly code: RuntimeConfigCompileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The outer identity is readonly; config is a deep-owned mutable runtime DTO. */
export type RuntimeConfigSnapshot = {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly config: AppConfig;
};

function comparePosition(
  left: { readonly position: number },
  right: { readonly position: number },
): number {
  return left.position - right.position;
}

function compilePlugins(
  bindings: readonly PluginBindingV2[],
  activeNames: ReadonlySet<string>,
): PluginConfig[] | undefined {
  const plugins = [...bindings]
    .sort(comparePosition)
    .filter(({ name }) => activeNames.has(name))
    .map(({ id, name, options, enabled }) => ({
      ...(id === undefined ? {} : { id }),
      name,
      ...(options === undefined ? {} : { options }),
      enabled,
    }));
  return plugins.length === 0 ? undefined : plugins;
}

function compileEndpoint(
  upstream: UpstreamV2,
  activeNames: ReadonlySet<string>,
): Endpoint {
  const { id, position: _position, plugins: bindings, ...policies } = upstream;
  const plugins = compilePlugins(bindings, activeNames);
  return {
    ...policies,
    id,
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function compileService(
  service: ServiceV2,
  activeNames: ReadonlySet<string>,
): Service {
  const {
    id: _id,
    position: _position,
    name,
    endpoints,
    plugins: bindings,
    ...policies
  } = service;
  const plugins = compilePlugins(bindings, activeNames);
  return {
    ...policies,
    name,
    endpoints: [...endpoints]
      .sort(comparePosition)
      .map((endpoint) => compileEndpoint(endpoint, activeNames)),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function compileRoute(
  route: RouteV2,
  servicesById: ReadonlyMap<string, ServiceV2>,
  activeNames: ReadonlySet<string>,
): RouteConfig {
  const {
    id: _id,
    position: _position,
    path,
    plugins: bindings,
    ...targetAndPolicies
  } = route;
  const plugins = compilePlugins(bindings, activeNames);
  if (targetAndPolicies.service_id !== undefined) {
    const service = servicesById.get(targetAndPolicies.service_id);
    if (service === undefined) {
      throw new RuntimeConfigCompileError(
        'unknown_service',
        `route ${path} references unknown service ${targetAndPolicies.service_id}`,
      );
    }
    const { service_id: _serviceId, ...policies } = targetAndPolicies;
    return {
      ...policies,
      path,
      service: service.name,
      ...(plugins === undefined ? {} : { plugins }),
    };
  }
  const { endpoints, ...policies } = targetAndPolicies;
  return {
    ...policies,
    path,
    endpoints: [...endpoints]
      .sort(comparePosition)
      .map((endpoint) => compileEndpoint(endpoint, activeNames)),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function activePluginNames(snapshot: CommittedConfigurationSnapshotV2): ReadonlySet<string> {
  const names = new Set<string>();
  for (const { plugin_name: name } of snapshot.aggregate.plugin_activations) {
    if (names.has(name)) {
      throw new RuntimeConfigCompileError(
        'duplicate_plugin_activation',
        `duplicate plugin activation: ${name}`,
      );
    }
    names.add(name);
  }
  return names;
}

function indexServices(services: readonly ServiceV2[]): ReadonlyMap<string, ServiceV2> {
  const byId = new Map<string, ServiceV2>();
  for (const service of services) {
    if (byId.has(service.id)) {
      throw new RuntimeConfigCompileError('duplicate_service_id', `duplicate service id: ${service.id}`);
    }
    byId.set(service.id, service);
  }
  return byId;
}

export function compileRuntimeConfigSnapshot(
  snapshot: CommittedConfigurationSnapshotV2,
): RuntimeConfigSnapshot {
  const activeNames = activePluginNames(snapshot);
  const logical = structuredClone(snapshot.aggregate.logical_configuration);
  const servicesById = indexServices(logical.services);
  const services = [...logical.services]
    .sort(comparePosition)
    .map((service) => compileService(service, activeNames));
  const routes = [...logical.routes]
    .sort(comparePosition)
    .map((route) => compileRoute(route, servicesById, activeNames));
  const plugins = compilePlugins(logical.plugins, activeNames);
  const { services: _services, routes: _routes, plugins: _plugins, ...globalPolicies } = logical;

  return {
    revision: snapshot.revision,
    content_hash: snapshot.content_hash,
    config: {
      ...globalPolicies,
      config_version: 4,
      ...(plugins === undefined ? {} : { plugins }),
      ...(services.length === 0 ? {} : { services }),
      routes,
    },
  };
}
