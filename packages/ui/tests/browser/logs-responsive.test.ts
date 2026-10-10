import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('logs responsive', async () => {
const uiRuntime = await startUiRuntime();
try {
const baseUrl = uiRuntime.origin;
const browser = await chromium.launch({ headless: true });
try {
  for (const language of ['zh-CN', 'en']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: language, isMobile: true, hasTouch: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
      retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
    const now = Date.now();
    const rows = ['pending', 'completed', 'failed', 'cancelled', 'unknown'].map((outcome, index) => ({
      id: index, requestId: `request-${index}`, chainId: `chain-${index}`, method: 'POST',
      path: '/responses/' + 'very-long-request-path/'.repeat(10), chainStatus: 200, status: 200,
      chainTransportOutcome: outcome, transportOutcome: outcome, chainStartTs: now - index * 60_000,
      timestamp: now - index * 60_000, chainDurationMs: 3800 + index * 30_000, duration: 3800,
      chainEndTs: now, chainAttempts: index === 0 ? 3 : 1, hasRetry: index === 0,
      upstream: 'https://chatgpt.com/' + 'very-long-upstream-path/'.repeat(10), success: true, authSuccess: true,
    }));
    await page.addInitScript(language => { localStorage.setItem('locale', language); localStorage.setItem('logsAutoRefresh', 'true'); }, language);
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
      if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
      if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
      if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
      if (url.pathname === '/api/plugins') return route.fulfill({ json: [] });
      if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
      if (url.pathname === '/api/logs') return route.fulfill({ json: { data: rows, total: rows.length, totalPages: 1, page: 1, limit: 50 } });
      if (url.pathname === '/api/logs/chain/chain-0') return route.fulfill({ json: { chain: rows[0], attempts: [rows[0]] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(baseUrl + '/#/logs');
    const pageRoot = page.getByTestId('page-logs');
    const scroller = page.getByTestId('logs-table-scroll');
    await expect(scroller.locator('tbody tr')).toHaveCount(5);
    for (const width of [320, 390, 640, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const geometry = await scroller.evaluate(node => ({
        scrolls: node.scrollWidth > node.clientWidth,
        tableWidth: node.querySelector('table')!.getBoundingClientRect().width,
        wraps: [...node.querySelectorAll('th, td')].some(cell => getComputedStyle(cell).whiteSpace !== 'nowrap'),
        headerHeight: node.querySelector('thead tr')!.getBoundingClientRect().height,
        rowHeights: [...node.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height),
        headersFit: [...node.querySelectorAll('th')].every(cell => {
          const range = document.createRange(); range.selectNodeContents(cell);
          const text = range.getBoundingClientRect(); const box = cell.getBoundingClientRect();
          const style = getComputedStyle(cell);
          return text.left >= box.left + parseFloat(style.paddingLeft) - 1
            && text.right <= box.right - parseFloat(style.paddingRight) + 1;
        }),
        badgesFit: [...node.querySelectorAll('tbody tr td:nth-child(5) span')].every(badge => {
          const box = badge.getBoundingClientRect(); const cell = badge.parentElement!.getBoundingClientRect();
          return box.height <= 28 && box.left >= cell.left && box.right <= cell.right;
        }),
      }));
      console.log(language, width, JSON.stringify(geometry));
      expect(geometry.wraps).toBe(false); expect(geometry.headersFit).toBe(true); expect(geometry.badgesFit).toBe(true);
      expect(geometry.headerHeight).toBeLessThan(43);
      expect(Math.max(...geometry.rowHeights)).toBeLessThan(55);
      if (width < 1120) expect(geometry.scrolls).toBe(true);
      await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      const detail = scroller.locator('tbody tr').first().getByRole('button');
      await expect(detail).toBeVisible(); expect(await detail.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
      await scroller.evaluate(node => { node.scrollLeft = 0; });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (language === 'zh-CN') {
      await scroller.evaluate(node => { node.scrollLeft = 480; });
      await page.screenshot({ path: '/tmp/bungee-logs-mobile-390.png' });
      await scroller.evaluate(node => { node.scrollLeft = 0; });
    }
    const actionName = language === 'zh-CN' ? '操作' : 'Actions';
    const action = pageRoot.getByRole('button', { name: actionName, exact: true });
    await expect(action).toBeVisible();
    await expect(action.locator('.nx-pill-accent')).toHaveCount(0);
    await expect(action.locator('span')).toHaveCount(0);
    await page.getByTestId('logs-filter-path-input').fill('test');
    const filteredAction = pageRoot.getByRole('button', { name: `${actionName} 1`, exact: true });
    await expect(filteredAction).toBeVisible(); await expect(filteredAction.locator('.nx-feature-tag')).toHaveText('1');
    await filteredAction.click();
    const menu = page.getByTestId('logs-mobile-actions'); await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.getByTestId('logs-filter-path-input').fill('');
    await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await scroller.locator('tbody tr').first().getByRole('button').click();
    await expect(page.getByTestId('chain-detail-modal')).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log('Logs responsive browser checks passed: 6 widths, 2 languages, single-line columns, contained scrolling, visible details and filter count.');
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
