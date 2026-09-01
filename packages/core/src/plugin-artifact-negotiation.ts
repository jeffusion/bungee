import type { PluginManifest } from './plugin.types';
import {
  PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR,
  PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR,
  PluginManifestValidationError,
  SUPPORTED_PLUGIN_CAPABILITIES,
  VALID_PLUGIN_ARTIFACT_KINDS,
  VALID_PLUGIN_UI_EXTENSION_MODES,
  type PluginArtifactKind,
  type PluginCapability,
  type PluginManifestContractSnapshot,
  type PluginUiExtensionMode,
} from './plugin-artifact-types';

export function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`artifact validation error: manifest field "${fieldName}" is required`);
  }
  return value;
}

export function validateArtifactKind(value: unknown): PluginArtifactKind {
  const found = VALID_PLUGIN_ARTIFACT_KINDS.find((kind) => kind === value);
  if (found !== undefined) return found;
  throw new Error(`artifact validation error: manifest field "artifactKind" must be one of ${VALID_PLUGIN_ARTIFACT_KINDS.join(' | ')}`);
}

export function validateCapabilities(value: unknown): PluginCapability[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error('artifact validation error: manifest field "capabilities" must be a non-empty string array');
  }
  const capabilities: PluginCapability[] = [];
  for (const item of value) {
    const found = SUPPORTED_PLUGIN_CAPABILITIES.find((capability) => capability === item.trim());
    if (found === undefined) throw new Error(`${PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR}: ${item}`);
    capabilities.push(found);
  }
  return capabilities;
}

export function validateSchemaVersion(value: unknown): number | string {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0)) return value;
  throw new Error('artifact validation error: manifest field "schemaVersion" is required');
}

export function negotiateSchemaVersion(
  schemaVersion: number | string,
  supportedSchemaVersions: ReadonlyArray<number | string>,
): number | string {
  const normalized = String(schemaVersion).trim();
  if (!new Set(supportedSchemaVersions.map((version) => String(version).trim())).has(normalized)) {
    throw new Error(`${PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR}: ${normalized}`);
  }
  return schemaVersion;
}

export function validateUiExtensionMode(value: unknown): PluginUiExtensionMode {
  const found = VALID_PLUGIN_UI_EXTENSION_MODES.find((mode) => mode === value);
  if (found !== undefined) return found;
  throw new Error(`artifact validation error: manifest field "uiExtensionMode" must be one of ${VALID_PLUGIN_UI_EXTENSION_MODES.join(' | ')}`);
}

export function validateBungeeEngineRange(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('artifact validation error: manifest field "engines.bungee" is required');
  }
  return value.trim();
}

export function negotiateCapabilities(
  capabilities: PluginCapability[],
  hostCapabilities: readonly string[],
): PluginCapability[] {
  const supported = new Set(hostCapabilities);
  const rejected = capabilities.find((capability) => !supported.has(capability));
  if (rejected) throw new Error(`${PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR}: ${rejected}`);
  return capabilities;
}

export function toPluginManifestContractSnapshot(
  manifest?: Partial<PluginManifest> | null,
  overrides: Partial<PluginManifestContractSnapshot> = {},
): PluginManifestContractSnapshot {
  const manifestContract = overrides.manifestContract ?? (manifest ? 'vnext' : 'unknown');
  return {
    manifestContract,
    schemaVersion: overrides.schemaVersion ?? manifest?.schemaVersion,
    artifactKind: overrides.artifactKind ?? manifest?.artifactKind,
    main: overrides.main ?? manifest?.main,
    capabilities: overrides.capabilities ?? (Array.isArray(manifest?.capabilities) ? manifest.capabilities : []),
    uiExtensionMode: overrides.uiExtensionMode ?? manifest?.uiExtensionMode,
    engines: overrides.engines ?? manifest?.engines,
    validationFailureCode: overrides.validationFailureCode,
  };
}

export function throwManifestValidationError(
  message: string,
  details: PluginManifestContractSnapshot,
): never {
  throw new PluginManifestValidationError(message, details);
}
