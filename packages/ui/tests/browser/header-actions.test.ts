import { test as browserTest } from 'bun:test';
import { chromium, expect, type Route } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('unified header navigation, group keyboard lifecycle, locales and session logout', async () => {
  const uiRuntime = await startUiRuntime({ mode: 'built-page' });
  const evidence = process.env.HEADER_EVIDENCE_DIR ?? '/tmp/bungee-header-actions';
  mkdirSync(evidence, { recursive: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try { browser = await chromium.launch({headless:true}); } catch (error) { await uiRuntime.close(); throw error; }
  const errors: string[] = [];
  const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
    retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
  try {
    for (const {mode, language} of [{mode:'anonymous',language:'zh-CN'}, {mode:'plugin',language:'en'}] as const) {
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
      const languages = page.locator('#header-language-trigger'), languageMenu = page.getByTestId('header-language-menu');
      const logout = page.locator('#header-logout-button');
      await expect(header).toBeVisible();
      await expect(logout).toHaveCount(mode === 'plugin' ? 1 : 0);
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(top).toBeVisible();
        await expect(page.locator('#header-menu-trigger')).toHaveCount(0);
        await expect(page.getByTestId('header-menu')).toHaveCount(0);
        const topKeys = await top.locator('li').evaluateAll(nodes => nodes.map(node => node.querySelector('a')?.getAttribute('href') ?? 'group'));
        expect(topKeys).toEqual(['/#/', '/#/routes', '/#/services', '/#/logs', 'group']);
        expect((await header.boundingBox())!.height).toBe(48);
        expect(await header.locator('.header-action').evaluateAll(nodes => nodes.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width >= 44 && rect.height >= 44;
        }))).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const system = top.getByRole('button', { name: language === 'en' ? 'System' : '系统管理', exact: true });
      await system.focus(); await page.keyboard.press('Enter');
      const config = page.getByRole('menuitem', { name: language === 'en' ? 'Global Settings' : '全局设置', exact: true });
      const plugins = page.getByRole('menuitem', { name: language === 'en' ? 'Plugins' : '插件管理', exact: true });
      const menus = page.getByRole('menuitem', { name: language === 'en' ? 'Menu Management' : '菜单管理', exact: true });
      await expect(config).toBeVisible(); await expect(plugins).toBeVisible(); await expect(menus).toBeVisible();
      await page.keyboard.press('Escape'); await expect(config).toHaveCount(0); await expect(system).toBeFocused();
      await system.click(); await menus.click();
      await expect(page.getByTestId('page-menus')).toBeVisible();
      await expect(system).toHaveAttribute('data-active', 'true');
      await expect(menus).toHaveCount(0);
      await system.click(); await expect(menus).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: `${evidence}/${mode}-${language}-group.png` });
      await page.keyboard.press('Escape'); await expect(system).toBeFocused();
      await system.hover(); await header.screenshot({ path: `${evidence}/${mode}-${language}-header.png` });
      await languages.click(); await expect(languageMenu).toBeVisible();
      await expect(languageMenu.getByRole('menuitemradio', { name: language === 'en' ? 'English' : '中文', exact: true })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape'); await expect(languageMenu).toHaveCount(0); await expect(languages).toBeFocused();
      await languages.click();
      const alternateCode = language === 'en' ? 'zh-CN' : 'en';
      await languageMenu.getByRole('menuitemradio', { name: language === 'en' ? '中文' : 'English', exact: true }).click();
      await expect(languages).toHaveAttribute('aria-label', alternateCode === 'en' ? 'Language' : '语言');
      expect(await page.evaluate(() => localStorage.getItem('locale'))).toBe(alternateCode);
      await page.reload(); await expect(header).toBeVisible();
      await expect(languages).toHaveAttribute('aria-label', alternateCode === 'en' ? 'Language' : '语言');
      if (mode === 'plugin') {
        for (const width of [1440, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await logout.click();
          const confirmation = page.getByRole('dialog');
          await expect(confirmation).toBeVisible(); await expect(logout).toBeDisabled();
          const message = alternateCode === 'zh-CN' ? '退出后需要重新登录才能访问管理界面。' : 'You will need to sign in again to access the dashboard.';
          await expect(confirmation.locator('[data-dialog-body]')).toContainText(message);
          await expect(confirmation.locator('header')).not.toContainText(message);
          await expect(confirmation.getByTestId('industrial-confirmation')).toHaveText(message);
          await expect(confirmation).toHaveAccessibleDescription(message);
          const bounds = await confirmation.getByTestId('industrial-confirmation').boundingBox();
          expect(bounds!.height).toBeGreaterThan(0);
          await confirmation.evaluate(async element => { await Promise.all(element.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {}))); });
          await page.screenshot({path: `${evidence}/logout-confirmation-${language}-${width}.png`});
          expect(logoutCalls).toBe(0);
          await confirmation.getByTestId('confirmation-cancel').click();
          await expect(confirmation).toHaveCount(0); await expect(logout).toBeFocused();
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
