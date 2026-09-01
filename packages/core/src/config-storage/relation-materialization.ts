import { parseCanonicalObject, type PersistedJsonObject } from './persisted-json';
import {
  requireBooleanInteger,
  requireOneOf,
  requirePluginName,
  requirePositiveFinite,
  requireSafeInteger,
  requireUuid,
} from './persisted-validation';
import { ConfigRepositoryError } from './repository-types';

export type RelationValue = PersistedJsonObject;
export type RelationGroups = Map<string, readonly RelationValue[]>;

export type UpstreamRow = {
  readonly id: string; readonly owner_kind: string; readonly service_id: string | null; readonly route_id: string | null;
  readonly position: number; readonly target: string; readonly weight: number; readonly priority: number;
  readonly is_disabled: number; readonly policy_json: string;
};
export type BindingRow = {
  readonly id: string; readonly scope_kind: string; readonly scope_owner: string; readonly position: number;
  readonly service_id: string | null; readonly route_id: string | null; readonly upstream_id: string | null;
  readonly plugin_name: string; readonly options_json: string | null; readonly enabled: number;
};

const UPSTREAM_RESERVED = new Set(['id', 'position', 'target', 'weight', 'priority', 'is_disabled', 'plugins']);

function bindingValue(row: BindingRow): RelationValue {
  requireUuid(row.id, 'plugin_bindings.id');
  const scopeKind = requireOneOf(row.scope_kind, ['global', 'service', 'route', 'upstream'], 'plugin_bindings.scope_kind');
  const compatibleOwner = scopeKind === 'global'
    ? row.scope_owner === '' && row.service_id === null && row.route_id === null && row.upstream_id === null
    : scopeKind === 'service'
      ? row.scope_owner === row.service_id && row.service_id !== null && row.route_id === null && row.upstream_id === null
      : scopeKind === 'route'
        ? row.scope_owner === row.route_id && row.route_id !== null && row.service_id === null && row.upstream_id === null
        : row.scope_owner === row.upstream_id && row.upstream_id !== null && row.service_id === null && row.route_id === null;
  if (!compatibleOwner) throw new ConfigRepositoryError('schema_corrupt', 'plugin binding owner is invalid');
  if (scopeKind !== 'global') requireUuid(row.scope_owner, 'plugin_bindings.scope_owner');
  return {
    id: row.id,
    position: requireSafeInteger(row.position, 'plugin_bindings.position'),
    name: requirePluginName(row.plugin_name, 'plugin_bindings.plugin_name'),
    ...(row.options_json === null ? {} : { options: parseCanonicalObject(row.options_json, 'options_json') }),
    enabled: requireBooleanInteger(row.enabled, 'plugin_bindings.enabled'),
  };
}

export function groupBindings(rows: readonly BindingRow[]): RelationGroups {
  const groups = new Map<string, RelationValue[]>();
  for (const row of rows) {
    const key = `${row.scope_kind}:${row.scope_owner}`;
    const values = groups.get(key) ?? [];
    values.push(bindingValue(row));
    groups.set(key, values);
  }
  return groups;
}

export function takeGroup(groups: RelationGroups, key: string): readonly RelationValue[] {
  const values = groups.get(key) ?? [];
  groups.delete(key);
  return values;
}

export function groupUpstreams(rows: readonly UpstreamRow[], bindings: RelationGroups): RelationGroups {
  const groups = new Map<string, RelationValue[]>();
  for (const row of rows) {
    requireUuid(row.id, 'upstreams.id');
    const ownerKind = requireOneOf(row.owner_kind, ['service', 'route'], 'upstreams.owner_kind');
    if ((ownerKind === 'service' && row.route_id !== null) || (ownerKind === 'route' && row.service_id !== null)) {
      throw new ConfigRepositoryError('schema_corrupt', 'upstream has incompatible owners');
    }
    const ownerId = ownerKind === 'service' ? row.service_id : row.route_id;
    if (ownerId === null) throw new ConfigRepositoryError('schema_corrupt', 'upstream owner is missing');
    requireUuid(ownerId, 'upstreams.owner_id');
    const key = `${ownerKind}:${ownerId}`;
    const values = groups.get(key) ?? [];
    values.push({
      ...parseCanonicalObject(row.policy_json, 'upstream policy_json', UPSTREAM_RESERVED),
      id: row.id,
      position: requireSafeInteger(row.position, 'upstreams.position'),
      target: row.target,
      weight: requirePositiveFinite(row.weight, 'upstreams.weight'),
      priority: requirePositiveFinite(row.priority, 'upstreams.priority'),
      is_disabled: requireBooleanInteger(row.is_disabled, 'upstreams.is_disabled'),
      plugins: takeGroup(bindings, `upstream:${row.id}`),
    });
    groups.set(key, values);
  }
  return groups;
}
