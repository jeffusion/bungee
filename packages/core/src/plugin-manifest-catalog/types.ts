import type { PluginConfigValue, Sha256Digest } from '@jeffusion/bungee-types';
import type {
  PluginArtifactKind,
  PluginCapability,
  PluginUiExtensionMode,
} from '../plugin-artifact-contract';
import type { PluginConfigFieldType } from '../plugin.types';

export type ReadonlyPluginOption = {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
};

export type ReadonlyPluginConfigField = {
  readonly name: string;
  readonly type: PluginConfigFieldType;
  readonly label: string;
  readonly required?: boolean;
  readonly default?: PluginConfigValue;
  readonly options?: readonly ReadonlyPluginOption[];
  readonly description?: string;
  readonly placeholder?: string;
  readonly catalogPlugin?: string;
  readonly sourceCatalogProviderField?: string;
  readonly targetCatalogProviderField?: string;
  readonly validation?: Readonly<{
    pattern?: string;
    trimmed?: boolean;
    min?: number;
    max?: number;
    message?: string;
  }>;
  readonly showIf?: ReadonlyPluginShowIfCondition;
  readonly properties?: readonly ReadonlyPluginConfigField[];
  readonly items?: ReadonlyPluginConfigField;
  readonly fieldTransform?: Readonly<{
    type: 'split' | 'concat' | 'compute';
    separator?: string;
    fields?: readonly string[];
  }>;
};

export type ReadonlyPluginShowIfCondition =
  | Readonly<{ field: string; value: PluginConfigValue }>
  | Readonly<{ all: readonly ReadonlyPluginShowIfCondition[] }>
  | Readonly<{ any: readonly ReadonlyPluginShowIfCondition[] }>;

export type PluginContributions = Readonly<{
  nativeWidgets?: readonly Readonly<{
    id: string;
    title: string;
    size: 'small' | 'medium' | 'large' | 'full';
    component: string;
    props?: Readonly<Record<string, PluginConfigValue>>;
  }>[];
  api?: readonly Readonly<{
    path: string;
    methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[];
    handler: string;
    execution: 'worker' | 'control';
  }>[];
  upstreamSources?: readonly Readonly<{
    id: string;
    label: string;
    listAccounts: string;
    createDraft: string;
    credentialPolicy: Readonly<{
      allowedOrigins: readonly string[];
      allowedRequests: readonly Readonly<{ pathname: string; methods: readonly string[] }>[];
      allowedHeaderNames: readonly string[];
    }>;
  }>[];
  widgets?: readonly Readonly<{
    title: string;
    path: string;
    size?: 'small' | 'medium' | 'large' | 'full';
  }>[];
  navigation?: readonly Readonly<{
    label: string;
    path: string;
    icon?: string;
    target?: 'sidebar' | 'header';
  }>[];
  settings?: string;
  nativeSettingsComponent?: string;
  commands?: readonly Readonly<{
    command: string;
    title: string;
    category?: string;
    icon?: string;
  }>[];
}>;

export type StrictPluginManifest = Readonly<{
  name: string;
  version: string;
  builtin?: boolean;
  schemaVersion: 2;
  artifactKind: PluginArtifactKind;
  main: string;
  capabilities: readonly PluginCapability[];
  uiExtensionMode: PluginUiExtensionMode;
  engines: Readonly<{ bungee: string; node?: string }>;
  control?: Readonly<{
    entry: string;
    rpc: readonly Readonly<{ name: string; access: 'bound-attempt' }>[];
  }>;
  description?: string;
  icon?: string;
  author?: string | Readonly<{ name: string; email?: string; url?: string }>;
  license?: string;
  homepage?: string;
  repository?: string | Readonly<{ type: string; url: string }>;
  keywords?: readonly string[];
  ui?: Readonly<{ components?: readonly Readonly<{ name: string; entry: string }>[] }>;
  permissions?: readonly string[];
  dependencies?: Readonly<Record<string, string>>;
  contributes?: PluginContributions;
  metadata?: Readonly<{
    name?: string;
    description?: string;
    icon?: string;
  }>;
  configSchema: readonly ReadonlyPluginConfigField[];
  translations?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export type PluginManifestRecord = Readonly<{
  name: string;
  rootPath: string;
  manifest: StrictPluginManifest;
  pluginPath: string;
  pluginDir: string;
  manifestPath: string;
  mainPath: string;
  controlPath?: string;
  runtimeHash: Sha256Digest;
  configSchema: readonly ReadonlyPluginConfigField[];
}>;

export type PluginManifestRecordBase = Readonly<Omit<PluginManifestRecord, 'runtimeHash'>>;

export type PluginManifestCatalogRecord = PluginManifestRecord;
