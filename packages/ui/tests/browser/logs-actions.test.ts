import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('logs actions', async () => {
const uiRuntime = await startUiRuntime();
try {
const baseUrl = uiRuntime.origin;
const browser = await chromium.launch({ headless: true });
try {
  for (const language of ['zh-CN', 'en']) {
    const text = await Bun.file(new URL(`../../src/i18n/locales/${language}.json`, import.meta.url)).json();
    for (const [width, height] of [[320, 568], [390, 600], [667, 375], [900, 480], [1440, 480]]) {
      const mobile = width < 768;
      const page = await browser.newPage({ viewport: { width, height }, locale: language, hasTouch: mobile, isMobile: mobile });
      const errors: string[] = []; const queries: URL[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
        retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
      const now = Date.now();
      const row = { id: 1, requestId: 'request', chainId: 'chain', method: 'POST', path: '/responses', status: 200,
        chainStatus: 200, chainTransportOutcome: 'completed', transportOutcome: 'completed', chainStartTs: now,
        timestamp: now, chainDurationMs: 3800, duration: 3800, chainEndTs: now, chainAttempts: 1, hasRetry: false, success: true };
      await page.addInitScript(language => { localStorage.setItem('locale', language); localStorage.setItem('logsAutoRefresh', 'true'); }, language);
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
        if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
        if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
        if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
        if (url.pathname === '/api/plugins') return route.fulfill({ json: [] });
        if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
        if (url.pathname === '/api/logs') { queries.push(url); return route.fulfill({ json: { data: [row], total: 1, totalPages: 1, page: 1, limit: 50 } }); }
        if (url.pathname === '/api/logs/export') return route.fulfill({ contentType: 'text/csv', body: 'requestId,status\nrequest,200\n' });
        return route.fulfill({ json: {} });
      });
      await page.goto(baseUrl + '/#/logs');
      await expect(page.getByTestId('logs-table-scroll')).toBeVisible();
      const trigger = page.getByRole('button', { name: mobile ? text.logs.actions : width < 1280 ? text.logs.filters : text.logs.moreFilters, exact: true });
      const triggerElement = await trigger.elementHandle();
      await trigger.click();
      const panel = mobile ? page.getByTestId('logs-mobile-actions') : page.getByRole('menu');
      await expect(panel).toBeVisible();
      await expect.poll(async () => {
        const bounds = await panel.boundingBox();
        return !!bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1;
      }).toBe(true);
      const time = panel.getByRole('combobox', { name: text.logs.timeRange, exact: true });
      await time.click(); await page.getByRole('option', { name: text.logs.customTime, exact: true }).click();
      await expect(panel).toBeVisible();
      await expect(panel.locator('input[type="datetime-local"]')).toHaveCount(2);
      const scroller = mobile ? page.getByTestId('logs-mobile-actions-scroll') : panel;
      const scrollable = await scroller.evaluate(node => ({ overflow: getComputedStyle(node).overflowY, required: node.scrollHeight > node.clientHeight }));
      expect(scrollable.overflow).toBe('auto');
      if (height <= 480) expect(scrollable.required).toBe(true);
      if (scrollable.required) {
        await expect(page.getByRole('listbox')).toHaveCount(0);
        await scroller.hover(); await page.mouse.wheel(0, 400);
        await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      }
      if (mobile) {
        await expect(panel.getByRole('switch',{name:text.logs.autoRefresh,exact:true})).toBeChecked();
        await expect(panel.getByText(text.logs.autoRefresh,{exact:true})).toHaveCount(1);
        const footer = page.getByTestId('logs-mobile-actions-footer');
        const before = await footer.boundingBox();
        await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
        const after = await footer.boundingBox();
        expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
        expect(after!.y + after!.height).toBeLessThanOrEqual(height + 1);
        if (scrollable.required) expect(await scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await footer.getByRole('button', { name: text.logs.resetFilters, exact: true }).click();
        await expect(panel.locator('input[type="datetime-local"]')).toHaveCount(0);
        await expect(panel.getByRole('switch',{name:text.logs.autoRefresh,exact:true})).toBeChecked();
        expect(await page.evaluate(()=>localStorage.getItem('logsAutoRefresh'))).toBe('true');
        await expect.poll(() => queries.at(-1)?.searchParams.has('startTime')).toBe(true);
        await expect(footer.getByRole('button', { name: text.common.refresh, exact: true })).toBeEnabled();
        await footer.getByRole('button', { name: text.common.refresh, exact: true }).click();
        await expect(panel).toBeVisible();
        const [download] = await Promise.all([page.waitForEvent('download'), footer.getByRole('button', { name: 'CSV', exact: true }).click()]);
        expect(download.suggestedFilename()).toMatch(/\.csv$/);
        if (language === 'zh-CN' && width === 390) await page.screenshot({ path: '/tmp/bungee-logs-actions-mobile.png' });
      } else {
        await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect.poll(async () => { const bounds = await panel.boundingBox(); return bounds!.y >= -1 && bounds!.y + bounds!.height <= height + 1; }).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      expect(await triggerElement!.evaluate(node => document.activeElement === node)).toBe(true);
      expect(errors).toEqual([]);
      await page.close();
      console.log(`Logs actions passed: ${language} ${width}x${height}`);
    }
  }
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
