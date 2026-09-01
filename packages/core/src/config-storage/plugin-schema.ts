import type { PluginConfigValue, Sha256Digest } from '@jeffusion/bungee-types';
import { fieldValueSatisfies } from '../plugin-manifest-catalog/plugin-field-value';
import type { ReadonlyPluginConfigField } from '../plugin-manifest-catalog/types';
import { type JsonObject, type ValidationContext } from './validation';

export interface ConfigurationCompileOptions {
  readonly pluginSchemas: ReadonlyMap<string, readonly ReadonlyPluginConfigField[]>;
  readonly availablePlugins?: ReadonlySet<string>;
  readonly pluginCatalogHash?: Sha256Digest;
}

export type PluginSchemaCatalog = ReadonlyMap<string, readonly ReadonlyPluginConfigField[]>;

type SplitGroup = Readonly<{ names: readonly string[]; allowed: ReadonlySet<string> }>;

function persistedSchema(schema: readonly ReadonlyPluginConfigField[]): {
  fields: readonly ReadonlyPluginConfigField[];
  groups: readonly SplitGroup[];
} {
  const fields: ReadonlyPluginConfigField[] = [];
  const groups: SplitGroup[] = [];
  for (const field of schema) {
    const transform = field.fieldTransform;
    if (!transform?.fields || transform.separator === undefined) {
      fields.push(field);
      continue;
    }
    const allowed = new Set<string>();
    for (const option of field.options ?? []) {
      const parts = option.value.split(transform.separator);
      if (parts.length === transform.fields.length && parts.every((part) => part.length > 0)) {
        allowed.add(JSON.stringify(parts));
      }
    }
    groups.push({ names: transform.fields, allowed });
    for (const name of transform.fields) {
      fields.push({ name, type: 'string', label: field.label, required: field.required });
    }
  }
  return { fields, groups };
}

function validateField(
  field: ReadonlyPluginConfigField,
  value: PluginConfigValue | undefined,
  path: string,
  context: ValidationContext,
): void {
  if (value === undefined) {
    if (field.required) context.add('invalid_plugin_option', path, 'Required plugin option is missing');
    return;
  }
  if (!fieldValueSatisfies(field, value)) {
    context.add('invalid_plugin_option', path, 'Plugin option does not satisfy its schema');
    return;
  }
  if (field.type === 'object' && field.properties && value !== null && !Array.isArray(value) && typeof value === 'object') {
    validateObject(value, field.properties, path, context);
  }
  if (field.type === 'array' && field.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      if (field.items) validateField(field.items, item, `${path}[${index}]`, context);
    });
  }
}

function validateObject(
  options: JsonObject,
  sourceSchema: readonly ReadonlyPluginConfigField[],
  path: string,
  context: ValidationContext,
): void {
  const { fields, groups } = persistedSchema(sourceSchema);
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(options)) {
    const field = byName.get(name);
    if (!field) context.add('unknown_field', `${path}.${name}`, 'Plugin option is not in its persisted schema');
    else validateField(field, value, `${path}.${name}`, context);
  }
  for (const field of fields) {
    if (!Object.hasOwn(options, field.name)) validateField(field, undefined, `${path}.${field.name}`, context);
  }
  for (const group of groups) {
    const values = group.names.map((name) => options[name]);
    if (values.every((value) => value === undefined)) continue;
    if (!values.every((value) => typeof value === 'string') || !group.allowed.has(JSON.stringify(values))) {
      context.add('invalid_plugin_option', path, 'Split plugin options do not match an allowed source value');
    }
  }
}

export function validatePluginOptions(
  name: string,
  options: JsonObject | undefined,
  path: string,
  catalog: PluginSchemaCatalog,
  context: ValidationContext,
): void {
  const schema = catalog.get(name);
  if (!schema) {
    context.add('unknown_plugin', `${path}.name`, 'Plugin is not present in the compile catalog');
    return;
  }
  validateObject(options ?? {}, schema, `${path}.options`, context);
}
