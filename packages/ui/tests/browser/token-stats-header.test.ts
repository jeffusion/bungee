import { test as browserTest } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardSample, historySample } from '../helpers/dashboard/stats';
import type { TimeRange } from '../../src/types';
import { observeNetwork } from '../helpers/dashboard/network';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { tokenStatsWindow } from '../../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../../core/src/plugin.types';
import { tokenMenuSnapshot } from '../helpers/dashboard/fixture';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
const uiRuntime = dashboardRuntime();
import { fulfillMenuIcons } from '../helpers/menus';

browserTest('Token header navigation and incomplete usage remain compact', () => uiRuntime.run(async page => {
const baseUrl = uiRuntime.origin;
const manifest = await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = runtime.config.logical_configuration;
logical.services = [{ id: 'service-test', position: 0, name: 'test-service',
  endpoints: [{ id: 'endpoint-test', position: 0, target: 'https://example.com', weight: 100, priority: 1, is_disabled: false, plugins: [] }], plugins: [] }];
logical.routes = [{ id: 'route-test', position: 0, path: '/test', service_id: 'service-test', plugins: [] }];
const errors: string[] = [];
  observeNetwork(page, errors);
page.on('pageerror', error => errors.push(error.message));
await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET') throw new Error(`Unexpected method: ${route.request().method()} ${url.pathname}`);
  const json = (value: unknown) => route.fulfill({ json: value });
  if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
  if (url.pathname === '/api/config/runtime') return json(runtime);
  if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
  if (url.pathname === '/api/resources/api-key') return json({ keys: [] });
  if (url.pathname === '/api/plugins/schemas') return json({});
  if (url.pathname === '/api/plugins') return json([
    { name: 'token-stats', enabled: true, runtimeScope: 'global', metadata: {
      ...manifest.metadata, contributes: manifest.contributes } },
  ]);
  if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(
    Object.entries(manifest.translations).map(([language, messages]) => [language, { plugins: { 'token-stats': messages } }])));
  if (url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1',
    generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 },
    workers: { observed: [], missing: [] }, upstreams: [] });
  if (url.pathname === '/api/stats/dashboard') return json(dashboardSample((url.searchParams.get('range') ?? '1h') as TimeRange, Date.now(), historySample([])));
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
  if (url.pathname === '/api/ui/menus') return json(tokenMenuSnapshot());
  if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
  throw new Error(`Unexpected API: ${route.request().method()} ${url.pathname}`);
});

  await page.goto(baseUrl);
  const trendCard = page.locator('[data-card-id="plugin:native:token-stats:token-stats-time"]');
  const overview = page.getByTestId('token-stats-overview');
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.3K');
  await expect(overview).not.toContainText(/含估算|用量记录丢失/);
  await expect(page.getByTestId('app-header').getByRole('link', { name: 'Token统计', exact: true })).toBeVisible();
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.locator(`${width < 768 ? '.dashboard-mobile-card' : '.grid-stack-item'}[data-card-id="plugin:native:token-stats:token-stats-time"]`)
      .waitFor({ state: 'visible' });
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
    await expect.poll(() => link.evaluate(node => node.getBoundingClientRect().height
      - Number.parseFloat(getComputedStyle(node).lineHeight)),
      { message: `The statistics link stays on one line at ${width}px` }).toBeLessThanOrEqual(1);
  }
  await trendCard.locator('header').getByRole('link', { name: '查看模型统计' }).click();
  await expect(page.getByTestId('token-stats-page-summary')).toBeVisible();
  await expect(page.getByTestId('token-stats-page')).not.toContainText(/含估算|用量记录丢失/);

  expect(errors).toEqual([]);
}), 120_000);
