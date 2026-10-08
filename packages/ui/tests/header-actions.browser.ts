import { chromium, expect, type Route } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';

// UI interaction checks with simulated auth/config responses; no live credentials.
const base = process.env.HEADER_BASE_URL ?? 'http://127.0.0.1:5185';
const evidence = process.env.HEADER_EVIDENCE_DIR ?? '/tmp/bungee-header-actions';
mkdirSync(evidence, { recursive: true });
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  for (const mode of ['anonymous', 'plugin'] as const) {
    for (const language of ['zh-CN', 'en']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language, hasTouch: true });
      await context.addInitScript(value => { if (!localStorage.getItem('locale')) localStorage.setItem('locale', value); }, language);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      let authenticated = true, logoutCalls = 0;
      const mockApi = (route: Route) => {
        const url = new URL(route.request().url());
        const json = (value: unknown) => route.fulfill({ json: value });
        if (url.pathname === '/api/auth/mode') return json({ mode, publicOrigin: url.origin,
          ...(mode === 'plugin' ? { provider: { name: 'local-accounts', loginComponent: 'LocalAccountsLogin' } } : {}) });
        if (url.pathname === '/api/auth/verify') return json({ mode, success: authenticated,
          ...(authenticated ? { subject: { id: mode === 'plugin' ? 'test-user' : 'anonymous',
            provider: mode === 'plugin' ? 'local-accounts' : 'anonymous' }, csrfToken: 'test-csrf' } : {}) });
        if (url.pathname === '/api/auth/logout') { authenticated = false; logoutCalls++; return json({ success: true }); }
        if (url.pathname === '/api/config/runtime') return json(runtime);
        if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
        if (url.pathname === '/api/plugins') return json([]);
        if (url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
          availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
        return json({});
      };
      await page.route('**/api/**', mockApi);
      await page.goto(`${base}/#/routes`);
      const header = page.getByTestId('app-header');
      const system = page.locator('#header-management-trigger');
      const languages = page.locator('#header-language-trigger');
      const languageMenu = page.getByTestId('header-language-menu');
      const logout = page.locator('#header-logout-button');
      const pages = page.locator('#header-menu-trigger');
      const sheet = page.getByTestId('header-menu');
      await expect(header).toBeVisible();
      await expect(logout).toHaveCount(mode === 'plugin' ? 1 : 0);
      for (const width of [320, 390, 667, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: width === 667 ? 320 : 900 });
        await expect(system).toBeVisible(); await expect(languages).toBeVisible();
        if (mode === 'plugin') await expect(logout).toBeVisible();
        await expect(languages).toHaveText('');
        if (mode === 'plugin') await expect(logout).toHaveText('');
        if (width >= 768) expect(await header.locator('#header-language-trigger, #header-logout-button').evaluateAll(nodes => nodes.every(node =>
          node.getBoundingClientRect().width === 44 && getComputedStyle(node).borderLeftWidth === '0px'
          && getComputedStyle(node.parentElement!).borderLeftWidth === '0px'))).toBe(true);
        if (width < 768) {
          await expect(pages).toBeVisible();
          expect(await pages.evaluate(node => ({
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
            border: getComputedStyle(node).borderWidth, separator: getComputedStyle(node.parentElement!).borderRightWidth,
          }))).toEqual({ width: 44, height: 44, border: '0px', separator: '0px' });
          const brand = header.getByRole('link', { name: 'BUNGEE', exact: true });
          expect((await pages.boundingBox())!.x + (await pages.boundingBox())!.width).toBeLessThanOrEqual((await brand.boundingBox())!.x);
          await pages.tap();
          await expect(sheet).toBeVisible();
          await expect.poll(() => sheet.evaluate(node => Math.abs(node.getBoundingClientRect().left))).toBeLessThan(1);
          expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(width - 24);
          if (mode === 'plugin' && language === 'zh-CN' && width === 320) await page.screenshot({ path: `${evidence}/mobile-navigation-open.png` });
          await sheet.locator('a[href="/#/services"]').click();
          await expect(sheet, `${mode}/${language}/${width}: close after navigation`).toHaveCount(0); await expect(pages).toBeFocused();
          await expect(page.getByTestId('page-services')).toBeVisible();
          await pages.click(); await expect(sheet).toBeVisible();
          await expect.poll(() => sheet.evaluate(node => Math.abs(node.getBoundingClientRect().left))).toBeLessThan(1);
          await page.mouse.click(width - 4, width === 667 ? 160 : 450);
          await expect(sheet, `${mode}/${language}/${width}: close after overlay click`).toHaveCount(0); await expect(pages).toBeFocused();
          await pages.focus(); await page.keyboard.press('Enter'); await expect(sheet).toBeVisible();
          await expect(sheet.locator('a').first()).toBeFocused();
          await expect.poll(() => sheet.evaluate(node => Math.abs(node.getBoundingClientRect().left))).toBeLessThan(1);
          await page.keyboard.press('Escape'); await expect(sheet, `${mode}/${language}/${width}: close after Escape`).toHaveCount(0); await expect(pages).toBeFocused();
          expect(await pages.evaluate(node => ({ color: getComputedStyle(node).outlineColor, width: getComputedStyle(node).outlineWidth })))
            .toEqual({ color: 'rgb(249, 115, 22)', width: '2px' });
        } else await expect(pages).toBeHidden();
        expect(await header.locator('.header-action').evaluateAll(nodes => nodes.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width === 0 || rect.width >= 44 && rect.height >= 44 && getComputedStyle(node).display === 'flex';
        }))).toBe(true);
        expect(await header.evaluate(node => {
          const bounds = node.getBoundingClientRect();
          return node.scrollWidth <= node.clientWidth && [...node.querySelectorAll('button')].every(button => {
            const rect = button.getBoundingClientRect();
            return rect.width === 0 || rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
          });
        })).toBe(true);
        await system.click();
        const systemMenu = page.getByTestId('header-management-menu');
        await expect(systemMenu.getByRole('menuitem')).toHaveCount(2);
        await expect(systemMenu.getByRole('menuitemradio')).toHaveCount(0);
        await expect(systemMenu).not.toContainText(/系统管理|\bSystem\b|退出登录|Logout|Language|语言/);
        await page.keyboard.press('Escape'); await expect(systemMenu).toHaveCount(0); await expect(system).toBeFocused();
        await languages.tap();
        await expect(languageMenu).toBeVisible();
        await expect(languageMenu.getByRole('menuitemradio', { name: language === 'en' ? 'English' : '中文', exact: true })).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Escape'); await expect(languageMenu).toHaveCount(0); await expect(languages).toBeFocused();
        if (width === 320 || width === 667 || width === 1440) {
          await languages.evaluate(node => (node as HTMLElement).blur());
          await page.mouse.move(0, 100);
          await header.screenshot({ path: `${evidence}/${mode}-${language}-${width}.png` });
          if (width === 1440) {
            const bounds = (await header.boundingBox())!;
            const start = (await system.boundingBox())!.x;
            await page.screenshot({ path: `${evidence}/${mode}-${language}-desktop-tools.png`,
              clip: { x: start, y: bounds.y, width: bounds.width - start, height: bounds.height } });
          }
        }
      }
      // Touch devices do not apply hover styles. Check the mouse affordance separately.
      if (mode === 'plugin' && language === 'zh-CN') {
        const mouseContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
        const mousePage = await mouseContext.newPage();
        await mousePage.route('**/api/**', mockApi);
        await mousePage.goto(`${base}/#/routes`);
        const mouseTrigger = mousePage.locator('#header-menu-trigger');
        await mouseTrigger.hover();
        await expect.poll(() => mouseTrigger.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(26, 29, 36)');
        await mousePage.mouse.move(0, 100);
        await mouseContext.close();
      }
      await languages.focus(); await page.keyboard.press('Enter');
      await expect(languageMenu.getByRole('menuitemradio', { name: '中文', exact: true })).toBeFocused();
      const alternate = language === 'en' ? '中文' : 'English';
      const alternateCode = language === 'en' ? 'zh-CN' : 'en';
      await page.keyboard.press(language === 'en' ? 'Home' : 'End');
      await expect(languageMenu.getByRole('menuitemradio', { name: alternate, exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(languageMenu).toHaveCount(0); await expect(languages).toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem('locale'))).toBe(alternateCode);
      await page.reload();
      await expect(languages).toHaveAttribute('aria-label', alternateCode === 'en' ? 'Language' : '语言');
      await languages.click(); await languageMenu.getByRole('menuitemradio', { name: language === 'en' ? 'English' : '中文', exact: true }).click();
      await expect(languageMenu).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 900 });
      await pages.click(); await expect(sheet).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(sheet, `${mode}/${language}: close at desktop breakpoint`).toHaveCount(0);
      await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).overflow)).not.toBe('hidden');
      await page.setViewportSize({ width: 390, height: 900 });
      await languages.click(); await expect(languageMenu).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(languageMenu).toHaveCount(0);
      // The independent logout button still uses the application's existing confirmation.
      if (mode === 'plugin') {
        for (const width of [1440, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await logout.click();
          const confirmation = page.getByRole('dialog');
          await expect(confirmation).toBeVisible(); await expect(logout).toBeDisabled();
          expect(logoutCalls).toBe(0);
          await confirmation.getByTestId('confirmation-cancel').click();
          await expect(confirmation).toHaveCount(0); await expect(logout).toBeFocused();
          await expect(logout).toBeEnabled(); expect(logoutCalls).toBe(0);
        }
        await logout.click(); await page.getByTestId('confirmation-accept').click();
        await expect(header).toHaveCount(0); await expect(page.getByTestId('page-login')).toBeVisible();
        expect(logoutCalls).toBe(1);
      }
      await context.close();
    }
  }
  expect(errors).toEqual([]);
  console.log('Header actions passed: left navigation trigger/drawer, link/overlay/Escape dismissal and focus, breakpoint scroll unlock, independent administration/language/logout, two locales and auth modes, six widths, touch/keyboard locale changes, persistence, logout confirmation.');
} finally { await browser.close(); }
