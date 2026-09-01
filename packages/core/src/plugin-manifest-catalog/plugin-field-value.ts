import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { parseJsonText, PluginManifestCatalogError } from './parse-utils';
import type { ReadonlyPluginConfigField } from './types';

function objectValue(value: PluginConfigValue): value is Record<string, PluginConfigValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modelMappings(value: PluginConfigValue): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!objectValue(item)) return false;
    const keys = Object.keys(item);
    return keys.length === 2 && keys.includes('source') && keys.includes('target')
      && typeof item.source === 'string' && item.source.length > 0 && item.source === item.source.trim()
      && typeof item.target === 'string' && item.target.length > 0 && item.target === item.target.trim();
  });
}

function validJsonString(value: string): boolean {
  try {
    parseJsonText(value, 'json field');
    return true;
  } catch (error) {
    if (error instanceof PluginManifestCatalogError) return false;
    throw error;
  }
}

function rules(field: ReadonlyPluginConfigField, value: PluginConfigValue): boolean {
  const validation = field.validation;
  if (!validation || value === null) return true;
  const size = typeof value === 'string' || Array.isArray(value) ? value.length : value;
  return !(validation.min !== undefined && typeof size === 'number' && size < validation.min)
    && !(validation.max !== undefined && typeof size === 'number' && size > validation.max);
}

export function fieldValueSatisfies(field: ReadonlyPluginConfigField, value: PluginConfigValue): boolean {
  if (value === null) return !field.required;
  let valid = false;
  switch (field.type) {
    case 'string': case 'textarea': valid = typeof value === 'string' && (!field.required || value.length > 0); break;
    case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'select': valid = typeof value === 'string' && (!field.required || value.length > 0)
      && (field.options?.some((option) => option.value === value) ?? false); break;
    case 'multiselect': valid = Array.isArray(value) && (!field.required || value.length > 0)
      && value.every((item) => typeof item === 'string')
      && new Set(value).size === value.length
      && value.every((item) => field.options?.some((option) => option.value === item) ?? false); break;
    case 'model_mapping': valid = Array.isArray(value) && modelMappings(value) && (!field.required || value.length > 0); break;
    case 'json': valid = typeof value !== 'string' || validJsonString(value); break;
    case 'array': valid = Array.isArray(value) && (!field.required || value.length > 0) && field.items !== undefined
      && value.every((item) => field.items !== undefined && fieldValueSatisfies(field.items, item)); break;
    case 'object': {
      if (!objectValue(value) || !field.properties) break;
      const allowed = new Set(field.properties.map(({ name }) => name));
      valid = Object.keys(value).every((key) => allowed.has(key))
        && field.properties.every((property) => {
          const nested = value[property.name];
          return nested === undefined ? !property.required : fieldValueSatisfies(property, nested);
        });
      break;
    }
  }
  return valid && rules(field, value);
}
