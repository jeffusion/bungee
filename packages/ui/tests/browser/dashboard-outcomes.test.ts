import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { LAYOUT_KEY } from '../../src/components/dashboard/layout';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('dashboard outcomes', async () => {
const uiRuntime = await startUiRuntime();
try {
// Exercise the production bundle as well as dev builds; no Vite-only module imports.
const baseUrl = uiRuntime.origin;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let scenario: 'mixed' | 'cancelled' | 'unknown' = 'mixed';
  const endTime = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
    retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
  const ids = ['kpi.requests', 'kpi.success', 'chart.success', 'chart.errors', 'chart.upstreams', 'chart.failures', 'chart.status'];
  await page.addInitScript(({ key, ids }) => {
    const cards = ids.map((id, index) => ({ id, x: index % 2 * 15, y: Math.floor(index / 2) * 8, w: 15, h: 8 }));
    localStorage.setItem(key, JSON.stringify({ version: 5, cards, mobile: cards.map(({ id }) => ({ id, height: 'standard' })) }));
  }, { key: LAYOUT_KEY, ids });
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
    if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
    if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
    if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
    if (url.pathname === '/api/plugins') return route.fulfill({ json: [] });
    if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
    if (url.pathname === '/api/runtime/upstreams') return route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] } });
    if (url.pathname === '/api/stats/dashboard') {
      const mixed = scenario === 'mixed';
      const requestCounts = scenario === 'unknown' ? undefined : mixed ? { success: 2, failed: 2 } : { success: 0, failed: 0 };
      const totalRequests = mixed ? 8 : 2;
      const transportCounts = mixed ? { completed: 3, failed: 1, cancelled: 2, pending: 1, unknown: 1 }
        : { completed: 0, failed: 0, cancelled: scenario === 'cancelled' ? 2 : 0, pending: 0, unknown: scenario === 'unknown' ? 2 : 0 };
      const httpStatusCounts = { status2xx: mixed ? 5 : 2, status3xx: 0, status4xx: 0, status5xx: mixed ? 3 : 0, statusOther: 0 };
      return route.fulfill({ json: { startTime: endTime - 3_600_000, endTime, range: '1h', requestCounts, transportCounts, httpStatusCounts,
        units: { history: 'request_chain', upstreams: 'upstream_attempt' },
        history: { timestamps: [endTime - 150_000, endTime - 90_000].map(time => new Date(time).toISOString()),
          requests: [0, totalRequests], errors: [0, totalRequests], responseTime: [0, 80], successRate: [100, 99], failureRate: [0, 100],
          requestCounts: requestCounts && { success: [0, requestCounts.success], failed: [0, requestCounts.failed] } },
        upstreams: [{ upstream: 'http://upstream.example', totalRequests, count: totalRequests, percentage: 100,
          successRequests: 0, failedRequests: totalRequests, successRate: 99, failureRate: 100, failed2xx: totalRequests,
          ...httpStatusCounts, requestCounts, httpStatusCounts, transportCounts }],
      } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(baseUrl);
  await expect(page.getByTestId('page-dashboard')).toBeVisible().catch(async error => { console.error('Browser errors:', errors); console.error('Page text:', await page.locator('body').innerText()); throw error; });
  const card = (id: string) => page.locator(`[data-card-id="${id}"]`);
  await expect(card('kpi.success')).toContainText('请求成功率');
  await expect(card('kpi.success').locator('.kpi-value')).toHaveText('50.0');
  await expect(card('kpi.requests').locator('.kpi-value')).toHaveText('8');
  await expect(card('chart.errors')).toContainText('失败率 50.00%');
  await expect(card('chart.failures').getByRole('meter')).toHaveAttribute('aria-valuenow', '2');
  await expect(card('chart.upstreams')).toContainText('成功请求 2 · 50.00%');
  await expect(card('chart.upstreams')).toContainText('失败请求 2 · 50.00%');
  await expect(card('chart.status')).not.toContainText(/成功请求|失败请求|已取消|传输/);
  await expect(page.getByTestId('dashboard-board')).not.toContainText(/服务未提供|HTTP 2xx 占比|进行中|已取消|未知/);
  await expect(page.getByTestId('upstream-transport-summary')).toHaveCount(0);
  for (const mode of ['cancelled', 'unknown'] as const) {
    scenario = mode;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('—');
    await expect(card('chart.failures').getByRole('meter')).toHaveCount(0);
    await expect(card('chart.errors')).not.toContainText('100.00%');
  }
  scenario = 'mixed';
  await page.getByRole('button', { name: '立即刷新', exact: true }).click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('50.0');
    await expect(card('chart.success').locator('canvas')).toBeVisible();
    await expect(card('chart.errors').locator('canvas')).toBeVisible();
  }
  expect(errors).toEqual([]);
  console.log('Dashboard outcome browser checks passed: joint success/failure, cancellation, unknown, concise cards, 3 viewport widths.');
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
