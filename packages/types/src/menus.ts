/** Instance-wide navigation. Visibility never grants or revokes page access. */
export type MenuPage = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly source: 'builtin' | 'plugin';
  readonly pluginName?: string;
  readonly defaultIcon: string;
  readonly available: boolean;
};

export type MenuPageNode = {
  readonly kind: 'page';
  readonly pageId: string;
  readonly visible: boolean;
  readonly icon?: string;
};

export type MenuGroupNode = {
  readonly kind: 'group';
  readonly id: string;
  /** Null is reserved for the translated default system group. */
  readonly title: string | null;
  readonly visible: boolean;
  readonly icon?: string;
  readonly children: readonly MenuPageNode[];
};

export type MenuNode = MenuPageNode | MenuGroupNode;
export type MenuLayout = readonly MenuNode[];
export type MenuLayoutRecord = { readonly revision: number; readonly layout: MenuLayout | null };
export type MenuSnapshot = {
  readonly revision: number;
  readonly catalog: readonly MenuPage[];
  readonly layout: MenuLayout;
  readonly iconRevision: string;
};
export type MenuWrite = { readonly expected_revision: number; readonly layout: MenuLayout };

export type MenuIconData = {
  readonly body: string;
  readonly width: number;
  readonly height: number;
};
export type MenuIconCollection = {
  readonly id: string;
  readonly title: string;
  readonly total: number;
  readonly version: string;
  readonly license: { readonly title: string; readonly url?: string };
};
export type MenuIconCollections = { readonly revision: string; readonly collections: readonly MenuIconCollection[] };
export type MenuIconSearch = {
  readonly revision: string;
  readonly items: readonly { readonly id: string; readonly name: string; readonly collection: string }[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
};
export type MenuIcons = {
  readonly revision: string;
  readonly icons: Readonly<Record<string, MenuIconData>>;
  readonly missing: readonly string[];
};

export const MENU_MANAGEMENT_ID = 'builtin:menus';
export const SYSTEM_MENU_GROUP_ID = 'group:system';
export const BUILTIN_MENU_PAGES: readonly MenuPage[] = [
  { id: 'builtin:dashboard', label: 'nav.dashboard', href: '/#/', source: 'builtin', defaultIcon: 'lucide:layout-dashboard', available: true },
  { id: 'builtin:routes', label: 'nav.routes', href: '/#/routes', source: 'builtin', defaultIcon: 'lucide:route', available: true },
  { id: 'builtin:services', label: 'nav.services', href: '/#/services', source: 'builtin', defaultIcon: 'lucide:server', available: true },
  { id: 'builtin:logs', label: 'nav.logs', href: '/#/logs', source: 'builtin', defaultIcon: 'lucide:file-text', available: true },
  { id: 'builtin:configuration', label: 'nav.configuration', href: '/#/config', source: 'builtin', defaultIcon: 'lucide:sliders-horizontal', available: true },
  { id: 'builtin:plugins', label: 'nav.plugins', href: '/#/plugins', source: 'builtin', defaultIcon: 'lucide:blocks', available: true },
  { id: MENU_MANAGEMENT_ID, label: 'nav.menus', href: '/#/menus', source: 'builtin', defaultIcon: 'lucide:list-tree', available: true },
];

export function createDefaultMenuLayout(catalog: readonly MenuPage[]): MenuLayout {
  const page = (pageId: string): MenuPageNode => ({ kind: 'page', pageId, visible: true });
  return [
    ...BUILTIN_MENU_PAGES.slice(0, 4).map(item => page(item.id)),
    ...catalog.filter(item => item.source === 'plugin' && item.available).map(item => page(item.id)),
    { kind: 'group', id: SYSTEM_MENU_GROUP_ID, title: null, visible: true,
      children: BUILTIN_MENU_PAGES.slice(4).map(item => page(item.id)) },
  ];
}

/** New contributions append without moving saved or temporarily unavailable pages. */
export function reconcileMenuLayout(layout: MenuLayout, catalog: readonly MenuPage[]): MenuLayout {
  const seen = new Set(layout.flatMap(node => node.kind === 'page' ? [node.pageId] : node.children.map(child => child.pageId)));
  return [...layout, ...catalog.filter(page => page.available && !seen.has(page.id)).map(page => ({ kind: 'page' as const, pageId: page.id, visible: true }))];
}
