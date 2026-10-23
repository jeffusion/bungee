import { expect, test } from 'bun:test';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, type MenuLayout, type MenuPage } from '@jeffusion/bungee-types';
import { dissolveMenuGroup, editableMenuLayout, effectiveMenu, moveMenuNode, fallbackMenuCatalog, moveMenuPage, reorderMenuNodes } from '../../../../../src/components/domain/menu/menu-model';
const catalog: MenuPage[] = [
  { id: 'routes', label: 'Routes', href: '/#/routes', defaultIcon: 'lucide:route', source: 'builtin', available: true },
  { id: 'detail', label: 'Details', href: '/#/routes/detail', defaultIcon: 'lucide:file-text', source: 'builtin', available: true },
  { id: 'plugin', label: 'Plugin', href: '/#/extensions/test', defaultIcon: 'lucide:puzzle', source: 'plugin', pluginName: 'test', available: false },
];
const page = (pageId: string, visible = true) => ({ kind: 'page' as const, pageId, visible });
const group = (visible = true) => ({ kind: 'group' as const, id: 'group:test', title: null, visible, children: [page('detail'), page('plugin')] });
test('predefined groups resolve translated labels and default icons while custom names and icons win', () => {
  const layout = createDefaultMenuLayout(BUILTIN_MENU_PAGES);
  const labels: Record<string, string> = {'menus.groups.gateway': '网关管理', 'header.management': '系统管理'};
  const result = effectiveMenu(layout, BUILTIN_MENU_PAGES, '/services', page => page.label, key => labels[key]);
  expect(result.find(item => item.id === 'group:gateway')).toMatchObject({ label: '网关管理', icon: 'lucide:network', active: true });
  const custom = layout.map(node => node.kind === 'group' && node.id === 'group:gateway' ? {...node, title: 'Team', icon: 'tabler:home'} : node);
  expect(effectiveMenu(custom, BUILTIN_MENU_PAGES, '/', page => page.label, key => key).find(item => item.id === 'group:gateway'))
    .toMatchObject({ label: 'Team', icon: 'tabler:home' });
});
test('flat and mixed menus preserve order and omit unavailable, hidden and empty entries', () => {
  const result = effectiveMenu([page('routes'), group(), { ...group(), id: 'empty', title: 'Custom', children: [] }], catalog, '/routes/detail/edit', item => item.label, () => 'System');
  expect(result.map(item => [item.id, item.active])).toEqual([['routes', false], ['group:test', true]]);
  expect(result[1].kind === 'group' && result[1].children.map(item => item.id)).toEqual(['detail']);
  expect(effectiveMenu([page('routes', false), group(false)], catalog, '/', item => item.label, () => 'System')).toEqual([]);
});
test('active route matching respects segment boundaries and longest available catalog match, including hidden pages', () => {
  expect(effectiveMenu([page('routes')], catalog, '/routes-extra', item => item.label, () => '')[0].active).toBe(false);
  expect(effectiveMenu([page('routes'), page('detail', false)], catalog, '/routes/detail/edit', item => item.label, () => '')[0].active).toBe(false);
});
test('move into and out of groups keeps pages unique, preserves page preferences and supports before positions', () => {
  const initial: MenuLayout = [{ ...page('routes', false), icon: 'tabler:route' }, group()];
  const moved = moveMenuPage(initial, 'routes', 'group:test', 'detail');
  expect(moved).toEqual([{ ...group(), children: [{ ...page('routes', false), icon: 'tabler:route' }, page('detail'), page('plugin')] }]);
  expect(moveMenuPage(moved, 'routes', null, 'group:test')).toEqual(initial);
  expect(moveMenuPage(initial, 'routes', 'missing')).toBe(initial);
});
test('dissolving a hidden group promotes children in place and preserves their effective visibility', () => {
  expect(dissolveMenuGroup([page('routes'), group(false)], 'group:test')).toEqual([page('routes'), page('detail', false), page('plugin', false)]);
  expect(reorderMenuNodes([page('routes'), group()], 'group:test', -1)).toEqual([group(), page('routes')]);
  expect(reorderMenuNodes([group()], 'plugin', -1, 'group:test')).toEqual([{ ...group(), children: [page('plugin'), page('detail')] }]);
});
test('fallback catalog registers unique contributions with stable encoded ids', () => {
  const pages = fallbackMenuCatalog([{ name: 'a b', enabled: true, metadata: { contributes: { navigation: [
    { label: 'Security', path: '/a/b', icon: 'shield', target: 'header' },
    { label: 'Duplicate security', path: '/a/b', icon: 'lucide:folder', target: 'sidebar' },
    { label: 'Accounts', path: '/users', icon: 'manage_accounts' },
    { label: 'Unknown', path: '/unknown' },
  ] } } }]).filter(item => item.source === 'plugin');
  expect(pages.map(item => item.id)).toEqual([
    'plugin:a%20b:%2Fa%2Fb', 'plugin:a%20b:%2Fusers', 'plugin:a%20b:%2Funknown',
  ]);
});


test('drag boundaries move complete groups and support first/last positions without nesting or duplication', () => {
  const retainedGroup = { ...group(), children: [page('plugin')] };
  const initial: MenuLayout = [page('routes'), retainedGroup, page('detail')];
  expect(moveMenuNode(initial, 'group:test', null, 'routes')).toEqual([retainedGroup, page('routes'), page('detail')]);
  expect(moveMenuNode(initial, 'routes', null)).toEqual([retainedGroup, page('detail'), page('routes')]);
  expect(moveMenuNode(initial, 'group:test', 'group:test')).toBe(initial);
  expect(moveMenuNode(initial, 'routes', 'missing')).toBe(initial);
  expect(moveMenuNode(initial, 'routes', null, 'routes')).toBe(initial);
  expect(moveMenuNode(initial, 'routes', null, 'missing')).toBe(initial);
});
test('editor projection excludes inactive pages while ordering skips them and preserves their preferences', () => {
  const inactive = { ...page('plugin', false), icon: 'tabler:home' };
  const retainedGroup = { ...group(), children: [{ ...inactive, pageId: 'inactive-child' }] };
  const initial: MenuLayout = [page('routes'), inactive, page('detail'), retainedGroup];
  expect(editableMenuLayout(initial, catalog)).toEqual([page('routes'), page('detail'), { ...group(), children: [] }]);
  expect(reorderMenuNodes(initial, 'detail', -1, null, catalog)).toEqual([page('detail'), page('routes'), inactive, retainedGroup]);
  expect(initial[1]).toEqual(inactive);
});
