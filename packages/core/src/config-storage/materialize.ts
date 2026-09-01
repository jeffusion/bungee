import type {
  ConfigurationAggregateV2,
  PluginBindingV2,
  RouteV2,
  ServiceV2,
  UpstreamV2,
} from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { canonicalJson } from './content-hash';

type BindingOwner =
  | { readonly kind: 'global'; readonly id: '' }
  | { readonly kind: 'service'; readonly id: string }
  | { readonly kind: 'route'; readonly id: string }
  | { readonly kind: 'upstream'; readonly id: string };

function writeBindings(db: Database, bindings: readonly PluginBindingV2[], owner: BindingOwner): void {
  for (const binding of bindings) {
    db.run(`INSERT INTO plugin_bindings
      (id,scope_kind,scope_owner,service_id,route_id,upstream_id,position,plugin_name,options_json,enabled)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      binding.id,
      owner.kind,
      owner.id,
      owner.kind === 'service' ? owner.id : null,
      owner.kind === 'route' ? owner.id : null,
      owner.kind === 'upstream' ? owner.id : null,
      binding.position,
      binding.name,
      binding.options === undefined ? null : canonicalJson(binding.options),
      binding.enabled ? 1 : 0,
    ]);
  }
}

function upstreamPolicy(upstream: UpstreamV2): Record<string, unknown> {
  const { id, position, target, weight, priority, is_disabled, plugins, ...policy } = upstream;
  return policy;
}

function writeUpstreams(
  db: Database,
  upstreams: readonly UpstreamV2[],
  owner: { readonly kind: 'service' | 'route'; readonly id: string },
): void {
  for (const upstream of upstreams) {
    db.run(`INSERT INTO upstreams
      (id,owner_kind,service_id,route_id,position,target,weight,priority,is_disabled,policy_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      upstream.id,
      owner.kind,
      owner.kind === 'service' ? owner.id : null,
      owner.kind === 'route' ? owner.id : null,
      upstream.position,
      upstream.target,
      upstream.weight,
      upstream.priority,
      upstream.is_disabled ? 1 : 0,
      canonicalJson(upstreamPolicy(upstream)),
    ]);
    writeBindings(db, upstream.plugins, { kind: 'upstream', id: upstream.id });
  }
}

function servicePolicy(service: ServiceV2): Record<string, unknown> {
  const { id, position, name, endpoints, plugins, ...policy } = service;
  return policy;
}

function routePolicy(route: RouteV2): Record<string, unknown> {
  const { id, position, path, plugins, ...remainder } = route;
  if ('service_id' in remainder) {
    const { service_id, ...policy } = remainder;
    return policy;
  }
  const { endpoints, ...policy } = remainder;
  return policy;
}

function writeServices(db: Database, services: readonly ServiceV2[]): void {
  for (const service of services) {
    db.run('INSERT INTO services (id,position,name,policy_json) VALUES (?,?,?,?)', [
      service.id, service.position, service.name, canonicalJson(servicePolicy(service)),
    ]);
    writeUpstreams(db, service.endpoints, { kind: 'service', id: service.id });
    writeBindings(db, service.plugins, { kind: 'service', id: service.id });
  }
}

function writeRoutes(db: Database, routes: readonly RouteV2[]): void {
  for (const route of routes) {
    const serviceId = typeof route.service_id === 'string' ? route.service_id : null;
    db.run('INSERT INTO routes (id,position,path,service_id,policy_json) VALUES (?,?,?,?,?)', [
      route.id, route.position, route.path, serviceId, canonicalJson(routePolicy(route)),
    ]);
    if (route.endpoints !== undefined) writeUpstreams(db, route.endpoints, { kind: 'route', id: route.id });
    writeBindings(db, route.plugins, { kind: 'route', id: route.id });
  }
}

export function replaceActiveMaterialization(db: Database, aggregate: ConfigurationAggregateV2): void {
  db.run('DELETE FROM plugin_bindings');
  db.run('DELETE FROM plugin_activations');
  db.run('DELETE FROM upstreams');
  db.run('DELETE FROM routes');
  db.run('DELETE FROM services');
  db.run('DELETE FROM settings');
  const logical = aggregate.logical_configuration;
  db.run(`INSERT INTO settings
    (id,log_level,body_parser_limit,auth_json,logging_json) VALUES (1,?,?,?,?)`, [
    logical.log_level ?? null,
    logical.body_parser_limit ?? null,
    logical.auth === undefined ? null : canonicalJson(logical.auth),
    logical.logging === undefined ? null : canonicalJson(logical.logging),
  ]);
  writeServices(db, logical.services);
  writeRoutes(db, logical.routes);
  writeBindings(db, logical.plugins, { kind: 'global', id: '' });
  for (const activation of aggregate.plugin_activations) {
    db.run('INSERT INTO plugin_activations (plugin_name) VALUES (?)', [activation.plugin_name]);
  }
}
