import type { PluginConfigValue } from '@jeffusion/bungee-types';
import type { PluginContributions, StrictPluginManifest } from './types';
import { internalRoute, relativeEntry, safeIdentifier, safeSlug } from './manifest-values';
import {
  array,
  exact,
  literal,
  optionalProperty,
  optionalString,
  PluginManifestCatalogError,
  record,
  string,
  uniqueStrings,
} from './parse-utils';

const CONTRIBUTION_FIELDS = new Set([
  'nativeWidgets', 'nativeSettingsComponent', 'api', 'widgets', 'navigation', 'settings', 'commands', 'upstreamSources',
]);
const NATIVE_WIDGET_FIELDS = new Set(['id', 'title', 'size', 'component', 'props']);
const API_FIELDS = new Set(['path', 'methods', 'handler', 'execution']);
const WIDGET_FIELDS = new Set(['title', 'path', 'size']);
const NAVIGATION_FIELDS = new Set(['label', 'path', 'icon', 'target']);
const COMMAND_FIELDS = new Set(['command', 'title', 'category', 'icon']);
const COMPONENT_FIELDS = new Set(['name', 'entry']);
const METADATA_FIELDS = new Set(['name', 'description', 'icon']);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);
const REPOSITORY_FIELDS = new Set(['type', 'url']);
const UPSTREAM_SOURCE_FIELDS = new Set(['id', 'label', 'listAccounts', 'createDraft', 'credentialPolicy']);
const CREDENTIAL_POLICY_FIELDS = new Set(['allowedOrigins', 'allowedRequests', 'allowedHeaderNames']);
const ALLOWED_REQUEST_FIELDS = new Set(['pathname', 'methods']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
const UNSAFE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'host', 'connection',
  'content-length', 'transfer-encoding', 'upgrade',
]);

function objects<T>(value: PluginConfigValue | undefined, path: string, parse: (item: PluginConfigValue, path: string) => T): readonly T[] | undefined {
  return value === undefined ? undefined : array(value, path).map((item, index) => parse(item, `${path}[${index}]`));
}

