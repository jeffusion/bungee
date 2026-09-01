import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parsePluginManifestText } from './manifest-parser';
import { PluginManifestCatalogError, freezeDeep } from './parse-utils';
import type { PluginManifestRecord } from './types';
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
  for (const [index, component] of (manifest.ui?.components ?? []).entries()) {
    await regularContainedFile(pluginPath, component.entry, `ui.components[${index}].entry`);
  }
  return mainPath;
}

export async function loadPluginManifestRecord(
  pluginDirectory: string,
  rootPath = pluginDirectory,
): Promise<PluginManifestRecord> {
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
  const record: PluginManifestRecord = {
    name: manifest.name,
    rootPath,
    pluginPath,
    pluginDir: pluginPath,
    manifestPath,
    mainPath,
    manifest,
    configSchema: manifest.configSchema,
  };
  freezeDeep(record);
  return record;
}
