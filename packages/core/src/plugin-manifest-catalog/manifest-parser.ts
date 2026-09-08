import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { CORE_HOST_VERSION } from '../core-version';
import {
  SUPPORTED_PLUGIN_CAPABILITIES,
  VALID_PLUGIN_ARTIFACT_KINDS,
  VALID_PLUGIN_UI_EXTENSION_MODES,
  type PluginCapability,
} from '../plugin-artifact-contract';
import { isPluginName } from '../config-storage/plugin-name';
import { parseConfigFields } from './config-field-parser';
import {
  parseAuthor,
  parseContributions,
  parseControl,
  parseMetadata,
  parseOptionalStringList,
  parseRepository,
  parseStringRecord,
  parseTranslations,
  parseUi,
} from './manifest-nested-parser';
import {
  boolean,
  exact,
  freezeDeep,
  literal,
  optionalProperty,
  optionalString,
  parseJsonText,
  PluginManifestCatalogError,
  record,
  string,
  uniqueStrings,
} from './parse-utils';
import type { StrictPluginManifest } from './types';
import { parseExactSemver, validateEngineRange } from './manifest-semver';
import { PLUGIN_PERMISSIONS, relativeEntry } from './manifest-values';

const TOP_FIELDS = new Set([
  'name', 'version', 'builtin', 'schemaVersion', 'artifactKind', 'main', 'capabilities', 'uiExtensionMode', 'engines', 'control',
  'description', 'icon', 'author', 'license', 'homepage', 'repository', 'keywords', 'ui', 'permissions', 'dependencies',
  'contributes', 'metadata', 'configSchema', 'translations',
]);
const ENGINE_FIELDS = new Set(['bungee', 'node']);
function version(value: PluginConfigValue | undefined, path: string): string {
  return parseExactSemver(string(value, path), path);
}

function engines(value: PluginConfigValue | undefined): StrictPluginManifest['engines'] {
  if (value === undefined) throw new PluginManifestCatalogError('engines', 'required field');
  const object = record(value, 'engines');
  exact(object, ENGINE_FIELDS, 'engines');
  return {
    bungee: validateEngineRange(string(object.bungee, 'engines.bungee'), 'engines.bungee', CORE_HOST_VERSION),
    ...optionalProperty('node', object.node === undefined ? undefined
      : validateEngineRange(string(object.node, 'engines.node'), 'engines.node', process.version)),
  };
}

function main(value: PluginConfigValue | undefined): string {
  return relativeEntry(string(value, 'main'), 'main', 'main');
}

function capabilities(value: PluginConfigValue | undefined): readonly PluginCapability[] {
  const entries = uniqueStrings(value, 'capabilities', false);
  return entries.map((entry) => {
    const match = SUPPORTED_PLUGIN_CAPABILITIES.find((candidate) => candidate === entry);
    if (match === undefined) throw new PluginManifestCatalogError('capabilities', `unsupported capability ${entry}`);
    return match;
  });
}

