import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';
import { tokenStatsWindow } from '../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../core/src/plugin.types';

const baseUrl = process.env.DASHBOARD_BASE_URL ?? 'http://127.0.0.1:5185';
const manifest = await Bun.file(new URL('../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = runtime.config.logical_configuration;
logical.services = [{ id: 'service-test', position: 0, name: 'test-service',
  endpoints: [{ id: 'endpoint-test', position: 0, url: 'https://example.com', plugins: [] }], plugins: [] }];
logical.routes = [{ id: 'route-test', position: 0, path: '/test', service_id: 'service-test', plugins: [] }];
const schemas = Object.fromEntries(['alpha', 'beta'].map(name => [name, {
  name, version: '1.0.0', runtimeScope: 'scoped', metadata: { name }, configSchema: [],
}]));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 },
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = (value: unknown) => route.fulfill({ json: value });
  if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
  if (url.pathname === '/api/config/runtime') return json(runtime);
  if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
  if (url.pathname === '/api/resources/api-key') return json({ keys: [] });
  if (url.pathname === '/api/plugins/schemas') return json(schemas);
  if (url.pathname === '/api/plugins') return json([
    { name: 'token-stats', enabled: true, runtimeScope: 'global', metadata: {
      ...manifest.metadata, contributes: manifest.contributes } },
    ...Object.values(schemas).map(schema => ({ ...schema, enabled: true })),
  ]);
  if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(
    Object.entries(manifest.translations).map(([language, messages]) => [language, { plugins: { 'token-stats': messages } }])));
  if (url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1',
    generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 },
    workers: { observed: [], missing: [] }, upstreams: [] });
  if (url.pathname === '/api/stats/dashboard') return json({ range: '1h', startTime: Date.now() - 3_600_000,
    endTime: Date.now(), history: { timestamps: [], requests: [], errors: [], responseTime: [],
      requestCounts: { success: [], failed: [] } }, upstreams: [], requestCounts: { success: 0, failed: 0 } });
  if (url.pathname === '/api/plugins/token-stats/control/stats') {
    const asOfMs = Date.now();
    const window = tokenStatsWindow((url.searchParams.get('range') ?? '1h') as TokenStatsRange,
      asOfMs, url.searchParams.get('timeZone') ?? 'UTC');
    return json({ ...window, asOfMs, logicalRequests: 1, upstreamAttempts: 1,
      totalInputTokens: 1200, totalOutputTokens: 600, estimatedInputTokens: 100, estimatedOutputTokens: 50,
      estimatedCostUsd: 0.078, reportingIncomplete: true,
      authorityBreakdown: { input: { official: 1, local: 1 }, output: { official: 1, local: 1 } },
      data: [{ dimension: 'test-model', bucketStartMs: Math.floor(asOfMs / window.bucketMs) * window.bucketMs,
        officialInputTokens: 1200, officialOutputTokens: 600, logicalRequests: 1, upstreamAttempts: 1,
        authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } }] });
  }
  return json({});
});

try {
  await page.goto(baseUrl);
  const trendCard = page.locator('[data-card-id="plugin:native:token-stats:token-stats-time"]');
  const overview = page.getByTestId('token-stats-overview');
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.3K');
  await expect(overview).not.toContainText(/含估算|用量记录丢失/);
  await expect(page.getByTestId('app-header').getByRole('link', { name: 'Token统计', exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1080 });
    const header = trendCard.locator('header');
    const link = header.getByRole('link', { name: '查看模型统计' });
    await expect(link).toBeVisible();
    await expect(trendCard.locator('.dashboard-card-body a')).toHaveCount(0);
    await expect.poll(() => header.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return [...node.querySelectorAll('a, button, [data-testid="native-widget-summary"], .nx-panel-head-title')].every(item => {
        const rect = item.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
    })).toBe(true);
    expect(await link.evaluate(node => node.getBoundingClientRect().height
      <= Number.parseFloat(getComputedStyle(node).lineHeight) + 1)).toBe(true);
  }
  await trendCard.locator('header').getByRole('link', { name: '查看模型统计' }).click();
  await expect(page.getByTestId('token-stats-page-summary')).toBeVisible();
  await expect(page.getByTestId('token-stats-page')).not.toContainText(/含估算|用量记录丢失/);

  await page.setViewportSize({ width: 1440, height: 1080 });
  for (const editor of ['/routes/new', '/routes/edit/%2Ftest', '/services/new', '/services/edit/test-service']) {
    await page.goto(`${baseUrl}/#${editor}`);
    await page.locator('aside button[data-testid$="-plugins"]').click();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const select = dialog.getByRole('combobox');
    for (const [name, keyboard] of [['alpha', false], ['beta', true], ['beta', false]] as const) {
      await select.click();
      await expect(page.getByRole('option', { name: `${name} (v1.0.0)`, exact: true })).toBeVisible();
      if (keyboard) {
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
      } else {
        await page.getByRole('option', { name: `${name} (v1.0.0)`, exact: true }).click();
      }
      await expect(select).toContainText(name);
      await expect(select).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(dialog).toBeVisible();
    }
    await dialog.getByTestId('plugin-config-save-button').click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
    await expect(dialog.getByRole('combobox')).toBeDisabled();
    await expect(dialog.getByRole('combobox')).toContainText('beta');
    await dialog.getByTestId('plugin-config-save-button').click();
    await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  console.log('UI adjustments passed: header fits at 320/390/768/1024/1440px, hints removed with estimated/incomplete data, menu spacing, mouse/keyboard/reselection closes plugin dropdown in route/service create/edit pages.');
} finally {
  await browser.close();
}
