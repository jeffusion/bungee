import { lstat, readFile, realpath } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { parsePluginManifestText } from './manifest-parser';
import { PluginManifestCatalogError, freezeDeep } from './parse-utils';
import { hashRuntimeIdentity } from './runtime-identity';
import type { PluginManifestRecord, PluginManifestRecordBase } from './types';
import type { StrictPluginManifest } from './types';

const MAX_MANIFEST_BYTES = 256 * 1024;

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function regularContainedFile(pluginPath: string, entry: string, field: string): Promise<string> {
  const candidate = resolve(pluginPath, entry);
  if (!contained(pluginPath, candidate)) throw new PluginManifestCatalogError(field, 'path escapes plugin directory');
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(candidate);
  } catch (error) {
    throw new PluginManifestCatalogError(field, 'must resolve to a non-symlink regular file', { cause: error });
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new PluginManifestCatalogError(field, 'must be a non-symlink regular file');
  }
  const physical = await realpath(candidate);
  if (!contained(pluginPath, physical)) throw new PluginManifestCatalogError(field, 'real path escapes plugin directory');
  return physical;
}

async function runtimeDependencyHash(
  pluginPath: string,
  entries: readonly string[],
): Promise<`sha256:${string}`> {
  type Metafile = { readonly inputs: Record<string, {
    readonly imports: readonly { readonly path: string; readonly external?: boolean; readonly original?: string }[];
  }> };
  const build = Bun.build as unknown as (config: Record<string, unknown>) => Promise<{
    readonly success: boolean;
    readonly metafile?: Metafile;
  }>;
  const entrypoints = new Set(entries);
  let result: Awaited<ReturnType<typeof build>>;
  while (true) {
    result = await build({ entrypoints: [...entrypoints], target: 'bun', format: 'esm', metafile: true, write: false });
    if (!result.success || result.metafile === undefined) {
      throw new PluginManifestCatalogError(entries.join(','), 'runtime dependency graph cannot be built');
    }
    let added = false;
    for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
      for (const imported of metadata.imports) {
        const specifier = imported.original ?? imported.path;
        if (!imported.external || /^(?:node|bun):/.test(specifier) || builtinModules.includes(specifier)) continue;
        if (!specifier.startsWith('.')) {
          throw new PluginManifestCatalogError(input, `external dependency must be bundled: ${specifier}`);
        }
        const candidate = await resolveDependencyFile(resolve(resolve(input), '..', specifier));
        if (candidate === undefined) {
          throw new PluginManifestCatalogError(input, `external dependency cannot be resolved: ${specifier}`);
        }
        if (!entrypoints.has(candidate)) {
          entrypoints.add(candidate);
          added = true;
        }
      }
    }
    if (!added) break;
  }
  const inputs = Object.entries(result.metafile.inputs).sort(([left], [right]) => left.localeCompare(right));
  const capturedInputs: { path: string; bytes: Uint8Array }[] = [];
  const externalDependencies = new Set<string>();
  for (const [input, metadata] of inputs) {
    for (const imported of metadata.imports) {
      const specifier = imported.original ?? imported.path;
      if (imported.external && !/^(?:node|bun):/.test(specifier)
        && !builtinModules.includes(specifier)
        && !specifier.startsWith('.')) {
        throw new PluginManifestCatalogError(input, `external dependency must be bundled: ${specifier}`);
      }
      if (imported.external) externalDependencies.add(specifier);
    }
    const absolute = resolve(input);
    capturedInputs.push({ path: absolute, bytes: await readFile(absolute) });
  }
  return hashRuntimeIdentity(pluginPath, capturedInputs, externalDependencies);
}

async function resolveDependencyFile(candidate: string): Promise<string | undefined> {
  for (const option of [candidate, `${candidate}.ts`, `${candidate}.js`, `${candidate}.mjs`, resolve(candidate, 'index.ts'), resolve(candidate, 'index.js')]) {
    try {
      if ((await lstat(option)).isFile()) return option;
    } catch { /* continue with the next conventional extension */ }
  }
  return undefined;
}

export async function validatePluginManifestEntries(
  pluginDirectory: string,
  manifest: StrictPluginManifest,
): Promise<string> {
  const directoryStatus = await lstat(pluginDirectory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new PluginManifestCatalogError(pluginDirectory, 'plugin directory must not be a symbolic link');
  }
  const pluginPath = await realpath(pluginDirectory);
  const mainPath = await regularContainedFile(pluginPath, manifest.main, 'main');
  if (manifest.control !== undefined) {
    await regularContainedFile(pluginPath, manifest.control.entry, 'control.entry');
  }
  for (const [index, component] of (manifest.ui?.components ?? []).entries()) {
    await regularContainedFile(pluginPath, component.entry, `ui.components[${index}].entry`);
  }
  return mainPath;
}

export async function loadPluginManifestRecord(
  pluginDirectory: string,
  rootPath = pluginDirectory,
): Promise<PluginManifestRecordBase> {
  const directoryStatus = await lstat(pluginDirectory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new PluginManifestCatalogError(pluginDirectory, 'plugin directory must not be a symbolic link');
  }
  const pluginPath = await realpath(pluginDirectory);
  const manifestPath = await regularContainedFile(pluginPath, 'manifest.json', 'manifest.json');
  const manifestStatus = await lstat(manifestPath);
  if (manifestStatus.size > MAX_MANIFEST_BYTES) {
    throw new PluginManifestCatalogError(manifestPath, 'manifest exceeds maximum size');
  }
  const bytes = await readFile(manifestPath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PluginManifestCatalogError(manifestPath, 'manifest must be valid UTF-8', { cause: error });
  }
  const manifest = parsePluginManifestText(content, manifestPath);
  const directoryName = pluginPath.split(/[\\/]/).at(-1);
  if (directoryName !== manifest.name) {
    throw new PluginManifestCatalogError('name', `must match directory name ${directoryName ?? ''}`);
  }
  const mainPath = await validatePluginManifestEntries(pluginPath, manifest);
  const controlPath = manifest.control === undefined
    ? undefined
    : await regularContainedFile(pluginPath, manifest.control.entry, 'control.entry');
  const record: PluginManifestRecordBase = {
    name: manifest.name,
    rootPath,
    pluginPath,
    pluginDir: pluginPath,
    manifestPath,
    mainPath,
    ...(controlPath === undefined ? {} : { controlPath }),
    manifest,
    configSchema: manifest.configSchema,
  };
  freezeDeep(record);
  return record;
}

export async function finalizePluginManifestRecord(
  record: PluginManifestRecordBase,
): Promise<PluginManifestRecord> {
  let runtimeHash: `sha256:${string}`;
  try {
    runtimeHash = await runtimeDependencyHash(record.pluginPath,
      [record.mainPath, ...(record.controlPath === undefined ? [] : [record.controlPath])]);
  } catch (error) {
    throw new PluginManifestCatalogError(record.name, `Failed to build ${record.name}`, { cause: error });
  }
  const finalized: PluginManifestRecord = { ...record, runtimeHash };
  freezeDeep(finalized);
  return finalized;
}
