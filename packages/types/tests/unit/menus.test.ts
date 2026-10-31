import { expect, test } from 'bun:test';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, reconcileMenuLayout, type MenuPage } from '../../src/menus';

const pluginPage = (pluginName: string, path: string, available = true): MenuPage => ({
  id: `plugin:${pluginName}:${encodeURIComponent(path)}`, label: pluginName, href: `/#/extensions/${pluginName}${path}`,
  source: 'plugin', pluginName, defaultIcon: 'lucide:puzzle', available,
});

test('default groups follow gateway, usage and access tasks independently of catalog order', () => {
  const catalog = [...BUILTIN_MENU_PAGES,
    pluginPage('user-auth', '/profile'), pluginPage('user-auth', '/users'), pluginPage('token-budget', '/settings'),
    pluginPage('token-stats', '/statistics'), pluginPage('key-access', '/settings'), pluginPage('chatgpt-oauth', '/accounts'),
    pluginPage('extra', '/page')].reverse();
  const page = (pageId: string) => ({ kind: 'page', pageId, visible: true });
  const group = (id: string, pages: string[]) => ({ kind: 'group', id, title: null, visible: true, children: pages.map(page) });
  expect(createDefaultMenuLayout(catalog)).toEqual([
    page('builtin:dashboard'),
    group('group:gateway', ['builtin:routes', 'builtin:services']),
    group('group:usage', ['plugin:token-stats:%2Fstatistics', 'plugin:token-budget:%2Fsettings', 'plugin:chatgpt-oauth:%2Faccounts']),
    group('group:access', ['plugin:key-access:%2Fsettings', 'plugin:user-auth:%2Fusers']),
    page('builtin:logs'),
    group('group:system', ['builtin:configuration', 'builtin:plugins', 'builtin:menus', 'plugin:user-auth:%2Fprofile']),
    page('plugin:extra:%2Fpage'),
  ]);
});

test('disabled known plugins and empty groups are absent, while partial groups retain their order', () => {
  const layout = createDefaultMenuLayout([...BUILTIN_MENU_PAGES,
    pluginPage('key-access', '/settings', false), pluginPage('user-auth', '/users', false),
    pluginPage('token-stats', '/statistics', false), pluginPage('token-budget', '/settings')]);
  expect(layout.map(node => node.kind === 'group' ? node.id : node.pageId)).toEqual([
    'builtin:dashboard', 'group:gateway', 'group:usage', 'builtin:logs', 'group:system',
  ]);
  expect(layout.find(node => node.kind === 'group' && node.id === 'group:usage')).toMatchObject({
    children: [{kind: 'page', pageId: 'plugin:token-budget:%2Fsettings', visible: true}],
  });
});

test('saved custom grouping, names and visibility remain authoritative for known plugins', () => {
  const layout = [{ kind: 'group' as const, id: 'group:custom', title: 'Team', visible: false,
    children: [{kind: 'page' as const, pageId: 'plugin:token-budget:%2Fsettings', visible: false, icon: 'tabler:home'}] }];
  expect(reconcileMenuLayout(layout, [pluginPage('token-budget', '/settings')])).toEqual(layout);
});

test('new available pages append without restoring deliberately removed unavailable entries', () => {
  const disabled: MenuPage = { id: 'plugin:disabled:%2Fpage', label: 'Disabled', href: '/#/extensions/disabled/page', source: 'plugin', defaultIcon: 'lucide:puzzle', available: false };
  const active = { ...disabled, id: 'plugin:active:%2Fpage', available: true };
  const layout = createDefaultMenuLayout(BUILTIN_MENU_PAGES);
  expect(reconcileMenuLayout(layout, [...BUILTIN_MENU_PAGES, disabled, active])).toEqual([
    ...layout, { kind: 'page', pageId: active.id, visible: true },
  ]);
  const retained = [...layout, { kind: 'page' as const, pageId: disabled.id, visible: false, icon: 'tabler:home' }];
  expect(reconcileMenuLayout(retained, [...BUILTIN_MENU_PAGES, disabled])).toEqual(retained);
});


test('default layouts never add unavailable plugin pages', () => {
  const disabled: MenuPage = { id: 'plugin:disabled:%2Fpage', label: 'Disabled', href: '/#/extensions/disabled/page', source: 'plugin', defaultIcon: 'lucide:puzzle', available: false };
  const enabled = { ...disabled, id: 'plugin:enabled:%2Fpage', available: true };
  const layout = createDefaultMenuLayout([...BUILTIN_MENU_PAGES, disabled, enabled]);
  expect(layout.flatMap(node => node.kind === 'page' ? [node.pageId] : node.children.map(child => child.pageId))).toEqual([
    'builtin:dashboard', 'builtin:routes', 'builtin:services', 'builtin:logs', 'builtin:configuration', 'builtin:plugins', 'builtin:menus', enabled.id,
  ]);
});
