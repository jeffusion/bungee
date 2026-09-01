import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import type { PluginScanRoot } from '../plugin-path-resolver';
import { hashConfigurationContent } from '../config-storage/content-hash';
import type { ConfigurationCompileOptions } from '../config-storage/plugin-schema';
import { loadPluginManifestRecord } from './manifest-filesystem';
import { PluginManifestCatalogError } from './parse-utils';
import type { PluginManifestRecord, ReadonlyPluginConfigField } from './types';

export interface CatalogPathResolver {
  getScanRoots?: () => PluginScanRoot[];
  getScanDirectories?: () => string[];
}

export interface PluginManifestCatalogBuildOptions {
  scanDirectories?: readonly string[];
  pathResolver?: CatalogPathResolver;
}

export type BuildPluginManifestCatalogOptions = PluginManifestCatalogBuildOptions;
const CATALOG_CONSTRUCTOR_TOKEN = Symbol('PluginManifestCatalog.constructor');

function hashRecords(records: readonly PluginManifestRecord[]): Sha256Digest {
  const semanticCatalog = records.map(({ name, manifest }) => ({ name, manifest }));
  return hashConfigurationContent(semanticCatalog);
}

function fields(fieldsToVisit: readonly ReadonlyPluginConfigField[]): ReadonlyPluginConfigField[] {
  const found: ReadonlyPluginConfigField[] = [];
  const pending = [...fieldsToVisit];
  while (pending.length > 0) {
    const field = pending.pop();
    if (field === undefined) continue;
    found.push(field);
    if (field.properties) pending.push(...field.properties);
    if (field.items) pending.push(field.items);
  }
  return found;
}

function validateCatalogReferences(records: readonly PluginManifestRecord[]): void {
  const names = new Set(records.map(({ name }) => name));
  const componentOwners = new Map<string, string>();
  for (const record of records) {
    for (const component of record.manifest.ui?.components ?? []) {
      const owner = componentOwners.get(component.name);
      if (owner !== undefined) {
        throw new PluginManifestCatalogError(
          `${record.name}.ui.components`, `duplicate UI component ${component.name} also declared by ${owner}`,
        );
      }
      componentOwners.set(component.name, record.name);
    }
    for (const field of fields(record.configSchema)) {
      if (field.catalogPlugin !== undefined && !names.has(field.catalogPlugin)) {
        throw new PluginManifestCatalogError(
          `${record.name}.configSchema.${field.name}.catalogPlugin`,
          `unknown catalog plugin ${field.catalogPlugin}`,
        );
      }
    }
  }
}

export class PluginManifestCatalog {
  readonly hash: Sha256Digest;
  readonly #records: ReadonlyMap<string, PluginManifestRecord>;

  private constructor(records: readonly PluginManifestRecord[], token: symbol) {
    if (token !== CATALOG_CONSTRUCTOR_TOKEN) throw new TypeError('PluginManifestCatalog constructor is private');
    const ordered = [...records].sort((left, right) => left.name.localeCompare(right.name));
    this.#records = new Map(ordered.map((record) => [record.name, record]));
    this.hash = hashRecords(ordered);
    Object.freeze(this);
  }

  static async build(options: PluginManifestCatalogBuildOptions): Promise<PluginManifestCatalog> {
    const declaredRoots = options.scanDirectories?.map((path) => ({ path, required: true }))
      ?? options.pathResolver?.getScanRoots?.()
      ?? options.pathResolver?.getScanDirectories?.().map((path) => ({ path, required: true }))
      ?? [];
    if (declaredRoots.length === 0 || !declaredRoots.some(({ required }) => required)) {
      throw new PluginManifestCatalogError('scanDirectories', 'at least one required scan root is required');
    }
    const roots = (await Promise.all(declaredRoots.map(canonicalRoot))).filter((root) => root !== undefined);
    if (!roots.some(({ required }) => required)) {
      throw new PluginManifestCatalogError('scanDirectories', 'no required scan root exists');
    }
    const uniqueRoots = [...new Map(roots.map((root) => [root.path, root])).values()]
      .sort((left, right) => left.path.localeCompare(right.path));
    const records: PluginManifestRecord[] = [];
    const names = new Set<string>();
    for (const root of uniqueRoots) {
      const entries = (await readdir(root.path, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const record = await loadPluginManifestRecord(resolve(root.path, entry.name), root.path);
        if (names.has(record.name)) throw new PluginManifestCatalogError(record.name, 'duplicate plugin name');
        names.add(record.name);
        records.push(record);
      }
    }
    if (records.length === 0) throw new PluginManifestCatalogError('scanDirectories', 'catalog must contain at least one plugin');
    validateCatalogReferences(records);
    return new PluginManifestCatalog(records, CATALOG_CONSTRUCTOR_TOKEN);
  }

  get(name: string): PluginManifestRecord | undefined { return this.#records.get(name); }
  has(name: string): boolean { return this.#records.has(name); }
  names(): readonly string[] { return Object.freeze([...this.#records.keys()]); }
  records(): readonly PluginManifestRecord[] { return Object.freeze([...this.#records.values()]); }
  schemaEntries(): ReadonlyMap<string, readonly ReadonlyPluginConfigField[]> {
    return new Map([...this.#records].map(([name, record]) => [name, record.configSchema]));
  }
  toCompileOptions(): ConfigurationCompileOptions {
    return Object.freeze({
      pluginSchemas: this.schemaEntries(),
      availablePlugins: new Set(this.#records.keys()),
      pluginCatalogHash: this.hash,
    });
  }
}

async function canonicalRoot(root: PluginScanRoot): Promise<PluginScanRoot | undefined> {
  const absolute = resolve(root.path);
  try {
    const status = await stat(absolute);
    if (!status.isDirectory()) throw new PluginManifestCatalogError(absolute, 'scan root must be a directory');
    return { path: await realpath(absolute), required: root.required };
  } catch (error) {
    if (!root.required && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    if (error instanceof PluginManifestCatalogError) throw error;
    throw new PluginManifestCatalogError(absolute, root.required ? 'required scan root is missing or unreadable' : 'scan root is unreadable', { cause: error });
  }
}

export async function buildPluginManifestCatalog(
  options: PluginManifestCatalogBuildOptions,
): Promise<PluginManifestCatalog> {
  return PluginManifestCatalog.build(options);
}
