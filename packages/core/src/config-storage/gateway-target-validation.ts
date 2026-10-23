import type { LogicalConfiguration, PluginBinding } from '@jeffusion/bungee-types';
import type { ReadonlyPluginConfigField } from '../plugin-manifest-catalog/types';
import type { PluginSchemaCatalog } from './plugin-schema';
import type { ValidationContext } from './validation';

/** Native references are always checked; plugin edges require the trusted compile catalog. */
export function validateGatewayTargets(config: LogicalConfiguration, schemas: PluginSchemaCatalog | undefined, context: ValidationContext): void {
  const routes = new Map(config.routes.map(route => [route.id,route]));
  const services = new Map(config.services.map(service => [service.id,service]));
  const edges = new Map<string, Set<string>>();
  const visit = (value: unknown, field: ReadonlyPluginConfigField, owner: string, path: string): void => {
    if (field.type === 'gateway_target' && value && typeof value === 'object') {
      const target = value as {type:string;id:string;protocol?:string};
      const entity = (target.type === 'route' ? routes : services).get(target.id);
      if (!entity) context.add('invalid_value',path,'Dispatch target does not exist');
      else if (!target.protocol) context.add('invalid_value',path,'Dispatch target requires an explicit receiving protocol');
      const refs = edges.get(owner) ?? new Set<string>(); refs.add(`${target.type}:${target.id}`); edges.set(owner,refs);
    } else if (field.type === 'array' && field.items && Array.isArray(value)) value.forEach((item,index) => visit(item,field.items!,owner,`${path}[${index}]`));
    else if (field.type === 'object' && field.properties && value && typeof value === 'object') {
      for (const property of field.properties) visit((value as Record<string,unknown>)[property.name],property,owner,`${path}.${property.name}`);
    }
  };
  const bindings = (plugins: readonly PluginBinding[], owner: string, path: string) => {
    plugins.forEach((plugin,index) => {
      if (!plugin.enabled) return;
      for (const field of schemas?.get(plugin.name) ?? []) visit(plugin.options?.[field.name],field,owner,`${path}[${index}].options.${field.name}`);
    });
  };
  const references = (values: readonly import('@jeffusion/bungee-types').ServiceReference[] | undefined,
    owner: string, path: string): void => {
    for (const [index, reference] of (values ?? []).entries()) {
      const target = `service:${reference.service_id}`;
      if (!services.has(reference.service_id)) context.add('unknown_service', `${path}[${index}].service_id`, 'Service does not exist');
      if (target === owner) context.add('invalid_value', `${path}[${index}].service_id`, 'Service cannot reference itself');
      const refs = edges.get(owner) ?? new Set<string>();
      refs.add(target); edges.set(owner, refs);
    }
  };
  config.routes.forEach((route,index) => {
    const owner = `route:${route.id}`;
    bindings(route.plugins,owner,`routes[${index}].plugins`);
    references(route.service_references, owner, `routes[${index}].service_references`);
    route.endpoints?.forEach((upstream,i) => bindings(upstream.plugins,owner,`routes[${index}].endpoints[${i}].plugins`));
  });
  config.services.forEach((service,index) => {
    const owner = `service:${service.id}`;
    bindings(service.plugins,owner,`services[${index}].plugins`);
    references(service.service_references, owner, `services[${index}].service_references`);
    service.endpoints.forEach((upstream,i) => bindings(upstream.plugins,owner,`services[${index}].endpoints[${i}].plugins`));
  });
  const incoming = new Map<string, number>();
  for (const [owner, targets] of edges) {
    if (!incoming.has(owner)) incoming.set(owner, 0);
    for (const target of targets) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([owner]) => owner);
  for (let index = 0; index < ready.length; index++) {
    for (const target of edges.get(ready[index]!) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (ready.length !== incoming.size) context.add('invalid_value', 'routes', 'Internal dispatch cycle');
}
