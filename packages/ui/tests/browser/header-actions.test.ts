import { test as browserTest } from 'bun:test';
import { chromium, expect, type Route } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('header navigation and confirmed session logout', async () => {
  const uiRuntime = await startUiRuntime({ mode: 'built-page' });

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try { browser = await chromium.launch({headless:true}); } catch (error) { await uiRuntime.close(); throw error; }
  const errors: string[] = [];
  const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
    retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
  try {
    for (const mode of ['anonymous', 'plugin'] as const) {
      const language = 'zh-CN' as string;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language });
      await context.addInitScript(value => {
        if (localStorage.getItem('locale') === null) localStorage.setItem('locale', value);
      }, language);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
      page.on('requestfailed', request => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
      let authenticated = true, logoutCalls = 0;
      const snapshot = menuSnapshot();
      const mockApi = (route: Route) => {
        const url = new URL(route.request().url());
        const json = (value: unknown) => route.fulfill({ json: value });
        if (route.request().method() === 'GET' && url.pathname === '/api/auth/mode') return json({ mode, initialized: true, publicOrigin: url.origin,
          ...(mode === 'plugin' ? { provider: { name: 'user-auth', loginComponent: 'UserAuthLogin' } } : {}) });
        if (route.request().method() === 'GET' && url.pathname === '/api/auth/verify') return json({ mode, success: authenticated,
          ...(authenticated ? { subject: { id: mode === 'plugin' ? 'test-user' : 'anonymous',
            provider: mode === 'plugin' ? 'user-auth' : 'anonymous' }, csrfToken: 'test-csrf' } : {}) });
        if (['POST'].includes(route.request().method()) && url.pathname === '/api/auth/logout') { authenticated = false; logoutCalls++; return json({ success: true }); }
        if (route.request().method() === 'GET' && url.pathname === '/api/auth/login/options') return json({local:{enabled:true,turnstile:{enabled:false}},methods:[]});
        if (route.request().method() === 'GET' && url.pathname === '/api/ui/menus') return json(snapshot);
        if (route.request().method() === 'GET' && url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
        if (route.request().method() === 'GET' && url.pathname === '/api/config/runtime') return json(runtime);
        if (route.request().method() === 'GET' && url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
        if (route.request().method() === 'GET' && url.pathname === '/api/plugins') return json([]);
        if (route.request().method() === 'GET' && url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
        if (route.request().method() === 'GET' && url.pathname === '/api/plugin-translations') return json({});
        if (route.request().method() === 'GET' && url.pathname === '/api/ui/icons/collections') return json({collections:[]});
        errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`);
        return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}});
      };
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, mockApi);
      await page.goto(`${uiRuntime.origin}/#/routes`);
      const header = page.getByTestId('app-header'), top = page.getByTestId('header-top-menu');
      const logout = page.locator('#header-logout-button');
      await expect(header).toBeVisible();
      await expect(logout).toHaveCount(mode === 'plugin' ? 1 : 0);
      {

        await expect(top).toBeVisible();
        await expect(page.locator('#header-menu-trigger')).toHaveCount(0);
        await expect(page.getByTestId('header-menu')).toHaveCount(0);
        const topKeys = await top.locator('li').evaluateAll(nodes => nodes.map(node => node.querySelector('a')?.getAttribute('href') ?? 'group'));
        expect(topKeys).toEqual(['/#/', '/#/routes', '/#/services', '/#/logs', 'group']);

      }

      const system = top.getByRole('button', { name: language === 'en' ? 'System' : '系统管理', exact: true });
      await system.focus(); await page.keyboard.press('Enter');
      const config = page.getByRole('menuitem', { name: language === 'en' ? 'Global Settings' : '全局设置', exact: true });
      const plugins = page.getByRole('menuitem', { name: language === 'en' ? 'Plugins' : '插件管理', exact: true });
      const menus = page.getByRole('menuitem', { name: language === 'en' ? 'Menu Management' : '菜单管理', exact: true });
      await expect(config).toBeVisible(); await expect(plugins).toBeVisible(); await expect(menus).toBeVisible();
      await page.keyboard.press('Escape'); await expect(config).toHaveCount(0);
      await system.click(); await menus.click();
      await expect(page.getByTestId('page-menus')).toBeVisible();
      await expect(system).toHaveAttribute('data-active', 'true');
      await expect(menus).toHaveCount(0);
      await system.click(); await expect(menus).toHaveAttribute('aria-current', 'page');

      await page.keyboard.press('Escape');
      await system.hover();
      if (mode === 'plugin') {
        {

          await logout.click();
          const confirmation = page.getByRole('dialog');
          await expect(confirmation).toBeVisible(); await expect(logout).toBeDisabled();
          expect(logoutCalls).toBe(0);
          await confirmation.getByTestId('confirmation-cancel').click();
          await expect(confirmation).toHaveCount(0);
          await expect(logout).toBeEnabled(); expect(logoutCalls).toBe(0);
        }
        await logout.click(); await page.getByTestId('confirmation-accept').click();
        await expect(header).toHaveCount(0); await expect(page.getByTestId('page-login')).toBeVisible(); expect(logoutCalls).toBe(1);
      }
      await context.close();
    }
    expect(errors).toEqual([]);
  } finally { try { await browser.close(); } finally { await uiRuntime.close(); } }
}, 240_000);
