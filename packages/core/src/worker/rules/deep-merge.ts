import type { ModificationRules } from '@jeffusion/bungee-types';
import { mergeWith } from 'lodash-es';

export function deepMergeRules(
  base: ModificationRules,
  override: ModificationRules,
): ModificationRules {
  return mergeWith({}, base, override, (baseValue: unknown, overrideValue: unknown) => {
    if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
      return [...new Set([...baseValue, ...overrideValue])];
    }
    return undefined;
  });
}
