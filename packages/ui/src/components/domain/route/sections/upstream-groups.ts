import type { Route, Service, Upstream } from '$api/routes';
import type { ServiceReference } from '@jeffusion/bungee-types';

export type TargetOwner = Pick<Route, 'endpoints' | 'service_references'>;
export type TargetRow = { key: string; priority: number; position: number } & (
  | { kind: 'endpoint'; endpoint: Upstream; originalIndex: number }
  | { kind: 'service'; reference: ServiceReference }
);
export interface PriorityGroup {
  priority: number;
  groupIndex: number;
  targets: TargetRow[];
}
export type DropDestination = { groupIndex: number; targetKey?: string; after?: boolean } | { insertIndex: number };

export function groupTargets(owner: TargetOwner, services: Service[] = [], searchTerm = ''): PriorityGroup[] {
  const targets: TargetRow[] = [
    ...(owner.endpoints ?? []).map((endpoint, originalIndex) => ({
      kind: 'endpoint' as const, endpoint, originalIndex, key: `endpoint:${endpoint._uid}`,
      priority: endpoint.priority ?? 1, position: endpoint._position ?? originalIndex,
    })),
    ...(owner.service_references ?? []).map(reference => ({
      kind: 'service' as const, reference, key: `service:${reference.id}`,
      priority: reference.priority, position: reference.position,
    })),
  ].sort((a, b) => a.priority - b.priority || a.position - b.position);
  const groups: PriorityGroup[] = [];
  for (const target of targets) {
    let group = groups.at(-1);
    if (!group || group.priority !== target.priority) {
      group = { priority: target.priority, groupIndex: groups.length, targets: [] };
      groups.push(group);
    }
    group.targets.push(target);
  }
  const query = searchTerm.trim().toLowerCase();
  if (!query) return groups;
  // Search is only a projection; drag destinations retain full-list boundaries.
  return groups.map(group => ({ ...group, targets: group.targets.filter(target => {
    const values = target.kind === 'endpoint' ? [target.endpoint.target, target.endpoint.description]
      : [target.reference.service_id, services.find(service => service._uid === target.reference.service_id)?.name];
    return values.some(value => value?.toLowerCase().includes(query));
  }) })).filter(group => group.targets.length > 0);
}

export function moveTarget(owner: TargetOwner, key: string, destination: DropDestination): TargetOwner {
  const groups = groupTargets(owner);
  const source = groups.find(group => group.targets.some(target => target.key === key));
  const moved = source?.targets.find(target => target.key === key);
  if (!source || !moved) return owner;
  if ('insertIndex' in destination) {
    if (!Number.isInteger(destination.insertIndex) || destination.insertIndex < 0 || destination.insertIndex > groups.length) return owner;
    const insertionIndex = groups.slice(0, destination.insertIndex).filter(group => group !== source || group.targets.length > 1).length;
    source.targets = source.targets.filter(target => target.key !== key);
    const remaining = groups.filter(group => group.targets.length > 0);
    remaining.splice(insertionIndex, 0, { priority: 0, groupIndex: 0, targets: [moved] });
    groups.splice(0, groups.length, ...remaining);
  } else {
    const targetGroup = groups[destination.groupIndex];
    if (!targetGroup || destination.targetKey === key) return owner;
    if (destination.targetKey && !targetGroup.targets.some(target => target.key === destination.targetKey)) return owner;
    source.targets = source.targets.filter(target => target.key !== key);
    const index = destination.targetKey
      ? targetGroup.targets.findIndex(target => target.key === destination.targetKey) + (destination.after ? 1 : 0)
      : targetGroup.targets.length;
    targetGroup.targets.splice(index, 0, moved);
  }
  const endpoints: Upstream[] = [], references: ServiceReference[] = [];
  let position = 0;
  groups.filter(group => group.targets.length > 0).forEach((group, index) => {
    for (const target of group.targets) {
      if (target.kind === 'endpoint') endpoints.push({ ...target.endpoint, priority: index + 1, _position: position++ });
      else references.push({ ...target.reference, priority: index + 1, position: position++ });
    }
  });
  return {
    ...(owner.endpoints === undefined ? {} : { endpoints }),
    ...(owner.service_references === undefined ? {} : { service_references: references }),
  };
}
