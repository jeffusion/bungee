import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { fieldValueSatisfies } from './plugin-field-value';
import { joinPath, PluginManifestCatalogError } from './parse-utils';
import type { ReadonlyPluginConfigField, ReadonlyPluginShowIfCondition } from './types';

type FieldSymbol = ReadonlyPluginConfigField & Readonly<{
  derived?: true;
  reachableValues?: ReadonlySet<string>;
}>;

function conditionLeaves(condition: ReadonlyPluginShowIfCondition): readonly Readonly<{
  field: string;
  value: PluginConfigValue;
}>[] {
  if ('field' in condition) return [condition];
  const nested = 'all' in condition ? condition.all : condition.any;
  return nested.flatMap(conditionLeaves);
}

function symbolTable(fields: readonly ReadonlyPluginConfigField[], path: string): ReadonlyMap<string, FieldSymbol> {
  const symbols = new Map<string, FieldSymbol>(fields.map((field) => [field.name, field]));
  for (const field of fields) {
    const transform = field.fieldTransform;
    if (!transform?.fields || transform.separator === undefined) continue;
    const separator = transform.separator;
    for (const [targetIndex, target] of transform.fields.entries()) {
      if (symbols.has(target)) {
        throw new PluginManifestCatalogError(`${path}.${field.name}.fieldTransform`, `duplicate transform target ${target}`);
      }
      const reachableValues = new Set((field.options ?? []).map((option) =>
        option.value.split(separator)[targetIndex] ?? ''));
      symbols.set(target, { name: target, type: 'string', label: target, derived: true, reachableValues });
    }
  }
  return symbols;
}

function validateConditions(
  field: ReadonlyPluginConfigField,
  symbols: ReadonlyMap<string, FieldSymbol>,
  path: string,
): readonly string[] {
  if (!field.showIf) return [];
  const dependencies: string[] = [];
  for (const condition of conditionLeaves(field.showIf)) {
    const symbol = symbols.get(condition.field);
    if (!symbol) throw new PluginManifestCatalogError(path, `unknown showIf field ${condition.field}`);
    if (!fieldValueSatisfies(symbol, condition.value)) {
      throw new PluginManifestCatalogError(path, `showIf value does not satisfy ${condition.field}`);
    }
    if (symbol.derived && (typeof condition.value !== 'string'
      || !symbol.reachableValues?.has(condition.value))) {
      throw new PluginManifestCatalogError(path, `showIf value is not reachable for ${condition.field}`);
    }
    dependencies.push(condition.field);
  }
  return dependencies;
}

function validateCycles(edges: ReadonlyMap<string, readonly string[]>, path: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new PluginManifestCatalogError(path, 'showIf dependency cycle');
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of edges.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of edges.keys()) visit(name);
}

export function validateConfigFieldReferences(fields: readonly ReadonlyPluginConfigField[], path: string): void {
  const symbols = symbolTable(fields, path);
  const realNames = new Set(fields.map(({ name }) => name));
  const edges = new Map<string, readonly string[]>();
  for (const field of fields) {
    const fieldPath = `${path}.${field.name}`;
    const dependencies = validateConditions(field, symbols, `${fieldPath}.showIf`);
    for (const provider of [field.sourceCatalogProviderField, field.targetCatalogProviderField]) {
      if (provider === undefined) continue;
      const symbol = symbols.get(provider);
      if (!symbol) throw new PluginManifestCatalogError(fieldPath, `unknown provider field ${provider}`);
      if (!['string', 'textarea', 'select'].includes(symbol.type)) {
        throw new PluginManifestCatalogError(fieldPath, `provider field ${provider} must be string-compatible`);
      }
    }
    edges.set(field.name, dependencies.filter((name) => realNames.has(name)));
  }
  validateCycles(edges, path);
  for (const field of fields) {
    if (field.properties) validateConfigFieldReferences(field.properties, joinPath(path, field.name));
    if (field.items) validateConfigFieldReferences([field.items], joinPath(path, `${field.name}.items`));
  }
}
