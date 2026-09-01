import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { validateConfigFieldReferences } from './config-field-references';
import type { PluginConfigFieldType } from '../plugin.types';
import { isPluginName } from '../config-storage/plugin-name';
import type {
  ReadonlyPluginConfigField,
  ReadonlyPluginOption,
  ReadonlyPluginShowIfCondition,
} from './types';
import { defaultSatisfiesField } from './config-default-validator';
import { isDangerousObjectName } from './manifest-values';
import {
  array,
  boolean,
  exact,
  literal,
  optionalProperty,
  optionalString,
  PluginManifestCatalogError,
  record,
  string,
} from './parse-utils';

const FIELD_TYPES = ['string', 'number', 'boolean', 'select', 'multiselect', 'textarea', 'json', 'model_mapping', 'object', 'array'] as const;
const FIELD_FIELDS = new Set(['name', 'type', 'label', 'required', 'default', 'options', 'description', 'placeholder', 'catalogPlugin', 'sourceCatalogProviderField', 'targetCatalogProviderField', 'validation', 'showIf', 'properties', 'items', 'fieldTransform']);
const OPTION_FIELDS = new Set(['label', 'value', 'description']);
const VALIDATION_FIELDS = new Set(['min', 'max', 'message']);
const TRANSFORM_FIELDS = new Set(['type', 'separator', 'fields']);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SCHEMA_DEPTH = 24;
const MAX_CONDITION_DEPTH = 24;

function fieldName(value: PluginConfigValue | undefined, path: string): string {
  const name = string(value, path);
  if (!NAME_PATTERN.test(name) || FORBIDDEN_NAMES.has(name) || isDangerousObjectName(name)) {
    throw new PluginManifestCatalogError(path, 'invalid field name');
  }
  return name;
}

function options(value: PluginConfigValue | undefined, path: string): readonly ReadonlyPluginOption[] {
  const seen = new Set<string>();
  const parsed = array(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = record(item, itemPath);
    exact(object, OPTION_FIELDS, itemPath);
    const option = {
      label: string(object.label, `${itemPath}.label`),
      value: string(object.value, `${itemPath}.value`),
      ...optionalProperty('description', optionalString(object.description, `${itemPath}.description`)),
    };
    if (seen.has(option.value)) throw new PluginManifestCatalogError(`${itemPath}.value`, 'option values must be unique');
    seen.add(option.value);
    return option;
  });
  if (parsed.length === 0) throw new PluginManifestCatalogError(path, 'options must not be empty');
  return parsed;
}

function finiteLimit(value: PluginConfigValue | undefined, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new PluginManifestCatalogError(path, 'expected a finite safe integer');
  }
  return value;
}

function validation(value: PluginConfigValue | undefined, path: string, type: PluginConfigFieldType): ReadonlyPluginConfigField['validation'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, VALIDATION_FIELDS, path);
  if (object.pattern !== undefined) {
    throw new PluginManifestCatalogError(`${path}.pattern`, 'validation.pattern is unsupported in strict v2');
  }
  const min = finiteLimit(object.min, `${path}.min`);
  const max = finiteLimit(object.max, `${path}.max`);
  if ((min !== undefined || max !== undefined) && !['string', 'textarea', 'number', 'array', 'multiselect'].includes(type)) {
    throw new PluginManifestCatalogError(path, `min/max are not supported for ${type}`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new PluginManifestCatalogError(path, 'validation min must be <= max');
  }
  return {
    ...optionalProperty('min', min),
    ...optionalProperty('max', max),
    ...optionalProperty('message', optionalString(object.message, `${path}.message`)),
  };
}

function showIf(value: PluginConfigValue, path: string, depth: number): ReadonlyPluginShowIfCondition {
  if (depth > MAX_CONDITION_DEPTH) throw new PluginManifestCatalogError(path, 'showIf exceeds maximum depth');
  const object = record(value, path);
  if ('field' in object || 'value' in object) {
    exact(object, new Set(['field', 'value']), path);
    if (!('value' in object)) throw new PluginManifestCatalogError(`${path}.value`, 'required field');
    return { field: fieldName(object.field, `${path}.field`), value: object.value };
  }
  const key = 'all' in object ? 'all' : 'any' in object ? 'any' : undefined;
  if (key === undefined) throw new PluginManifestCatalogError(path, 'invalid showIf tagged union');
  exact(object, new Set([key]), path);
  const conditions = array(object[key], `${path}.${key}`);
  if (conditions.length === 0) throw new PluginManifestCatalogError(`${path}.${key}`, 'must not be empty');
  const parsed = conditions.map((condition, index) => showIf(condition, `${path}.${key}[${index}]`, depth + 1));
  return key === 'all' ? { all: parsed } : { any: parsed };
}

