import type { MenuLayout, MenuPageNode, MenuGroupNode } from '@jeffusion/bungee-types';
import { defaultMenuGroup } from '@jeffusion/bungee-types';
import { isMenuIconId } from './menu-icons';

export const MAX_MENU_PAGES = 512;
export const MAX_MENU_GROUPS = 64;
export const MAX_MENU_LAYOUT_BYTES = 262144;
export class InvalidMenuLayoutError extends Error {}
function invalid(): never { throw new InvalidMenuLayoutError('invalid_menu_layout'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export function isMenuPageId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 512) return false;
  if (/^builtin:[a-z][a-z0-9-]*$/.test(id)) return true;
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'plugin') return false;
  try {
    const name = decodeURIComponent(parts[1]!), path = decodeURIComponent(parts[2]!);
    return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) && path.startsWith('/')
      && path.length > 1 && !/[\\?#\u0000-\u0020\u007f]/.test(path)
      && encodeURIComponent(name) === parts[1] && encodeURIComponent(path) === parts[2];
  } catch { return false; }
}
/** Canonicalize titles while rejecting unknown fields, nested groups and duplicate identities. */
export function validateMenuLayout(value: unknown, allowedPages?: ReadonlySet<string>, requireAvailableIcons = true): MenuLayout {
  if (!Array.isArray(value) || value.length > MAX_MENU_PAGES + MAX_MENU_GROUPS) invalid();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { invalid(); }
  if (bytes! > MAX_MENU_LAYOUT_BYTES) invalid();
  const pages = new Set<string>(), groups = new Set<string>(), titles = new Set<string>();
  const icon = (node: Record<string, unknown>): { icon?: string } => {
    if (!Object.hasOwn(node, 'icon')) return {};
    if (typeof node.icon !== 'string' || node.icon.length > 160
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.icon)
      || requireAvailableIcons && !isMenuIconId(node.icon)) invalid();
    return { icon: node.icon };
  };
  const page = (value: unknown): MenuPageNode => {
    const node = object(value, ['kind','pageId','visible','icon']);
    if (node.kind !== 'page' || !isMenuPageId(node.pageId) || typeof node.visible !== 'boolean'
      || pages.has(node.pageId) || (allowedPages && !allowedPages.has(node.pageId))) invalid();
    pages.add(node.pageId);
    if (pages.size > MAX_MENU_PAGES) invalid();
    return { kind: 'page', pageId: node.pageId, visible: node.visible, ...icon(node) };
  };
  return value.map(value => {
    if (value !== null && typeof value === 'object' && value.kind === 'page') return page(value);
    const node = object(value, ['kind','id','title','visible','icon','children']);
    if (node.kind !== 'group' || typeof node.id !== 'string' || !/^group:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(node.id)
      || groups.has(node.id) || typeof node.visible !== 'boolean' || !Array.isArray(node.children)
      || node.children.length > MAX_MENU_PAGES) invalid();
    const title = typeof node.title === 'string' ? node.title.trim() : node.title;
    if (title === null ? !defaultMenuGroup(node.id) : typeof title !== 'string' || !title || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title)) invalid();
    if (typeof title === 'string' && titles.has(title)) invalid();
    if (typeof title === 'string') titles.add(title);
    groups.add(node.id);
    if (groups.size > MAX_MENU_GROUPS) invalid();
    return { kind: 'group', id: node.id, title, visible: node.visible, ...icon(node), children: node.children.map(page) } as MenuGroupNode;
  });
}
export function menuPageIds(layout: MenuLayout | null): readonly string[] {
  return (layout ?? []).flatMap(node => node.kind === 'page' ? [node.pageId] : node.children.map(child => child.pageId));
}
