import * as fs from 'fs';
import * as path from 'path';
import { CORE_HOST_VERSION } from './core-version';
import type { PluginConfigValue } from '@jeffusion/bungee-types';
import type { PluginManifest } from './plugin.types';
import { parseBoundedJson } from './plugin-manifest-catalog/manifest-json';
import { parseContributions, parseControl } from './plugin-manifest-catalog/manifest-nested-parser';
import { validateEngineRange } from './plugin-manifest-catalog/manifest-semver';
import {
  negotiateCapabilities,
  negotiateSchemaVersion,
  throwManifestValidationError,
  toPluginManifestContractSnapshot,
  validateArtifactKind,
  validateBungeeEngineRange,
  validateCapabilities,
  validateRequiredString,
  validateSchemaVersion,
  validateUiExtensionMode,
} from './plugin-artifact-negotiation';
import {
  CURRENT_PLUGIN_SCHEMA_VERSION,
  PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR,
  PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR,
  PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR,
  PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR,
  SUPPORTED_PLUGIN_CAPABILITIES,
  type LoadedPluginArtifactManifest,
  type PluginArtifactKind,
  type PluginCapability,
  type PluginManifestNegotiationOptions,
  type PluginManifestValidationFailureCode,
  type PluginUiExtensionMode,
} from './plugin-artifact-types';

export * from './plugin-artifact-types';
export { toPluginManifestContractSnapshot } from './plugin-artifact-negotiation';

async function validateArtifactEntry(pluginDir: string, entry: string, field: string): Promise<string> {
  const root = path.resolve(pluginDir);
  const candidate = path.resolve(root, entry);
  const relation = path.relative(root, candidate);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`artifact validation error: manifest field "${field}" escapes plugin directory`);
  }
  let status: fs.Stats;
  try { status = await fs.promises.lstat(candidate); } catch { throw new Error(`artifact validation error: manifest field "${field}" is missing`); }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`artifact validation error: manifest field "${field}" must be a regular file`);
  }
  const physical = await fs.promises.realpath(candidate);
  const physicalRelation = path.relative(root, physical);
  if (physicalRelation.startsWith('..') || path.isAbsolute(physicalRelation)) {
    throw new Error(`artifact validation error: manifest field "${field}" escapes plugin directory`);
  }
  return physical;
}

