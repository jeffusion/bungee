import type { PluginConfigField } from '../plugin.types';
import type { GatewayDispatchTarget } from './contracts';

/** Extract references only from the trusted schema, never from arbitrary request JSON. */
export function declaredDispatchTargets(options: Record<string, unknown>, fields: readonly PluginConfigField[]): GatewayDispatchTarget[] {
  const result: GatewayDispatchTarget[] = [];
  const walk = (value: unknown, field: PluginConfigField) => {
    if (field.type === 'gateway_target' && value && typeof value === 'object') {
      const target = value as GatewayDispatchTarget;
      if (['route','service'].includes(target.type) && typeof target.id === 'string') result.push({type:target.type,id:target.id});
    } else if (field.type === 'array' && field.items && Array.isArray(value)) value.forEach(item => walk(item,field.items!));
    else if (field.type === 'object' && field.properties && value && typeof value === 'object')
      field.properties.forEach(property => walk((value as Record<string,unknown>)[property.name],property));
  };
  fields.forEach(field => walk(options[field.name],field));
  return result;
}
