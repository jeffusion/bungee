import { pluginConfigConstraintSatisfied } from '@jeffusion/bungee-types';
import { validateGatewayTargets } from './gateway-target-validation';
import type {
  LogicalConfiguration, ServiceReference, PluginBinding, ConfigurationRoute, ConfigurationService, UpstreamManagedBy, ConfigurationUpstream,
} from '@jeffusion/bungee-types';
import {
  validateRouteDomain, validateServiceDomain, validateUpstreamDomain,
} from './domain-validation';
import { validateGlobalPolicies } from './global-validation';
import { preflightJsonGraph } from './json-preflight';
import { isPluginName } from './plugin-name';
import {
  type ConfigurationCompileOptions,
  type PluginSchemaCatalog,
  validatePluginOptions,
} from './plugin-schema';
import {
  copyJsonValue,
  copyKnown,
  type ConfigurationResult,
  type JsonObject,
  isLowercaseUuid,
  isObject,
  normalizePositions,
  rejectUnknownFields,
  ValidationContext,
} from './validation';

const GLOBAL_KEYS = ['log_level', 'body_parser_limit', 'auth', 'logging', 'publication'] as const;
const SERVICE_KEYS = ['health_check', 'failover', 'load_balancing'] as const;
const ROUTE_KEYS = ['request', 'response', 'path_rewrite', 'auth', 'timeouts', 'rate_limit', 'cors',
  'response_rules', 'direct_response', 'redirect', 'retry', 'websocket', 'load_balancing', 'failover'] as const;
const UPSTREAM_KEYS = ['request', 'response', 'description', 'condition'] as const;
const ENTITY_KEYS = ['id', 'position', 'plugins'] as const;

function allowed(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}
const ROOT_FIELDS = allowed(GLOBAL_KEYS, ['services', 'routes', 'plugins']);
const PLUGIN_FIELDS = allowed(ENTITY_KEYS, ['name', 'options', 'enabled', 'path']);
const SERVICE_FIELDS = allowed(ENTITY_KEYS, SERVICE_KEYS, ['name', 'endpoints', 'service_references']);
const ROUTE_FIELDS = allowed(ENTITY_KEYS, ROUTE_KEYS, ['path', 'service_references', 'endpoints']);
const UPSTREAM_FIELDS = allowed(ENTITY_KEYS, UPSTREAM_KEYS, [
  'target', 'weight', 'priority', 'is_disabled', 'route_id', 'service_id',
  'managedBy',
]);

const MANAGED_BY_FIELDS = new Set(['plugin', 'contributionId', 'bindingId']);

function parseManagedBy(
  value: unknown,
  path: string,
  plugins: readonly PluginBinding[],
  context: ValidationContext,
): UpstreamManagedBy | undefined {
  if (value === undefined) return undefined;
  const object = context.object(value, path);
  if (!object) return undefined;
  rejectUnknownFields(object, MANAGED_BY_FIELDS, path, context);
  const plugin = context.string(object, 'plugin', `${path}.plugin`);
  const contributionId = context.string(object, 'contributionId', `${path}.contributionId`);
  const bindingId = context.string(object, 'bindingId', `${path}.bindingId`);
  const matches = plugins.filter((binding) => binding.id === bindingId && binding.name === plugin);
  if (matches.length !== 1) {
    context.add('invalid_value', path, 'managedBy must match exactly one plugin binding on this upstream');
  }
  return { plugin, contributionId, bindingId };
}

function parsePlugins(
  value: unknown,
  path: string,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
  present = false,
): PluginBinding[] {
  const plugins: PluginBinding[] = [];
  const candidates = context.array(value, path, present);
  const positions = normalizePositions(candidates, path, context);
  candidates.forEach((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return;
    rejectUnknownFields(object, PLUGIN_FIELDS, itemPath, context);
    const id = context.id(object, `${itemPath}.id`);
    const name = context.string(object, 'name', `${itemPath}.name`);
    if (!isPluginName(name)) {
      context.add('invalid_value', `${itemPath}.name`, 'Plugin name must use lowercase ASCII letters, digits, and single hyphens');
    }
    if ('path' in object) context.add('plugin_path_forbidden', `${itemPath}.path`, 'Plugin paths are forbidden');
    let options: PluginBinding['options'];
    if (object.options !== undefined) {
      const cloned = copyJsonValue(object.options, `${itemPath}.options`, context);
      if (isObject(cloned)) options = cloned;
      else if (cloned !== undefined) context.add('invalid_type', `${itemPath}.options`, 'Expected a JSON object');
    }
    if (catalog !== undefined && (object.options === undefined || options !== undefined)) {
      validatePluginOptions(name, options, itemPath, catalog, context);
    }
    const enabled = booleanDefault(object, 'enabled', true, itemPath, context);
    plugins.push({ id, position: context.position(object, positions[index]!, `${itemPath}.position`),
      name, ...(options ? { options } : {}), enabled });
  });
  return plugins.sort((left, right) => left.position - right.position);
}

