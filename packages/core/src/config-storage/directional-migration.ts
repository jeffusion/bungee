import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { rewriteLegacyResponseHeaders } from '../utils/expression-dependencies';
import { parseNormalizeCompileAggregate } from './aggregate';
import { hashConfigurationContent } from './content-hash';
import { preflightJsonGraph } from './json-preflight';
import { ConfigRepositoryError } from './repository-types';
import { validateDirectionalModificationRules } from './modification-validation';
import { isObject, ValidationContext, type ConfigurationResult, type JsonObject } from './validation';

export interface DirectionalMigrationWarning {
  readonly path: string;
  readonly reason: 'invalid_modification' | 'new_format_preferred' | 'unsupported_service_modification';
}

const RULE_FIELDS = ['headers', 'query', 'body'] as const;
const OPERATIONS = new Set(['add', 'replace', 'default', 'remove']);

/** Reuse the strict runtime validator, but discard only the failing imported rule. */
function sanitizeDirection(
  value: unknown, direction: 'request' | 'response', path: string,
  warnings: DirectionalMigrationWarning[], rewriteResponse = false,
): JsonObject | undefined {
  const ignore = (field: string) => warnings.push({ path: field, reason: 'invalid_modification' });
  if (!isObject(value)) { ignore(path); return undefined; }
  const result: JsonObject = {};
  const allowed = new Set(direction === 'request' ? RULE_FIELDS : ['headers', 'body', 'body_formats']);
  for (const field of Object.keys(value)) if (!allowed.has(field)) ignore(`${path}.${field}`);
  const valid = (block: JsonObject): boolean => {
    const context = new ValidationContext();
    validateDirectionalModificationRules({ [direction]: block }, '', context);
    return context.errors.length === 0;
  };
  let invalidFormats = false;
  if (direction === 'response' && Object.hasOwn(value, 'body_formats')) {
    if (valid({ body_formats: value.body_formats })) result.body_formats = value.body_formats;
    else { ignore(`${path}.body_formats`); invalidFormats = true; }
  }
  for (const field of RULE_FIELDS) {
    if (!allowed.has(field) || !Object.hasOwn(value, field)) continue;
    const fieldPath = `${path}.${field}`;
    // Dropping an invalid selector must not broaden a JSON rule to SSE.
    if (field === 'body' && invalidFormats) { ignore(fieldPath); continue; }
    const rules = value[field];
    if (!isObject(rules)) { ignore(fieldPath); continue; }
    const cleaned: JsonObject = {};
    for (const [operation, entries] of Object.entries(rules)) {
      const operationPath = `${fieldPath}.${operation}`;
      if (!OPERATIONS.has(operation)) { ignore(operationPath); continue; }
      if (operation === 'remove' ? !Array.isArray(entries) : !isObject(entries)) {
        ignore(operationPath); continue;
      }
      const retained: JsonObject | string[] = operation === 'remove' ? [] : {};
      for (const [key, original] of Object.entries(entries as JsonObject | unknown[])) {
        let candidate: unknown = original;
        try {
          if (rewriteResponse && field === 'body') candidate = rewriteLegacyResponseHeaders(original);
          const single = operation === 'remove' ? [candidate] : { [key]: candidate };
          if (!valid({ ...(Object.hasOwn(result, 'body_formats') ? { body_formats: result.body_formats } : {}),
            [field]: { [operation]: single } } as JsonObject)) throw new Error('invalid rule');
          if (Array.isArray(retained)) retained.push(candidate as string);
          else retained[key] = candidate as JsonObject[string];
        } catch { ignore(`${operationPath}${operation === 'remove' ? `[${key}]` : `.${key}`}`); }
      }
      cleaned[operation] = retained;
    }
    result[field] = cleaned;
  }
  return result;
}

