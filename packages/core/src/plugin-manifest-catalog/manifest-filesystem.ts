import { lstat, readFile, realpath } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { parsePluginManifestText } from './manifest-parser';
import { PluginManifestCatalogError, freezeDeep } from './parse-utils';
import { hashRuntimeIdentity } from './runtime-identity';
import type { PluginManifestRecord, PluginManifestRecordBase } from './types';
import type { StrictPluginManifest } from './types';

const MAX_MANIFEST_BYTES = 256 * 1024;

type MetafilePathApi = Pick<typeof posix, 'normalize' | 'resolve'>;

function isWindowsDrivePath(value: string): boolean {
  return /^\/?[A-Za-z]:\//.test(value.replaceAll('\\', '/'));
}

export function resolveMetafileInputPath(
  input: string,
  absWorkingDirectory: string,
  pathApi: MetafilePathApi = isWindowsDrivePath(input) || isWindowsDrivePath(absWorkingDirectory) ? win32 : posix,
): string {
  const normalized = input.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(normalized) && !isWindowsDrivePath(normalized)) {
    throw new Error(`invalid drive-relative metafile input: ${input}`);
  }
  if (isWindowsDrivePath(normalized)) return pathApi.normalize(normalized.replace(/^\//, ''));
  return pathApi.resolve(absWorkingDirectory, normalized);
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
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
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new PluginManifestCatalogError(field, 'must be a non-symlink regular file');
  }
  const physical = await realpath(candidate);
  if (!contained(pluginPath, physical)) throw new PluginManifestCatalogError(field, 'real path escapes plugin directory');
  return physical;
}

async function canonicalUiRoot(pluginPath: string): Promise<string | undefined> {
  const candidate = resolve(pluginPath, 'ui');
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(candidate);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new PluginManifestCatalogError('ui', 'must resolve to a directory', { cause: error });
  }

  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new PluginManifestCatalogError('ui', 'must be a real non-symlink directory');
  }

  const physical = await realpath(candidate).catch((error) => {
    throw new PluginManifestCatalogError('ui', 'must resolve to a directory', { cause: error });
  });
  const physicalStatus = await lstat(physical).catch((error) => {
    throw new PluginManifestCatalogError('ui', 'must resolve to a directory', { cause: error });
  });
  if (!physicalStatus.isDirectory()) {
    throw new PluginManifestCatalogError('ui', 'must resolve to a directory');
  }
  if (!contained(pluginPath, physical)) {
    throw new PluginManifestCatalogError('ui', 'real path escapes plugin directory');
  }
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
  const loaded = new Map<string, Uint8Array>();
  const resolveInput = (input: string): string => {
    const candidate = resolveMetafileInputPath(input, pluginPath);
    if (loaded.has(candidate)) return candidate;
    const suffix = input.replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, '');
    const matches = [...loaded.keys()].filter((path) => path.replaceAll('\\', '/') === suffix || path.replaceAll('\\', '/').endsWith(`/${suffix}`));
    if (matches.length > 1) throw new Error(`ambiguous metafile input: ${input}`);
    return matches[0] ?? candidate;
  };
  const resolveLoadedCandidate = (candidate: string): string => {
    if (loaded.has(candidate)) return candidate;
    const suffix = relative(pluginPath, candidate).replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, '');
    const matches = [...loaded.keys()].filter((path) => path.replaceAll('\\', '/').endsWith(`/${suffix}`));
    if (matches.length > 1) throw new Error(`ambiguous metafile dependency: ${candidate}`);
    return matches[0] ?? candidate;
  };
  const absWorkingDirectory = pluginPath;
  let result: Awaited<ReturnType<typeof build>>;
  while (true) {
    result = await build({
      entrypoints: [...entrypoints], target: 'bun', format: 'esm', bundle: true, metafile: true, write: false, absWorkingDirectory,
      plugins: [{
        name: 'bungee-runtime-identity-capture',
        setup(builder: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<unknown>): void }) {
          builder.onLoad({ filter: /.*/ }, async ({ path }) => { loaded.set(path, await readFile(path)); });
        },
      }],
    });
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
        const absoluteInput = resolveInput(input);
        const inputDirectory = isWindowsDrivePath(absoluteInput) ? win32.dirname(absoluteInput) : dirname(absoluteInput);
        const candidate = await resolveDependencyFile(resolveLoadedCandidate(
          resolveMetafileInputPath(specifier, inputDirectory),
        ));
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
    const absolute = resolveInput(input);
    capturedInputs.push({ path: absolute, bytes: loaded.get(absolute) ?? await readFile(absolute) });
  }
  return hashRuntimeIdentity(pluginPath, capturedInputs, externalDependencies);
}

async function resolveDependencyFile(candidate: string): Promise<string | undefined> {
  const pathApi = isWindowsDrivePath(candidate) ? win32 : posix;
  for (const option of [candidate, `${candidate}.ts`, `${candidate}.js`, `${candidate}.mjs`, pathApi.resolve(candidate, 'index.ts'), pathApi.resolve(candidate, 'index.js')]) {
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
  const uiRoot = await canonicalUiRoot(pluginPath);
  const controlPath = manifest.control === undefined
    ? undefined
    : await regularContainedFile(pluginPath, manifest.control.entry, 'control.entry');
  const record: PluginManifestRecordBase = {
    name: manifest.name,
    rootPath,
    pluginPath,
    pluginDir: pluginPath,
    ...(uiRoot === undefined ? {} : { uiRoot }),
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
