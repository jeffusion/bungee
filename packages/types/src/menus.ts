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
  /** Null uses the translated title of a predefined group. */
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
export const DEFAULT_MENU_GROUPS = [
  { id: 'group:gateway', label: 'menus.groups.gateway', icon: 'lucide:network',
    pages: ['builtin:routes', 'builtin:services'] },
  { id: 'group:usage', label: 'menus.groups.usage', icon: 'lucide:chart-no-axes-combined',
    pages: ['plugin:token-stats:%2Fstatistics', 'plugin:token-budget:%2Fsettings'] },
  { id: 'group:access', label: 'menus.groups.access', icon: 'lucide:shield-check',
    pages: ['plugin:key-access:%2Fsettings', 'plugin:user-auth:%2Fusers'] },
  { id: SYSTEM_MENU_GROUP_ID, label: 'header.management', icon: 'lucide:settings',
    pages: ['builtin:configuration', 'builtin:plugins', MENU_MANAGEMENT_ID, 'plugin:user-auth:%2Fprofile'] },
] as const;

export function defaultMenuGroup(id: string) {
  return DEFAULT_MENU_GROUPS.find(group => group.id === id);
}
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
  const available = new Set(catalog.filter(item => item.available).map(item => item.id));
  const group = (id: string): MenuGroupNode => ({ kind: 'group', id, title: null, visible: true,
    children: defaultMenuGroup(id)!.pages.filter(pageId => available.has(pageId)).map(page) });
  const layout: MenuLayout = [
    page('builtin:dashboard'),
    group('group:gateway'),
    group('group:usage'),
    group('group:access'),
    page('builtin:logs'),
    group(SYSTEM_MENU_GROUP_ID),
  ];
  const seen = new Set(layout.flatMap(node => node.kind === 'page' ? [node.pageId] : node.children.map(child => child.pageId)));
  return [
    ...layout.filter(node => node.kind === 'group' ? node.children.length > 0 : available.has(node.pageId)),
    ...catalog.filter(item => item.available && !seen.has(item.id)).map(item => page(item.id)),
  ];
}

/** New contributions append without moving saved or temporarily unavailable pages. */
export function reconcileMenuLayout(layout: MenuLayout, catalog: readonly MenuPage[]): MenuLayout {
  const seen = new Set(layout.flatMap(node => node.kind === 'page' ? [node.pageId] : node.children.map(child => child.pageId)));
  return [...layout, ...catalog.filter(page => page.available && !seen.has(page.id)).map(page => ({ kind: 'page' as const, pageId: page.id, visible: true }))];
}
