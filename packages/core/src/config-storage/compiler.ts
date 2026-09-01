import type { LogicalConfigurationV2, PluginBindingV2, RouteV2, ServiceV2, UpstreamV2 } from '@jeffusion/bungee-types';
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

const GLOBAL_KEYS = ['log_level', 'body_parser_limit', 'auth', 'logging'] as const;
const SERVICE_KEYS = ['health_check', 'failover', 'load_balancing', 'timeouts'] as const;
const ROUTE_KEYS = ['headers', 'body', 'query', 'path_rewrite', 'auth', 'timeouts', 'rate_limit', 'cors',
  'response_rules', 'direct_response', 'redirect', 'retry'] as const;
const UPSTREAM_KEYS = ['headers', 'body', 'query', 'description', 'condition'] as const;
const ENTITY_KEYS = ['id', 'position', 'plugins'] as const;

function allowed(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}
const ROOT_FIELDS = allowed(GLOBAL_KEYS, ['services', 'routes', 'plugins']);
const PLUGIN_FIELDS = allowed(ENTITY_KEYS, ['name', 'options', 'enabled', 'path']);
const SERVICE_FIELDS = allowed(ENTITY_KEYS, SERVICE_KEYS, ['name', 'endpoints']);
const ROUTE_FIELDS = allowed(ENTITY_KEYS, ROUTE_KEYS, ['path', 'service_id', 'service', 'endpoints']);
const UPSTREAM_FIELDS = allowed(ENTITY_KEYS, UPSTREAM_KEYS, [
  'target', 'weight', 'priority', 'is_disabled', 'route_id', 'service_id',
]);

function parsePlugins(
  value: unknown,
  path: string,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
  present = false,
): PluginBindingV2[] {
  const plugins: PluginBindingV2[] = [];
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
    let options: PluginBindingV2['options'];
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
): UpstreamV2[] {
  const upstreams: UpstreamV2[] = [];
  const candidates = context.array(value, path, present);
  const positions = normalizePositions(candidates, path, context);
  candidates.forEach((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return;
    rejectUnknownFields(object, UPSTREAM_FIELDS, itemPath, context);
    validateUpstreamDomain(object, itemPath, context);
    for (const owner of ['route_id', 'service_id'] as const) {
      if (owner in object) context.add('conflicting_owner', `${itemPath}.${owner}`, 'Ownership is defined by nesting');
    }
    upstreams.push({
      ...copyKnown(object, UPSTREAM_KEYS, itemPath, context),
      id: context.id(object, `${itemPath}.id`),
      position: context.position(object, positions[index]!, `${itemPath}.position`),
      target: context.string(object, 'target', `${itemPath}.target`),
      weight: numberDefault(object, 'weight', 100, itemPath, context),
      priority: numberDefault(object, 'priority', 1, itemPath, context),
      is_disabled: booleanDefault(object, 'is_disabled', false, itemPath, context),
      plugins: parsePlugins(object.plugins, `${itemPath}.plugins`, catalog, context, 'plugins' in object),
    });
  });
  return upstreams.sort((left, right) => left.position - right.position);
}
function parseServices(
  value: unknown,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
): ServiceV2[] {
  const services: ServiceV2[] = [];
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
    const endpointCount = Array.isArray(object.endpoints) ? object.endpoints.length : 0;
    const policies = copyKnown(object, SERVICE_KEYS, path, context);
    validateServiceDomain(object, path, endpointCount, context);
    services.push({
      ...policies,
      id,
      position: context.position(object, positions[index]!, `${path}.position`),
      name,
      endpoints: parseUpstreams(object.endpoints, `${path}.endpoints`, catalog, context, 'endpoints' in object),
      plugins: parsePlugins(object.plugins, `${path}.plugins`, catalog, context, 'plugins' in object),
    });
  });
  return services.sort((left, right) => left.position - right.position);
}
function parseRoutes(
  value: unknown,
  serviceIds: ReadonlySet<string>,
  catalog: PluginSchemaCatalog | undefined,
  context: ValidationContext,
): RouteV2[] {
  const routes: RouteV2[] = [];
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
    const serviceId = object.service_id;
    const hasService = serviceId !== undefined;
    const endpointCount = Array.isArray(object.endpoints) ? object.endpoints.length : 0;
    const policies = copyKnown(object, ROUTE_KEYS, itemPath, context);
    validateRouteDomain(object, itemPath, hasService, endpointCount, context);
    validateServiceReference(serviceId, itemPath, serviceIds, context);
    if ('service' in object) context.add('invalid_value', `${itemPath}.service`, 'Use service_id');
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
    if (hasService) routes.push({ ...base, service_id: typeof serviceId === 'string' ? serviceId : '' });
    else routes.push({ ...base, endpoints: parseUpstreams(object.endpoints, `${itemPath}.endpoints`, catalog,
      context, 'endpoints' in object) });
  });
  return routes.sort((left, right) => left.position - right.position);
}
function validateServiceReference(
  value: unknown,
  path: string,
  serviceIds: ReadonlySet<string>,
  context: ValidationContext,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') context.add('invalid_type', `${path}.service_id`, 'Expected a UUID string');
  else if (!isLowercaseUuid(value)) context.add('invalid_uuid', `${path}.service_id`, 'Expected a lowercase UUID');
  else if (!serviceIds.has(value)) context.add('unknown_service', `${path}.service_id`, 'Service does not exist');
}

export function parseNormalizeCompile(
  input: unknown,
  options?: ConfigurationCompileOptions,
): ConfigurationResult<LogicalConfigurationV2> {
  const context = new ValidationContext();
  const safeInput = preflightJsonGraph(input, context);
  if (context.errors.length) return { ok: false, errors: context.errors };
  const root = context.object(safeInput, '') ?? {};
  rejectUnknownFields(root, ROOT_FIELDS, '', context);
  const policies = copyKnown(root, GLOBAL_KEYS, '', context);
  validateGlobalPolicies(root, context);
  const catalog = options?.availablePlugins === undefined
    ? options?.pluginSchemas
    : new Map([...options.pluginSchemas].filter(([name]) => options.availablePlugins?.has(name)));
  const plugins = parsePlugins(root.plugins, 'plugins', catalog, context, 'plugins' in root);
  const services = parseServices(root.services, catalog, context);
  const serviceIds = new Set(services.map(({ id }) => id));
  const value: LogicalConfigurationV2 = {
    ...policies,
    services,
    routes: parseRoutes(root.routes, serviceIds, catalog, context),
    plugins,
  };
  return context.errors.length ? { ok: false, errors: context.errors } : { ok: true, value };
}
