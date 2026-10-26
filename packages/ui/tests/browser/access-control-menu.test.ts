import { systemUpdateStatusFixture } from '../helpers/system-updates';
import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import {menuSnapshot, fulfillMenuIcons} from '../helpers/menus';
import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('access control menu', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
try {
const base = uiRuntime.origin;
const manifest = await Bun.file(new URL('../../../../plugins/key-access/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
runtime.config.logical_configuration.routes = [{ id: 'route-test', position: 0, path: '/v1/chat/completions', endpoints: [],
  plugins: [] }];

const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const canonical = '/extensions/key-access/settings';
try {
  {
    const language = 'zh-CN';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: language });
    await context.addInitScript(value => localStorage.setItem('locale', value), language);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
    let activeBookmark: string | undefined;
    const cancelledBookmarkFrames: string[] = [];
    page.on('requestfailed', request => {
      // The root bookmark redirects through /extensions/key-access before selecting its page.
      // Its transient sandbox document is cancelled by that observed navigation only.
      if (activeBookmark === '/plugins/key-access?from=bookmark'
        && request.method() === 'GET' && request.isNavigationRequest()
        && request.frame().parentFrame() === page.mainFrame()
        && request.url() === `${base}/plugins/key-access/index.html`
        && request.failure()?.errorText === 'net::ERR_ABORTED'
        && cancelledBookmarkFrames.length === 0) { cancelledBookmarkFrames.push(activeBookmark); return; }
      errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
    const t = (key: string) => manifest.translations[language][key];
    let enabled = true;
    let protectedRouteIds: string[] = [];
    let key = { id: 'key-test', name: 'demo-app', prefix: 'bk_example', createdAt: Date.now(), expiresAt: null, revokedAt: null };
    const writes: Array<{ path: string; body: unknown }> = [];
    await page.route('**/plugins/key-access/index.html', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Plugin navigation</title>'}));
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ json: value });
      if (request.method() === 'GET' && url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
      if (request.method() === 'GET' && url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
      if (request.method() === 'GET' && url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled, version: manifest.version,
        metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
      if (request.method() === 'GET' && url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
        .map(([code, messages]) => [code, { plugins: { 'key-access': messages } }])));
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
      if (request.method() === 'GET' && url.pathname === '/api/ui/menus') {
        const snapshot = menuSnapshot();
        const catalog = [...snapshot.catalog, ...[manifest].filter(() => enabled).flatMap(item => (item.contributes.navigation ?? []).map((nav: any) => ({
          id:`plugin:${item.name}:${encodeURIComponent(nav.path)}`,label:nav.label,href:`/#/extensions/${item.name}${nav.path}`,
          source:'plugin' as const,pluginName:item.name,defaultIcon:'lucide:user',available:true,
        })))];
        return json({...snapshot,catalog,layout:createDefaultMenuLayout(catalog)});
      }
      if (request.method() === 'GET' && url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (request.method() === 'GET' && url.pathname === '/api/runtime/upstreams') return json({schema:'bungee-runtime-upstreams-v1',generated_at:Date.now(),availability:'complete',reason:null,admission:{revision:1},workers:{observed:[],missing:[]},upstreams:[]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/key-access/sandbox') return json({sandbox:'allow-scripts',allowedHostActions:[],controlAllowlist:[]});
      if (request.method() === 'GET' && url.pathname === '/api/config/runtime') return json(runtime);
      if (request.method() === 'GET' && url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
      if (request.method() === 'GET' && url.pathname === '/api/resources/api-key') return json({ keys: [key] });
      if (['GET','PUT'].includes(request.method()) && url.pathname === '/api/plugins/key-access/control/routes') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          protectedRouteIds = body.protectedRouteIds;
        }
        return json({ protectedRouteIds, routeKeyBindings: {}, ready: true, published: true });
      }
      if (request.method() === 'GET' && url.pathname === '/api/plugins/key-access/control/keys/key-test') return json({ value: { routes: null, models: null } });
      if (['GET','PUT'].includes(request.method()) && url.pathname === '/api/plugins/key-access/control/credentials/key-test') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          key = { ...key, name: body.name };
          return json({ key, ready: true, published: true });
        }
        return json({ token: 'fixture-only-token' });
      }
      errors.push(`Unexpected API ${request.method()} ${url.pathname}`);
      return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}});
    });
    await page.goto(`${base}/#/plugins`);
    const pluginCard = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({ hasText: t('metadata.name') });
    await expect(pluginCard).toBeVisible();
    await expect(pluginCard.locator('a[href^="/#/plugins/key-access"]')).toHaveCount(0);
    await expect(pluginCard.locator('a[href^="/#/extensions/"]')).toHaveCount(0);
    const accessGroup = page.getByTestId('header-top-menu').getByRole('button', { name: '访问管理', exact: true });
    await accessGroup.click();
    const menuLink = page.getByRole('menuitem', { name: t('metadata.name'), exact: true });
    await menuLink.click();
    const settings = page.getByTestId('access-control-settings');
    await expect(settings).toContainText(key.name);
    await expect(accessGroup).toHaveAttribute('data-active', 'true');
    expect(new URL(page.url()).hash).toBe(`#${canonical}`);
    await page.reload(); await expect(settings).toContainText(key.name);
    // The relocated component saves through the same plugin controls.
    await settings.getByRole('radio', { name: t('ui.routeAccess'), exact: true }).click();
    const publicSwitch = settings.getByRole('switch');
    await expect(publicSwitch).toBeEnabled(); await publicSwitch.click();
    await expect(publicSwitch).not.toBeChecked();
    expect(writes.at(-1)).toEqual({ path: '/api/plugins/key-access/control/routes', body: { protectedRouteIds: ['route-test'] } });
    await settings.getByRole('radio', { name: t('ui.keys'), exact: true }).click();
    await settings.getByRole('row').filter({ hasText: key.name }).getByRole('button', { name: t('ui.edit'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#key-route-policy')).toBeVisible();
    await dialog.getByLabel(t('ui.name'), { exact: true }).fill('updated-app');
    await dialog.getByRole('button', { name: t('ui.save'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes.at(-1)).toEqual({ path: '/api/plugins/key-access/control/credentials/key-test',
      body: { name: 'updated-app', expiresAt: null, routes: null, models: null } });
    await settings.getByRole('button', { name: t('ui.refresh'), exact: true }).click();
    await expect(settings).toContainText('updated-app');
    for (const oldPath of ['/plugins/key-access/settings?from=bookmark', '/plugins/key-access?from=bookmark']) {
      activeBookmark = oldPath;
      await page.goto(`${base}/#${oldPath}`);
      await expect.poll(() => new URL(page.url()).hash).toBe(`#${canonical}?from=bookmark`);
      await expect(settings).toContainText('updated-app');
      activeBookmark = undefined;
    }
    expect(cancelledBookmarkFrames).toEqual(['/plugins/key-access?from=bookmark']);
    await page.getByTestId('header-top-menu').getByRole('button', { name: '网关管理', exact: true }).click();
    await page.getByRole('menuitem', { name: language === 'zh-CN' ? '路由管理' : 'Routes', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await page.goBack(); await expect(settings).toContainText('updated-app');
    enabled = false;
    await page.reload(); await page.goto(`${base}/#/plugins`);
    await expect(accessGroup).toHaveCount(0);
    await expect(pluginCard.locator('a')).toHaveCount(0);
    await context.close();
  }
  expect(errors).toEqual([]);

} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
