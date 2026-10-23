import type { ServiceReference } from '@jeffusion/bungee-types';
import type { Service } from '$api/routes';
import type { ValidationError } from './route-validator';

/** Validate the graph against the current draft, including disabled edges. */
export function validateServiceReferences(
  references: readonly ServiceReference[] = [], services: readonly Service[] = [], owner?: Service,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const graph = new Map(services.filter(service => service._uid).map(service => [service._uid!, service]));
  if (owner?._uid) graph.set(owner._uid, owner);
  const walk = (refs: readonly ServiceReference[], path: Set<string>, field: string) => {
    const used = new Set<string>();
    for (const reference of refs) {
      const target = graph.get(reference.service_id);
      if (used.has(reference.service_id)) errors.push({ field, message: `重复引用服务：${target?.name ?? reference.service_id}` });
      used.add(reference.service_id);
      if (!Number.isSafeInteger(reference.priority) || reference.priority < 1 || !Number.isSafeInteger(reference.weight) || reference.weight < 1) {
        errors.push({ field, message: '服务引用的优先级和权重必须是正整数' });
      }
      if (!target) { errors.push({ field, message: `引用的服务不存在：${reference.service_id}` }); continue; }
      if (path.has(reference.service_id)) { errors.push({ field, message: `服务引用形成循环：${target.name}` }); continue; }
      walk(target.service_references ?? [], new Set([...path, reference.service_id]), field);
    }
  };
  walk(references, new Set(owner?._uid ? [owner._uid] : []), 'service_references');
  return errors;
}
