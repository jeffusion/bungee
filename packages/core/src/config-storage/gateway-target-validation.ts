import type { LogicalConfigurationV2, PluginBindingV2 } from '@jeffusion/bungee-types';
import type { ReadonlyPluginConfigField } from '../plugin-manifest-catalog/types';
import type { PluginSchemaCatalog } from './plugin-schema';
import type { ValidationContext } from './validation';

/** Only schema-declared references participate. Client JSON and headers never supply targets. */
export function validateGatewayTargets(config: LogicalConfigurationV2, schemas: PluginSchemaCatalog | undefined, context: ValidationContext): void {
  if (!schemas) return;
  const routes = new Map(config.routes.map(route => [route.id,route]));
  const services = new Map(config.services.map(service => [service.id,service]));
  const edges = new Map<string, Set<string>>();
  const visit = (value: unknown, field: ReadonlyPluginConfigField, owner: string, path: string): void => {
    if (field.type === 'gateway_target' && value && typeof value === 'object') {
      const target = value as {type:string;id:string;protocol?:string};
      const entity = (target.type === 'route' ? routes : services).get(target.id);
      if (!entity) context.add('invalid_value',path,'Dispatch target does not exist');
      else if (!target.protocol && !entity.llm_protocol) context.add('invalid_value',path,'Dispatch target requires an explicit receiving protocol');
      const refs = edges.get(owner) ?? new Set<string>(); refs.add(`${target.type}:${target.id}`); edges.set(owner,refs);
    } else if (field.type === 'array' && field.items && Array.isArray(value)) value.forEach((item,index) => visit(item,field.items!,owner,`${path}[${index}]`));
    else if (field.type === 'object' && field.properties && value && typeof value === 'object') {
      for (const property of field.properties) visit((value as Record<string,unknown>)[property.name],property,owner,`${path}.${property.name}`);
    }
  };
  const bindings = (plugins: readonly PluginBindingV2[], owner: string, path: string) => {
    plugins.forEach((plugin,index) => {
      if (!plugin.enabled) return;
      for (const field of schemas.get(plugin.name) ?? []) visit(plugin.options?.[field.name],field,owner,`${path}[${index}].options.${field.name}`);
    });
  };
  config.routes.forEach((route,index) => {
    const owner = `route:${route.id}`;
    bindings(route.plugins,owner,`routes[${index}].plugins`);
    if (route.service_id) { const refs=edges.get(owner) ?? new Set<string>();refs.add(`service:${route.service_id}`);edges.set(owner,refs); }
  });
  config.services.forEach((service,index) => bindings(service.plugins,`service:${service.id}`,`services[${index}].plugins`));
  const active = new Set<string>(), done = new Set<string>();
  const walk = (owner:string):boolean => {
    if (active.has(owner)) return false;
    if (done.has(owner)) return true;
    active.add(owner);
    for (const target of edges.get(owner) ?? []) if (!walk(target)) return false;
    active.delete(owner);done.add(owner);return true;
  };
  for (const owner of edges.keys()) if (!walk(owner)) {context.add('invalid_value','routes','Internal dispatch cycle');break;}
}
