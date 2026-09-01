import type { PluginConfigValue } from '@jeffusion/bungee-types';

export type ConfigurationErrorCode =
  | 'required'
  | 'invalid_type'
  | 'invalid_uuid'
  | 'invalid_value'
  | 'duplicate_id'
  | 'duplicate_name'
  | 'duplicate_path'
  | 'duplicate_position'
  | 'unknown_service'
  | 'conflicting_owner'
  | 'plugin_path_forbidden'
  | 'non_json_value'
  | 'forbidden_key'
  | 'unknown_field'
  | 'invalid_url'
  | 'invalid_positive_number'
  | 'empty_service'
  | 'missing_route_target'
  | 'invalid_path'
  | 'invalid_auth'
  | 'invalid_load_balancing'
  | 'invalid_expression'
  | 'unknown_plugin'
  | 'invalid_plugin_option';

export interface ConfigurationError {
  readonly code: ConfigurationErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ConfigurationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ConfigurationError[] };

export type JsonObject = Record<string, PluginConfigValue>;

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLowercaseUuid(value: string): boolean {
  return LOWERCASE_UUID.test(value);
}

export function isObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class ValidationContext {
  readonly errors: ConfigurationError[] = [];
  readonly ids = new Map<string, string>();

  add(code: ConfigurationErrorCode, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }

  object(value: unknown, path: string): JsonObject | undefined {
    if (isObject(value)) return value;
    this.add('invalid_type', path, 'Expected an object');
    return undefined;
  }

  array(value: unknown, path: string, present = false): readonly unknown[] {
    if (value === undefined && !present) return [];
    if (value === undefined) {
      this.add('non_json_value', path, 'Expected a JSON array');
      return [];
    }
    if (Array.isArray(value)) return value;
    this.add('invalid_type', path, 'Expected an array');
    return [];
  }

  string(object: JsonObject, key: string, path: string): string {
    const value = object[key];
    if (value === undefined) {
      this.add('required', path, 'Required field is missing');
      return '';
    }
    if (typeof value === 'string') return value;
    this.add('invalid_type', path, 'Expected a string');
    return '';
  }

  id(object: JsonObject, path: string): string {
    const value = this.string(object, 'id', path);
    if (value && !isLowercaseUuid(value)) {
      this.add('invalid_uuid', path, 'Expected a lowercase UUID');
    } else if (value) {
      const firstPath = this.ids.get(value);
      if (firstPath) this.add('duplicate_id', path, `ID already used at ${firstPath}`);
      else this.ids.set(value, path);
    }
    return value;
  }

  position(object: JsonObject, fallback: number, path: string): number {
    const value = object.position;
    if (!('position' in object)) return fallback;
    if (value === undefined) {
      this.add('non_json_value', path, 'Expected a JSON number');
      return fallback;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    this.add('invalid_value', path, 'Expected a non-negative integer');
    return fallback;
  }
}

export function copyJsonValue(
  value: PluginConfigValue | undefined,
  path: string,
  context: ValidationContext,
): PluginConfigValue | undefined {
  if (value !== undefined) return value;
  context.add('non_json_value', path, 'Expected a JSON-compatible value');
  return undefined;
}

export function normalizePositions(
  values: readonly unknown[],
  path: string,
  context: ValidationContext,
): readonly number[] {
  const reserved = new Set<number>();
  const seen = new Set<number>();
  for (const value of values) {
    if (isObject(value) && typeof value.position === 'number' && Number.isSafeInteger(value.position)
      && value.position >= 0) reserved.add(value.position);
  }
  let generated = 0;
  return values.map((value, index) => {
    if (isObject(value) && typeof value.position === 'number' && Number.isSafeInteger(value.position)
      && value.position >= 0) {
      if (seen.has(value.position)) {
        context.add('duplicate_position', `${path}[${index}].position`, 'Position must be unique within its owner');
      }
      seen.add(value.position);
      return value.position;
    }
    while (reserved.has(generated)) generated += 1;
    const position = generated;
    reserved.add(position);
    generated += 1;
    return position;
  });
}

export function copyKnown(
  object: JsonObject,
  keys: readonly string[],
  path: string,
  context: ValidationContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in object)) continue;
    const fieldPath = path ? `${path}.${key}` : key;
    const cloned = copyJsonValue(object[key], fieldPath, context);
    if (cloned !== undefined) result[key] = cloned;
  }
  return result;
}

export function rejectUnknownFields(
  object: JsonObject,
  allowed: ReadonlySet<string>,
  path: string,
  context: ValidationContext,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      context.add('unknown_field', path ? `${path}.${key}` : key, 'Field is not part of configuration v2');
    }
  }
}
