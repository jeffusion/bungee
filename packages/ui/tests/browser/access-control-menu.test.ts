import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('access control menu', async () => {
const uiRuntime = await startUiRuntime();
try {
const base = uiRuntime.origin;
const evidence = process.env.ACCESS_EVIDENCE_DIR ?? '/tmp/bungee-access-control-menu';
const manifest = await Bun.file(new URL('../../../../plugins/key-access/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
runtime.config.logical_configuration.routes = [{ id: 'route-test', position: 0, path: '/v1/chat/completions', endpoints: [],
  plugins: [] }];
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const canonical = '/extensions/key-access/settings';
try {
  for (const language of ['zh-CN', 'en']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: language });
    await context.addInitScript(value => localStorage.setItem('locale', value), language);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const t = (key: string) => manifest.translations[language][key];
    let enabled = true;
    let protectedRouteIds: string[] = [];
    let key = { id: 'key-test', name: 'demo-app', prefix: 'bk_example', createdAt: Date.now(), expiresAt: null, revokedAt: null };
    const writes: Array<{ path: string; body: unknown }> = [];
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ json: value });
      if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
      if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
      if (url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled, version: manifest.version,
        metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
      if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
        .map(([code, messages]) => [code, { plugins: { 'key-access': messages } }])));
      if (url.pathname === '/api/config/runtime') return json(runtime);
      if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
      if (url.pathname === '/api/resources/api-key') return json({ keys: [key] });
      if (url.pathname === '/api/plugins/key-access/control/routes') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          protectedRouteIds = body.protectedRouteIds;
        }
        return json({ protectedRouteIds, routeKeyBindings: {}, ready: true, published: true });
      }
      if (url.pathname === '/api/plugins/key-access/control/keys/key-test') return json({ value: { routes: null, models: null } });
      if (url.pathname === '/api/plugins/key-access/control/credentials/key-test') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          key = { ...key, name: body.name };
          return json({ key, ready: true, published: true });
        }
        return json({ token: 'fixture-only-token' });
      }
      return json({});
    });
    await page.goto(`${base}/#/plugins`);
    const pluginCard = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({ hasText: t('metadata.name') });
    await expect(pluginCard).toBeVisible();
    await expect(pluginCard.locator('a[href^="/#/plugins/key-access"]')).toHaveCount(0);
    await expect(pluginCard.locator(`a[href="/#${canonical}"]`)).toBeVisible();
    const menuLink = page.getByTestId('app-header').getByRole('link', { name: t('metadata.name'), exact: true });
    await menuLink.click();
    const settings = page.getByTestId('access-control-settings');
    await expect(settings).toContainText(key.name);
    await expect(menuLink).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe(`#${canonical}`);
    await page.reload(); await expect(settings).toContainText(key.name);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width < 768) {
        await page.locator('#header-menu-trigger').click();
        const sheet = page.getByTestId('header-menu');
        const link = sheet.getByRole('link', { name: t('metadata.name'), exact: true });
        await expect(link).toHaveAttribute('aria-current', 'page');
        await link.click(); await expect(sheet).toHaveCount(0);
      } else await expect(menuLink).toHaveAttribute('aria-current', 'page');
      await expect(settings).toContainText(key.name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (language === 'zh-CN' && [390, 1440].includes(width)) {
        await page.screenshot({ path: `${evidence}/access-control-${width}.png`, animations: 'disabled', fullPage: true });
      }
    }
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
      await page.goto(`${base}/#${oldPath}`);
      await expect.poll(() => new URL(page.url()).hash).toBe(`#${canonical}?from=bookmark`);
      await expect(settings).toContainText('updated-app');
    }
    await page.getByRole('link', { name: language === 'zh-CN' ? '路由管理' : 'Routes', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await page.goBack(); await expect(settings).toContainText('updated-app');
    enabled = false;
    await page.goto(`${base}/#/plugins`); await page.reload();
    await expect(page.getByTestId('app-header').getByRole('link', { name: t('metadata.name'), exact: true })).toHaveCount(0);
    await expect(pluginCard.locator('a')).toHaveCount(0);
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ languages: 2, widths: 4, menu: true, settingsRemoved: true, reload: true,
    legacyRedirects: true, routeProtection: true, keySave: true, disabledMenuHidden: true, errors, evidence }));
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