export function parseContributions(value: PluginConfigValue | undefined, path: string): PluginContributions | undefined {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, CONTRIBUTION_FIELDS, path);
  const nativeWidgetIds = new Set<string>();
  const nativeWidgets = objects(object.nativeWidgets, `${path}.nativeWidgets`, (item, itemPath) => {
    const widget = record(item, itemPath);
    exact(widget, NATIVE_WIDGET_FIELDS, itemPath);
    const id = safeSlug(string(widget.id, `${itemPath}.id`), `${itemPath}.id`);
    if (nativeWidgetIds.has(id)) throw new PluginManifestCatalogError(`${itemPath}.id`, 'widget ids must be unique');
    nativeWidgetIds.add(id);
    return {
      id, title: string(widget.title, `${itemPath}.title`),
      size: literal(widget.size, ['small', 'medium', 'large', 'full'] as const, `${itemPath}.size`),
      component: safeIdentifier(string(widget.component, `${itemPath}.component`), `${itemPath}.component`),
      ...optionalProperty('props', widget.props === undefined ? undefined : record(widget.props, `${itemPath}.props`)),
    };
  });
  const api = objects(object.api, `${path}.api`, (item, itemPath) => {
    const endpoint = record(item, itemPath);
    exact(endpoint, API_FIELDS, itemPath);
    const methods = array(endpoint.methods, `${itemPath}.methods`).map((method, index) =>
      literal(method, ['GET', 'POST', 'PUT', 'DELETE'] as const, `${itemPath}.methods[${index}]`));
    if (methods.length === 0 || new Set(methods).size !== methods.length) {
      throw new PluginManifestCatalogError(`${itemPath}.methods`, 'methods must be nonempty and unique');
    }
    return {
      path: internalRoute(string(endpoint.path, `${itemPath}.path`), `${itemPath}.path`),
      methods,
      handler: safeIdentifier(string(endpoint.handler, `${itemPath}.handler`), `${itemPath}.handler`),
      execution: endpoint.execution === undefined ? 'worker'
        : literal(endpoint.execution, ['worker', 'control'] as const, `${itemPath}.execution`),
    };
  });
  const upstreamSourceIds = new Set<string>();
  const upstreamSources = objects(object.upstreamSources, `${path}.upstreamSources`, (item, itemPath) => {
    const source = record(item, itemPath);
    exact(source, UPSTREAM_SOURCE_FIELDS, itemPath);
    const id = safeSlug(string(source.id, `${itemPath}.id`), `${itemPath}.id`);
    if (upstreamSourceIds.has(id)) throw new PluginManifestCatalogError(`${itemPath}.id`, 'upstream source ids must be unique');
    upstreamSourceIds.add(id);
    const policy = record(source.credentialPolicy, `${itemPath}.credentialPolicy`);
    exact(policy, CREDENTIAL_POLICY_FIELDS, `${itemPath}.credentialPolicy`);
    const origins = uniqueStrings(policy.allowedOrigins, `${itemPath}.credentialPolicy.allowedOrigins`, false);
    for (const [index, origin] of origins.entries()) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new PluginManifestCatalogError(`${itemPath}.credentialPolicy.allowedOrigins[${index}]`, 'invalid URL'); }
      if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
        throw new PluginManifestCatalogError(`${itemPath}.credentialPolicy.allowedOrigins[${index}]`, 'must be an exact HTTPS origin');
      }
    }
    const requests = array(policy.allowedRequests, `${itemPath}.credentialPolicy.allowedRequests`).map((request, index) => {
      const requestPath = `${itemPath}.credentialPolicy.allowedRequests[${index}]`;
      const requestObject = record(request, requestPath);
      exact(requestObject, ALLOWED_REQUEST_FIELDS, requestPath);
      const pathname = string(requestObject.pathname, `${requestPath}.pathname`);
      if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#') || pathname.includes('//')) {
        throw new PluginManifestCatalogError(`${requestPath}.pathname`, 'must be a valid absolute pathname');
      }
      const methods = array(requestObject.methods, `${requestPath}.methods`).map((method, methodIndex) =>
        literal(method, HTTP_METHODS, `${requestPath}.methods[${methodIndex}]`));
      if (methods.length === 0 || new Set(methods).size !== methods.length) {
        throw new PluginManifestCatalogError(`${requestPath}.methods`, 'methods must be nonempty and unique');
      }
      return { pathname, methods };
    });
    const headerNames = uniqueStrings(policy.allowedHeaderNames, `${itemPath}.credentialPolicy.allowedHeaderNames`);
    for (const [index, header] of headerNames.entries()) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header) || UNSAFE_HEADERS.has(header.toLowerCase())
        || header.toLowerCase().startsWith('x-forwarded-') || header.toLowerCase().startsWith('sec-')) {
        throw new PluginManifestCatalogError(`${itemPath}.credentialPolicy.allowedHeaderNames[${index}]`, 'unsafe header name');
      }
    }
    return {
      id,
      label: string(source.label, `${itemPath}.label`),
      listAccounts: safeIdentifier(string(source.listAccounts, `${itemPath}.listAccounts`), `${itemPath}.listAccounts`),
      createDraft: safeIdentifier(string(source.createDraft, `${itemPath}.createDraft`), `${itemPath}.createDraft`),
      credentialPolicy: { allowedOrigins: origins, allowedRequests: requests, allowedHeaderNames: headerNames },
    };
  });
  const widgets = objects(object.widgets, `${path}.widgets`, (item, itemPath) => {
    const widget = record(item, itemPath);
    exact(widget, WIDGET_FIELDS, itemPath);
    return {
      title: string(widget.title, `${itemPath}.title`),
      path: internalRoute(string(widget.path, `${itemPath}.path`), `${itemPath}.path`),
      ...optionalProperty('size', widget.size === undefined ? undefined
        : literal(widget.size, ['small', 'medium', 'large', 'full'] as const, `${itemPath}.size`)),
    };
  });
  const navigation = objects(object.navigation, `${path}.navigation`, (item, itemPath) => {
    const navigationItem = record(item, itemPath);
    exact(navigationItem, NAVIGATION_FIELDS, itemPath);
    return {
      label: string(navigationItem.label, `${itemPath}.label`),
      path: internalRoute(string(navigationItem.path, `${itemPath}.path`), `${itemPath}.path`),
      ...optionalProperty('icon', optionalString(navigationItem.icon, `${itemPath}.icon`)),
      ...optionalProperty('target', navigationItem.target === undefined ? undefined
        : literal(navigationItem.target, ['sidebar', 'header'] as const, `${itemPath}.target`)),
    };
  });
  const commands = objects(object.commands, `${path}.commands`, (item, itemPath) => {
    const command = record(item, itemPath);
    exact(command, COMMAND_FIELDS, itemPath);
    return {
      command: safeIdentifier(string(command.command, `${itemPath}.command`), `${itemPath}.command`),
      title: string(command.title, `${itemPath}.title`),
      ...optionalProperty('category', optionalString(command.category, `${itemPath}.category`)),
      ...optionalProperty('icon', optionalString(command.icon, `${itemPath}.icon`)),
    };
  });
  return {
    ...optionalProperty('nativeWidgets', nativeWidgets), ...optionalProperty('api', api),
    ...optionalProperty('widgets', widgets), ...optionalProperty('navigation', navigation),
    ...optionalProperty('upstreamSources', upstreamSources),
    ...optionalProperty('settings', object.settings === undefined ? undefined
      : internalRoute(string(object.settings, `${path}.settings`), `${path}.settings`)),
    ...optionalProperty('nativeSettingsComponent', object.nativeSettingsComponent === undefined ? undefined
      : safeIdentifier(string(object.nativeSettingsComponent, `${path}.nativeSettingsComponent`), `${path}.nativeSettingsComponent`)),
    ...optionalProperty('commands', commands),
  };
}

