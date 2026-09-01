import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { parseBoundedJson } from './manifest-json';

export class PluginManifestCatalogError extends Error {
  readonly name = 'PluginManifestCatalogError';

  constructor(readonly path: string, message: string, options?: ErrorOptions) {
    super(path ? `${path}: ${message}` : message, options);
  }
}

export type JsonRecord = Record<string, PluginConfigValue>;

export function parseJsonText(content: string, path: string): PluginConfigValue {
  const parsed = parseBoundedJson(content, path);
  try {
    return snapshotJsonGraph(parsed);
  } catch (error) {
    throw new PluginManifestCatalogError(path, 'forbidden or non-JSON value', { cause: error });
  }
}

export function record(value: PluginConfigValue, path: string): JsonRecord {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new PluginManifestCatalogError(path, 'expected an object');
  }
  return value;
}

export function exact(value: JsonRecord, fields: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new PluginManifestCatalogError(joinPath(path, key), 'unknown field');
  }
}

export function string(value: PluginConfigValue | undefined, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new PluginManifestCatalogError(path, 'expected a nonempty trimmed string');
  }
  return value;
}

export function optionalString(value: PluginConfigValue | undefined, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

export function boolean(value: PluginConfigValue | undefined, path: string): boolean {
  if (typeof value !== 'boolean') throw new PluginManifestCatalogError(path, 'expected a boolean');
  return value;
}

export function array(value: PluginConfigValue | undefined, path: string): readonly PluginConfigValue[] {
  if (!Array.isArray(value)) throw new PluginManifestCatalogError(path, 'expected an array');
  return value;
}

export function uniqueStrings(value: PluginConfigValue | undefined, path: string, allowEmpty = true): readonly string[] {
  const items = array(value, path).map((item, index) => string(item, `${path}[${index}]`));
  if (!allowEmpty && items.length === 0) throw new PluginManifestCatalogError(path, 'must not be empty');
  if (new Set(items).size !== items.length) throw new PluginManifestCatalogError(path, 'values must be unique');
  return items;
}

export function literal<const T extends string>(value: PluginConfigValue | undefined, values: readonly T[], path: string): T {
  if (typeof value === 'string') {
    const match = values.find((candidate) => candidate === value);
    if (match !== undefined) return match;
  }
  throw new PluginManifestCatalogError(path, `expected one of ${values.join(', ')}`);
}

export function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

export function freezeDeep(value: unknown): void {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue;
    for (const nested of Object.values(current)) stack.push(nested);
    Object.freeze(current);
  }
}

export function optionalProperty<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}