/** 显式用于旧数据库和导入；运行时编译器不接受旧字段。 */
export function migrateLegacyDirectionalAggregate(input: unknown, warnings: DirectionalMigrationWarning[] = []): unknown {
  const context = new ValidationContext();
  const safe = preflightJsonGraph(input, context);
  if (context.errors.length) throw new ConfigRepositoryError('invalid_configuration', 'Invalid legacy configuration JSON', context.errors);
  if (!isObject(safe) || !isObject(safe.logical_configuration)) return safe;
  const migrate = (entity: unknown, kind: 'route' | 'service' | 'endpoint', path: string): unknown => {
    if (!isObject(entity)) return entity;
    const result: Record<string, unknown> = { ...entity };
    if (kind === 'service') {
      for (const field of [...RULE_FIELDS, 'request', 'response']) {
        if (!Object.hasOwn(result, field)) continue;
        delete result[field];
        warnings.push({ path: `${path}.${field}`, reason: 'unsupported_service_modification' });
      }
    } else {
      for (const direction of ['request', 'response'] as const) {
        const legacyFields = direction === 'request' ? RULE_FIELDS : kind === 'endpoint' ? ['body'] as const : [];
        const hasNew = Object.hasOwn(entity, direction);
        const fields = legacyFields.filter(field => Object.hasOwn(entity, field));
        if (!hasNew && fields.length === 0) continue;
        // An explicit new field wins even if empty or invalid; never resurrect its old rule.
        const block: JsonObject = hasNew && isObject(entity[direction]) ? { ...entity[direction] } : {};
        for (const field of fields) {
          if (hasNew && (!isObject(entity[direction]) || Object.hasOwn(block, field))) {
            warnings.push({ path: `${path}.${field}`, reason: 'new_format_preferred' });
            continue;
          }
          if (direction === 'response' && Object.hasOwn(block, 'body_formats')
            && (!Array.isArray(block.body_formats) || block.body_formats.length !== 1 || block.body_formats[0] !== 'json')) {
            // A new selector wins, but the inherited old body cannot be moved to SSE.
            warnings.push({ path: `${path}.${field}`, reason: 'new_format_preferred' });
            continue;
          }
          block[field] = entity[field];
          if (direction === 'response' && !Object.hasOwn(block, 'body_formats')) block.body_formats = ['json'];
        }
        // Rewrite only inherited legacy response body, not explicit new expressions.
        const inheritedResponse = direction === 'response' && Object.hasOwn(block, 'body')
          && !(hasNew && isObject(entity.response) && Object.hasOwn(entity.response, 'body'));
        const cleaned = sanitizeDirection(hasNew && !isObject(entity[direction]) ? entity[direction] : block,
          direction, `${path}.${direction}`, warnings, inheritedResponse);
        if (cleaned !== undefined) result[direction] = cleaned;
        else delete result[direction];
      }
      for (const field of RULE_FIELDS) delete result[field];
    }
    if (Array.isArray(result.endpoints)) result.endpoints = result.endpoints.map((item, index) => migrate(item, 'endpoint', `${path}.endpoints[${index}]`));
    return result;
  };
  const logical = safe.logical_configuration;
  const result = { ...safe, logical_configuration: { ...logical,
    ...(Array.isArray(logical.routes) ? { routes: logical.routes.map((item, index) => migrate(item, 'route', `logical_configuration.routes[${index}]`)) } : {}),
    ...(Array.isArray(logical.services) ? { services: logical.services.map((item, index) => migrate(item, 'service', `logical_configuration.services[${index}]`)) } : {}),
  } };
  return result;
}

/** 早期迁移只清理各自字段，保持方向迁移由 v14 单独完成。 */
export function validatePreDirectionalAggregate(input: unknown): ConfigurationResult<ConfigurationAggregateV2> {
  try {
    const converted = migrateLegacyDirectionalAggregate(input);
    const result = parseNormalizeCompileAggregate(converted);
    if (!result.ok) return result;
    if (hashConfigurationContent(result.value) !== hashConfigurationContent(converted)) {
      return { ok: false, errors: [{ code: 'invalid_value', path: '', message: 'Historical aggregate normalization drifted' }] };
    }
    return { ok: true, value: input as ConfigurationAggregateV2 };
  } catch (error) {
    return { ok: false, errors: [{ code: 'invalid_value', path: '', message: error instanceof Error ? error.message : String(error) }] };
  }
}