export function parseControl(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['control'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, new Set(['entry', 'rpc']), path);
  const names = new Set<string>();
  const rpc = array(object.rpc, `${path}.rpc`).map((item, index) => {
    const rpcPath = `${path}.rpc[${index}]`;
    const declaration = record(item, rpcPath);
    exact(declaration, new Set(['name', 'access']), rpcPath);
    const name = safeIdentifier(string(declaration.name, `${rpcPath}.name`), `${rpcPath}.name`);
    if (names.has(name)) throw new PluginManifestCatalogError(`${rpcPath}.name`, 'rpc names must be unique');
    names.add(name);
    return { name, access: literal(declaration.access, ['bound-attempt'] as const, `${rpcPath}.access`) };
  });
  return { entry: relativeEntry(string(object.entry, `${path}.entry`), `${path}.entry`, 'main'), rpc };
}

export function parseMetadata(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['metadata'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, METADATA_FIELDS, path);
  return {
    ...optionalProperty('name', optionalString(object.name, `${path}.name`)),
    ...optionalProperty('description', optionalString(object.description, `${path}.description`)),
    ...optionalProperty('icon', optionalString(object.icon, `${path}.icon`)),
  };
}

export function parseUi(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['ui'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  exact(object, new Set(['components']), path);
  const components = objects(object.components, `${path}.components`, (item, itemPath) => {
    const component = record(item, itemPath);
    exact(component, COMPONENT_FIELDS, itemPath);
    return {
      name: safeIdentifier(string(component.name, `${itemPath}.name`), `${itemPath}.name`),
      entry: relativeEntry(string(component.entry, `${itemPath}.entry`), `${itemPath}.entry`, 'ui'),
    };
  });
  return { ...optionalProperty('components', components) };
}

export function parseAuthor(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['author'] {
  if (value === undefined || typeof value === 'string') return value === undefined ? undefined : string(value, path);
  const object = record(value, path);
  exact(object, AUTHOR_FIELDS, path);
  return {
    name: string(object.name, `${path}.name`),
    ...optionalProperty('email', optionalString(object.email, `${path}.email`)),
    ...optionalProperty('url', optionalString(object.url, `${path}.url`)),
  };
}

export function parseRepository(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['repository'] {
  if (value === undefined || typeof value === 'string') return value === undefined ? undefined : string(value, path);
  const object = record(value, path);
  exact(object, REPOSITORY_FIELDS, path);
  return { type: string(object.type, `${path}.type`), url: string(object.url, `${path}.url`) };
}

export function parseStringRecord(value: PluginConfigValue | undefined, path: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const object = record(value, path);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key.length === 0) throw new PluginManifestCatalogError(path, 'keys must not be empty');
    output[key] = string(item, `${path}.${key}`);
  }
  return output;
}

export function parseTranslations(value: PluginConfigValue | undefined, path: string): StrictPluginManifest['translations'] {
  if (value === undefined) return undefined;
  const object = record(value, path);
  const translations: Record<string, Readonly<Record<string, string>>> = {};
  for (const [locale, messages] of Object.entries(object)) {
    if (locale.length === 0) throw new PluginManifestCatalogError(path, 'locale must not be empty');
    translations[locale] = parseStringRecord(messages, `${path}.${locale}`) ?? {};
  }
  return translations;
}

export function parseOptionalStringList(value: PluginConfigValue | undefined, path: string): readonly string[] | undefined {
  return value === undefined ? undefined : uniqueStrings(value, path);
}