export async function loadPluginArtifactManifest(
  pluginDir: string,
  options: PluginManifestNegotiationOptions = {},
): Promise<LoadedPluginArtifactManifest> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!await Bun.file(manifestPath).exists()) throw new Error('artifact validation error: manifest.json is required');
  const content = await Bun.file(manifestPath).text();
  let manifest: PluginManifest;
  try {
    const value = parseBoundedJson(content, manifestPath);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('manifest must be an object');
    manifest = value as PluginManifest;
  } catch {
    throwManifestValidationError('artifact validation error: manifest.json is invalid JSON', {
      manifestContract: 'unknown', capabilities: [], validationFailureCode: 'invalid-manifest',
    });
  }
  if ('requiresManagementAuth' in manifest) {
    throwManifestValidationError('artifact validation error: unsupported manifest field', {
      ...toPluginManifestContractSnapshot(manifest), validationFailureCode: 'invalid-manifest',
    });
  }
  try {
    if (manifest.control !== undefined) parseControl(manifest.control as PluginConfigValue, 'control');
    if (manifest.contributes !== undefined) parseContributions(manifest.contributes as PluginConfigValue, 'contributes');
  } catch (error) {
    throwManifestValidationError(error instanceof Error ? `artifact validation error: ${error.message}` : String(error), {
      ...toPluginManifestContractSnapshot(manifest), validationFailureCode: 'invalid-manifest',
    });
  }
  const manifestContract = 'vnext' as const;
  const supportedSchemas = options.supportedSchemaVersions ?? [CURRENT_PLUGIN_SCHEMA_VERSION];
  const snapshot = toPluginManifestContractSnapshot(manifest, { manifestContract });
  let name: string;
  let version: string;
  let main: string;
  try {
    name = validateRequiredString(manifest.name, 'name');
    version = validateRequiredString(manifest.version, 'version');
    main = validateRequiredString(manifest.main, 'main');
  } catch (error) {
    throwManifestValidationError(error instanceof Error ? error.message : String(error), snapshot);
  }
  const hostVersion = options.hostVersion ?? CORE_HOST_VERSION;
  let schemaVersion: number | string;
  let artifactKind: PluginArtifactKind;
  let capabilities: PluginCapability[];
  let uiExtensionMode: PluginUiExtensionMode;
  let bungeeRange: string;
  try {
    schemaVersion = negotiateSchemaVersion(validateSchemaVersion(manifest.schemaVersion), supportedSchemas);
    artifactKind = validateArtifactKind(manifest.artifactKind);
    capabilities = negotiateCapabilities(
      validateCapabilities(manifest.capabilities),
      options.hostCapabilities ?? SUPPORTED_PLUGIN_CAPABILITIES,
    );
    uiExtensionMode = validateUiExtensionMode(manifest.uiExtensionMode);
    bungeeRange = validateBungeeEngineRange(manifest.engines?.bungee);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let validationFailureCode: PluginManifestValidationFailureCode | undefined;
    if (message.includes(PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR)) validationFailureCode = 'schema-mismatch';
    else if (message.includes(PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR)) validationFailureCode = 'unsupported-capability';
    throwManifestValidationError(message, {
      ...snapshot, schemaVersion: manifest.schemaVersion, artifactKind: manifest.artifactKind, main,
      capabilities: Array.isArray(manifest.capabilities)
        ? manifest.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : [],
      uiExtensionMode: manifest.uiExtensionMode, engines: manifest.engines, validationFailureCode,
    });
  }
  const details = { ...snapshot, schemaVersion, artifactKind, main, capabilities, uiExtensionMode,
    engines: { ...manifest.engines, bungee: bungeeRange } };
  const control = manifest.control;
  if (capabilities.includes('controlPlane') !== (control !== undefined)) {
    throwManifestValidationError('artifact validation error: controlPlane capability/control declaration mismatch',
      { ...details, validationFailureCode: 'invalid-manifest' });
  }
  if (control !== undefined && (typeof control.entry !== 'string' || !Array.isArray(control.rpc))) {
    throwManifestValidationError('artifact validation error: control declaration is invalid',
      { ...details, validationFailureCode: 'invalid-manifest' });
  }
  if (Array.isArray(manifest.contributes?.api)) {
    const apiRoutes = new Set<string>();
    for (const [index, endpoint] of manifest.contributes.api.entries()) {
      const execution = endpoint.execution ?? 'worker';
      if (execution !== 'worker' && execution !== 'control') {
        throwManifestValidationError(`artifact validation error: contributes.api[${index}].execution is invalid`,
          { ...details, validationFailureCode: 'invalid-manifest' });
      }
      if (execution === 'control' && control === undefined) {
        throwManifestValidationError(`artifact validation error: contributes.api[${index}] requires control`,
          { ...details, validationFailureCode: 'invalid-manifest' });
      }
      if (typeof endpoint.path === 'string' && Array.isArray(endpoint.methods)) {
        for (const method of endpoint.methods) {
          const key = `${method}:${endpoint.path.replace(/\/+$/, '') || '/'}`;
          if (apiRoutes.has(key)) {
            throwManifestValidationError(`artifact validation error: duplicate control namespace path ${endpoint.path}`,
              { ...details, validationFailureCode: 'invalid-manifest' });
          }
          apiRoutes.add(key);
        }
      }
    }
  }
  try {
    validateEngineRange(bungeeRange, 'engines.bungee', hostVersion);
  } catch {
    throwManifestValidationError(`${PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR}: ${bungeeRange} vs ${hostVersion}`,
      { ...details, validationFailureCode: 'engine-mismatch' });
  }
  if (manifest.engines?.node !== undefined) {
    try {
      validateEngineRange(manifest.engines.node, 'engines.node', process.version);
    } catch {
      throwManifestValidationError(
        `artifact validation error: engines.node is not compatible with process version: ${manifest.engines.node} vs ${process.version}`,
        { ...details, validationFailureCode: 'engine-mismatch' },
      );
    }
  }
  if (manifest.contributes?.nativeWidgets?.length && uiExtensionMode !== 'native-static') {
    throwManifestValidationError(
      'artifact validation error: manifest contributes.nativeWidgets requires uiExtensionMode "native-static"',
      { ...details, validationFailureCode: 'invalid-manifest' },
    );
  }
  if (manifest.contributes?.nativeWidgets?.length && !capabilities.includes('nativeWidgetsStatic')) {
    throwManifestValidationError(
      'artifact validation error: manifest contributes.nativeWidgets requires capability "nativeWidgetsStatic"',
      { ...details, validationFailureCode: 'invalid-manifest' },
    );
  }
  let mainPath: string;
  try { mainPath = await validateArtifactEntry(pluginDir, main, 'main'); } catch {
    throwManifestValidationError(`${PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR} at ${main}`,
      { ...details, validationFailureCode: 'missing-artifact' });
  }
  let controlPath: string | undefined;
  if (manifest.control !== undefined) {
    try { controlPath = await validateArtifactEntry(pluginDir, manifest.control.entry, 'control.entry'); } catch (error) {
      throwManifestValidationError(error instanceof Error ? error.message : String(error),
        { ...details, validationFailureCode: 'missing-artifact' });
    }
  }
  const uiAssetsPath = path.join(pluginDir, 'ui');
  const hasUiAssets = await fs.promises.stat(uiAssetsPath).then((stats) => stats.isDirectory()).catch(() => false);
  return {
    ...manifest, name, version, schemaVersion, artifactKind, main, capabilities, uiExtensionMode,
    manifestContract, engines: { ...manifest.engines, bungee: bungeeRange },
    pluginDir, manifestPath, mainPath, ...(controlPath === undefined ? {} : { controlPath }),
    uiAssetsPath: hasUiAssets ? uiAssetsPath : undefined,
  };
}
