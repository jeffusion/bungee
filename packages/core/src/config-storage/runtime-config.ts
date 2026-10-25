import type {
  AppConfig,
  CommittedConfigurationSnapshot,
  Endpoint,
  PluginBinding,
  PluginConfig,
  RouteConfig,
  ConfigurationRoute,
  Service,
  ConfigurationService,
  Sha256Digest,
  ConfigurationUpstream,
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
  bindings: readonly PluginBinding[],
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
  upstream: ConfigurationUpstream,
  activeNames: ReadonlySet<string>,
): Endpoint {
  const { id, plugins: bindings, ...policies } = upstream;
  const plugins = compilePlugins(bindings, activeNames);
  return {
    ...policies,
    id,
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function compileService(
  service: ConfigurationService,
  activeNames: ReadonlySet<string>,
): Service {
  const {
    id,
    position: _position,
    name,
    endpoints,
    service_references,
    plugins: bindings,
    ...policies
  } = service;
  const plugins = compilePlugins(bindings, activeNames);
  return {
    ...policies,
    id,
    name,
    ...(service_references?.length ? { service_references: [...service_references].sort(comparePosition) } : {}),
    endpoints: [...endpoints]
      .sort(comparePosition)
      .map((endpoint) => compileEndpoint(endpoint, activeNames)),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function compileRoute(
  route: ConfigurationRoute,
  servicesById: ReadonlyMap<string, ConfigurationService>,
  activeNames: ReadonlySet<string>,
): RouteConfig {
  const {
    id,
    position: _position,
    path,
    plugins: bindings,
    ...targetAndPolicies
  } = route;
  const plugins = compilePlugins(bindings, activeNames);
  const { endpoints, service_references, ...policies } = targetAndPolicies;
  for (const reference of service_references ?? []) {
    if (!servicesById.has(reference.service_id)) throw new RuntimeConfigCompileError('unknown_service',
      `route ${path} references unknown service ${reference.service_id}`);
  }
  return {
    ...policies,
    id,
    path,
    ...(service_references === undefined ? {}
      : { service_references: [...service_references].sort(comparePosition) }),
    ...(endpoints === undefined ? {} : {
      endpoints: [...endpoints].sort(comparePosition).map((endpoint) => compileEndpoint(endpoint, activeNames)),
    }),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

function activePluginNames(snapshot: CommittedConfigurationSnapshot): ReadonlySet<string> {
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

function indexServices(services: readonly ConfigurationService[]): ReadonlyMap<string, ConfigurationService> {
  const byId = new Map<string, ConfigurationService>();
  for (const service of services) {
    if (byId.has(service.id)) {
      throw new RuntimeConfigCompileError('duplicate_service_id', `duplicate service id: ${service.id}`);
    }
    byId.set(service.id, service);
  }
  return byId;
}

export function compileRuntimeConfigSnapshot(
  snapshot: CommittedConfigurationSnapshot,
): RuntimeConfigSnapshot {
  const activeNames = activePluginNames(snapshot);
  const logical = structuredClone(snapshot.aggregate.logical_configuration);
  const servicesById = indexServices(logical.services);
  for (const service of logical.services) for (const reference of service.service_references ?? []) {
    if (!servicesById.has(reference.service_id)) throw new RuntimeConfigCompileError('unknown_service',
      `service ${service.name} references unknown service ${reference.service_id}`);
  }
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