function transform(
  value: PluginConfigValue | undefined,
  path: string,
  fieldType: PluginConfigFieldType,
  parsedOptions: readonly ReadonlyPluginOption[] | undefined,
): ReadonlyPluginConfigField['fieldTransform'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, TRANSFORM_FIELDS, path);
  if (object.type !== 'split') throw new PluginManifestCatalogError(`${path}.type`, 'unsupported fieldTransform type');
  const type = object.type;
  if (fieldType !== 'select') {
    throw new PluginManifestCatalogError(path, 'fieldTransform requires a select field');
  }
  const separator = optionalString(object.separator, `${path}.separator`);
  const fields = object.fields === undefined ? undefined : array(object.fields, `${path}.fields`)
    .map((item, index) => fieldName(item, `${path}.fields[${index}]`));
  if (!fields || fields.length === 0) throw new PluginManifestCatalogError(`${path}.fields`, 'split requires target fields');
  if (separator === undefined) throw new PluginManifestCatalogError(`${path}.separator`, 'split requires a separator');
  if (fields && new Set(fields).size !== fields.length) throw new PluginManifestCatalogError(`${path}.fields`, 'target fields must be unique');
  if (parsedOptions?.some((option) => {
    const parts = option.value.split(separator);
    return parts.length !== fields.length || parts.some((part) => part.length === 0);
  })) throw new PluginManifestCatalogError(path, 'select options must deterministically populate every transform target');
  return { type, ...optionalProperty('separator', separator), ...optionalProperty('fields', fields) };
}

function parseField(value: PluginConfigValue, path: string, depth: number): ReadonlyPluginConfigField {
  if (depth > MAX_SCHEMA_DEPTH) throw new PluginManifestCatalogError(path, 'config schema exceeds maximum depth');
  const object = record(value, path);
  exact(object, FIELD_FIELDS, path);
  if (depth > 0 && object.fieldTransform !== undefined) {
    throw new PluginManifestCatalogError(`${path}.fieldTransform`, 'fieldTransform is allowed only at top-level configSchema');
  }
  const type = literal(object.type, FIELD_TYPES, `${path}.type`);
  const parsedOptions = object.options === undefined ? undefined : options(object.options, `${path}.options`);
  if ((type === 'select' || type === 'multiselect') !== (parsedOptions !== undefined)) {
    throw new PluginManifestCatalogError(`${path}.options`, `${type} options contract is invalid`);
  }
  const properties = object.properties === undefined ? undefined : parseFields(object.properties, `${path}.properties`, depth + 1);
  const items = object.items === undefined ? undefined : parseField(object.items, `${path}.items`, depth + 1);
  if (type === 'object' ? !properties || items !== undefined : type === 'array' ? !items || properties !== undefined : properties !== undefined || items !== undefined) {
    throw new PluginManifestCatalogError(path, `${type} properties/items contract is invalid`);
  }
  const catalogPlugin = optionalString(object.catalogPlugin, `${path}.catalogPlugin`);
  const sourceProvider = object.sourceCatalogProviderField === undefined ? undefined
    : fieldName(object.sourceCatalogProviderField, `${path}.sourceCatalogProviderField`);
  const targetProvider = object.targetCatalogProviderField === undefined ? undefined
    : fieldName(object.targetCatalogProviderField, `${path}.targetCatalogProviderField`);
  if ((catalogPlugin !== undefined || sourceProvider !== undefined || targetProvider !== undefined) && type !== 'model_mapping') {
    throw new PluginManifestCatalogError(path, 'catalog fields require type model_mapping');
  }
  if (catalogPlugin !== undefined && !isPluginName(catalogPlugin)) {
    throw new PluginManifestCatalogError(`${path}.catalogPlugin`, 'invalid plugin name');
  }
  const field: ReadonlyPluginConfigField = {
    name: fieldName(object.name, `${path}.name`), type, label: string(object.label, `${path}.label`),
    ...optionalProperty('required', object.required === undefined ? undefined : boolean(object.required, `${path}.required`)),
    ...optionalProperty('default', object.default), ...optionalProperty('options', parsedOptions),
    ...optionalProperty('description', optionalString(object.description, `${path}.description`)),
    ...optionalProperty('placeholder', optionalString(object.placeholder, `${path}.placeholder`)),
    ...optionalProperty('catalogPlugin', catalogPlugin),
    ...optionalProperty('sourceCatalogProviderField', sourceProvider),
    ...optionalProperty('targetCatalogProviderField', targetProvider),
    ...optionalProperty('validation', validation(object.validation, `${path}.validation`, type)),
    ...optionalProperty('showIf', object.showIf === undefined ? undefined : showIf(object.showIf, `${path}.showIf`, 0)),
    ...optionalProperty('properties', properties), ...optionalProperty('items', items),
    ...optionalProperty('fieldTransform', transform(object.fieldTransform, `${path}.fieldTransform`, type, parsedOptions)),
  };
  if (object.default !== undefined && !defaultSatisfiesField(field, object.default)) throw new PluginManifestCatalogError(`${path}.default`, 'default does not satisfy field schema');
  return field;
}

export function parseConfigFields(value: PluginConfigValue | undefined, path: string): readonly ReadonlyPluginConfigField[] {
  const fields = parseFields(value ?? [], path, 0);
  validateConfigFieldReferences(fields, path);
  return fields;
}

function parseFields(value: PluginConfigValue, path: string, depth: number): readonly ReadonlyPluginConfigField[] {
  const fields = array(value, path).map((field, index) => parseField(field, `${path}[${index}]`, depth));
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new PluginManifestCatalogError(path, `duplicate field name ${field.name}`);
    names.add(field.name);
  }
  return fields;
}
