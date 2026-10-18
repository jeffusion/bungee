import { afterEach, expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, type MenuSnapshot, type MenuPage } from '@jeffusion/bungee-types';
import { editableMenuLayout, effectiveMenu } from '../../../src/components/domain/menu/menu-model';
let authRevision = 1;
const authenticated = writable(true);
let requests: { resolve: (value: MenuSnapshot) => void; reject: (error: unknown) => void }[] = [];
mock.module('../../../src/stores/auth', () => ({ getAuthStateRevision: () => authRevision, isAuthenticationStateCurrent: (revision: number) => revision === authRevision, isAuthenticated: authenticated }));
mock.module('../../../src/api/menus', () => ({ MenusAPI: { read: () => new Promise<MenuSnapshot>((resolve, reject) => { requests.push({ resolve, reject }); }) } }));
const { menus, resetMenus, refreshMenus, acceptMenus, updateMenuFallback } = await import('../../../src/stores/menus');
const snapshot = (revision: number): MenuSnapshot => ({ revision, catalog: BUILTIN_MENU_PAGES, layout: createDefaultMenuLayout(BUILTIN_MENU_PAGES), iconRevision: 'test' });
afterEach(() => { resetMenus(); requests = []; authRevision++; authenticated.set(true); });
test('menu reads are latest-wins and a save invalidates an older background read', async () => {
  resetMenus(BUILTIN_MENU_PAGES);
  const first = refreshMenus(), second = refreshMenus();
  requests[1].resolve(snapshot(2)); expect((await second)?.revision).toBe(2);
  requests[0].resolve(snapshot(1)); expect(await first).toBeNull(); expect(get(menus).snapshot.revision).toBe(2);
  const background = refreshMenus(); acceptMenus(snapshot(3)); requests[2].resolve(snapshot(2));
  expect(await background).toBeNull(); expect(get(menus).snapshot.revision).toBe(3);
});
test('late reads from a different authentication state cannot update the current session', async () => {
  resetMenus(BUILTIN_MENU_PAGES); const pending = refreshMenus(); authRevision++;
  requests[0].resolve(snapshot(8)); expect(await pending).toBeNull(); expect(get(menus).available).toBe(false);
  resetMenus(BUILTIN_MENU_PAGES); const another = refreshMenus(); resetMenus(); requests[1].resolve(snapshot(9));
  expect(await another).toBeNull(); expect(get(menus).snapshot.catalog).toEqual([]);
});
test('a background read failure preserves the last saved arrangement and disables persistence', async () => {
  const saved = { ...snapshot(1), layout: snapshot(1).layout.map(node => ({ ...node, visible: false })) };
  resetMenus(BUILTIN_MENU_PAGES); acceptMenus(saved);
  const pending = refreshMenus(); requests[0].reject(new Error('offline')); expect(await pending).toBeNull();
  expect(get(menus).available).toBe(false); expect(get(menus).error).toBe(true); expect(get(menus).loading).toBe(false);
  expect(get(menus).snapshot.layout).toEqual(saved.layout);
  updateMenuFallback([...BUILTIN_MENU_PAGES, { ...BUILTIN_MENU_PAGES[0], id: 'plugin:test:%2Fpage', source: 'plugin', pluginName: 'test' }]);
  expect(get(menus).snapshot.layout).toEqual(saved.layout);
  expect(get(menus).snapshot.revision).toBe(saved.revision);
  expect(get(menus).snapshot.iconRevision).toBe(saved.iconRevision);
  const retry = refreshMenus(); requests[1].reject(new Error('still offline')); await retry;
  expect(get(menus).snapshot.layout).toEqual(saved.layout);
});
test('plugin availability updates survive a failed menu read without replacing saved preferences', async () => {
  const plugin: MenuPage = { id: 'plugin:test:%2Fpage', label: 'Server page title', href: '/#/extensions/test/page',
    source: 'plugin', pluginName: 'test', defaultIcon: 'carbon:settings', available: true };
  const catalog = [...BUILTIN_MENU_PAGES, plugin];
  const saved: MenuSnapshot = { ...snapshot(4), catalog,
    layout: [{ kind: 'group', id: 'group:custom', title: 'Operations', visible: true,
      children: [{ kind: 'page', pageId: plugin.id, visible: true, icon: 'tabler:home' }] },
      ...snapshot(4).layout.map(node => ({ ...node, visible: false }))] };
  resetMenus(catalog); acceptMenus(saved);
  updateMenuFallback([...BUILTIN_MENU_PAGES, { ...plugin, label: 'Fallback title', defaultIcon: 'lucide:puzzle', available: false }]);
  const pending = refreshMenus(); requests[0].reject(new Error('offline')); await pending;
  const state = get(menus);
  expect(state.error).toBe(true); expect(state.available).toBe(false);
  expect(state.snapshot.layout).toEqual(saved.layout);
  expect(state.snapshot.revision).toBe(4); expect(state.snapshot.iconRevision).toBe('test');
  expect(state.snapshot.catalog.find(page => page.id === plugin.id)).toEqual({ ...plugin, available: false });
  expect(effectiveMenu(state.snapshot.layout, state.snapshot.catalog, '/', page => page.label, 'System')).toEqual([]);
  expect(editableMenuLayout(state.snapshot.layout, state.snapshot.catalog)[0]).toMatchObject({ children: [] });
  updateMenuFallback(catalog);
  expect(get(menus).snapshot.layout).toEqual(saved.layout);
  expect(effectiveMenu(get(menus).snapshot.layout, get(menus).snapshot.catalog, '/', page => page.label, 'System')[0])
    .toMatchObject({ label: 'Operations', children: [{ label: plugin.label, icon: 'tabler:home' }] });
});
test('an initial read failure retains reachable defaults without claiming a saved snapshot', async () => {
  resetMenus(BUILTIN_MENU_PAGES);
  const pending = refreshMenus(); requests[0].reject(new Error('offline')); await pending;
  expect(get(menus).snapshot.layout).toEqual(createDefaultMenuLayout(BUILTIN_MENU_PAGES));
  expect(get(menus).available).toBe(false);
});
