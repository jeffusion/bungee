import { systemUpdateStatusFixture } from '../helpers/system-updates';
import { test } from 'bun:test';
import { expect, type Page, type Route } from 'playwright/test';
import { BUILTIN_MENU_PAGES, type MenuLayout, type MenuNode, type MenuPage, type MenuSnapshot } from '@jeffusion/bungee-types';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { observeNetwork } from '../helpers/dashboard/network';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
const runtime = dashboardRuntime();
const iconCollections = { revision: 'icons:test', collections: [
  { id: 'lucide', title: 'Lucide', total: 60, version: 'test', license: { title: 'ISC' } },
  { id: 'tabler', title: 'Tabler', total: 60, version: 'test', license: { title: 'MIT' } },
  { id: 'carbon', title: 'Carbon', total: 60, version: 'test', license: { title: 'Apache 2.0' } },
] };

async function closeDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test('menu editor saves, reloads, preserves conflicted drafts, guards navigation and renders offline icon search', () => runtime.run(async page => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
  const errors: string[] = [];
  const network = observeNetwork(page, errors);
  const configuration = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    page.on('pageerror', error => errors.push(error.message));
    let snapshot = menuSnapshot(), conflictFailures = 0, writes = 0, loseResponse = false;
    let responseLoss: Promise<void> | undefined;
    let slowSearch: Route | null = null, failSearchOnce = true;
    let lastWrite: { expected_revision: number; layout: MenuLayout } | null = null;
    const searches: { collection: string | null; q: string | null; offset: number; limit: number }[] = [];
    const iconBatches: string[][] = [];
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const url = new URL(route.request().url()), json = (value: unknown) => route.fulfill({ json: value });
      if (route.request().method() !== (url.pathname === '/api/ui/menus' && route.request().method() === 'PUT' ? 'PUT' : 'GET')) throw new Error(`Unexpected method: ${route.request().method()} ${url.pathname}`);
      if (url.pathname === '/api/auth/mode') return json({ mode: 'plugin', initialized: true, publicOrigin: url.origin, provider: { name: 'user-auth', loginComponent: 'UserAuthLogin' } });
      if (url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: true, subject: { id: 'editor', provider: 'user-auth' }, csrfToken: 'test-csrf' });
      if (url.pathname === '/api/plugins') return json([]);
      if (url.pathname === '/api/config/runtime') return json(configuration);
      if (url.pathname === '/api/config') return json({ revision: 1, content_hash: configuration.content_hash, config: configuration.config });
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (url.pathname === '/api/ui/menus') {
        if (route.request().method() === 'PUT') {
          writes++; lastWrite = route.request().postDataJSON();
          expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
          if (conflictFailures > 0) { conflictFailures--; network.expectHttpError(route.request(), 409); return route.fulfill({ status: 409, json: { error: 'menu_revision_conflict' } }); }
          snapshot = { ...snapshot, revision: snapshot.revision + 1, layout: lastWrite!.layout };
          if (loseResponse) { loseResponse = false; responseLoss = network.expectFailure(route.request(), 'net::ERR_FAILED', () => route.abort('failed')); return responseLoss; }
        }
        return json(snapshot);
      }
      if (url.pathname === '/api/ui/icons/collections') return json(iconCollections);
      if (url.pathname === '/api/ui/icons/search') {
        const offset = Number(url.searchParams.get('offset')); searches.push({ collection: url.searchParams.get('collection'), q: url.searchParams.get('q'), offset, limit: Number(url.searchParams.get('limit')) });
        if (url.searchParams.get('q') === 'slow') { slowSearch = route; return; }
        if (url.searchParams.get('q') === 'broken' && failSearchOnce) { failSearchOnce = false; network.expectHttpError(route.request(), 500); return route.fulfill({ status: 500, json: { error: 'icon_search_unavailable' } }); }
        const prefix = url.searchParams.get('collection') ?? 'lucide';
        return json({ revision: 'icons:test', offset, limit: 48, total: 60, items: Array.from({ length: Math.min(48, 60 - offset) }, (_, i) => ({ id: `${prefix}:search-${i + offset}`, name: `search-${i + offset}`, collection: prefix })) });
      }
      if (url.pathname === '/api/ui/icons/data') { iconBatches.push((url.searchParams.get('ids') ?? '').split(',')); return fulfillMenuIcons(route); }
      if (url.pathname === '/api/plugins/schemas' || url.pathname === '/api/plugin-translations') return json({});
      throw new Error(`Unexpected API: ${route.request().method()} ${url.pathname}`);
    });
    await page.addInitScript(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const slow = String(input).includes('/api/ui/icons/search') && new URL(String(input), location.origin).searchParams.get('q') === 'slow';
        const response = await fetch(input, init);
        if (slow) {
          const json = response.json.bind(response);
          response.json = async () => { const body = await json(); requestAnimationFrame(() => { (window as any).oldIconSearchConsumed = true; }); return body; };
        }
        return response;
      }, window.fetch);
    });
    await page.goto(`${runtime.origin}/#/menus`);
    const editor = page.getByTestId('page-menus'), save = page.getByTestId('menus-save');
    const system = editor.locator('[data-menu-id="group:system"]'), groupName = system.getByRole('textbox', { name: 'Group name' });
    const groupTitle = system.getByRole('button', { name: /^Collapse group/ });
    async function renameGroup(value: string) {
      await system.getByRole('button', { name: /^Menu actions / }).click();
      await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
       await groupName.fill(value); await groupName.press('Enter');
    }
    async function pageAction(name: string) {
      await editor.getByRole('button', { name: 'Page actions', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    await expect(editor).toBeVisible(); await expect(save).toBeDisabled();
    await expect(groupName).toHaveCount(0);

    await renameGroup('Operations'); await expect(save).toBeEnabled();

    await expect(page.getByTestId('header-top-menu')).not.toContainText('Operations');
    await editor.getByRole('button', { name: 'Draft preview', exact: true }).click();
    await expect(page.getByRole('dialog').getByTestId('menu-preview-tree')).toContainText('Operations');
    await expect(page.getByRole('dialog').getByTestId('menu-preview-tree')).toHaveCount(1);
    await closeDialog(page);

    await expect(editor.getByTestId('menu-preview-tree')).toHaveCount(0);
    // Background synchronization updates the live state and never replaces a dirty draft.
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(groupTitle).toContainText('Operations');
    await save.click(); await expect(page.getByTestId('menus-status')).toBeVisible();
    expect(writes).toBe(1); expect(lastWrite!.expected_revision).toBe(1);
    await expect(page.getByTestId('header-top-menu')).toContainText('Operations');
    await page.reload(); await expect(groupTitle).toContainText('Operations');
    // Every page and group has icon controls. Only the selected search page requests preview data.
    const iconButton = system.getByRole('button', { name: 'Icon Operations', exact: true });
    await iconButton.click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();

    await dialog.getByRole('searchbox', { name: 'Search icons' }).fill('slow');
    await expect.poll(() => slowSearch !== null).toBe(true);
    await dialog.getByRole('searchbox', { name: 'Search icons' }).fill('服务器');
    await expect.poll(() => searches.at(-1)?.q).toBe('服务器');
    await expect(dialog.getByTestId('icon-search-results').getByRole('button')).toHaveCount(48);
    expect(searches.at(-1)?.limit).toBe(48);
    await slowSearch!.fulfill({ json: { revision: 'icons:test', offset: 0, limit: 48, total: 0, items: [] } });
    await page.waitForFunction(() => (window as any).oldIconSearchConsumed === true);
    await expect(dialog.getByTestId('icon-search-results').getByRole('button')).toHaveCount(48);
    await dialog.getByRole('searchbox', { name: 'Search icons' }).fill('broken');
    await expect(dialog.getByText('Icons could not be loaded. Text navigation remains available.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.getByTestId('icon-search-results').getByRole('button')).toHaveCount(48);

    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => searches.at(-1)?.offset).toBe(48);
    await expect(dialog.getByTestId('icon-search-results').getByRole('button')).toHaveCount(12);
    const collection = dialog.getByRole('combobox', { name: 'Collection' });
    await expect(dialog.locator('select')).toHaveCount(0);
    await collection.click(); await expect(page.getByRole('option', { name: 'Tabler', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('listbox')).toHaveCount(0); await expect(dialog).toBeVisible();

    await collection.click();
    const option = page.getByRole('option', { name: 'Tabler', exact: true });

    await option.click();
    await expect.poll(() => searches.at(-1)?.collection).toBe('tabler');
    expect(searches.at(-1)?.offset).toBe(0);
    await dialog.getByRole('button', { name: 'tabler:search-0', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await save.click(); await expect(save).toBeDisabled();
    expect(iconBatches.every(ids => ids.length <= 64)).toBe(true);
    // A CAS conflict retains the draft and blocks another write until reload.
    await renameGroup('Conflicting draft'); conflictFailures = 1;
    await save.click(); await expect(page.getByTestId('menus-status')).toBeVisible();
    await expect(groupTitle).toContainText('Conflicting draft'); await expect(save).toBeDisabled();
    const writeCount = writes;
    await pageAction('Reload');
    await expect(page.getByTestId('confirmation-accept')).toBeVisible(); await page.getByTestId('confirmation-cancel').click(); await expect(page.getByTestId('confirmation-accept')).toHaveCount(0);
    await expect(groupTitle).toContainText('Conflicting draft'); expect(writes).toBe(writeCount);
    await pageAction('Reload'); await page.getByTestId('confirmation-accept').click();
    await expect(groupTitle).toContainText('Operations'); conflictFailures = 0;
    // A committed write with a lost response is verified by GET without retrying PUT.
    await renameGroup('Verified after response loss'); loseResponse = true;
    await save.click(); await expect(page.getByTestId('menus-status')).toBeVisible();
    expect(responseLoss).toBeDefined(); await responseLoss; network.assertSettled();
    expect(writes).toBe(writeCount + 1);
    // The guarded router keeps the dirty editor and restores a still-attached menu trigger.
    await renameGroup('Unsaved draft');
    await page.locator('#header-logout-button').click();

    await page.getByTestId('confirmation-cancel').click();
    await expect(groupTitle).toContainText('Unsaved draft');
    await page.getByTestId('header-top-menu').getByRole('button', { name: 'Gateway', exact: true }).click();
    const routesLink = page.getByRole('menuitem', { name: 'Routes', exact: true });
    await routesLink.click();
    await expect(page.getByTestId('confirmation-cancel')).toBeVisible(); await page.getByTestId('confirmation-cancel').click();
    await expect(editor).toBeVisible(); await expect(groupTitle).toContainText('Unsaved draft');

    const headerGroup = page.getByTestId('header-top-menu').getByRole('button', { name: 'Verified after response loss', exact: true });
    await headerGroup.click(); await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
    await expect(page.getByTestId('confirmation-cancel')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Plugins', exact: true })).toHaveCount(0);
    await page.getByTestId('confirmation-cancel').click();
    await expect(editor).toBeVisible(); await expect(groupTitle).toContainText('Unsaved draft');
    // Reset changes only the draft, and keeping the editor retains it.
    await pageAction('Reset to defaults'); await page.getByTestId('confirmation-accept').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    network.assertSettled(); expect(errors).toEqual([]);
}), 150_000);

test('flat and grouped menus follow configured navigation order', () => runtime.run(async page => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
    const errors: string[] = []; const network = observeNetwork(page, errors); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    const catalog = [...BUILTIN_MENU_PAGES, ...Array.from({ length: 12 }, (_, index) => ({ id: `plugin:long:${index}`, label: `Plugin contribution with complete long label ${index}`, href: `/#/extensions/long/${index}`, source: 'plugin' as const, pluginName: 'long', available: true, defaultIcon: 'lucide:puzzle' }))];
    const flat: MenuLayout = catalog.map(page => ({ kind: 'page', pageId: page.id, visible: true }));
    let snapshot: MenuSnapshot = { ...menuSnapshot(), catalog, layout: flat };
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname, json = (value: unknown) => route.fulfill({ json: value });
      if (route.request().method() !== (path === '/api/ui/menus' && route.request().method() === 'PUT' ? 'PUT' : 'GET')) throw new Error(`Unexpected method: ${route.request().method()} ${path}`);
      if (path === '/api/auth/mode') return json({ mode: 'anonymous' });
      if (path === '/api/auth/verify') return json({ mode: 'anonymous', success: true, subject: { id: 'anonymous', provider: 'anonymous' } });
      if (path === '/api/plugins') return json([]);
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (path === '/api/ui/menus') return json(snapshot);
      if (path === '/api/ui/icons/collections') return json(iconCollections);
      if (path === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (path === '/api/config/runtime') return json(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
      if (path === '/api/config') return json({ revision: 1, content_hash: 'menus-fixture', config: configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })).config });
      if (path === '/api/plugins/schemas' || path === '/api/plugin-translations') return json({});
      throw new Error(`Unexpected API: ${route.request().method()} ${path}`);
    });
    await page.goto(`${runtime.origin}/#/menus`);
    const top = page.getByTestId('header-top-menu');
    {

      await expect(top).toBeVisible();
      await expect(top.locator('a')).toHaveCount(catalog.length);
      expect(await top.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))).toEqual(catalog.map(item => item.href));
      await expect(top.locator('a[href="/#/menus"]')).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#header-menu-trigger')).toBeHidden();
      await expect(page.getByTestId('header-menu')).toHaveCount(0);
      await page.locator('#header-more-trigger').click();
      await expect(page.getByTestId('header-more-menu').getByRole('menuitem', { name: catalog.at(-1)!.label, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    snapshot = { ...snapshot, revision: 2, layout: [flat[0], { kind: 'group', id: 'group:mixed', title: 'Operations', visible: true, children: flat.slice(1, 4) as any }, ...flat.slice(4)] };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(top.getByRole('button', { name: 'Operations', exact: true })).toBeVisible();
    await top.getByRole('button', { name: 'Operations', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Routes', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect(top.locator('li')).toHaveCount(catalog.length - 2);
    network.assertSettled(); expect(errors).toEqual([]);
}), 90_000);

test('disabled plugins disappear when menu refresh fails and recover their saved preferences', () => runtime.run(async page => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    const errors: string[] = []; const network = observeNetwork(page, errors); page.on('pageerror', error => errors.push(error.message));
    let enabled = true, remainingMenuFailures = 0, failedReads = 0, writes = 0;
    const plugin: MenuPage = { id: 'plugin:test:%2Fpage', label: 'Test page', href: '/#/extensions/test/page',
      source: 'plugin', pluginName: 'test', defaultIcon: 'lucide:puzzle', available: true };
    const snapshot = {...menuSnapshot()};
    snapshot.catalog = [...snapshot.catalog, plugin];
    snapshot.layout = [{ kind: 'page', pageId: plugin.id, visible: true, icon: 'tabler:home' }, ...snapshot.layout];
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = (value: unknown) => route.fulfill({ json: value });
      if (request.method() !== 'GET') writes++;
      if (route.request().method() !== (path === '/api/ui/menus' && route.request().method() === 'PUT' ? 'PUT' : 'GET')) throw new Error(`Unexpected method: ${route.request().method()} ${path}`);
      if (path === '/api/auth/mode') return json({ mode: 'anonymous' });
      if (path === '/api/auth/verify') return json({ mode: 'anonymous', success: true, subject: { id: 'anonymous', provider: 'anonymous' } });
      if (path === '/api/plugins') return json([{ name: 'test', enabled, version: '1.0.0', metadata: { name: 'Test plugin',
        contributes: { navigation: [{ label: plugin.label, path: '/page' }] } } }]);
      if (path === '/api/ui/icons/collections') return json(iconCollections);
      if (path === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (path === '/api/ui/menus') {
        if (remainingMenuFailures > 0) { remainingMenuFailures--; failedReads++; network.expectHttpError(route.request(), 503); return route.fulfill({ status: 503, json: { error: 'menu_storage_unavailable' } }); }
        return json(snapshot);
      }
      if (path === '/api/config/runtime') return json(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
      if (path === '/api/config') return json({ revision: 1, content_hash: 'menus-fixture', config: configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })).config });
      if (path === '/api/plugins/schemas' || path === '/api/plugin-translations') return json({});
      throw new Error(`Unexpected API: ${route.request().method()} ${path}`);
    });
    await page.goto(`${runtime.origin}/#/menus`);
    const top = page.getByTestId('header-top-menu'), editor = page.getByTestId('page-menus');
    const pluginRow = editor.locator(`[data-menu-id="${plugin.id}"]`);

    await expect(top.getByRole('link', { name: plugin.label, exact: true })).toBeVisible();
    enabled = false; remainingMenuFailures = 1;
    await top.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
    await expect(page.getByTestId('page-plugins')).toBeVisible(); await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(top.getByRole('link', { name: plugin.label, exact: true })).toHaveCount(0);
    await top.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Menu Management', exact: true }).click();
    await expect(editor).toBeVisible(); await expect(pluginRow).toHaveCount(0);
    await expect(editor.getByRole('alert')).toBeVisible();
    expect(failedReads).toBe(1); expect(remainingMenuFailures).toBe(0);
    await editor.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page catalog', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(plugin.label, { exact: true })).toHaveCount(0);
    await closeDialog(page);

    enabled = true;
    await top.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
    await expect(top.getByRole('link', { name: plugin.label, exact: true })).toBeVisible();
    await top.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Menu Management', exact: true }).click();

    await expect(editor.getByRole('alert')).toHaveCount(0);
    expect(writes).toBe(0); network.assertSettled(); expect(errors).toEqual([]);
}), 90_000);

test('menu actions support reordering, reparenting, validation and read-only previews', () => runtime.run(async page => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    const errors: string[] = []; const network = observeNetwork(page, errors); page.on('pageerror', error => errors.push(error.message));
    const initial = {...menuSnapshot()};
    // Exercise a saved arrangement with gateway pages at the top level.
    initial.layout = initial.layout.flatMap<MenuNode>(node => node.kind === 'group' && node.id === 'group:gateway' ? [...node.children] : [node]);
    initial.layout = initial.layout.map(node => node.kind === 'page' && node.pageId === 'builtin:services' ? { ...node, icon: 'tabler:home' } : node);
    const configuration = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
    const captured: {layout: MenuLayout | null} = {layout: null};
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname, json = (value: unknown) => route.fulfill({ json: value });
      if (route.request().method() !== (path === '/api/ui/menus' && route.request().method() === 'PUT' ? 'PUT' : 'GET')) throw new Error(`Unexpected method: ${route.request().method()} ${path}`);
      if (path === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: runtime.origin });
      if (path === '/api/auth/verify') return json({ mode: 'anonymous', success: true, subject: { id: 'anonymous', provider: 'anonymous' } });
      if (path === '/api/plugins') return json([]);
      if (path === '/api/config/runtime') return json(configuration);
      if (path === '/api/ui/icons/collections') return json(iconCollections);
      if (path === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (path === '/api/ui/menus') {
        if (request.method() === 'PUT') { captured.layout = request.postDataJSON().layout; return json({ ...initial, layout: captured.layout, revision: 2 }); }
        return json(initial);
      }
      if (path === '/api/config/runtime') return json(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
      if (path === '/api/config') return json({ revision: 1, content_hash: 'menus-fixture', config: configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })).config });
      if (path === '/api/plugins/schemas' || path === '/api/plugin-translations') return json({});
      throw new Error(`Unexpected API: ${route.request().method()} ${path}`);
    });
    await page.goto(`${runtime.origin}/#/menus`);
    const editor = page.getByTestId('page-menus'), tree = page.getByTestId('menu-layout-tree'), save = page.getByTestId('menus-save');
    const row = (id: string) => tree.locator(`[data-menu-id="${id}"]`);
    const system = row('group:system'), services = row('builtin:services');
    async function actions(id: string, label: string) {
      await row(id).getByRole('button', { name: /^Menu actions / }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    }
    async function moveTo(target: string) {
      await services.getByRole('button', { name: 'Menu actions Services', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Move to', exact: true }).click();
      await page.getByRole('menuitem', { name: target, exact: true }).click();
    }
    await expect(tree).toBeVisible();
    await system.getByRole('button', { name: 'Collapse group System', exact: true }).click();
    await expect(row('builtin:configuration')).toHaveCount(0);
    await system.getByRole('button', { name: 'Expand group System', exact: true }).click();
    await expect(row('builtin:configuration')).toBeVisible();
    await actions('group:system', 'Rename group');
    const name = system.getByRole('textbox', { name: 'Group name', exact: true });

    await name.fill('中文输入');
    await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true });

    await name.dispatchEvent('keydown', { key: 'Escape', isComposing: true });

    await name.fill('');
    await expect(system.getByRole('alert')).toBeVisible(); await expect(save).toBeDisabled();
    await name.press('Escape'); await expect(system.getByRole('button', { name: 'Collapse group System', exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await editor.getByRole('button', { name: 'Add group', exact: true }).click();
    const newGroup = tree.getByRole('textbox', { name: 'Group name', exact: true });
     await newGroup.fill('System');
    await expect(tree.getByRole('alert')).toHaveCount(2); await expect(save).toBeDisabled();
    await newGroup.press('Escape');
    const newId = await tree.getByRole('group', { name: 'Untitled group', exact: true }).getAttribute('data-menu-id');
    await actions(newId!, 'Dissolve group (keep pages)');
    await expect(save).toBeDisabled();
    await services.getByRole('button', { name: 'Menu actions Services', exact: true }).focus();
    await page.keyboard.press('Enter'); await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    expect(await tree.locator(':scope > [role="listitem"] > [data-menu-id]').evaluateAll(nodes => nodes.slice(0, 3).map(node => node.getAttribute('data-menu-id')))).toEqual(['builtin:dashboard', 'builtin:services', 'builtin:routes']);

    // Selecting an action and Save in the same event turn must not start a write
    // while that action waits for the dropdown's exit transition.
    await editor.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reset to defaults', exact: true }).evaluate(element => {
      (element as HTMLElement).click();
      (document.querySelector('[data-testid="menus-save"]') as HTMLButtonElement).click();
    });
    await expect(page.getByTestId('confirmation-cancel')).toBeVisible(); expect(captured.layout).toBeNull();
    await page.getByTestId('confirmation-cancel').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await moveTo('System');
    await expect(tree.getByRole('list', { name: 'System', exact: true }).locator('[data-menu-id="builtin:services"]')).toHaveCount(1);

    await moveTo('Top level'); await expect(row('builtin:services')).toHaveCount(1);

    await services.getByRole('button', { name: 'Menu actions Services', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to', exact: true }).click();
    const destination = page.getByRole('menuitem', { name: 'System', exact: true });

    await destination.click();
    await moveTo('Top level');
    await actions('builtin:services', 'Use default icon');

    await editor.getByRole('button', { name: 'Draft preview', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').locator('a')).toHaveCount(0);
    await closeDialog(page);
    await editor.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page catalog', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Dashboard', { exact: true })).toBeVisible();
    await closeDialog(page);

    await system.getByRole('switch').uncheck(); await actions('group:system', 'Dissolve group (keep pages)');
    await expect(system).toHaveCount(0);
    for (const id of ['builtin:configuration', 'builtin:plugins', 'builtin:menus']) await expect(row(id).getByRole('switch')).not.toBeChecked();
    await save.click(); await expect(save).toBeDisabled();
    expect(captured.layout?.filter(node => node.kind === 'page')).toHaveLength(7);
    expect(new Set(captured.layout?.map(node => node.kind === 'page' ? node.pageId : node.id)).size).toBe(7);
    network.assertSettled(); expect(errors).toEqual([]);
}), 120_000);

test('menu drag reorders groups and preserves disabled plugin preferences', () => runtime.run(async page => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    const errors: string[] = []; const network = observeNetwork(page, errors); page.on('pageerror', error => errors.push(error.message));
    const inactiveRoot = { kind: 'page', pageId: 'plugin:inactive:%2Froot', visible: false, icon: 'tabler:home' } as const;
    const inactiveChild = { ...inactiveRoot, pageId: 'plugin:inactive:%2Fchild' };
    const pluginPage = (id: string, available: boolean): MenuPage => ({ id, label: id, href: '/#/extensions/inactive/' + id.split('%2F')[1], source: 'plugin', pluginName: 'inactive', defaultIcon: 'lucide:puzzle', available });
    let snapshot = {...menuSnapshot()};
    snapshot.layout = snapshot.layout.flatMap<MenuNode>(node => node.kind === 'group' && node.id === 'group:gateway' ? [...node.children] : [node]);
    const captured: {layout: MenuLayout | null} = {layout: null};
    snapshot = { ...snapshot, catalog: [...snapshot.catalog, pluginPage(inactiveRoot.pageId, false), pluginPage(inactiveChild.pageId, false)],
      layout: snapshot.layout.flatMap<MenuNode>(node => node.kind === 'group' ? [{ ...node, children: [node.children[0], inactiveChild, ...node.children.slice(1)] }]
        : node.pageId === 'builtin:routes' ? [node, inactiveRoot] : [node]) };
    snapshot.layout = [...snapshot.layout, { kind: 'group', id: 'group:other', title: 'Other', visible: true, children: [] }];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname, json = (value: unknown) => route.fulfill({ json: value });
      if (route.request().method() !== (path === '/api/ui/menus' && route.request().method() === 'PUT' ? 'PUT' : 'GET')) throw new Error(`Unexpected method: ${route.request().method()} ${path}`);
      if (path === '/api/auth/mode') return json({ mode: 'anonymous' });
      if (path === '/api/auth/verify') return json({ mode: 'anonymous', success: true, subject: { id: 'anonymous', provider: 'anonymous' } });
      if (path === '/api/plugins') return json([]);
      if (path === '/api/ui/icons/collections') return json(iconCollections);
      if (path === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (path === '/api/ui/menus') {
        if (route.request().method() === 'PUT') { captured.layout = route.request().postDataJSON().layout; snapshot = { ...snapshot, layout: captured.layout!, revision: snapshot.revision + 1 }; }
        return json(snapshot);
      }
      if (path === '/api/config/runtime') return json(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
      if (path === '/api/config') return json({ revision: 1, content_hash: 'menus-fixture', config: configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })).config });
      if (path === '/api/plugins/schemas' || path === '/api/plugin-translations') return json({});
      throw new Error(`Unexpected API: ${route.request().method()} ${path}`);
    });
    await page.goto(`${runtime.origin}/#/menus`);
    const editor = page.getByTestId('page-menus'), tree = page.getByTestId('menu-layout-tree'), save = page.getByTestId('menus-save');
    const row = (id: string) => tree.locator(`[data-menu-id="${id}"]`);
    const rootOrder = () => tree.locator(':scope > [role="listitem"] > [data-menu-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-menu-id')));
    async function beginDrag(id: string) {
      const handle = row(id).getByRole('button', { name: /^Drag / }), bounds = (await handle.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2 + 5, { steps: 5 });
      await expect(row(id)).toHaveAttribute('data-drag-source', 'true');

    }
    async function hoverRow(id: string, fraction: number) {
      const bounds = (await row(id).boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width * .45, bounds.y + bounds.height * fraction, { steps: 8 });
      await page.mouse.move(bounds.x + bounds.width * .45 + 1, bounds.y + bounds.height * fraction);
    }
    async function finishDrag() {
      await page.mouse.up(); await expect(tree.locator('[data-drag-source="true"]')).toHaveCount(0);

    }
    await expect(tree).toBeVisible(); await expect(save).toBeDisabled();
    await expect(row(inactiveRoot.pageId)).toHaveCount(0); await expect(row(inactiveChild.pageId)).toHaveCount(0);
    await editor.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page catalog', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.getByRole('dialog').getByText(/inactive/)).toHaveCount(0);
    await closeDialog(page);
    await beginDrag('builtin:services'); await hoverRow('builtin:logs', .8);
    expect((await rootOrder()).slice(0, 4)).toEqual(['builtin:dashboard', 'builtin:routes', 'builtin:logs', 'builtin:services']);
     await expect(save).toBeDisabled();

     await finishDrag();
    expect((await rootOrder()).slice(0, 4)).toEqual(['builtin:dashboard', 'builtin:routes', 'builtin:logs', 'builtin:services']);
    await beginDrag('builtin:services'); await hoverRow('builtin:dashboard', .1); await finishDrag();
    expect((await rootOrder())[0]).toBe('builtin:services');
    await beginDrag('builtin:services'); await hoverRow('group:system', .5);
     await finishDrag();
    await expect(tree.getByRole('list', { name: 'System', exact: true }).locator('[data-menu-id="builtin:services"]')).toHaveCount(1);
    await beginDrag('builtin:services'); await hoverRow('group:other', .5); await finishDrag();
    await expect(tree.getByRole('list', { name: 'Other', exact: true }).locator('[data-menu-id="builtin:services"]')).toHaveCount(1);
    await beginDrag('builtin:services'); await hoverRow('group:other', .9); await finishDrag();
    expect((await rootOrder()).at(-1)).toBe('builtin:services');
    await row('group:system').getByRole('button', { name: 'Collapse group System', exact: true }).click();
    await beginDrag('builtin:services'); await hoverRow('group:system', .5); await finishDrag();
    await expect(row('builtin:configuration')).toBeVisible();
    await beginDrag('group:other'); await hoverRow('builtin:dashboard', .1);
    expect((await rootOrder())[0]).toBe('group:other'); await finishDrag();
    await beginDrag('group:other'); await hoverRow('group:system', .9); await finishDrag();
    const beforeInvalid = await rootOrder();
    await beginDrag('group:other'); await hoverRow('builtin:configuration', .5); await finishDrag();
    expect(await rootOrder()).toEqual(beforeInvalid);
    // Editing a projected group must preserve its inactive children in the write.
    await row('group:system').getByRole('button', { name: /^Menu actions / }).click();
    await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
    const name = row('group:system').getByRole('textbox', { name: 'Group name', exact: true });
     await name.fill('Operations'); await name.press('Enter');
    await row('group:system').getByRole('switch').uncheck(); await save.click();
    await expect(page.getByTestId('menus-status')).toBeVisible(); await expect(save).toBeDisabled();
    expect(captured.layout?.find(node => node.kind === 'page' && node.pageId === inactiveRoot.pageId)).toEqual(inactiveRoot);
    const storedGroup = captured.layout?.find(node => node.kind === 'group' && node.id === 'group:system');
    expect(storedGroup?.kind === 'group' && storedGroup.children.find(node => node.pageId === inactiveChild.pageId)).toEqual(inactiveChild);
    const savedOrder = await rootOrder();
    await beginDrag('builtin:dashboard'); await hoverRow('group:other', .5); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(tree.locator('[data-drag-source="true"], [data-drop-inside="true"]')).toHaveCount(0);
    expect(await rootOrder()).toEqual(savedOrder); await expect(save).toBeDisabled();
    await beginDrag('builtin:dashboard'); await editor.getByRole('heading').hover(); await finishDrag();
    expect(await rootOrder()).toEqual(savedOrder); await expect(save).toBeDisabled();
    await beginDrag('builtin:dashboard'); await hoverRow('group:other', .5);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    await expect(tree.locator('[data-drag-source="true"]')).toHaveCount(0);
    expect(await rootOrder()).toEqual(savedOrder); await expect(save).toBeDisabled();
    snapshot = { ...snapshot, catalog: snapshot.catalog.map(page => page.pluginName === 'inactive' ? { ...page, available: true } : page) };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(row(inactiveRoot.pageId)).toBeVisible(); await expect(row(inactiveRoot.pageId).getByRole('switch')).not.toBeChecked();
    await expect(row(inactiveChild.pageId)).toBeVisible(); await expect(row(inactiveChild.pageId).getByRole('switch')).not.toBeChecked();

    network.assertSettled(); expect(errors).toEqual([]);
}), 120_000);
