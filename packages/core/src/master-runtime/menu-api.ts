import { createHash } from 'node:crypto';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, reconcileMenuLayout,
  type MenuLayout, type MenuLayoutRecord, type MenuPage, type MenuSnapshot } from '@jeffusion/bungee-types';
import type { MenuLayoutCommit } from '../config-storage/menu-store';
import type { RepositorySnapshot } from '../config-storage';
import { ConfigRepositoryError } from '../config-storage';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import { defaultMenuIcon, hasMenuIconCollection, menuIconCollections, menuIconRevision, menuIcons, searchMenuIcons } from '../ui/menu-icons';
import { isMenuPageId, MAX_MENU_LAYOUT_BYTES, menuPageIds, validateMenuLayout } from '../ui/menu-layout';
import { readControlJson } from './control-api-body';

export interface MenuApi {
  matches(path: string): boolean;
  handle(request: Request, snapshot: RepositorySnapshot, authorizeWrite: () => Promise<boolean>): Promise<Response>;
}
export interface MenuApiOptions {
  readonly repository: {
    getMenuLayout(): Promise<MenuLayoutRecord>;
    putMenuLayout(expectedRevision: number, layout: MenuLayout, catalogPageIds: readonly string[]): Promise<MenuLayoutCommit>;
  };
  readonly catalog: { records(): readonly PluginManifestRecord[] };
}
class InvalidMenuCatalogError extends Error {}
export function menuCatalog(records: readonly PluginManifestRecord[], snapshot: RepositorySnapshot): readonly MenuPage[] {
  const active = new Set(snapshot.aggregate.plugin_activations.map(item => item.plugin_name));
  const plugins = [...records].sort((a,b) => a.name.localeCompare(b.name)).flatMap(record => {
    const paths = new Set<string>();
    // Header/sidebar contributions to one page share its first declared presentation.
    return (record.manifest.contributes?.navigation ?? []).filter(nav => {
      if (paths.has(nav.path)) return false;
      paths.add(nav.path); return true;
    }).map(nav => ({
      id: `plugin:${encodeURIComponent(record.name)}:${encodeURIComponent(nav.path)}`,
      label: nav.label, href: `/#/extensions/${encodeURIComponent(record.name)}/${nav.path.replace(/^\//, '')}`,
      source: 'plugin' as const, pluginName: record.name, defaultIcon: defaultMenuIcon(nav.icon ?? record.manifest.metadata?.icon), available: active.has(record.name),
    }));
  });
  const catalog = [...BUILTIN_MENU_PAGES.slice(0,4), ...plugins, ...BUILTIN_MENU_PAGES.slice(4)];
  if (catalog.length > 512 || new Set(catalog.map(page => page.id)).size !== catalog.length
    || catalog.some(page => !isMenuPageId(page.id)) || Buffer.byteLength(JSON.stringify(catalog)) > MAX_MENU_LAYOUT_BYTES) {
    throw new InvalidMenuCatalogError('menu catalog exceeds limits or contains duplicate pages');
  }
  return catalog;
}
function snapshot(record: MenuLayoutRecord, catalog: readonly MenuPage[]): MenuSnapshot {
  return { revision: record.revision, catalog,
    layout: record.layout === null ? createDefaultMenuLayout(catalog) : reconcileMenuLayout(record.layout, catalog), iconRevision: menuIconRevision };
}
function json(value: unknown, status = 200): Response { return Response.json(value, {status, headers: {'cache-control':'no-store'}}); }
function cached(request: Request, value: unknown): Response {
  const body = JSON.stringify(value);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const headers = {'content-type':'application/json; charset=utf-8',etag,'cache-control':'private, no-cache',vary:'Authorization, Cookie'};
  const match = request.headers.get('if-none-match')?.split(',').map(value => value.trim().replace(/^W\//, '')).some(value => value === etag || value === '*');
  return new Response(match ? null : body, {status:match ? 304 : 200,headers});
}
function parameters(url: URL, allowed: readonly string[]): boolean {
  return url.search.length <= 16384 && [...url.searchParams.keys()].every(key => allowed.includes(key) && url.searchParams.getAll(key).length === 1);
}
function integer(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}
export function createMenuApi(options: MenuApiOptions): MenuApi {
  const matches = (path: string) => ['/api/ui/menus','/api/ui/icons/collections','/api/ui/icons/search','/api/ui/icons/data'].includes(path);
  return {
    matches,
    async handle(request, configuration, authorizeWrite) {
      const url = new URL(request.url), path = url.pathname;
      if (!matches(path)) return json({error:'not_found'},404);
      const allowed = path === '/api/ui/menus' ? ['GET','PUT'] : ['GET'];
      if (!allowed.includes(request.method)) return new Response(JSON.stringify({error:'method_not_allowed'}), {status:405,headers:{allow:allowed.join(', '),'content-type':'application/json'}});
      if (path === '/api/ui/menus') {
        if (!parameters(url, [])) return json({error:'invalid_request'},400);
        try {
          const catalog = menuCatalog(options.catalog.records(), configuration);
          if (request.method === 'GET') return json(snapshot(await options.repository.getMenuLayout(), catalog));
          const body = await readControlJson(request);
          if (!body.ok) return json({error:body.error},body.status);
          const value = body.value as Record<string, unknown> | null;
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).length !== 2 || !Object.hasOwn(value,'layout') || !Object.hasOwn(value,'expected_revision')
            || !Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0
            || (value.expected_revision as number) >= Number.MAX_SAFE_INTEGER) return json({error:'invalid_request'},400);
          const current = await options.repository.getMenuLayout();
          if (current.revision !== value.expected_revision) return json({error:'stale_revision',active:snapshot(current,catalog)},409);
          let layout: MenuLayout;
          try { layout = validateMenuLayout(value.layout, new Set([...catalog.map(page => page.id), ...menuPageIds(current.layout)])); }
          catch { return json({error:'invalid_menu_layout'},422); }
          if (!await authorizeWrite()) return json({error:'unauthorized'},401);
          const result = await options.repository.putMenuLayout(value.expected_revision as number,layout,catalog.map(page => page.id));
          return result.kind === 'stale_revision' ? json({error:'stale_revision',active:snapshot(result.record,catalog)},409)
            : json(snapshot(result.record,catalog));
        } catch (error) {
          if (error instanceof InvalidMenuCatalogError) return json({error:'invalid_menu_catalog'},503);
          if (error instanceof ConfigRepositoryError && error.code === 'invalid_command') return json({error:'invalid_menu_layout'},422);
          return json({error:'menu_storage_unavailable'},503);
        }
      }
      if (path === '/api/ui/icons/collections') {
        if (!parameters(url,[])) return json({error:'invalid_request'},400);
        return cached(request,menuIconCollections());
      }
      if (path === '/api/ui/icons/search') {
        if (!parameters(url,['collection','q','offset','limit'])) return json({error:'invalid_request'},400);
        const collection = url.searchParams.get('collection');
        if (!collection || !hasMenuIconCollection(collection)) return json({error:'unknown_collection'},400);
        const q = url.searchParams.get('q') ?? '';
        const offset = integer(url.searchParams.get('offset'),0,1000000), limit = integer(url.searchParams.get('limit'),48,96);
        if (offset === null || limit === null || limit < 1 || q.length > 80 || /[\u0000-\u001f\u007f]/.test(q)) return json({error:'invalid_request'},400);
        return cached(request,searchMenuIcons(collection,q,offset,limit));
      }
      if (!parameters(url,['ids'])) return json({error:'invalid_request'},400);
      const raw = url.searchParams.get('ids');
      if (!raw) return json({error:'invalid_request'},400);
      const ids = raw.split(',');
      if (ids.length > 64 || ids.some(id => id.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) return json({error:'invalid_request'},400);
      return cached(request,menuIcons(ids));
    },
  };
}