function numberDefault(
  object: JsonObject,
  key: string,
  fallback: number,
  path: string,
  context: ValidationContext,
): number {
  const value = object[key];
  if (!(key in object)) return fallback;
  if (value === undefined) {
    context.add('non_json_value', `${path}.${key}`, 'Expected a JSON number');
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'number') context.add('non_json_value', `${path}.${key}`, 'Expected a JSON number');
  else context.add('invalid_type', `${path}.${key}`, 'Expected a number');
  return fallback;
}
function booleanDefault(
  object: JsonObject,
  key: string,
  fallback: boolean,
  path: string,
  context: ValidationContext,
): boolean {
  const value = object[key];
  if (!(key in object)) return fallback;
  if (value === undefined) {
    context.add('non_json_value', `${path}.${key}`, 'Expected a JSON boolean');
    return fallback;
  }
  if (typeof value === 'boolean') return value;
  context.add('invalid_type', `${path}.${key}`, 'Expected a boolean');
  return fallback;
}
function parseUpstreams(
  value: unknown,
  path: string,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
  present = false,
  sharedPositions?: readonly number[],
): ConfigurationUpstream[] {
  const upstreams: ConfigurationUpstream[] = [];
  const candidates = context.array(value, path, present);
  const positions = sharedPositions ?? normalizePositions(candidates, path, context);
  candidates.forEach((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return;
    rejectUnknownFields(object, UPSTREAM_FIELDS, itemPath, context);
    validateUpstreamDomain(object, itemPath, context);
    for (const owner of ['route_id', 'service_id'] as const) {
      if (owner in object) context.add('conflicting_owner', `${itemPath}.${owner}`, 'Ownership is defined by nesting');
    }
    const plugins = parsePlugins(object.plugins, `${itemPath}.plugins`, catalog, context, 'plugins' in object);
    const managedBy = parseManagedBy(object.managedBy, `${itemPath}.managedBy`, plugins, context);
    upstreams.push({
      ...copyKnown(object, UPSTREAM_KEYS, itemPath, context),
      id: context.id(object, `${itemPath}.id`),
      position: context.position(object, positions[index]!, `${itemPath}.position`),
      target: context.string(object, 'target', `${itemPath}.target`),
      weight: numberDefault(object, 'weight', 100, itemPath, context),
      priority: numberDefault(object, 'priority', 1, itemPath, context),
      is_disabled: booleanDefault(object, 'is_disabled', false, itemPath, context),
      ...(managedBy === undefined ? {} : { managedBy }),
      plugins,
    });
  });
  return upstreams.sort((left, right) => left.position - right.position);
}
const REFERENCE_FIELDS = new Set(['id', 'position', 'service_id', 'weight', 'priority', 'is_disabled']);

function parseReferences(value: unknown, path: string, context: ValidationContext,
  positions?: readonly number[], present = false): ServiceReference[] {
  const candidates = context.array(value, path, present);
  const normalized = positions ?? normalizePositions(candidates, path, context);
  const targets = new Set<string>();
  return candidates.flatMap((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return [];
    rejectUnknownFields(object, REFERENCE_FIELDS, itemPath, context);
    const serviceId = context.string(object, 'service_id', `${itemPath}.service_id`);
    if (!isLowercaseUuid(serviceId)) context.add('invalid_uuid', `${itemPath}.service_id`, 'Expected a lowercase UUID');
    if (targets.has(serviceId)) context.add('invalid_value', `${itemPath}.service_id`, 'Service reference must be unique within its owner');
    targets.add(serviceId);
    for (const key of ['weight', 'priority']) if (typeof object[key] === 'number' && object[key] <= 0) {
      context.add('invalid_positive_number', `${itemPath}.${key}`, 'Expected a positive number');
    }
    return [{ id: context.id(object, `${itemPath}.id`),
      position: context.position(object, normalized[index]!, `${itemPath}.position`),
      service_id: serviceId, weight: numberDefault(object, 'weight', 100, itemPath, context),
      priority: numberDefault(object, 'priority', 1, itemPath, context),
      is_disabled: booleanDefault(object, 'is_disabled', false, itemPath, context) }];
  }).sort((left, right) => left.position - right.position);
}

