import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { parseNormalizeCompileAggregate } from './aggregate';
import { parseCanonicalObject, type PersistedJsonObject } from './persisted-json';
import {
  groupBindings,
  groupUpstreams,
  takeGroup,
  type BindingRow,
  type UpstreamRow,
} from './relation-materialization';
import {
  requireOptionalGlobalScalar,
  requirePluginName,
  requireSafeInteger,
  requireUuid,
} from './persisted-validation';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll } from './sqlite-query';

type SettingsRow = {
  readonly log_level: string | null;
  readonly body_parser_limit: string | null;
  readonly auth_json: string | null;
  readonly logging_json: string | null;
};
type ServiceRow = { readonly id: string; readonly position: number; readonly name: string; readonly policy_json: string };
type RouteRow = { readonly id: string; readonly position: number; readonly path: string; readonly service_id: string | null; readonly policy_json: string };
type ActivationRow = { readonly plugin_name: string };
type JsonObject = PersistedJsonObject;

const SERVICE_RESERVED = new Set(['id', 'position', 'name', 'endpoints', 'plugins']);
const ROUTE_RESERVED = new Set(['id', 'position', 'path', 'service_id', 'service', 'endpoints', 'plugins']);

function readSettings(db: Database): JsonObject {
  const rows = sqliteAll<SettingsRow, []>(db, 'SELECT log_level,body_parser_limit,auth_json,logging_json FROM settings');
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new ConfigRepositoryError('schema_corrupt', 'settings singleton is broken');
  return {
    ...(row.log_level === null ? {} : { log_level: requireOptionalGlobalScalar(row.log_level, 'log_level') }),
    ...(row.body_parser_limit === null ? {} : {
      body_parser_limit: requireOptionalGlobalScalar(row.body_parser_limit, 'body_parser_limit'),
    }),
    ...(row.auth_json === null ? {} : { auth: parseCanonicalObject(row.auth_json, 'auth_json') }),
    ...(row.logging_json === null ? {} : { logging: parseCanonicalObject(row.logging_json, 'logging_json') }),
  };
}

export function readActiveAggregate(
  db: Database,
): ConfigurationAggregateV2 {
  const bindings = groupBindings(sqliteAll<BindingRow, []>(db, `SELECT id,scope_kind,scope_owner,service_id,route_id,
    upstream_id,position,plugin_name,options_json,enabled FROM plugin_bindings ORDER BY scope_kind,scope_owner,position`));
  const upstreams = groupUpstreams(sqliteAll<UpstreamRow, []>(db, `SELECT id,owner_kind,service_id,route_id,
    position,target,weight,priority,is_disabled,policy_json FROM upstreams ORDER BY owner_kind,position`), bindings);
  const services = sqliteAll<ServiceRow, []>(db, 'SELECT id,position,name,policy_json FROM services ORDER BY position')
    .map((row) => ({ ...parseCanonicalObject(row.policy_json, 'service policy_json', SERVICE_RESERVED),
      id: requireUuid(row.id, 'services.id'), position: requireSafeInteger(row.position, 'services.position'),
      name: row.name, endpoints: takeGroup(upstreams, `service:${row.id}`),
      plugins: takeGroup(bindings, `service:${row.id}`) }));
  const routes = sqliteAll<RouteRow, []>(db, 'SELECT id,position,path,service_id,policy_json FROM routes ORDER BY position')
    .map((row) => ({ ...parseCanonicalObject(row.policy_json, 'route policy_json', ROUTE_RESERVED),
      id: requireUuid(row.id, 'routes.id'), position: requireSafeInteger(row.position, 'routes.position'),
      path: row.path, ...(row.service_id === null ? { endpoints: takeGroup(upstreams, `route:${row.id}`) }
        : { service_id: requireUuid(row.service_id, 'routes.service_id') }),
      plugins: takeGroup(bindings, `route:${row.id}`) }));
  const activations = sqliteAll<ActivationRow, []>(db, 'SELECT plugin_name FROM plugin_activations ORDER BY plugin_name');
  const input = { logical_configuration: { ...readSettings(db), services, routes,
    plugins: takeGroup(bindings, 'global:') }, plugin_activations: activations.map(({ plugin_name }) => ({
      plugin_name: requirePluginName(plugin_name, 'plugin_activations.plugin_name'),
    })) };
  if (bindings.size !== 0 || upstreams.size !== 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'normalized relation rows were not consumed');
  }
  const result = parseNormalizeCompileAggregate(input);
  if (!result.ok) throw new ConfigRepositoryError('schema_corrupt', 'active configuration is invalid', result.errors);
  return result.value;
}