export function parsePluginManifestText(content: string, source = 'manifest.json'): StrictPluginManifest {
  const root = record(parseJsonText(content, source), '');
  exact(root, TOP_FIELDS, '');
  const name = string(root.name, 'name');
  if (!isPluginName(name)) throw new PluginManifestCatalogError('name', 'invalid plugin name');
  if (root.schemaVersion !== 2) throw new PluginManifestCatalogError('schemaVersion', 'expected exactly 2');
  const parsedCapabilities = capabilities(root.capabilities);
  const contributes = parseContributions(root.contributes, 'contributes');
  const control = parseControl(root.control, 'control');
  const hasControlPlane = parsedCapabilities.includes('controlPlane');
  if (hasControlPlane !== (control !== undefined)) {
    throw new PluginManifestCatalogError('control', 'controlPlane capability/control declaration mismatch');
  }
  const uiExtensionMode = literal(root.uiExtensionMode, VALID_PLUGIN_UI_EXTENSION_MODES, 'uiExtensionMode');
  const nativeCapability = parsedCapabilities.includes('nativeWidgetsStatic');
  const sandboxCapability = parsedCapabilities.includes('sandboxUiExtension');
  if ((uiExtensionMode === 'native-static') !== nativeCapability
    || (uiExtensionMode === 'sandbox-iframe') !== sandboxCapability) {
    throw new PluginManifestCatalogError('uiExtensionMode', 'capability/ui mode mismatch');
  }
  if (!parsedCapabilities.includes('dynamicRuntimeLoad')) {
    throw new PluginManifestCatalogError('capabilities', 'runtime-plugin requires dynamicRuntimeLoad');
  }
  if (!parsedCapabilities.some((capability) => capability === 'hooks' || capability === 'api')) {
    throw new PluginManifestCatalogError('capabilities', 'runtime-plugin requires at least one runtime capability');
  }
  if ((contributes?.nativeWidgets?.length ?? 0) > 0
    && (uiExtensionMode !== 'native-static' || !parsedCapabilities.includes('nativeWidgetsStatic'))) {
    throw new PluginManifestCatalogError('contributes.nativeWidgets', 'capability/ui mode mismatch');
  }
  if ((contributes?.api?.length ?? 0) > 0 && !parsedCapabilities.includes('api')) {
    throw new PluginManifestCatalogError('contributes.api', 'capability mismatch');
  }
  const apiRoutes = new Map<string, string>();
  for (const [index, endpoint] of (contributes?.api ?? []).entries()) {
    if (endpoint.execution === 'control' && !hasControlPlane) {
      throw new PluginManifestCatalogError(`contributes.api[${index}].execution`, 'control API requires controlPlane');
    }
    for (const method of endpoint.methods) {
      const normalized = `${method}:${endpoint.path.length > 1 ? endpoint.path.replace(/\/+$/, '') : endpoint.path}`;
      const previous = apiRoutes.get(normalized);
      if (previous !== undefined) {
        throw new PluginManifestCatalogError(`contributes.api[${index}].path`, `conflicts with ${previous}`);
      }
      apiRoutes.set(normalized, `contributes.api[${index}].path`);
    }
  }
  const resolveControlApi = (
    handler: string,
    method: 'GET' | 'POST',
    sourcePath: string,
  ): void => {
    const declarations = (contributes?.api ?? []).filter((candidate) => candidate.handler === handler);
    if (declarations.length === 0) {
      throw new PluginManifestCatalogError(sourcePath, `unknown control API handler ${handler}`);
    }
    const declaration = declarations.find((candidate) => candidate.execution === 'control' && candidate.methods.includes(method));
    if (declaration === undefined && declarations.every((candidate) => candidate.execution !== 'control')) {
      throw new PluginManifestCatalogError(sourcePath, `handler ${handler} must declare execution control`);
    }
    if (declaration === undefined) {
      throw new PluginManifestCatalogError(sourcePath, `control API handler ${handler} must declare ${method}`);
    }
    // The API declaration is the sole source of the route path. The source
    // contribution carries only the handler reference and never an alias.
    const resolvedPath = declaration.path;
    if (resolvedPath.length === 0) throw new PluginManifestCatalogError(sourcePath, 'control API path must not be empty');
  };
  for (const [index, source] of (contributes?.upstreamSources ?? []).entries()) {
    resolveControlApi(source.listAccounts, 'GET', `contributes.upstreamSources[${index}].listAccounts`);
    resolveControlApi(source.createDraft, 'POST', `contributes.upstreamSources[${index}].createDraft`);
  }
  const components = parseUi(root.ui, 'ui')?.components;
  if ((components?.length ?? 0) > 0
    && (uiExtensionMode !== 'native-static' || !parsedCapabilities.includes('nativeWidgetsStatic'))) {
    throw new PluginManifestCatalogError('ui.components', 'capability/ui mode mismatch');
  }
  const componentNames = new Set(components?.map(({ name: componentName }) => componentName) ?? []);
  for (const widget of contributes?.nativeWidgets ?? []) {
    if (!componentNames.has(widget.component)) {
      throw new PluginManifestCatalogError('contributes.nativeWidgets', `unknown component ${widget.component}`);
    }
  }
  const permissions = root.permissions === undefined ? undefined : uniqueStrings(root.permissions, 'permissions');
  for (const permission of permissions ?? []) {
    if (PLUGIN_PERMISSIONS.find((candidate) => candidate === permission) === undefined) {
      throw new PluginManifestCatalogError('permissions', `unsupported permission ${permission}`);
    }
  }
  const parsed: StrictPluginManifest = {
    name, version: version(root.version, 'version'), schemaVersion: 2,
    artifactKind: literal(root.artifactKind, VALID_PLUGIN_ARTIFACT_KINDS, 'artifactKind'),
    main: main(root.main), capabilities: parsedCapabilities, uiExtensionMode, engines: engines(root.engines),
    ...optionalProperty('control', control),
    ...optionalProperty('builtin', root.builtin === undefined ? undefined : boolean(root.builtin, 'builtin')),
    ...optionalProperty('description', optionalString(root.description, 'description')),
    ...optionalProperty('icon', optionalString(root.icon, 'icon')),
    ...optionalProperty('author', parseAuthor(root.author, 'author')),
    ...optionalProperty('license', optionalString(root.license, 'license')),
    ...optionalProperty('homepage', optionalString(root.homepage, 'homepage')),
    ...optionalProperty('repository', parseRepository(root.repository, 'repository')),
    ...optionalProperty('keywords', parseOptionalStringList(root.keywords, 'keywords')),
    ...optionalProperty('ui', components === undefined ? undefined : { components }),
    ...optionalProperty('permissions', permissions),
    ...optionalProperty('dependencies', parseStringRecord(root.dependencies, 'dependencies')),
    ...optionalProperty('contributes', contributes),
    ...optionalProperty('metadata', parseMetadata(root.metadata, 'metadata')),
    configSchema: parseConfigFields(root.configSchema, 'configSchema'),
    ...optionalProperty('translations', parseTranslations(root.translations, 'translations')),
  };
  freezeDeep(parsed);
  return parsed;
}
