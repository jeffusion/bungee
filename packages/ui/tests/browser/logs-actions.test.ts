import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import {collectApiEvidence} from '../helpers/editors/api-evidence';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('logs actions', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
try {
const baseUrl = uiRuntime.origin;
const browser = await chromium.launch({ headless: true });
try {
  {
    const language = 'zh-CN';
    const text = await Bun.file(new URL(`../../src/i18n/locales/${language}.json`, import.meta.url)).json();
    for (const width of [390, 1100]) {
      const height = 900;
      const mobile = width < 768;
      const context = await browser.newContext({ viewport: { width, height }, locale: language, hasTouch: mobile, isMobile: mobile });
      try {
      const page = await context.newPage();
      const evidence=collectApiEvidence(page),errors=evidence.errors; const queries: URL[] = [];
      const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
        retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
      const now = Date.now();
      const row = { id: 1, requestId: 'request', chainId: 'chain', method: 'POST', path: '/responses', status: 200,
        chainStatus: 200, chainTransportOutcome: 'completed', transportOutcome: 'completed', chainStartTs: now,
        timestamp: now, chainDurationMs: 3800, duration: 3800, chainEndTs: now, chainAttempts: 1, hasRetry: false, success: true };
      await page.addInitScript(language => { localStorage.setItem('locale', language); localStorage.setItem('logsAutoRefresh', 'true'); }, language);
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET') { errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`); return route.fulfill({status: 500, json: {error: 'unexpected_method'}}); }
        if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
        if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
        if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
        if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
        if (url.pathname === '/api/plugins') return route.fulfill({ json: [] });
        if (url.pathname === '/api/ui/menus') {
          // Log panel bounds use a compact user layout, independently of header overflow.
          const snapshot = menuSnapshot();
          return route.fulfill({ json: { ...snapshot, layout: [{ kind: 'group', id: 'group:pages', title: 'Pages', visible: true,
            children: snapshot.catalog.map(page => ({ kind: 'page', pageId: page.id, visible: true })) }] } });
        }
        if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
        if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
        if (url.pathname === '/api/logs') { queries.push(url); return route.fulfill({ json: { data: [row], total: 1, totalPages: 1, page: 1, limit: 50 } }); }
        if (url.pathname === '/api/logs/export') return route.fulfill({ contentType: 'text/csv', body: 'requestId,status\nrequest,200\n' });
        if (url.pathname === '/api/plugin-translations') return route.fulfill({ json: {} });
        if (url.pathname === '/api/logs/cleanup/config') return route.fulfill({ json: { enabled: false, retentionDays: 1, scheduleIntervalHours: 1, isActive: false } });
        errors.push(`Unexpected API GET ${url.pathname}`);
        return route.fulfill({ status: 500, json: {error: 'unexpected_request'} });
      });
      await page.goto(baseUrl + '/#/logs');
      await expect(page.getByTestId('logs-table-scroll')).toBeVisible();
      const trigger = page.getByRole('button', { name: mobile ? text.logs.actions : text.logs.moreFilters, exact: true });
      const triggerNode=await trigger.elementHandle();
      try {
      await trigger.click();
      const panel = mobile ? page.getByTestId('logs-mobile-actions') : page.getByRole('menu');
      await expect(panel).toBeVisible();

      const time = panel.getByRole('combobox', { name: text.logs.timeRange, exact: true });
      await time.click(); await page.getByRole('option', { name: text.logs.customTime, exact: true }).click();
      await expect(panel).toBeVisible();
      await expect(panel.locator('input[type="datetime-local"]')).toHaveCount(2);
      if (mobile) {
        await expect(panel.getByRole('switch',{name:text.logs.autoRefresh,exact:true})).toBeChecked();
        await expect(panel.getByText(text.logs.autoRefresh,{exact:true})).toHaveCount(1);
        const footer = page.getByTestId('logs-mobile-actions-footer');
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
      }
      if (mobile) await panel.getByRole('button', { name: text.common.close, exact: true }).click();
      else await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);

      expect(errors).toEqual([]); evidence.verify();
      } finally { await triggerNode?.dispose(); }
       } finally { await context.close(); }

    }
  }
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
