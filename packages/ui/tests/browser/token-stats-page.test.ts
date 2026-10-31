import { systemUpdateStatusFixture } from '../helpers/system-updates';
import { serviceReference } from '../helpers/service-references';
import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardSample, historySample } from '../helpers/dashboard/stats';
import type { TimeRange } from '../../src/types';
import { observeNetwork } from '../helpers/dashboard/network';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { tokenStatsWindow } from '../../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../../core/src/plugin.types';
import { tokenMenuSnapshot, connectDashboard } from '../helpers/dashboard/fixture';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { fulfillMenuIcons } from '../helpers/menus';
const runtime = dashboardRuntime();

test('Token statistics query ranges, model sorting and refresh failures recover independently', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { tokenManifest, nativeRequests, pageErrors } = fixture;

    await page.goto(`${runtime.origin}/#/extensions/token-stats${tokenManifest.contributes.navigation[0].path}`);
    await expect(page.getByTestId('token-stats-page')).toBeVisible();
    const rangeSelect = page.getByRole('combobox', { name: '时间范围' });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    await expect(refresh).toBeEnabled();

    await rangeSelect.click();

    await page.keyboard.press('Escape');
    for (const [label, range] of [
      ['本日', 'day'], ['最近7天', '7d'], ['最近30天', '30d'],
      ['本周', 'week'], ['本月', 'month'], ['最近1天', '1d'],
    ] as const) {
      await rangeSelect.click();
      await page.getByRole('option', { name: label, exact: true }).click();

      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=model'))).toBe(true);
      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=time'))).toBe(true);
      await expect(refresh).toBeEnabled();
    }
    for (const calendarRange of ['day', 'week', 'month']) {
      expect(nativeRequests.some(query => query.includes(`range=${calendarRange}`) && query.includes('timeZone=Asia%2FShanghai'))).toBe(true);
    }

    await expect(page.getByRole('radio', { name: 'Token', exact: true })).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-11');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-0');
    await page.getByRole('radio', { name: 'Token', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索模型' }).fill('model-11');
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(1);
    await page.getByRole('textbox', { name: '搜索模型' }).fill('');

    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);

    fixture.nativeFailure = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    fixture.nativeFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}, { viewport: { width: 390, height: 844 } }), 120_000);

test('native Token host isolates plugin ownership and shares the selected range', () => runtime.run(async page => {
  const fixture = await connectDashboard(page, true);
  const { nativeRequests, pageErrors } = fixture;
  await page.goto(runtime.origin);
  const overview = page.getByTestId('token-stats-overview');
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-card-id^="plugin:native:intruder:"]')).toHaveCount(0);
  expect(nativeRequests).toHaveLength(1);
  expect(nativeRequests.every(query => query.includes('range=1h'))).toBe(true);
  expect(nativeRequests.some(query => query.includes('groupBy=model'))).toBe(false);

  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/plugins/token-stats/control/stats');
  await page.getByRole('radio', { name: '12h', exact: true }).click();
  await (await refreshed).finished();
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  expect(nativeRequests.some(query => query.includes('range=12h'))).toBe(true);
  expect(nativeRequests.some(query => query.includes('groupBy=model'))).toBe(false);
  fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);

test('Token navigation opens current usage statistics', () => runtime.run(async page => {
const baseUrl = runtime.origin;
const manifest = await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const configurationRuntime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = configurationRuntime.config.logical_configuration;
logical.services = [{ id: 'service-test', position: 0, name: 'test-service',
  endpoints: [{ id: 'endpoint-test', position: 0, target: 'https://example.com', weight: 100, priority: 1, is_disabled: false, plugins: [] }], plugins: [] }];
logical.routes = [{ id: 'route-test', position: 0, path: '/test', service_references: [serviceReference('service-test')], plugins: [] }];
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
  if (url.pathname === '/api/config/runtime') return json(configurationRuntime);
  if (url.pathname === '/api/config') return json({ revision: 1, content_hash: configurationRuntime.content_hash, config: configurationRuntime.config });
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
  if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
  if (url.pathname === '/api/ui/menus') return json(tokenMenuSnapshot());
  if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
  throw new Error(`Unexpected API: ${route.request().method()} ${url.pathname}`);
});

  await page.goto(baseUrl);
  const trendCard = page.locator('[data-card-id="plugin:native:token-stats:token-stats-time"]');
  const overview = page.getByTestId('token-stats-overview');
  await expect(overview).toBeVisible();

  await expect(page.getByTestId('app-header').getByRole('link', { name: 'Token统计', exact: true })).toBeVisible();
  await trendCard.locator('header').getByRole('link', { name: '查看模型统计' }).click();
  await expect(page.getByTestId('token-stats-page-summary')).toBeVisible();

  expect(errors).toEqual([]);
}), 120_000);
