import type { PluginConfigConstraint, PluginConfigValue } from '@jeffusion/bungee-types';
import { fieldValueSatisfies } from './plugin-field-value';
import { array, exact, optionalProperty, optionalString, PluginManifestCatalogError, record, string } from './parse-utils';
import type { ReadonlyPluginConfigField } from './types';

export function parseConfigConstraints(
  value: PluginConfigValue | undefined,
  schema: readonly ReadonlyPluginConfigField[],
): readonly PluginConfigConstraint[] | undefined {
  if (value === undefined) return undefined;
  const byName = new Map(schema.filter(field => !field.fieldTransform).map(field => [field.name, field]));
  return array(value, 'configConstraints').map((item, index) => {
    const path = `configConstraints[${index}]`, object = record(item, path);
    exact(object, new Set(['type', 'fields', 'tuples', 'message']), path);
    if (object.type !== 'allowed-tuples') throw new PluginManifestCatalogError(`${path}.type`, 'unsupported constraint type');
    const fields = array(object.fields, `${path}.fields`).map((entry, i) => string(entry, `${path}.fields[${i}]`));
    if (fields.length < 2 || new Set(fields).size !== fields.length) throw new PluginManifestCatalogError(`${path}.fields`, 'requires at least two distinct fields');
    for (const field of fields) {
      const declaration = byName.get(field);
      if (!declaration || !['string','textarea','select','number','boolean'].includes(declaration.type)) {
        throw new PluginManifestCatalogError(`${path}.fields`, 'requires declared, independent scalar fields');
      }
    }
    const seen = new Set<string>();
    const tuples = array(object.tuples, `${path}.tuples`).map((entry, i) => {
      const tuplePath = `${path}.tuples[${i}]`, tuple = array(entry, tuplePath);
      if (tuple.length !== fields.length) throw new PluginManifestCatalogError(tuplePath, 'tuple length must match fields');
      const parsed = tuple.map((entry, fieldIndex) => {
        if (entry !== null && !['string','number','boolean'].includes(typeof entry)) throw new PluginManifestCatalogError(tuplePath, 'tuple entries must be scalars');
        if (!fieldValueSatisfies(byName.get(fields[fieldIndex]!)!, entry)) throw new PluginManifestCatalogError(tuplePath, 'tuple entry does not satisfy field schema');
        return entry as string | number | boolean | null;
      });
      const key = JSON.stringify(parsed);
      if (seen.has(key)) throw new PluginManifestCatalogError(tuplePath, 'duplicate tuple');
      seen.add(key);
      return parsed;
    });
    if (!tuples.length) throw new PluginManifestCatalogError(`${path}.tuples`, 'tuples must not be empty');
    return {type: 'allowed-tuples', fields, tuples, ...optionalProperty('message', optionalString(object.message, `${path}.message`))};
  });
}
