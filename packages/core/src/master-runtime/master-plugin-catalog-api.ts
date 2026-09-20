import type { RepositorySnapshot } from '../config-storage';
import { createPluginSandboxPolicy } from '../ui/plugin-sandbox-policy';
import type { PluginManifestCatalog } from '../plugin-manifest-catalog/catalog';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import { freezeDeep } from '../plugin-manifest-catalog/parse-utils';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export interface MasterPluginCatalogApi {
  matches(path: string): boolean;
  handle(request: Request, snapshot: RepositorySnapshot): Promise<Response>;
}

export interface MasterPluginCatalogApiOptions {
  readonly catalog: Pick<PluginManifestCatalog, 'records'>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

function methodNotAllowed(): Response {
  return json({ error: 'method_not_allowed' }, 405);
}

function isTranslationKey(value: unknown): value is string {
  return typeof value === 'string' && value.includes('.') && !value.includes(' ');
}

function prefixTranslationKeys(value: unknown, pluginName: string, fields = new Set(['label', 'description', 'placeholder'])): unknown {
  if (Array.isArray(value)) return value.map((item) => prefixTranslationKeys(item, pluginName, fields));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    fields.has(key) && isTranslationKey(child)
      ? `plugins.${pluginName}.${child}`
      : prefixTranslationKeys(child, pluginName, fields),
  ]));
}

function activePlugins(snapshot: RepositorySnapshot): ReadonlySet<string> {
  return new Set(snapshot.aggregate.plugin_activations.map(({ plugin_name }) => plugin_name));
}

function metadata(record: PluginManifestRecord): object {
  const manifest = record.manifest;
  const metadataValue = manifest.metadata ?? {};
  const result = {
    name: isTranslationKey(metadataValue.name) ? `plugins.${record.name}.${metadataValue.name}` : metadataValue.name ?? manifest.name,
    description: isTranslationKey(metadataValue.description ?? manifest.description)
      ? `plugins.${record.name}.${metadataValue.description ?? manifest.description}`
      : metadataValue.description ?? manifest.description ?? '',
    ...(metadataValue.icon === undefined ? {} : { icon: metadataValue.icon }),
    ...(manifest.contributes === undefined ? {} : { contributes: safeContributions(manifest.contributes) }),
  };
  freezeDeep(result);
  return result;
}

const CONTRIBUTION_KEYS = [
  'nativeWidgets', 'nativeSettingsComponent', 'api', 'widgets', 'navigation', 'settings', 'commands', 'upstreamSources',
] as const;

function safeContributions(value: NonNullable<PluginManifestRecord['manifest']['contributes']>): object {
  const result = Object.fromEntries(CONTRIBUTION_KEYS.flatMap((key) =>
    value[key] === undefined ? [] : [[key, value[key]]]));
  freezeDeep(result);
  return result;
}

function pluginResponse(record: PluginManifestRecord, enabled: boolean): object {
  const manifest = record.manifest;
  return {
    name: record.name,
    version: manifest.version,
    description: isTranslationKey(manifest.description ?? manifest.metadata?.description)
      ? `plugins.${record.name}.${manifest.description ?? manifest.metadata?.description}`
      : manifest.description ?? manifest.metadata?.description ?? '',
    metadata: metadata(record),
    enabled,
    hasManifest: true,
  };
}

function schemaResponse(record: PluginManifestRecord): object {
  const manifest = record.manifest;
  return {
    name: record.name,
    version: manifest.version,
    description: isTranslationKey(manifest.description)
      ? `plugins.${record.name}.${manifest.description}` : manifest.description,
    metadata: metadata(record),
    configSchema: prefixTranslationKeys(record.configSchema, record.name),
  };
}

function records(options: MasterPluginCatalogApiOptions): readonly PluginManifestRecord[] {
  return options.catalog.records();
}

function sandboxResponse(record: PluginManifestRecord, active: boolean): object {
  const policy = createPluginSandboxPolicy(record.manifest, active);
  const result = {
    sandbox: policy.attributes,
    allowedHostActions: policy.allowedHostActions,
    controlAllowlist: policy.controlAllowlist,
  };
  freezeDeep(result);
  return result;
}

export function createMasterPluginCatalogApi(
  options: MasterPluginCatalogApiOptions,
): MasterPluginCatalogApi {
  const catalogRecords = records(options);
  const byName = new Map(catalogRecords.map((record) => [record.name, record]));
  const matches = (path: string): boolean => {
    return path === '/api/plugins'
      || path === '/api/plugins/schemas'
      || path === '/api/plugin-translations'
      || /^\/api\/plugins\/[^/]+\/sandbox$/.test(path);
  };

  return Object.freeze({
    matches,

    async handle(request: Request, snapshot: RepositorySnapshot): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (!matches(path)) return notFound();
      if (request.method !== 'GET') return methodNotAllowed();
      const enabled = activePlugins(snapshot);

      if (path === '/api/plugins') {
        return json(catalogRecords.map((record) => pluginResponse(record, enabled.has(record.name))));
      }
      if (path === '/api/plugins/schemas') {
        const schemas = Object.fromEntries(catalogRecords
          .filter((record) => new URL(request.url).searchParams.get('enabledOnly') !== 'true' || enabled.has(record.name))
          .map((record) => [record.name, schemaResponse(record)]));
        return json(schemas);
      }
      if (path === '/api/plugin-translations') {
        const translations: Record<string, { plugins: Record<string, Readonly<Record<string, string>>> }> = {};
        for (const record of catalogRecords) {
          for (const [locale, messages] of Object.entries(record.manifest.translations ?? {})) {
            (translations[locale] ??= { plugins: {} }).plugins[record.name] = messages;
          }
        }
        return json(translations);
      }

      const match = /^\/api\/plugins\/([^/]+)\/sandbox$/.exec(path);
      const name = match?.[1];
      let decodedName: string | undefined;
      try { decodedName = name === undefined ? undefined : decodeURIComponent(name); }
      catch { return notFound(); }
      const record = decodedName === undefined ? undefined : byName.get(decodedName);
      return record === undefined || !enabled.has(record.name) ? notFound() : json(sandboxResponse(record, true));
    },
  });
}
