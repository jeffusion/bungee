import { gunzipSync } from 'node:zlib';
import { getIconData, iconToSVG } from '@iconify/utils';
import type { MenuIconData, MenuIconCollections, MenuIconSearch, MenuIcons } from '@jeffusion/bungee-types';
import { ICON_RESOURCES, ICON_REVISION } from './icon-resources';
type IconifyJSON = Parameters<typeof getIconData>[0];

export const menuIconRevision = ICON_REVISION;
const collections = new Map(ICON_RESOURCES.map(resource => [resource.metadata.id, {
  ...resource, namesSet: new Set(resource.names),
}]));
// Names stay resident; large geometry is inflated lazily for at most two collections.
const geometry = new Map<string, IconifyJSON>();
const MAX_INFLATED_COLLECTIONS = 2;
export function isMenuIconId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return false;
  const [collection, name] = id.split(':');
  return collections.get(collection!)?.namesSet.has(name!) === true;
}
export function hasMenuIconCollection(id: string): boolean { return collections.has(id); }
function loadCollection(id: string): IconifyJSON {
  const cached = geometry.get(id);
  if (cached) { geometry.delete(id); geometry.set(id, cached); return cached; }
  const resource = collections.get(id);
  if (!resource) throw new TypeError('unknown icon collection');
  const data = JSON.parse(gunzipSync(Buffer.from(resource.compressed, 'base64')).toString('utf8')) as IconifyJSON;
  if (geometry.size >= MAX_INFLATED_COLLECTIONS) geometry.delete(geometry.keys().next().value!);
  geometry.set(id, data);
  return data;
}
/** Resolve aliases and fold all Iconify transforms into the returned SVG geometry. */
export function resolveMenuIcon(data: IconifyJSON, name: string): MenuIconData | null {
  const icon = getIconData(data, name);
  if (!icon) return null;
  const svg = iconToSVG(icon);
  const [left, top, width, height] = svg.viewBox;
  const body = left || top ? `<g transform="translate(${-left} ${-top})">${svg.body}</g>` : svg.body;
  return { body, width, height };
}
export function menuIconCollections(): MenuIconCollections {
  return { revision: ICON_REVISION, collections: [...collections.values()].map(resource => resource.metadata) };
}
const KEYWORDS: Readonly<Record<string, string>> = {
  '设置': 'settings', '配置': 'settings', '用户': 'user', '账户': 'user', '菜单': 'menu', '路由': 'route',
  '服务': 'server', '日志': 'file', '图表': 'chart', '统计': 'chart', '密钥': 'key', '安全': 'shield',
  '搜索': 'search', '文件': 'file', '文件夹': 'folder', '主页': 'home', '网络': 'network', '插件': 'puzzle',
  '数据库': 'database', '云': 'cloud', '下载': 'download', '上传': 'upload', '箭头': 'arrow',
};
export function searchMenuIcons(collection: string, query: string, offset: number, limit: number): MenuIconSearch {
  const resource = collections.get(collection);
  if (!resource) throw new TypeError('unknown icon collection');
  const normalized = query.trim().toLowerCase();
  const tokens = (KEYWORDS[normalized] ?? normalized).split(/\s+/).filter(Boolean);
  const matches = resource.names.filter(name => tokens.every(token => name.includes(token)));
  return { revision: ICON_REVISION, total: matches.length, offset, limit,
    items: matches.slice(offset, offset + limit).map(name => ({ id: `${collection}:${name}`, name, collection })) };
}
export function menuIcons(ids: readonly string[]): MenuIcons {
  const icons: Record<string, MenuIconData> = {};
  const missing: string[] = [];
  const batches = new Map<string, Array<{ id: string; name: string }>>();
  for (const id of new Set(ids)) {
    if (!isMenuIconId(id)) { missing.push(id); continue; }
    const [collection, name] = id.split(':');
    const batch = batches.get(collection!) ?? [];
    batch.push({ id, name: name! });
    batches.set(collection!, batch);
  }
  // A mixed request inflates each requested collection once, even across LRU evictions.
  for (const [collection, batch] of batches) {
    const data = loadCollection(collection);
    for (const { id, name } of batch) {
      const icon = resolveMenuIcon(data, name);
      if (!icon) missing.push(id); else icons[id] = icon;
    }
  }
  return { revision: ICON_REVISION, icons, missing };
}
/** Existing manifest Material names are translated explicitly to local resources. */
export const MATERIAL_MENU_ICONS: Readonly<Record<string, string>> = {
  dashboard: 'lucide:layout-dashboard', route: 'lucide:route', alt_route: 'lucide:route',
  dns: 'lucide:server', server: 'lucide:server', description: 'lucide:file-text',
  settings: 'lucide:settings', tune: 'lucide:sliders-horizontal', extension: 'lucide:puzzle',
  shield: 'lucide:shield', bar_chart: 'lucide:chart-no-axes-combined', calculate: 'lucide:calculator',
  wrench: 'lucide:wrench', psychology: 'lucide:brain', cloud_download: 'lucide:cloud-download',
  compare_arrows: 'lucide:arrow-right-left', text_rotation_none: 'lucide:case-sensitive',
  account_circle: 'lucide:circle-user-round', transform: 'lucide:shuffle', manage_accounts: 'lucide:users-round',
};
export function defaultMenuIcon(value?: string): string {
  if (isMenuIconId(value)) return value;
  return (value && Object.hasOwn(MATERIAL_MENU_ICONS, value) && MATERIAL_MENU_ICONS[value]) || 'lucide:puzzle';
}
