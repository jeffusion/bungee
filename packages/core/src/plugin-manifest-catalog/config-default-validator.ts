import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { fieldValueSatisfies } from './plugin-field-value';
import type { ReadonlyPluginConfigField } from './types';

export function defaultSatisfiesField(field: ReadonlyPluginConfigField, value: PluginConfigValue): boolean {
  return fieldValueSatisfies(field, value);
}
