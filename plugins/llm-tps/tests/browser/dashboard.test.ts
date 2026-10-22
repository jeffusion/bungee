import { test, expect as assert } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../../../../packages/ui/tests/helpers/dashboard/runtime';
import { connectDashboard } from '../../../../packages/ui/tests/helpers/dashboard/fixture';
import { menuSnapshot } from '../../../../packages/ui/tests/helpers/menus';
import { LAYOUT_KEY } from '../../../../packages/ui/src/components/dashboard/layout';

const runtime = dashboardRuntime();
const manifest = await Bun.file(new URL('../../manifest.json', import.meta.url)).json();

test('dashboard supplies endpoint configuration to TPS widgets and preserves navigation when menus overflow', () => runtime.run(async page => {
  const fixture = await connectDashboard(page);
  const overview = 'plugin:native:llm-tps:llm-tps-overview';
  const endpoints = 'plugin:native:llm-tps:llm-tps-endpoints';
  const models = 'plugin:native:llm-tps:llm-tps-models';
  await page.addInitScript(({ key, overview, endpoints, models }) => {
    localStorage.setItem('locale', 'zh-CN');
    const cards = [
      { id: 'kpi.rpm', x: 0, y: 0, w: 10, h: 4 },
      { id: 'kpi.success', x: 10, y: 0, w: 10, h: 4 },
      { id: 'kpi.latency', x: 20, y: 0, w: 10, h: 4 },
      { id: overview, x: 0, y: 4, w: 10, h: 4, pluginName: 'llm-tps' },
      { id: 'chart.upstreams', x: 10, y: 4, w: 20, h: 6 },
      { id: endpoints, x: 0, y: 10, w: 15, h: 10, pluginName: 'llm-tps' },
      { id: models, x: 15, y: 10, w: 15, h: 10, pluginName: 'llm-tps' },
    ];
    localStorage.setItem(key, JSON.stringify({ version: 5, cards, mobile: cards.map(card => ({ id: card.id, height: 'standard' })) }));
  }, { key: LAYOUT_KEY, overview, endpoints, models });
  await page.route('**/api/plugins', route => route.fulfill({ json: [{ name: 'llm-tps', enabled: true,
    metadata: { ...manifest.metadata, contributes: manifest.contributes } }] }));
  await page.route('**/api/plugin-translations', route => route.fulfill({ json: Object.fromEntries(
    Object.entries(manifest.translations).map(([language, messages]) => [language, { plugins: { 'llm-tps': messages } }])) }));
  const menus = menuSnapshot();
  for (const [index, label] of ['访问控制', 'TOKEN预算', 'TOKEN统计', '用户管理', '用户信息'].entries()) {
    const id = `plugin:fixture:${index}`;
    menus.catalog.push({ id, label, href: `/#/extensions/fixture/${index}`, source: 'plugin', pluginName: 'fixture', defaultIcon: 'lucide:puzzle', available: true });
    menus.layout.push({ kind: 'page', pageId: id, visible: true });
  }
  await page.route('**/api/ui/menus', route => route.fulfill({ json: menus }));
  let reads = 0;
  await page.route('**/api/plugins/llm-tps/control/stats?*', route => {
    reads++;
    const total = { tps: 56.2, outputTokens: 16860, generationDurationMs: 300000, sampleCount: 30, estimatedSampleCount: 0 };
    return route.fulfill({ json: { range: new URL(route.request().url()).searchParams.get('range'), asOfMs: Date.now(),
      total, history: Array.from({ length: 12 }, (_, i) => ({ ...total, bucketStartMs: i * 60000, tps: [38,42,40,48,46,53,49,58,55,63,59,56.2][i]! })), reportingIncomplete: false, endpoints: [
        { ...total, routeId: 'route-0', endpointId: 'ep-0-0', tps: 64.8 },
        { ...total, routeId: 'route-1', endpointId: 'ep-1-0', tps: 56.2 },
        { ...total, routeId: 'route-2', endpointId: 'ep-2-0', tps: 42.1 },
      ], models: [
        { ...total, routeId: 'route-0', model: 'gpt-4.1-mini', tps: 94.6 },
        { ...total, routeId: 'route-1', model: 'gpt-4.1-mini', tps: 71.3 },
        { ...total, routeId: 'route-2', model: 'gemini-2.5-pro', tps: 63.8 },
      ] } });
  });
  await page.goto(`${runtime.origin}/#/`);
  const rows = page.getByTestId('tps-endpoint-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first().getByText('openai-pool.example.com', { exact: true })).toBeVisible();
  await expect(rows.first().getByText('/v1/chat/completions', { exact: true })).toBeVisible();
  await expect(page.getByTestId('tps-total-samples')).toBeVisible();
  await expect(page.getByTestId('tps-model-row')).toHaveCount(3);
  assert(reads).toBe(1);
  await page.setViewportSize({ width: 1304, height: 820 });
  await page.screenshot({ path: '/tmp/bungee-tps-redesign-wide.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 820 });
  const navigation = page.locator('#header-menu-trigger');
  await expect(navigation).toBeVisible();
  await page.screenshot({ path: '/tmp/bungee-tps-redesign-narrow.png', fullPage: true, animations: 'disabled' });
  await page.getByTestId('tps-endpoint-list').focus();
  await page.keyboard.press('End');
  await expect(rows.last()).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await navigation.click();
  await expect(page.getByTestId('header-menu').getByRole('link', { name: '用户管理', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/bungee-tps-redesign-menu.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('header-menu')).toHaveCount(0);
  fixture.network.assertSettled(); assert(fixture.pageErrors).toEqual([]);
}), 120_000);
