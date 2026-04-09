import * as fs from 'fs';
import * as path from 'path';
import type { LoadedPluginManifest, PluginManifest } from './plugin.types';

export const CORE_HOST_VERSION = '3.2.0';
export const CURRENT_PLUGIN_SCHEMA_VERSION = 2;
export const VALID_PLUGIN_UI_EXTENSION_MODES = ['none', 'native-static', 'sandbox-iframe'] as const;
export const VALID_PLUGIN_ARTIFACT_KINDS = ['runtime-plugin'] as const;
export const SUPPORTED_PLUGIN_CAPABILITIES = [
  'hooks',
  'api',
  'nativeWidgetsStatic',
  'sandboxUiExtension',
  'dynamicRuntimeLoad',
] as const;

export const PLUGIN_MANIFEST_LEGACY_WARNING =
  'manifest compatibility warning: legacy manifest compatibility path is deprecated; migrate to schemaVersion, capabilities, artifactKind, uiExtensionMode, and engines.bungee';
export const PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR =
  'manifest negotiation error: unsupported capability';
export const PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR =
  'manifest negotiation error: schemaVersion is not compatible with host schema';
export const PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR =
  'manifest negotiation error: engines.bungee is not compatible with host version';
export const PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR =
  'artifact validation error: built server entry not found';

export type PluginUiExtensionMode = typeof VALID_PLUGIN_UI_EXTENSION_MODES[number];
export type PluginArtifactKind = typeof VALID_PLUGIN_ARTIFACT_KINDS[number];
export type PluginCapability = typeof SUPPORTED_PLUGIN_CAPABILITIES[number];

export interface PluginManifestNegotiationOptions {
  hostVersion?: string;
  hostCapabilities?: readonly string[];
  supportedSchemaVersions?: ReadonlyArray<number | string>;
}

export type PluginManifestValidationFailureCode =
  | 'invalid-manifest'
  | 'schema-mismatch'
  | 'unsupported-capability'
  | 'engine-mismatch'
  | 'missing-artifact';

export interface PluginManifestContractSnapshot {
  manifestContract: 'vnext' | 'legacy-compat' | 'unknown';
  schemaVersion?: number | string;
  artifactKind?: string;
  main?: string;
  capabilities: string[];
  uiExtensionMode?: string;
  engines?: {
    bungee?: string;
    node?: string;
  };
  contractWarnings: string[];
  validationFailureCode?: PluginManifestValidationFailureCode;
}

export class PluginManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly details: PluginManifestContractSnapshot,
  ) {
    super(message);
    this.name = 'PluginManifestValidationError';
  }
}

export interface PluginArtifactManifest extends PluginManifest {
  schemaVersion: number | string;
  artifactKind: PluginArtifactKind;
  main: string;
  capabilities: PluginCapability[];
  uiExtensionMode: PluginUiExtensionMode;
  manifestContract: 'vnext' | 'legacy-compat';
  contractWarnings: string[];
  engines: {
    bungee: string;
    node?: string;
  };
}

export interface LoadedPluginArtifactManifest extends LoadedPluginManifest {
  schemaVersion: number | string;
  artifactKind: PluginArtifactKind;
  main: string;
  capabilities: PluginCapability[];
  uiExtensionMode: PluginUiExtensionMode;
  uiAssetsPath?: string;
  manifestContract: 'vnext' | 'legacy-compat';
  contractWarnings: string[];
  engines: {
    bungee: string;
    node?: string;
  };
}

function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`artifact validation error: manifest field \"${fieldName}\" is required`);
  }

  return value;
}

function validateArtifactKind(value: unknown): PluginArtifactKind {
  if (typeof value === 'string' && VALID_PLUGIN_ARTIFACT_KINDS.includes(value as PluginArtifactKind)) {
    return value as PluginArtifactKind;
  }

  throw new Error(
    `artifact validation error: manifest field "artifactKind" must be one of ${VALID_PLUGIN_ARTIFACT_KINDS.join(' | ')}`
  );
}

function validateCapabilities(value: unknown): PluginCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error('artifact validation error: manifest field "capabilities" must be a non-empty string array');
  }

  const normalized = value.map((item) => item.trim());
  const unsupportedCapability = normalized.find(
    (item): item is string => !SUPPORTED_PLUGIN_CAPABILITIES.includes(item as PluginCapability)
  );

  if (unsupportedCapability) {
    throw new Error(`${PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR}: ${unsupportedCapability}`);
  }

  return normalized as PluginCapability[];
}

