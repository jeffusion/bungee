import { expect, test } from 'bun:test';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, reconcileMenuLayout, type MenuPage } from '../../src/menus';

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
    'builtin:dashboard', 'builtin:routes', 'builtin:services', 'builtin:logs', enabled.id, 'builtin:configuration', 'builtin:plugins', 'builtin:menus',
  ]);
});
