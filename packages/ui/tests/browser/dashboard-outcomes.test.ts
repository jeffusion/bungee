import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { LAYOUT_KEY } from '../../src/components/dashboard/layout';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { dashboardSample, historySample, upstreamSample, emptyHttp, emptyTransport } from '../helpers/dashboard/stats';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
for (const scenario of ['mixed', 'cancelled', 'unknown'] as const) test(`Dashboard applies ${scenario} outcome response independently`, () => runtime.run(async page => {
 const fixture = await connectDashboard(page);
 const { card } = fixture;
 const endTime = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
 const ids = ['kpi.requests', 'kpi.success', 'chart.success', 'chart.errors', 'chart.upstreams', 'chart.failures', 'chart.status'];
 await page.addInitScript(({ key, ids }) => {
  const cards = ids.map((id, index) => ({ id, x: index % 2 * 15, y: Math.floor(index / 2) * 8, w: 15, h: 8 }));
  localStorage.setItem(key, JSON.stringify({ version: 5, cards, mobile: cards.map(({ id }) => ({ id, height: 'standard' })) }));
 }, { key: LAYOUT_KEY, ids });
 await page.route('**/api/stats/dashboard?*', route => {
  if (route.request().method() !== 'GET') throw new Error('Dashboard stats must use GET');
      const mixed = scenario === 'mixed';
      const sample = {
        requestCounts: mixed ? { success: 2, failed: 2 } : { success: 0, failed: 0 },
        transportCounts: mixed ? { completed: 3, failed: 1, cancelled: 2, pending: 1, unknown: 1 }
          : { ...emptyTransport(), [scenario]: 2 },
        httpStatusCounts: { ...emptyHttp(), status2xx: mixed ? 5 : 2, status5xx: mixed ? 3 : 0 },
        successRequests: scenario === 'unknown' ? 2 : mixed ? 2 : 0,
        failedRequests: scenario === 'unknown' ? 0 : mixed ? 6 : 2,
      };
      const history = historySample([
        { requestCounts: { success: 0, failed: 0 }, httpStatusCounts: emptyHttp(), transportCounts: emptyTransport(),
          successRequests: 0, failedRequests: 0, timestamp: endTime - 150_000, responseTime: 0 },
        { ...sample, timestamp: endTime - 90_000, responseTime: 80 },
      ]);
      return route.fulfill({ json: dashboardSample('1h', endTime, history, [upstreamSample('http://upstream.example', sample, mixed ? 3 : scenario === 'cancelled' ? 2 : 0)]) });

 });
 const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/stats/dashboard');
 await page.goto(runtime.origin); await applied;
 await expect(card('kpi.requests').locator('.kpi-value')).toHaveText(scenario === 'mixed' ? '8' : '2');
 if (scenario === 'mixed') {
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

 } else {
  await expect(card('kpi.success').locator('.kpi-value')).toHaveText('—');
  await expect(card('chart.failures').getByRole('meter')).toHaveCount(0);
  await expect(card('chart.errors')).not.toContainText('100.00%');
 }
 await expect(card('chart.success').locator('canvas')).toBeVisible();
 await expect(card('chart.errors').locator('canvas')).toBeVisible();
 fixture.network.assertSettled(); expect(fixture.pageErrors).toEqual([]);
}), 60_000);
