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
  array,
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
  'name', 'version', 'builtin', 'schemaVersion', 'artifactKind', 'main', 'capabilities', 'runtimeScope', 'uiExtensionMode', 'engines', 'control',
  'description', 'icon', 'author', 'license', 'homepage', 'repository', 'keywords', 'ui', 'permissions', 'dependencies',
  'contributes', 'metadata', 'configSchema', 'translations', 'ingress', 'management', 'services',
]);
const ENGINE_FIELDS = new Set(['bungee', 'node']);
function serviceDeclarations(value: PluginConfigValue | undefined): StrictPluginManifest['services'] {
  if (value === undefined) return undefined;
  const root = record(value, 'services');
  exact(root, new Set(['provides','consumes']), 'services');
  const parse = (kind: 'provides' | 'consumes') => {
    const seen = new Set<string>();
    return root[kind] === undefined ? [] : array(root[kind], `services.${kind}`).map((item, index) => {
      const path = `services.${kind}[${index}]`, entry = record(item, path);
      exact(entry, new Set(kind === 'provides' ? ['id','version','process','kind','scope'] : ['plugin','id','version','process','kind','scope']), path);
      const id = string(entry.id, `${path}.id`);
      if (!/^[a-z][a-z0-9.-]{0,127}$/.test(id)) throw new PluginManifestCatalogError(path, 'invalid service ID');
      if (typeof entry.version !== 'number' || !Number.isSafeInteger(entry.version) || entry.version < 1) throw new PluginManifestCatalogError(path, 'invalid service contract version');
      const process = literal(entry.process, ['worker','control','ingress'] as const, `${path}.process`);
      const serviceKind = entry.kind === undefined ? undefined : literal(entry.kind, ['local','rpc','events','snapshot','stream'] as const, `${path}.kind`);
      const scope = entry.scope === undefined ? undefined : literal(entry.scope, ['global'] as const, `${path}.scope`);
      const plugin = kind === 'consumes' ? string(entry.plugin, `${path}.plugin`) : undefined;
      if (plugin !== undefined && !isPluginName(plugin)) throw new PluginManifestCatalogError(path, 'invalid provider name');
      // consume(provider, id, major) has no scope selector: reject ambiguous consumers.
      const identity = `${plugin ?? ''}/${id}/${entry.version}/${process}${kind === 'provides' ? `/${scope ?? 'global'}` : ''}`;
      if (seen.has(identity)) throw new PluginManifestCatalogError(path, 'duplicate service declaration');
      seen.add(identity);
      return {id,version:entry.version,process,...(plugin === undefined ? {} : {plugin}), ...optionalProperty('kind',serviceKind), ...optionalProperty('scope',scope)};
    });
  };
  return {provides:parse('provides'),consumes:parse('consumes') as NonNullable<StrictPluginManifest['services']>['consumes']};
}
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
  const runtimeScope = root.runtimeScope === undefined ? undefined
    : literal(root.runtimeScope, ['global', 'scoped'] as const, 'runtimeScope');
  if (runtimeScope === 'global' && !parsedCapabilities.includes('hooks') && !parsedCapabilities.includes('controlPlane')) {
    throw new PluginManifestCatalogError('runtimeScope', 'global scope requires a runtime entry capability');
  }
  const contributes = parseContributions(root.contributes, 'contributes');
  const control = parseControl(root.control, 'control');
  const ingress = root.ingress === undefined ? undefined : (() => { const value = record(root.ingress, 'ingress'); exact(value, new Set(['entry']), 'ingress'); return {entry:relativeEntry(string(value.entry,'ingress.entry'),'ingress.entry','main')}; })();
  const management = root.management === undefined ? undefined : (() => { const value = record(root.management, 'management'); exact(value, new Set(['loginComponent']), 'management'); return { ...optionalProperty('loginComponent', optionalString(value.loginComponent,'management.loginComponent')) }; })();
  if ((ingress || management) && !control) throw new PluginManifestCatalogError('control','extensions require control entry');
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
  if ((contributes?.api?.length ?? 0) > 0 && (control === undefined || !hasControlPlane)) {
    throw new PluginManifestCatalogError('contributes.api', 'requires control entry and controlPlane capability');
  }
  const apiRoutes = new Map<string, string>();
  for (const [index, endpoint] of (contributes?.api ?? []).entries()) {
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
  const componentNames = new Set(components?.map(({ name: componentName }) => componentName) ?? []);
  const nativeSettingsComponent = contributes?.nativeSettingsComponent;
  if (nativeSettingsComponent !== undefined) {
    if (contributes?.settings === undefined) {
      throw new PluginManifestCatalogError('contributes.nativeSettingsComponent', 'requires contributes.settings');
    }
    if (root.builtin !== true) {
      throw new PluginManifestCatalogError('contributes.nativeSettingsComponent', 'requires builtin manifest');
    }
    if (uiExtensionMode !== 'native-static') {
      throw new PluginManifestCatalogError('contributes.nativeSettingsComponent', 'requires uiExtensionMode native-static');
    }
    if (!parsedCapabilities.includes('nativeWidgetsStatic')) {
      throw new PluginManifestCatalogError('contributes.nativeSettingsComponent', 'requires capability nativeWidgetsStatic');
    }
    if (!componentNames.has(nativeSettingsComponent)) {
      throw new PluginManifestCatalogError('contributes.nativeSettingsComponent', `unknown component ${nativeSettingsComponent}`);
    }
  }
  if ((components?.length ?? 0) > 0
    && (uiExtensionMode !== 'native-static' || !parsedCapabilities.includes('nativeWidgetsStatic'))) {
    throw new PluginManifestCatalogError('ui.components', 'capability/ui mode mismatch');
  }
  for (const widget of contributes?.nativeWidgets ?? []) {
    if (!componentNames.has(widget.component)) {
      throw new PluginManifestCatalogError('contributes.nativeWidgets', `unknown component ${widget.component}`);
    }
  }
  const nativePagePaths = new Set<string>();
  for (const page of contributes?.navigation ?? []) {
    if (page.component === undefined) continue;
    if (uiExtensionMode !== 'native-static' || !componentNames.has(page.component)) {
      throw new PluginManifestCatalogError('contributes.navigation', `unknown native component ${page.component}`);
    }
    if (nativePagePaths.has(page.path) || page.path === contributes?.settings) {
      throw new PluginManifestCatalogError('contributes.navigation', 'native page paths must be unique and distinct from settings');
    }
    nativePagePaths.add(page.path);
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
    ...optionalProperty('runtimeScope', runtimeScope),
    ...optionalProperty('control', control), ...optionalProperty('ingress', ingress), ...optionalProperty('management', management),
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
    ...optionalProperty('services', serviceDeclarations(root.services)),
    ...optionalProperty('contributes', contributes),
    ...optionalProperty('metadata', parseMetadata(root.metadata, 'metadata')),
    configSchema: parseConfigFields(root.configSchema, 'configSchema'),
    ...optionalProperty('translations', parseTranslations(root.translations, 'translations')),
  };
  freezeDeep(parsed);
  return parsed;
}
