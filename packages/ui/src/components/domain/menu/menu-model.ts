import { BUILTIN_MENU_PAGES, defaultMenuGroup, type MenuGroupNode, type MenuLayout, type MenuNode, type MenuPage, type MenuPageNode } from '@jeffusion/bungee-types';
import type { Plugin } from '$api/plugins';
export type EffectivePage = { kind: 'page'; id: string; label: string; href: string; icon: string; active: boolean };
export type EffectiveGroup = { kind: 'group'; id: string; label: string; icon: string; active: boolean; children: EffectivePage[] };
export type EffectiveMenu = EffectivePage | EffectiveGroup;
const pluginIcons: Record<string, string> = { shield: 'lucide:shield', bar_chart: 'lucide:chart-no-axes-column', manage_accounts: 'lucide:users-round' };
export function fallbackMenuCatalog(plugins: readonly Plugin[]): MenuPage[] {
  return [...BUILTIN_MENU_PAGES, ...plugins.flatMap(plugin => (plugin.metadata?.contributes?.navigation ?? [])
    .filter((nav, index, entries) => entries.findIndex(item => item.path === nav.path) === index)
    .map(nav => ({ id: `plugin:${encodeURIComponent(plugin.name)}:${encodeURIComponent(nav.path)}`, label: nav.label,
      href: `/#/extensions/${plugin.name}${nav.path}`, source: 'plugin' as const, pluginName: plugin.name,
      defaultIcon: nav.icon?.includes(':') ? nav.icon : pluginIcons[nav.icon ?? ''] ?? 'lucide:puzzle', available: plugin.enabled })))];
}
export function pathMatches(path: string, href: string): boolean {
  const target = href.slice(href.indexOf('#') + 1).split('?')[0].replace(/\/$/, '') || '/';
  return path === target || target !== '/' && path.startsWith(target + '/');
}
export function menuGroupLabel(node: MenuGroupNode, translate: (key: string) => string): string {
  return node.title ?? translate(defaultMenuGroup(node.id)?.label ?? 'header.management');
}
export function effectiveMenu(layout: MenuLayout, catalog: readonly MenuPage[], path: string,
  pageLabel: (page: MenuPage) => string, translate: (key: string) => string): EffectiveMenu[] {
  const pages = new Map(catalog.map(page => [page.id, page]));
  // Resolve overlapping routes against the complete available catalog, including hidden entries.
  const active = catalog.filter(page => page.available && pathMatches(path, page.href)).sort((a, b) => b.href.length - a.href.length)[0]?.id;
  function resolve(node: MenuPageNode): EffectivePage | null {
    const page = pages.get(node.pageId);
    return node.visible && page?.available ? { kind: 'page', id: page.id, label: pageLabel(page), href: page.href,
      icon: node.icon ?? page.defaultIcon, active: page.id === active } : null;
  }
  return layout.flatMap(node => {
    if (!node.visible) return [];
    if (node.kind === 'page') { const page = resolve(node); return page ? [page] : []; }
    const children = node.children.map(resolve).filter((page): page is EffectivePage => page !== null);
    return children.length ? [{ kind: 'group', id: node.id, label: menuGroupLabel(node, translate),
      icon: node.icon ?? defaultMenuGroup(node.id)?.icon ?? 'lucide:folder', active: children.some(page => page.active), children } as EffectiveMenu] : [];
  });
}
export function menuNodeKey(node: MenuNode): string { return node.kind === 'page' ? node.pageId : node.id; }
export function moveMenuPage(layout: MenuLayout, pageId: string, targetGroup: string | null, before?: string): MenuLayout {
  if (pageId === before) return layout;
  let found: MenuPageNode | undefined;
  const root = layout.flatMap(node => {
    if (node.kind === 'page') { if (node.pageId === pageId) { found = node; return []; } return [node]; }
    const children = node.children.filter(child => { if (child.pageId === pageId) { found = child; return false; } return true; });
    return [{ ...node, children } as MenuNode];
  });
  if (!found) return layout;
  if (targetGroup !== null) {
    if (!root.some(node => node.kind === 'group' && node.id === targetGroup)) return layout;
    return root.map(node => node.kind === 'group' && node.id === targetGroup
      ? { ...node, children: insert(node.children, found!, before) } : node);
  }
  return insert(root, found, before);
}
function insert<T extends MenuNode>(nodes: readonly T[], node: T, before?: string): T[] {
  const next = [...nodes], index = before ? next.findIndex(item => menuNodeKey(item) === before) : -1;
  next.splice(index < 0 ? next.length : index, 0, node); return next;
}
export function dissolveMenuGroup(layout: MenuLayout, id: string): MenuLayout {
  return layout.flatMap(node => node.kind === 'group' && node.id === id
    ? node.children.map(child => ({ ...child, visible: node.visible && child.visible })) : [node as MenuNode]);
}
/** Move a page or an entire group to a boundary in the destination list. */
export function moveMenuNode(layout: MenuLayout, key: string, targetGroup: string | null, before?: string): MenuLayout {
  if (key === before) return layout;
  const target = layout.find(node => node.kind === 'group' && node.id === targetGroup);
  const destination = targetGroup === null ? layout : target?.kind === 'group' ? target.children : undefined;
  if (!destination || before && !destination.some(node => menuNodeKey(node) === before)) return layout;
  const group = layout.find(node => node.kind === 'group' && node.id === key);
  if (!group) return moveMenuPage(layout, key, targetGroup, before);
  if (targetGroup !== null) return layout;
  return insert(layout.filter(node => menuNodeKey(node) !== key), group, before);
}
export function editableMenuLayout(layout: MenuLayout, catalog: readonly MenuPage[]): MenuLayout {
  const available = new Set(catalog.filter(page => page.available).map(page => page.id));
  return layout.flatMap(node => node.kind === 'group'
    ? [{ ...node, children: node.children.filter(child => available.has(child.pageId)) } as MenuNode]
    : available.has(node.pageId) ? [node] : []);
}
export function reorderMenuNodes(layout: MenuLayout, key: string, direction: -1 | 1, group: string | null = null, catalog?: readonly MenuPage[]): MenuLayout {
  const visible = catalog ? editableMenuLayout(layout, catalog) : layout;
  const target = visible.find(node => node.kind === 'group' && node.id === group);
  const nodes = group === null ? visible : target?.kind === 'group' ? target.children : undefined;
  if (!nodes) return layout;
  const from = nodes.findIndex(node => menuNodeKey(node) === key), to = from + direction;
  if (from < 0 || to < 0 || to >= nodes.length) return layout;
  return moveMenuNode(layout, key, group, direction === -1 ? menuNodeKey(nodes[to]) : nodes[to + 1] && menuNodeKey(nodes[to + 1]));
}
export const sameMenuLayout = (a: MenuLayout, b: MenuLayout) => JSON.stringify(a) === JSON.stringify(b);