function parseServices(
  value: unknown,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
): ConfigurationService[] {
  const services: ConfigurationService[] = [];
  const names = new Set<string>();
  const candidates = context.array(value, 'services', value !== undefined);
  const positions = normalizePositions(candidates, 'services', context);
  candidates.forEach((candidate, index) => {
    const path = `services[${index}]`;
    const object = context.object(candidate, path);
    if (!object) return;
    rejectUnknownFields(object, SERVICE_FIELDS, path, context);
    const id = context.id(object, `${path}.id`);
    const name = context.string(object, 'name', `${path}.name`);
    if (names.has(name)) context.add('duplicate_name', `${path}.name`, 'Service name must be unique');
    else names.add(name);
    const endpointCandidates = Array.isArray(object.endpoints) ? object.endpoints : [];
    const referenceCandidates = Array.isArray(object.service_references) ? object.service_references : [];
    const sharedPositions = normalizePositions([...endpointCandidates, ...referenceCandidates], path, context,
      index => index < endpointCandidates.length ? `${path}.endpoints[${index}]`
        : `${path}.service_references[${index - endpointCandidates.length}]`);
    const references = parseReferences(object.service_references, `${path}.service_references`, context,
      sharedPositions.slice(endpointCandidates.length), 'service_references' in object);
    const endpointCount = endpointCandidates.length + references.length;
    const policies = copyKnown(object, SERVICE_KEYS, path, context);
    validateServiceDomain(object, path, endpointCount, context);
    services.push({
      ...policies,
      id,
      position: context.position(object, positions[index]!, `${path}.position`),
      name,
      endpoints: parseUpstreams(object.endpoints, `${path}.endpoints`, catalog, context, 'endpoints' in object, sharedPositions),
      ...(references.length ? { service_references: references } : {}),
      plugins: parsePlugins(object.plugins, `${path}.plugins`, catalog, context, 'plugins' in object),
    });
  });
  return services.sort((left, right) => left.position - right.position);
}
function parseRoutes(
  value: unknown,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
): ConfigurationRoute[] {
  const routes: ConfigurationRoute[] = [];
  const paths = new Set<string>();
  const candidates = context.array(value, 'routes', value !== undefined);
  const positions = normalizePositions(candidates, 'routes', context);
  candidates.forEach((candidate, index) => {
    const itemPath = `routes[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return;
    rejectUnknownFields(object, ROUTE_FIELDS, itemPath, context);
    const id = context.id(object, `${itemPath}.id`);
    const path = context.string(object, 'path', `${itemPath}.path`);
    if (paths.has(path)) context.add('duplicate_path', `${itemPath}.path`, 'Route path must be unique');
    else paths.add(path);
    const references = parseReferences(object.service_references, `${itemPath}.service_references`, context, undefined, 'service_references' in object);
    const hasService = references.length > 0;
    if ('service_references' in object && !hasService) context.add('invalid_value', `${itemPath}.service_references`, 'Service route requires at least one reference');
    const endpointCount = Array.isArray(object.endpoints) ? object.endpoints.length : 0;
    const policies = copyKnown(object, ROUTE_KEYS, itemPath, context);
    validateRouteDomain(object, itemPath, hasService, endpointCount, context);
    if (hasService && object.endpoints !== undefined) {
      context.add('conflicting_owner', `${itemPath}.endpoints`, 'A service route cannot own upstreams');
    }
    const base = {
      ...policies,
      id,
      position: context.position(object, positions[index]!, `${itemPath}.position`),
      path,
      plugins: parsePlugins(object.plugins, `${itemPath}.plugins`, catalog, context, 'plugins' in object),
    };
    if (hasService) routes.push({ ...base, service_references: references as [ServiceReference, ...ServiceReference[]] });
    else routes.push({ ...base, endpoints: parseUpstreams(object.endpoints, `${itemPath}.endpoints`, catalog,
      context, 'endpoints' in object) });
  });
  return routes.sort((left, right) => left.position - right.position);
}
export function parseNormalizeCompile(
  input: unknown,
  options?: ConfigurationCompileOptions,
): ConfigurationResult<LogicalConfiguration> {
  const context = new ValidationContext();
  const safeInput = preflightJsonGraph(input, context);
  if (context.errors.length) return { ok: false, errors: context.errors };
  const root = context.object(safeInput, '') ?? {};
  if (options?.rejectLegacyAuth) {
    if (Object.hasOwn(root, 'auth')) context.add('invalid_auth', 'auth', 'Shared auth has been removed; manage independent API Keys instead');
    if (Array.isArray(root.routes)) root.routes.forEach((route, index) => {
      if (isObject(route) && Object.hasOwn(route, 'auth')) context.add('invalid_auth', `routes[${index}].auth`, 'Route auth has been removed; use Key policy plugins instead');
    });
  }
  rejectUnknownFields(root, ROOT_FIELDS, '', context);
  const policies = copyKnown(root, GLOBAL_KEYS, '', context);
  validateGlobalPolicies(root, context);
  const catalog = options?.availablePlugins === undefined
    ? options?.pluginSchemas
    : new Map([...options.pluginSchemas].filter(([name]) => options.availablePlugins?.has(name)));
  const plugins = parsePlugins(root.plugins, 'plugins', catalog, context, 'plugins' in root);
  const services = parseServices(root.services, catalog, context);
  const value: LogicalConfiguration = {
    ...policies,
    services,
    routes: parseRoutes(root.routes, catalog, context),
    plugins,
  };
  validateGatewayTargets(value, catalog, context);
  if (options?.pluginConstraints) {
    const validate = (bindings: readonly PluginBinding[], path: string): void => {
      bindings.forEach((binding, index) => {
        for (const constraint of options.pluginConstraints!.get(binding.name) ?? []) {
          if (!pluginConfigConstraintSatisfied(binding.options ?? {}, constraint)) {
            context.add('invalid_plugin_option', `${path}[${index}].options`, constraint.message ?? 'Plugin option tuple is not allowed');
          }
        }
      });
    };
    validate(plugins, 'plugins');
    services.forEach((service, index) => {
      validate(service.plugins, `services[${index}].plugins`);
      service.endpoints.forEach((endpoint, i) => validate(endpoint.plugins, `services[${index}].endpoints[${i}].plugins`));
    });
    value.routes.forEach((route, index) => {
      validate(route.plugins, `routes[${index}].plugins`);
      if ('endpoints' in route) route.endpoints?.forEach((endpoint, i) => validate(endpoint.plugins, `routes[${index}].endpoints[${i}].plugins`));
    });
  }
  if (options?.globalPlugins) {
    const validateScopedBindings = (bindings: readonly PluginBinding[], path: string): void => {
      bindings.forEach((binding, index) => {
        if (options.globalPlugins!.has(binding.name)) {
          context.add('invalid_value', `${path}[${index}].name`, 'Global provider plugins cannot be bound to route, service, or upstream scopes');
        }
      });
    };
    services.forEach((service, index) => {
      validateScopedBindings(service.plugins, `services[${index}].plugins`);
      service.endpoints.forEach((endpoint, upstreamIndex) =>
        validateScopedBindings(endpoint.plugins, `services[${index}].endpoints[${upstreamIndex}].plugins`));
    });
    value.routes.forEach((route, index) => {
      validateScopedBindings(route.plugins, `routes[${index}].plugins`);
      if ('endpoints' in route) route.endpoints?.forEach((endpoint, upstreamIndex) =>
        validateScopedBindings(endpoint.plugins, `routes[${index}].endpoints[${upstreamIndex}].plugins`));
    });
  }
  return context.errors.length ? { ok: false, errors: context.errors } : { ok: true, value };
}