function validateSchemaVersion(value: unknown): number | string {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0)) {
    return value;
  }

  throw new Error('artifact validation error: manifest field "schemaVersion" is required');
}

function negotiateSchemaVersion(
  schemaVersion: number | string,
  supportedSchemaVersions: ReadonlyArray<number | string>,
): number | string {
  const normalized = String(schemaVersion).trim();
  const supported = new Set(supportedSchemaVersions.map((version) => String(version).trim()));
  if (!supported.has(normalized)) {
    throw new Error(`${PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR}: ${normalized}`);
  }

  return schemaVersion;
}

function validateUiExtensionMode(value: unknown): PluginUiExtensionMode {
  if (typeof value === 'string' && VALID_PLUGIN_UI_EXTENSION_MODES.includes(value as PluginUiExtensionMode)) {
    return value as PluginUiExtensionMode;
  }

  throw new Error(
    `artifact validation error: manifest field "uiExtensionMode" must be one of ${VALID_PLUGIN_UI_EXTENSION_MODES.join(' | ')}`
  );
}

function validateBungeeEngineRange(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('artifact validation error: manifest field "engines.bungee" is required');
  }

  return value.trim();
}

function parseVersionSegments(version: string): [number, number, number] {
  const normalized = version.trim().replace(/^v/, '').split('-')[0];
  const [major = '0', minor = '0', patch = '0'] = normalized.split('.');
  return [Number.parseInt(major, 10) || 0, Number.parseInt(minor, 10) || 0, Number.parseInt(patch, 10) || 0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionSegments(left);
  const rightParts = parseVersionSegments(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

function matchesComparator(hostVersion: string, comparator: string): boolean {
  const trimmed = comparator.trim();

  if (trimmed === '*' || trimmed.length === 0) {
    return true;
  }

  if (trimmed.startsWith('>=')) {
    return compareVersions(hostVersion, trimmed.slice(2)) >= 0;
  }

  if (trimmed.startsWith('<=')) {
    return compareVersions(hostVersion, trimmed.slice(2)) <= 0;
  }

  if (trimmed.startsWith('>')) {
    return compareVersions(hostVersion, trimmed.slice(1)) > 0;
  }

  if (trimmed.startsWith('<')) {
    return compareVersions(hostVersion, trimmed.slice(1)) < 0;
  }

  if (trimmed.startsWith('^')) {
    const [major, minor, patch] = parseVersionSegments(trimmed.slice(1));
    const lowerBound = `${major}.${minor}.${patch}`;
    const upperBound = `${major + 1}.0.0`;
    return compareVersions(hostVersion, lowerBound) >= 0 && compareVersions(hostVersion, upperBound) < 0;
  }

  if (trimmed.startsWith('~')) {
    const [major, minor, patch] = parseVersionSegments(trimmed.slice(1));
    const lowerBound = `${major}.${minor}.${patch}`;
    const upperBound = `${major}.${minor + 1}.0`;
    return compareVersions(hostVersion, lowerBound) >= 0 && compareVersions(hostVersion, upperBound) < 0;
  }

  return compareVersions(hostVersion, trimmed) === 0;
}

function isEngineRangeSatisfied(hostVersion: string, range: string): boolean {
  return range.split(/\s+/).filter(Boolean).every((comparator) => matchesComparator(hostVersion, comparator));
}

function negotiateCapabilities(
  capabilities: PluginCapability[],
  hostCapabilities: readonly string[],
): PluginCapability[] {
  const hostCapabilitySet = new Set(hostCapabilities);
  const rejectedCapability = capabilities.find((capability) => !hostCapabilitySet.has(capability));

  if (rejectedCapability) {
    throw new Error(`${PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR}: ${rejectedCapability}`);
  }

  return capabilities;
}

function inferLegacyCapabilities(manifest: PluginManifest): PluginCapability[] {
  const capabilities = new Set<PluginCapability>();

  if (manifest.main) {
    capabilities.add('hooks');
    capabilities.add('dynamicRuntimeLoad');
  }

  if (manifest.contributes?.api?.length) {
    capabilities.add('api');
  }

  if (manifest.contributes?.nativeWidgets?.length) {
    capabilities.add('nativeWidgetsStatic');
  }

  if (manifest.contributes?.widgets?.length || manifest.contributes?.navigation?.length || manifest.contributes?.settings) {
    capabilities.add('sandboxUiExtension');
  }

  return Array.from(capabilities);
}

function inferLegacyUiExtensionMode(manifest: PluginManifest): PluginUiExtensionMode {
  if (manifest.contributes?.nativeWidgets?.length) {
    return 'native-static';
  }

  if (manifest.contributes?.widgets?.length || manifest.contributes?.navigation?.length || manifest.contributes?.settings) {
    return 'sandbox-iframe';
  }

  return 'none';
}

function hasVNextContractFields(manifest: PluginManifest): boolean {
  return manifest.schemaVersion !== undefined
    || manifest.artifactKind !== undefined
    || manifest.capabilities !== undefined
    || manifest.uiExtensionMode !== undefined
    || manifest.engines?.bungee !== undefined;
}

export function toPluginManifestContractSnapshot(
  manifest?: Partial<PluginManifest> | null,
  overrides: Partial<PluginManifestContractSnapshot> = {},
): PluginManifestContractSnapshot {
  const manifestContract = overrides.manifestContract
    ?? (manifest
      ? hasVNextContractFields(manifest as PluginManifest)
        ? 'vnext'
        : 'legacy-compat'
      : 'unknown');
  const contractWarnings = overrides.contractWarnings
    ?? (manifestContract === 'legacy-compat' ? [PLUGIN_MANIFEST_LEGACY_WARNING] : []);

  return {
    manifestContract,
    schemaVersion: overrides.schemaVersion ?? manifest?.schemaVersion,
    artifactKind: overrides.artifactKind ?? manifest?.artifactKind,
    main: overrides.main ?? manifest?.main,
    capabilities: overrides.capabilities ?? (Array.isArray(manifest?.capabilities) ? manifest.capabilities : []),
    uiExtensionMode: overrides.uiExtensionMode ?? manifest?.uiExtensionMode,
    engines: overrides.engines ?? manifest?.engines,
    contractWarnings,
    validationFailureCode: overrides.validationFailureCode,
  };
}

function throwManifestValidationError(
  message: string,
  details: PluginManifestContractSnapshot,
): never {
  throw new PluginManifestValidationError(message, details);
}

export async function loadPluginArtifactManifest(
  pluginDir: string,
  options: PluginManifestNegotiationOptions = {},
): Promise<LoadedPluginArtifactManifest> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifestExists = await Bun.file(manifestPath).exists();
  if (!manifestExists) {
    throw new Error('artifact validation error: manifest.json is required');
  }

  const content = await Bun.file(manifestPath).text();
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(content) as PluginManifest;
  } catch {
    throwManifestValidationError('artifact validation error: manifest.json is invalid JSON', {
      manifestContract: 'unknown',
      capabilities: [],
      contractWarnings: [],
      validationFailureCode: 'invalid-manifest',
    });
  }

  const manifestContract = hasVNextContractFields(manifest) ? 'vnext' : 'legacy-compat';
  const contractWarnings = manifestContract === 'legacy-compat' ? [PLUGIN_MANIFEST_LEGACY_WARNING] : [];
  const supportedSchemaVersions = options.supportedSchemaVersions ?? [CURRENT_PLUGIN_SCHEMA_VERSION];
  const baseContractSnapshot = toPluginManifestContractSnapshot(manifest, {
    manifestContract,
    contractWarnings,
  });

  let name: string;
  let version: string;
  let main: string;
  try {
    name = validateRequiredString(manifest.name, 'name');
    version = validateRequiredString(manifest.version, 'version');
    main = validateRequiredString(manifest.main, 'main');
  } catch (error) {
    throwManifestValidationError((error as Error).message, baseContractSnapshot);
  }

  const hostVersion = options.hostVersion ?? CORE_HOST_VERSION;
  const hostCapabilities = options.hostCapabilities ?? SUPPORTED_PLUGIN_CAPABILITIES;

  let schemaVersion: number | string;
  let artifactKind: PluginArtifactKind;
  let capabilities: PluginCapability[];
  let uiExtensionMode: PluginUiExtensionMode;
  let bungeeEngineRange: string;
  try {
    schemaVersion = manifestContract === 'vnext'
      ? negotiateSchemaVersion(validateSchemaVersion(manifest.schemaVersion), supportedSchemaVersions)
      : 'legacy';
    artifactKind = manifestContract === 'vnext'
      ? validateArtifactKind(manifest.artifactKind)
      : 'runtime-plugin';
    capabilities = negotiateCapabilities(
      manifestContract === 'vnext'
        ? validateCapabilities(manifest.capabilities)
        : inferLegacyCapabilities(manifest),
      hostCapabilities,
    );
    uiExtensionMode = manifestContract === 'vnext'
      ? validateUiExtensionMode(manifest.uiExtensionMode)
      : inferLegacyUiExtensionMode(manifest);
    bungeeEngineRange = manifestContract === 'vnext'
      ? validateBungeeEngineRange(manifest.engines?.bungee)
      : '*';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown manifest validation error');
    let validationFailureCode: PluginManifestValidationFailureCode | undefined;
    if (message.includes(PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR)) {
      validationFailureCode = 'schema-mismatch';
    } else if (message.includes(PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR)) {
      validationFailureCode = 'unsupported-capability';
    }

    throwManifestValidationError(message, {
      ...baseContractSnapshot,
      schemaVersion: manifest.schemaVersion,
      artifactKind: manifest.artifactKind,
      main,
      capabilities: Array.isArray(manifest.capabilities)
        ? manifest.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : manifestContract === 'legacy-compat'
          ? inferLegacyCapabilities(manifest)
          : [],
      uiExtensionMode: manifest.uiExtensionMode,
      engines: manifest.engines,
      validationFailureCode,
    });
  }

  if (!isEngineRangeSatisfied(hostVersion, bungeeEngineRange)) {
    throwManifestValidationError(
      `${PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR}: ${bungeeEngineRange} vs ${hostVersion}`,
      {
        ...baseContractSnapshot,
        schemaVersion,
        artifactKind,
        main,
        capabilities,
        uiExtensionMode,
        engines: {
          ...manifest.engines,
          bungee: bungeeEngineRange,
        },
        validationFailureCode: 'engine-mismatch',
      },
    );
  }

  if (manifest.contributes?.nativeWidgets?.length) {
    if (uiExtensionMode !== 'native-static') {
      throwManifestValidationError(
        'artifact validation error: manifest contributes.nativeWidgets requires uiExtensionMode "native-static"',
        {
          ...baseContractSnapshot,
          schemaVersion,
          artifactKind,
          main,
          capabilities,
          uiExtensionMode,
          engines: {
            ...manifest.engines,
            bungee: bungeeEngineRange,
          },
          validationFailureCode: 'invalid-manifest',
        },
      );
    }

    if (!capabilities.includes('nativeWidgetsStatic')) {
      throwManifestValidationError(
        'artifact validation error: manifest contributes.nativeWidgets requires capability "nativeWidgetsStatic"',
        {
          ...baseContractSnapshot,
          schemaVersion,
          artifactKind,
          main,
          capabilities,
          uiExtensionMode,
          engines: {
            ...manifest.engines,
            bungee: bungeeEngineRange,
          },
          validationFailureCode: 'invalid-manifest',
        },
      );
    }
  }

  const mainPath = path.resolve(pluginDir, main);
  const mainExists = await Bun.file(mainPath).exists();
  if (!mainExists) {
    throwManifestValidationError(
      `${PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR} at ${main}`,
      {
        ...baseContractSnapshot,
        schemaVersion,
        artifactKind,
        main,
        capabilities,
        uiExtensionMode,
        engines: {
          ...manifest.engines,
          bungee: bungeeEngineRange,
        },
        validationFailureCode: 'missing-artifact',
      },
    );
  }

  const uiAssetsPath = path.join(pluginDir, 'ui');
  const hasUiAssets = await fs.promises
    .stat(uiAssetsPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);

  return {
    ...manifest,
    name,
    version,
    schemaVersion,
    artifactKind,
    main,
    capabilities,
    uiExtensionMode,
    manifestContract,
    contractWarnings,
    engines: {
      ...manifest.engines,
      bungee: bungeeEngineRange,
    },
    pluginDir,
    manifestPath,
    mainPath,
    uiAssetsPath: hasUiAssets ? uiAssetsPath : undefined,
  };
}

export function isDevelopmentCompatPluginPath(pluginPath: string): boolean {
  const normalizedPath = pluginPath.replace(/\\/g, '/');
  return normalizedPath.endsWith('/server/index.ts') || normalizedPath.endsWith('/server/index.js');
}
