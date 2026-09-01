import { extname } from 'node:path';
import { PluginManifestCatalogError } from './parse-utils';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ROUTE_SEGMENT = /^(?:[A-Za-z0-9_~-]+|:[A-Za-z_$][A-Za-z0-9_$]*)$/;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const OBJECT_PROTOTYPE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));
const ECMASCRIPT_RESERVED_WORDS = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);
const MAIN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const UI_EXTENSIONS = new Set(['.svelte']);

export const PLUGIN_PERMISSIONS = [
  'network', 'filesystem', 'database', 'storage',
  'ui:modals', 'ui:popups', 'ui:forms', 'ui:navigation',
  'api:routes', 'api:plugins', 'api:logs',
] as const;

export function isDangerousObjectName(value: string): boolean {
  return value === 'prototype' || OBJECT_PROTOTYPE_NAMES.has(value);
}

export function safeIdentifier(value: string, path: string): string {
  if (!IDENTIFIER.test(value) || isDangerousObjectName(value)
    || ECMASCRIPT_RESERVED_WORDS.has(value)) {
    throw new PluginManifestCatalogError(path, 'invalid safe identifier');
  }
  return value;
}

export function safeSlug(value: string, path: string): string {
  if (!SLUG.test(value) || isDangerousObjectName(value)) {
    throw new PluginManifestCatalogError(path, 'invalid identifier');
  }
  return value;
}

export function relativeEntry(value: string, path: string, kind: 'main' | 'ui'): string {
  const segments = value.split('/');
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')
    || segments.some((segment) => segment === '.' || segment === '..' || !PORTABLE_PATH_SEGMENT.test(segment))) {
    throw new PluginManifestCatalogError(path, 'must use safe portable path segments without dot segments');
  }
  const extensions = kind === 'main' ? MAIN_EXTENSIONS : UI_EXTENSIONS;
  if (!extensions.has(extname(value).toLowerCase())) {
    throw new PluginManifestCatalogError(path, `has an unsupported ${kind} extension`);
  }
  return value;
}

export function internalRoute(value: string, path: string): string {
  if (!value.startsWith('/') || value === '/' || value.includes('\\') || value.includes('?')
    || value.includes('#') || value.includes('//')) {
    throw new PluginManifestCatalogError(path, 'invalid internal path');
  }
  const segments = value.slice(1).split('/');
  if (segments.some((segment) => !ROUTE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new PluginManifestCatalogError(path, 'invalid internal path segment');
  }
  return value;
}
