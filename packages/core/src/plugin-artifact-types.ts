import type { LoadedPluginManifest, PluginManifest } from './plugin.types';

export { CORE_HOST_VERSION } from './core-version';
export const CURRENT_PLUGIN_SCHEMA_VERSION = 2;
export const VALID_PLUGIN_UI_EXTENSION_MODES = ['none', 'native-static', 'sandbox-iframe'] as const;
export const VALID_PLUGIN_ARTIFACT_KINDS = ['runtime-plugin'] as const;
export const SUPPORTED_PLUGIN_CAPABILITIES = [
  'hooks', 'api', 'nativeWidgetsStatic', 'sandboxUiExtension', 'dynamicRuntimeLoad', 'controlPlane',
] as const;

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
  | 'invalid-manifest' | 'schema-mismatch' | 'unsupported-capability' | 'engine-mismatch' | 'missing-artifact';

export interface PluginManifestContractSnapshot {
  manifestContract: 'vnext' | 'unknown';
  schemaVersion?: number | string;
  artifactKind?: string;
  main?: string;
  capabilities: string[];
  uiExtensionMode?: string;
  engines?: { bungee?: string; node?: string };
  validationFailureCode?: PluginManifestValidationFailureCode;
}

export class PluginManifestValidationError extends Error {
  constructor(message: string, public readonly details: PluginManifestContractSnapshot) {
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
  manifestContract: 'vnext';
  engines: { bungee: string; node?: string };
}

export interface LoadedPluginArtifactManifest extends LoadedPluginManifest {
  schemaVersion: number | string;
  artifactKind: PluginArtifactKind;
  main: string;
  capabilities: PluginCapability[];
  uiExtensionMode: PluginUiExtensionMode;
  uiAssetsPath?: string;
  manifestContract: 'vnext';
  engines: { bungee: string; node?: string };
}
