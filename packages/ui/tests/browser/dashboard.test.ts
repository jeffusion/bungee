import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { LAYOUT_KEY, COARSE_LAYOUT_KEY, PREVIOUS_LAYOUT_KEY, LEGACY_LAYOUT_KEY } from '../../src/components/dashboard/layout';
import * as fs from 'node:fs';
import { tokenStatsWindow } from '../../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../../core/src/plugin.types';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('dashboard', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
try {
const baseUrl = uiRuntime.origin;
const evidence = process.env.DASHBOARD_EVIDENCE_DIR ?? '/tmp/bungee-dashboard-evidence';
const previewOnly = false;
const nativeOnly = true;
const tokenManifest = nativeOnly ? await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json() : null;
const modelsDevManifest = nativeOnly ? await Bun.file(new URL('../../../../plugins/models-dev/manifest.json', import.meta.url)).json() : null;
fs.mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', error => pageErrors.push(error.message));
let historyCalls = 0, historyFailure = false, disabledPlugin = false, nativeFailure = false;
let nativeInput = 1200, nativeOutput = 600, nativeCost = 0.078;
let nativeLargeNumbers = false;
let nativeLimitedModels = false;
page.on('console', message => {
  // The error-recovery case deliberately returns an HTTP 503.
  if (message.type() === 'error' && !historyFailure && !nativeFailure) pageErrors.push(message.text());
});
page.on('requestfailed', request => {
  const reason = request.failure()?.errorText ?? 'unknown';
  if (!reason.includes('ERR_ABORTED')) pageErrors.push(`Network request failed: ${request.url()} (${reason})`);
});
const nativeRequests: string[] = [];
const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = config.config.logical_configuration as any;
logical.services = ['openai-pool', 'anthropic-pool', 'gemini-pool', 'billing-api'].map((name, i) => ({ id: `service-${i}`, position: i, name,
  endpoints: Array.from({ length: i === 0 ? 3 : 2 }, (_, j) => ({ id: `ep-${i}-${j}`, position: j, url: `https://${name}.example.com`, weight: 1, priority: 0, is_disabled: false, plugins: [] })), plugins: [] }));
logical.routes = ['/v1/chat/completions', '/v1/messages', '/v1beta/models', '/api/billing'].map((path, i) => ({ id: `route-${i}`, position: i, path, service_id: `service-${i}`, plugins: [] }));
const requestCounts = [30,31,32,33,34,35,36,35,34,33,31,25];
const errors = [0,0,0,1,1,0,0,1,1,1,0,1];
const statistics = {
  timestamps: Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 30, 4, i * 5)).toISOString()),
  requests: requestCounts, errors,
  responseTime: [85,88,84,90,94,87,83,79,84,82,85,90],
  successRate: requestCounts.map((count, i) => (count - errors[i]) / count * 100),
  failureRate: requestCounts.map((count, i) => errors[i] / count * 100),
};
// One failed attempt was retried successfully: 389 client requests, 390 upstream attempts.
const upstreams = [{ upstream: 'https://chatgpt.com', count: 390, totalRequests: 390, percentage: 100,
  successRequests: 383, failedRequests: 7,
  successRate: 98.21, failureRate: 1.79,
  status2xx: 389, status3xx: 0, status4xx: 0, status5xx: 1, statusOther: 0, failed2xx: 6 }];
let statusFixtures = false;
let cancellationFixture = false;
let trendScenario: 'default' | 'growth' | 'new' | 'idle' | 'stopped' = 'default';
const snapshotTime = Date.UTC(2026, 8, 30, 4, 38, 30);
function dashboardHistory(range: string) {
  const intervalMs = range === '1h' ? 60_000 : range === '12h' ? 1_800_000 : 3_600_000;
  const currentStart = Math.floor(snapshotTime / intervalMs) * intervalMs;
  const history = { ...statistics,
    timestamps: requestCounts.map((_, i) => new Date(currentStart - (requestCounts.length - 1 - i) * intervalMs).toISOString()),
    requests: [...requestCounts], responseTime: [...statistics.responseTime], successRate: [...statistics.successRate],
  };
  const previous = requestCounts.length - 3, current = requestCounts.length - 2;
  if (trendScenario === 'growth') {
    history.requests[previous] = 515; history.requests[current] = 542;
    history.requests[current + 1] = 220;
    history.responseTime[previous] = 29044; history.responseTime[current] = 23610;
    history.successRate[previous] = 99.42; history.successRate[current] = 99.63;
  } else if (trendScenario !== 'default') {
    history.requests[previous] = trendScenario === 'stopped' ? 9 : 0;
    history.requests[current] = trendScenario === 'new' ? 9 : 0;
    history.responseTime[previous] = history.requests[previous] ? 100 : 0;
    history.responseTime[current] = history.requests[current] ? 100 : 0;
    history.successRate[previous] = history.successRate[current] = 100;
  }
  return { ...history, requestCounts: {
    success: history.requests.map((count, i) => count * history.successRate[i] / 100),
    failed: history.requests.map((count, i) => count * (100 - history.successRate[i]) / 100),
  } };
}
const statusUpstreams = [
  { upstream: 'https://api.openai.com', count: 1020, totalRequests: 1020, percentage: 1020 / 1036 * 100,
    successRequests: 1005, failedRequests: 15, successRate: 1005 / 1020 * 100, failureRate: 15 / 1020 * 100,
    status2xx: 1000, status3xx: 5, status4xx: 10, status5xx: 5, statusOther: 0, failed2xx: 0 },
  { upstream: 'https://client-errors.example.com', count: 13, totalRequests: 13, percentage: 13 / 1036 * 100,
    successRequests: 0, failedRequests: 13, successRate: 0, failureRate: 100,
    status2xx: 0, status3xx: 0, status4xx: 13, status5xx: 0, statusOther: 0, failed2xx: 0 },
  { upstream: 'https://idle.example.com', count: 0, totalRequests: 0, percentage: 0,
    successRequests: 0, failedRequests: 0, successRate: 0, failureRate: 0,
    status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0, failed2xx: 0 },
  { upstream: 'https://no-http-response.example.com', count: 3, totalRequests: 3, percentage: 3 / 1036 * 100,
    successRequests: 0, failedRequests: 3, successRate: 0, failureRate: 100,
    status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 3, failed2xx: 0 },
];
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
  if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
  if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
  if (nativeOnly && url.pathname === '/api/plugin-translations') return route.fulfill({ json: Object.fromEntries(
    Object.entries(tokenManifest.translations).map(([language, messages]) => [language, { plugins: { 'token-stats': messages, 'models-dev': modelsDevManifest.translations[language] } }])) });
  if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
  if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
  if (url.pathname === '/api/runtime/upstreams') return route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null,
    admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: logical.services.flatMap((service: any) => service.endpoints.map((endpoint: any, j: number) => ({
      state_key: service.name, upstream_id: endpoint.id, circuit_state: service.name === 'gemini-pool' && j === 1 ? 'HALF_OPEN' : 'HEALTHY',
      active_request_count: 0, last_used_time: null, last_used_complete: true, last_failure_time: null, last_failure_complete: true, workers: [],
    }))) } });
  if (url.pathname === '/api/stats/dashboard') {
    historyCalls++;
    const range = url.searchParams.get('range') ?? '1h';
    const history = cancellationFixture ? { ...dashboardHistory(range), requests: [7], errors: [4], timestamps: [new Date(snapshotTime - 60_000).toISOString()], responseTime: [80], requestCounts: { success: [2], failed: [2] } } : dashboardHistory(range);
    const data = cancellationFixture ? [{ ...upstreams[0], totalRequests: 7, count: 7, requestCounts: { success: 2, failed: 2 } }] : (statusFixtures ? statusUpstreams : upstreams).map(row => ({ ...row, requestCounts: { success: row.successRequests, failed: row.failedRequests }, httpStatusCounts: { status2xx: row.status2xx, status3xx: row.status3xx, status4xx: row.status4xx, status5xx: row.status5xx, statusOther: row.statusOther } }));
    return historyFailure ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) : route.fulfill({ json: {
      startTime: snapshotTime - (range === '1h' ? 3_600_000 : range === '12h' ? 43_200_000 : 86_400_000), endTime: snapshotTime, range,
      units: { history: 'request_chain', upstreams: 'upstream_attempt' }, history, upstreams: data, requestCounts: { success: history.requestCounts.success.reduce((sum, count) => sum + count, 0), failed: history.requestCounts.failed.reduce((sum, count) => sum + count, 0) },
    } });
  }
  if (url.pathname === '/api/plugins/demo/sandbox') return route.fulfill({ json: { sandbox: 'allow-scripts', allowedHostActions: [], controlAllowlist: [] } });
  if (url.pathname === '/api/plugins/token-stats/control/stats') {
    nativeRequests.push(url.search);
    if (nativeFailure) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    const asOfMs = Date.parse('2026-10-31T06:00:30Z');
    const { bucketMs, bucketStarts, bucketEndMs } = tokenStatsWindow((url.searchParams.get('range') ?? '1h') as TokenStatsRange, asOfMs, url.searchParams.get('timeZone') ?? 'UTC');
    return route.fulfill({ json: { groupBy: url.searchParams.get('groupBy'), asOfMs, bucketMs, bucketStarts, bucketEndMs, logicalRequests: 12, upstreamAttempts: 12,
      totalInputTokens: nativeInput, totalOutputTokens: nativeOutput, estimatedCostUsd: nativeCost,
      ...(nativeLargeNumbers ? { cacheReadTokens: 1_000_000, cacheWriteTokens: 1024 } : {}),
      authorityBreakdown: { input: { official: 12 }, output: { official: 12 } },
      data: Array.from({ length: 12 }, (_, i) => ({ dimension: i === 10 ? 'unknown' : `model-${i}`, logicalRequests: 1, upstreamAttempts: 1,
        bucketStartMs: bucketStarts ? bucketStarts[Math.max(0, bucketStarts.findLastIndex(start => start < asOfMs) - i % 5)] : Math.floor(asOfMs / bucketMs) * bucketMs - (i % 5) * bucketMs,
        officialInputTokens: url.searchParams.get('groupBy') === 'model' && i < 2 ? (i === 0 ? 200 : 0) : 100,
        officialOutputTokens: 50, estimatedCostUsd: 0.001 * (i + 1),
        authorityBreakdown: { input: { official: 1 }, output: { official: 1 } },
        ...(nativeLargeNumbers ? { officialInputTokens: 1_000_000_000_000, officialOutputTokens: 1_000_000_000,
          cacheReadTokens: 1_000_000, cacheWriteTokens: 1024, estimatedCostUsd: 1234.56 } : {}) }))
        .slice(0, nativeLimitedModels && url.searchParams.get('groupBy') === 'time' ? 1 : undefined),
    } });
  }
  if (url.pathname === '/api/plugins/token-stats/control/pricing') return route.fulfill({ json: {
    state: 'empty', version: null, fetchedAt: null, error: null, modelCount: 0, providerCount: 0,
  } });
  if (url.pathname === '/api/plugins/token-stats/control/pricing/mappings') return route.fulfill({ json: { mappings: [] } });
  if (url.pathname === '/api/plugins/models-dev/control/catalog/providers') return route.fulfill({ json: { providers: [] } });
  if (url.pathname === '/api/plugins/models-dev/control/catalog/status') return route.fulfill({ json: {
    state: 'empty', version: null, settings: { autoRefresh: true, intervalHours: 24, timeoutSeconds: 15 },
    refreshing: false, lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, lastError: null,
    modelCount: 0, providerCount: 0,
  } });
  if (url.pathname === '/api/plugins') return route.fulfill({ json: previewOnly ? [] : nativeOnly
    ? [{ name: 'token-stats', version: tokenManifest.version, enabled: true, metadata: { ...tokenManifest.metadata, contributes: { ...tokenManifest.contributes,
        nativeWidgets: tokenManifest.contributes.nativeWidgets.map((widget: any) => ({ ...widget, props: { pluginName: 'intruder', selectedRange: '24h' } })),
      } } },
      { name: 'intruder', enabled: true, metadata: { contributes: { nativeWidgets: tokenManifest.contributes.nativeWidgets } } },
      { name: 'models-dev', version: modelsDevManifest.version, enabled: true, metadata: { ...modelsDevManifest.metadata, contributes: modelsDevManifest.contributes } }]
    : [{ name: 'demo', enabled: !disabledPlugin, metadata: { name: 'demo', version: '1.0.0', contributes: { widgets: [{ id: 'demo', title: '测试插件', path: 'widget.html', size: 'medium' }] } } }] });
  return route.fulfill({ json: {} });
});
await page.route('**/plugins/demo/index.html*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="color:#aaa;background:#15171c">Test plugin widget</body></html>' }));
const card = (id: string) => page.locator(`.grid-stack-item[data-card-id="${id}"]`);
const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), LAYOUT_KEY);
async function edit() { await page.getByTestId('dashboard-customize').click(); await expect(page.getByTestId('dashboard-save-layout')).toBeVisible(); }
async function cancel() { await page.getByTestId('dashboard-cancel-layout').click(); const discard = page.getByRole('button', { name: '放弃更改', exact: true }); if (await discard.isVisible()) await discard.click(); await expect(page.getByTestId('dashboard-customize')).toBeVisible(); }
async function library() { await page.getByTestId('dashboard-add-card').click(); await expect(page.getByRole('dialog')).toBeVisible(); }
async function closeLibrary() { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); }

async function checkKpiRegions(count = 5) {
  const cards = page.locator('.dashboard-kpi-card').filter({ hasNot: page.getByTestId('token-stats-overview') });
  await expect(cards).toHaveCount(count);
  await expect.poll(() => cards.evaluateAll(nodes => {
    const heights = nodes.map(node => ['.kpi-header', '.kpi-body', '.kpi-footer'].map(selector => node.querySelector(selector)!.getBoundingClientRect().height));
    return Math.max(...[0, 1, 2].map(region => Math.max(...heights.map(card => card[region])) - Math.min(...heights.map(card => card[region]))));
  })).toBeLessThan(1);
  const clipped = await cards.evaluateAll(nodes => nodes.flatMap(node => {
    const body = node.querySelector('.kpi-body')!.getBoundingClientRect();
    const metric = node.querySelector('.kpi-metric-row')!.getBoundingClientRect();
    const footer = node.querySelector('.kpi-footer')!.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return metric.top < body.top || metric.bottom > body.bottom || Math.abs(footer.bottom - bounds.bottom) > 2 ? [node.textContent] : [];
  }));
  expect(clipped).toEqual([]);
}

async function recordSheetMotion() {
  await page.evaluate(() => {
    (window as any).__sheetMotion = [];
    for (const phase of ['intro', 'outro']) document.addEventListener(`${phase}start`, event => {
      const node = event.target as HTMLElement;
      if (!node.matches('[data-sheet-content], [data-sheet-overlay]')) return;
      const trace = { phase, panel: node.hasAttribute('data-sheet-content'), done: false,
        samples: [] as { x: number; y: number; opacity: number; locked: boolean }[] };
      (window as any).__sheetMotion.push(trace);
      node.addEventListener(`${phase}end`, () => { trace.done = true; }, { once: true });
      const sample = () => {
        if (trace.done || !node.isConnected) return;
        const style = getComputedStyle(node), matrix = new DOMMatrix(style.transform);
        trace.samples.push({ x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity),
          locked: getComputedStyle(document.body).overflow === 'hidden' });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, true);
  });
}

async function checkLibraryModal(width: number, dismiss: 'escape' | 'close' | 'overlay') {
  await page.setViewportSize({ width, height: 844 });
  const opener = width < 768 ? page.locator('.dashboard-add-row') : page.getByTestId('dashboard-add-card');
  await opener.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ scrollY, x: document.querySelector('.dashboard-board')!.getBoundingClientRect().x }));
  await page.evaluate(() => { (window as any).__sheetMotion = []; });
  await opener.click();
  const panel = page.locator('[data-sheet-content]'), overlay = page.locator('[data-sheet-overlay]');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => panel.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return Math.max(Math.abs(rect.top), Math.abs(rect.bottom - innerHeight), Math.abs(rect.right - innerWidth));
  })).toBeLessThan(1);
  await expect.poll(() => panel.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width, height: 844 });
  expect(await panel.evaluate(node => node.getBoundingClientRect().width)).toBe(width < 768 ? width : 392);
  expect(await page.evaluate(() => ({ scrollY, x: document.querySelector('.dashboard-board')!.getBoundingClientRect().x }))).toEqual(before);
  if (width >= 768) expect(await page.evaluate(() => document.elementFromPoint(10, 10)?.hasAttribute('data-sheet-overlay'))).toBe(true);
  await expect(panel.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  const header = await panel.locator('header').boundingBox();
  await page.mouse.move(header!.x + 24, header!.y + 20); await page.mouse.wheel(0, 400);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  const list = page.getByTestId('dashboard-library-list'), bounds = await list.boundingBox();
  await page.mouse.move(bounds!.x + 20, bounds!.y + 30); await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  await expect(panel.locator('header')).toBeInViewport();
  await expect(panel.locator('footer')).toBeInViewport();
  await page.screenshot({ path: `${evidence}/modal-${width}.png` });
  if (dismiss === 'escape') await page.keyboard.press('Escape');
  else if (dismiss === 'close') await panel.getByRole('button', { name: '关闭', exact: true }).click();
  else await overlay.click({ position: { x: 10, y: 400 } });
  await expect(panel).toHaveCount(0);
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  const motion = await page.evaluate(() => (window as any).__sheetMotion);
  for (const phase of ['intro', 'outro']) {
    const panelMotion = motion.find((trace: any) => trace.phase === phase && trace.panel);
    const overlayMotion = motion.find((trace: any) => trace.phase === phase && !trace.panel);
    expect(panelMotion?.done).toBe(true);
    expect(overlayMotion?.done).toBe(true);
    const distance = width < 768 ? 844 : 392;
    expect(panelMotion.samples.some((sample: any) => {
      const offset = width < 768 ? sample.y : sample.x;
      return offset > 1 && offset < distance - 1;
    })).toBe(true);
    expect(overlayMotion.samples.some((sample: any) => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
    expect(panelMotion.samples.every((sample: any) => sample.locked)).toBe(true);
  }
}

try {
  await page.goto(baseUrl);
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  const chartChunk = (await fs.promises.readdir(new URL('../../dist/assets/', import.meta.url)))
    .find(name => /^vendor-charts-.*\.js$/.test(name));
  if (!chartChunk) throw new Error('Current UI build has no Chart.js chunk');
  await page.addInitScript(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chartChunk}`);
  await page.evaluate(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chartChunk}`);
  if (!nativeOnly) {
    const appHeader = page.getByTestId('app-header');
    const tabs = appHeader.locator('.header-tab');
    const tabWidths = () => tabs.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    const checkIndicator = () => expect.poll(() => appHeader.locator('.header-tab[aria-current="page"]').evaluate(node => {
      const tab = node.getBoundingClientRect();
      const indicator = node.closest('ul')!.querySelector('li[aria-hidden="true"]')!.getBoundingClientRect();
      return Math.abs(indicator.left - tab.left) < 0.5 && Math.abs(indicator.width - tab.width) < 0.5;
    })).toBe(true);
    expect((await appHeader.boundingBox())!.height).toBe(48);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const widths = await tabWidths();
    await checkIndicator();
    await expect(tabs.first().locator('.nx-caret-left')).toBeVisible();
    await expect(tabs.nth(1).locator('.nx-caret-left')).toBeHidden();
    const labelPositions = () => tabs.evaluateAll(nodes => nodes.map(node => node.querySelector('[title]')!.getBoundingClientRect().x));
    const positions = await labelPositions();
    expect(await tabs.first().evaluate(node => {
      const style = getComputedStyle(node);
      return { mono: style.fontFamily.includes('DM Mono'), size: style.fontSize,
        weight: style.fontWeight, transform: style.textTransform, spacing: style.letterSpacing };
    })).toEqual({ mono: true, size: '11px', weight: '600', transform: 'uppercase', spacing: '1.32px' });
    const indicatorMotion = await tabs.nth(1).evaluate(async node => {
      const indicator = node.closest('ul')!.querySelector<HTMLElement>('li[aria-hidden="true"]')!;
      const samples: number[] = [];
      const start = performance.now();
      (node as HTMLAnchorElement).click();
      await new Promise<void>(resolve => {
        const sample = () => {
          samples.push(new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41);
          if (performance.now() - start < 300) requestAnimationFrame(sample); else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    });
    await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(tabs.nth(1).locator('.nx-caret-left')).toBeVisible();
    await expect(tabs.first().locator('.nx-caret-left')).toBeHidden();
    expect(await labelPositions()).toEqual(positions);
    expect(await tabWidths()).toEqual(widths);
    expect(indicatorMotion.some(x => x > 0 && x < widths[0])).toBe(true);
    expect(indicatorMotion.at(-1)).toBeCloseTo(widths[0], 2);
    await checkIndicator();
    await tabs.first().click();
    await expect(page.getByTestId('page-dashboard')).toBeVisible();
    await appHeader.getByRole('button', { name: '语言', exact: true }).click();
    const languages = page.getByRole('menuitem');
    expect(await languages.evaluateAll(nodes => nodes.every(node => getComputedStyle(node).minHeight === '0px' && node.getBoundingClientRect().height < 44))).toBe(true);
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await expect(tabs.first()).toHaveText('Dashboard');
    const englishWidths = await tabWidths();
    expect(new Set(englishWidths).size).toBeGreaterThan(1);
    expect(englishWidths).not.toEqual(widths);
    await checkIndicator();
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
    expect(await tabWidths()).toEqual(englishWidths);
    await checkIndicator();
    await tabs.first().click();
    await expect(page.getByTestId('page-dashboard')).toBeVisible();
    // Auto-sized tabs keep the full translated label visible and accessible.
    await expect(tabs.filter({ hasText: 'Global Settings' })).toHaveAccessibleName('Global Settings');
    await expect(tabs.filter({ hasText: 'Global Settings' }).locator('span[title]')).toHaveAttribute('title', 'Global Settings');
    await appHeader.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitem', { name: '中文', exact: true }).click();
    await expect(tabs.first()).toHaveText('仪表板');
    expect(await tabWidths()).toEqual(widths);
    await checkIndicator();
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect((await appHeader.boundingBox())!.height).toBe(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 768) {
        await appHeader.getByRole('button', { name: '菜单', exact: true }).click();
        await expect(page.getByTestId('header-menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('header-menu')).toHaveCount(0);
      } else {
        await tabs.last().focus();
        await expect(tabs.last()).toBeInViewport();
        await checkIndicator();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await appHeader.locator('li[aria-hidden="true"]').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.screenshot({ path: `${evidence}/compact-header.png` });
  }
  await expect(card('kpi.rpm')).toBeVisible();
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  await checkKpiRegions(3);
  await expect(page.locator('.grid-stack-item')).toHaveCount(nativeOnly ? 13 : 11);
  await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(nativeOnly ? 2 : 0);
  if (nativeOnly) {
    await expect(card('plugin:native:token-stats:token-stats-time').locator('canvas')).toBeVisible();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.2K');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect.poll(() => page.locator('.dashboard-grid').evaluate(node => Number.parseFloat((node as HTMLElement).style.getPropertyValue('--dashboard-row-height')))).toBeLessThanOrEqual(40);
    // The plugin overview keeps the same header/body/footer regions as adjacent KPIs.
    await expect.poll(() => page.locator('.dashboard-kpi-card').evaluateAll(nodes => {
      const heights = nodes.map(node => ['.kpi-header', '.kpi-body', '.kpi-footer'].map(selector => node.querySelector(selector)?.getBoundingClientRect().height ?? -1));
      return Math.max(...[0, 1, 2].map(region => Math.max(...heights.map(card => card[region])) - Math.min(...heights.map(card => card[region]))));
    })).toBeLessThan(1);
    await expect(page.getByTestId('token-stats-overview-trends')).toBeVisible();
    await expect(page.getByTestId('token-stats-trend-input')).toContainText('+50.0%');
    await expect(page.getByTestId('token-stats-trend-output')).toContainText('+50.0%');
    await expect(page.getByTestId('token-stats-trend-cost')).toContainText('+90.9%');
    await expect(page.getByTestId('token-stats-trend-input')).toContainText('较上个5分钟');
    expect(nativeRequests).toHaveLength(1);
    await expect(page.locator('[data-card-id^="plugin:native:intruder:"]')).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/template-llm-initial.png`, fullPage: true });
    // A saved API layout stays unchanged when plugin metadata arrives on reload.
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-api').click();
    await page.getByTestId('dashboard-save-layout').click();
    await page.reload();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/template-api-desktop.png`, fullPage: true });
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await expect(page.getByTestId('dashboard-template-api')).toBeVisible();
    await page.screenshot({ path: `${evidence}/template-picker-desktop.png`, fullPage: true });
    await page.getByTestId('dashboard-template-llm').click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(13);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-llm').click();
    await cancel();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-llm').click();
    await page.getByTestId('dashboard-save-layout').click();
    await page.reload();
    await expect(page.locator('.grid-stack-item')).toHaveCount(13);
    await expect(card('plugin:native:token-stats:token-stats-time').locator('canvas')).toBeVisible();
    await page.screenshot({ path: `${evidence}/template-llm-desktop.png`, fullPage: true });
    const before = await stored();
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-api').click();
    await cancel();
    expect(await stored()).toEqual(before);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.dashboard-mobile-card')).toHaveCount(13);
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.screenshot({ path: `${evidence}/template-picker-mobile.png`, fullPage: true });
    await page.getByTestId('dashboard-template-api').click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.dashboard-manage-row')).toHaveCount(13);
    await cancel();
    await page.setViewportSize({ width: 1440, height: 1100 });
  } else {
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await expect(page.getByTestId('dashboard-template-llm')).toContainText('部分 Token 卡片不可用');
    await page.getByTestId('dashboard-template-api').click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(11);
    await cancel();
  }
  if (!nativeOnly && !previewOnly) {
    // Preserve coverage of every existing card and old saved custom layouts.
    const ids = ['kpi.requests', 'kpi.rpm', 'kpi.success', 'kpi.latency', 'kpi.cluster',
      'health.services', 'health.routes', 'chart.requests', 'chart.latency', 'chart.success', 'chart.errors',
      'chart.upstreams', 'chart.failures', 'chart.status', 'plugin:iframe:demo:widget.html'];
    const geometry = [[0,0,6,2], [6,0,6,2], [12,0,6,2], [18,0,6,2], [24,0,6,2],
      [0,2,10,8], [0,10,10,8], [10,2,10,4], [20,2,10,4], [10,6,10,4], [20,6,10,4],
      [10,10,10,4], [10,14,10,4], [20,10,10,8], [0,18,15,4]];
    const cards = ids.map((id, i) => { const [x,y,w,h] = geometry[i]; return { id,x,y,w,h }; });
    await page.evaluate(({ key, cards }) => localStorage.setItem(key, JSON.stringify({ version: 4, cards,
      mobile: cards.map(({ id }) => ({ id, height: 'standard' })) })), { key: LAYOUT_KEY, cards });
    await page.reload();
    await expect(page.locator('.grid-stack-item')).toHaveCount(15);
    const trend = (id: string) => card(id).getByTestId('kpi-trend');
    const refresh = () => page.getByRole('button', { name: '立即刷新', exact: true }).click();
    trendScenario = 'growth';
    await refresh();
    await expect(trend('kpi.requests')).toContainText('↑ +5.2%');
    await expect(trend('kpi.rpm')).toContainText('↑ +5.2%');
    await expect(trend('kpi.success')).toContainText('↑ +0.2 pp');
    await expect(trend('kpi.latency')).toContainText('↓ -18.7%');
    await expect(trend('kpi.latency').locator('.kpi-trend-value')).toHaveClass(/text-emerald-400/);
    await expect(trend('kpi.requests')).toContainText('较上一分钟');
    const ranges = ['1h', '12h', '24h'] as const;
    for (const range of ranges) {
      await page.getByRole('radio', { name: range, exact: true }).click();
      await expect(trend('kpi.requests')).toContainText(range === '1h' ? '较上一分钟' : range === '12h' ? '较上一时段' : '较上一小时');
      await expect(trend('kpi.requests')).toContainText('↑ +5.2%');
      await expect(trend('kpi.requests')).toHaveAttribute('title', /时段对比.*–.* → .*–/);
      await expect(trend('kpi.requests')).not.toHaveAttribute('title', /完整/);
    }
    await page.getByRole('radio', { name: '1h', exact: true }).click();
    trendScenario = 'new';
    await refresh();
    await expect(trend('kpi.requests')).toContainText('↑ 新增');
    await expect(trend('kpi.rpm')).toContainText('↑ 新增');
    await expect(trend('kpi.requests').locator('.kpi-trend-value')).toHaveClass(/text-emerald-400/);
    for (const scenario of ['idle', 'stopped'] as const) {
      trendScenario = scenario;
      await refresh();
      await expect(trend('kpi.requests')).toContainText(scenario === 'idle' ? '→ +0.0%' : '↓ -100.0%');
      await expect(trend('kpi.success').locator('.kpi-trend-value')).toHaveText('—');
      await expect(trend('kpi.latency').locator('.kpi-trend-value')).toHaveText('—');
    }
    trendScenario = 'default';
    await refresh();
    await expect(trend('kpi.requests')).toContainText('↓ -6.1%');
  }
  const statusRows = page.getByTestId('upstream-status-row');
  async function checkStatusRow(index: number, counts: string[], percentages: string[]) {
    for (const [segmentIndex, key] of ['status2xx', 'status3xx', 'status4xx', 'status5xx', 'statusOther'].entries()) {
      const segment = statusRows.nth(index).locator(`[data-status="${key}"]`);
      await expect(segment.locator('dt')).toHaveText(key === 'statusOther' ? '其他' : key.slice(6));
      await expect(segment.locator('dd span').first()).toHaveText(counts[segmentIndex]);
      await expect(segment.locator('dd span').last()).toHaveText(percentages[segmentIndex]);
    }
  }
  if (!nativeOnly && !previewOnly) {
    await expect(statusRows).toHaveCount(1);
    await checkStatusRow(0, ['389', '0', '0', '1', '0'], ['99.7%', '0.0%', '0.0%', '0.3%', '0.0%']);
    // A real canvas hover drives shared HTML tooltips on all four linked charts.
    await card('chart.requests').scrollIntoViewIfNeeded();
    const hoverTrend = (index: number | null) => page.evaluate(async index => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      const canvas = document.querySelector<HTMLCanvasElement>('[data-card-id="chart.requests"] canvas')!;
      const chart = Chart.getChart(canvas);
      const point = chart.getDatasetMeta(0).data[index ?? 0];
      const bounds = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent(index === null ? 'mouseout' : 'mousemove', { bubbles: true, clientX: bounds.left + point.x, clientY: bounds.top + point.y }));
      return new Promise(resolve => requestAnimationFrame(() => {
        const tooltips = ['chart.requests', 'chart.latency', 'chart.success', 'chart.errors'].map(id => {
          const linked = Chart.getChart(document.querySelector(`[data-card-id="${id}"] canvas`));
          return { native: linked.options.plugins.tooltip.enabled, external: typeof linked.options.plugins.tooltip.external,
            index: linked.tooltip.getActiveElements()[0]?.index };
        });
        resolve({ dataDuration: chart.options.datasets.line.animation.duration, tooltips });
      }));
    }, index);
    expect(await hoverTrend(2)).toEqual({ dataDuration: 0,
      tooltips: Array.from({ length: 4 }, () => ({ native: false, external: 'function', index: 2 })) });
    const htmlTooltips = page.getByTestId('line-chart-tooltip');
    await expect(htmlTooltips).toHaveCount(4);
    for (const [label, value] of [['请求数趋势', '32'], ['响应时间趋势', '84 ms'], ['成功率趋势', '100 %'], ['失败数趋势', '0']]) {
      const tooltip = htmlTooltips.filter({ hasText: label });
      await expect(tooltip).toBeVisible();
      await expect(tooltip.locator('strong')).toHaveText(value);
    }
    await expect.poll(() => htmlTooltips.first().evaluate(node => getComputedStyle(node).transitionProperty)).toContain('left');
    const initialLeft = await htmlTooltips.first().evaluate(node => parseFloat((node as HTMLElement).style.left));
    await hoverTrend(8);
    await expect(htmlTooltips.filter({ hasText: '请求数趋势' }).locator('strong')).toHaveText('34');
    await expect.poll(() => htmlTooltips.first().evaluate(node => parseFloat((node as HTMLElement).style.left))).not.toBe(initialLeft);
    expect(await htmlTooltips.first().evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
      border: getComputedStyle(node).borderColor, pointerEvents: getComputedStyle(node).pointerEvents }))).toEqual({
      background: 'rgb(21, 23, 28)', border: 'rgb(55, 61, 74)', pointerEvents: 'none' });
    await expect.poll(() => htmlTooltips.evaluateAll(nodes => nodes.every(node => node.getAnimations().every(animation => animation.playState !== 'running')))).toBe(true);
    await page.screenshot({ path: `${evidence}/shared-trend-tooltips.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await htmlTooltips.first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.keyboard.press('Escape');
    await expect(htmlTooltips).toHaveCount(0);
    await hoverTrend(4);
    await expect(htmlTooltips).toHaveCount(4);
    await hoverTrend(null);
    await expect(htmlTooltips).toHaveCount(0);
    await expect(card('kpi.requests').locator('.kpi-value')).toHaveText('389');
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('98.5');
    const distribution = card('chart.upstreams');
    await expect(distribution).toContainText('流量占比 100.0%');
    await expect(distribution).toContainText('390');
    await expect(distribution).toContainText('成功请求 383 · 98.21%');
    await expect(distribution).toContainText('失败请求 7 · 1.79%');
    await expect(distribution).not.toContainText('取消请求');
    await expect(card('chart.failures')).toContainText('失败请求 7 · 1.79%');
    await expect(card('chart.failures').getByRole('meter')).toHaveAttribute('aria-valuemax', '390');
    await expect(card('chart.failures').getByRole('meter')).toHaveAttribute('aria-valuenow', '7');
    await expect(card('chart.status')).not.toContainText('HTTP 2xx 后仍失败');
    await expect(page.getByTestId('upstream-transport-summary')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-board')).not.toContainText(/服务未提供|传输失败占比|HTTP 2xx 占比/);
    await expect(card('chart.errors')).not.toContainText('取消请求');
    // Client failure rate includes interrupted requests and excludes recovered retry attempts.
    await expect(card('chart.errors')).toContainText('失败率 1.54%');
    await expect(page.getByTestId('dashboard-board')).not.toContainText(/客户端请求 · 重试按一次计数|上游尝试 · 每次重试单独计数/);
    cancellationFixture = true;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('50.0');
    await expect(card('chart.failures').getByRole('meter')).toHaveAttribute('aria-valuenow', '2');
    await expect(card('chart.upstreams')).toContainText('成功请求 2 · 50.00%');
    await expect(card('chart.upstreams')).toContainText('失败请求 2 · 50.00%');
    await expect(card('chart.errors')).toContainText('失败率 50.00%');
    cancellationFixture = false;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('98.5');
  }
  if (nativeOnly) {
    const nativeCard = card('plugin:native:token-stats:token-stats-time');
    const overviewCard = card('plugin:native:token-stats:token-stats-overview');
    await expect(overviewCard).toHaveAttribute('gs-w', '12');
    await expect(overviewCard).toHaveAttribute('gs-h', '4');
    await expect(overviewCard).toHaveAttribute('gs-x', '18');
    await expect(nativeCard).toHaveAttribute('gs-w', '20');
    await expect(nativeCard).toHaveAttribute('gs-h', '8');
    await expect(nativeCard).toHaveAttribute('gs-x', '10');
    await expect(nativeCard).toHaveAttribute('gs-y', '4');
    for (const [id, x, y, w, h] of [
      ['kpi.rpm', 0, 0, 6, 2], ['kpi.success', 6, 0, 6, 2], ['kpi.latency', 12, 0, 6, 2],
      ['health.services', 0, 2, 10, 8], ['health.routes', 0, 10, 10, 8],
      ['chart.requests', 10, 6, 10, 4], ['chart.latency', 20, 6, 10, 4],
      ['chart.success', 10, 10, 10, 4], ['chart.errors', 20, 10, 10, 4],
      ['chart.upstreams', 10, 14, 10, 4], ['chart.status', 20, 14, 10, 4],
    ] as const) {
      expect((await stored()).cards.find((entry: { id: string }) => entry.id === id)).toMatchObject({ x, y: y * 2, w, h: h * 2 });
    }
    const serviceBounds = (await card('health.services').boundingBox())!, timeBounds = (await nativeCard.boundingBox())!;
    expect(Math.abs(serviceBounds.y - timeBounds.y)).toBeLessThan(1);
    expect(timeBounds.x).toBeGreaterThanOrEqual(serviceBounds.x + serviceBounds.width);
    await expect(page.locator('[data-card-id^="plugin:native:intruder:"]')).toHaveCount(0);
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(0);
    for (const metric of ['input', 'output', 'cost']) await expect(page.getByTestId(`token-stats-metric-${metric}`)).toBeVisible();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.2K');
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveAttribute('title', '1,200');
    await expect(overviewCard.locator('.nx-panel-head-title')).toContainText('Token 概览');
    await expect(nativeCard.locator('.nx-panel-head-title')).toContainText('Token 趋势');
    await expect(nativeCard.locator('canvas')).toBeVisible();
    await expect(page.getByTestId('dashboard-board')).not.toContainText(/客户端请求 · 重试按一次计数|上游尝试 · 每次重试单独计数/);
    cancellationFixture = true;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('50.0');
    // The LLM template omits the upstream failure card; its failure trend remains visible.
    await expect(card('chart.failures')).toHaveCount(0);
    await expect(card('chart.upstreams')).toContainText('成功请求 2 · 50.00%');
    await expect(card('chart.upstreams')).toContainText('失败请求 2 · 50.00%');
    await expect(card('chart.errors')).toContainText('失败率 50.00%');
    cancellationFixture = false;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('98.5');
    // Reproduce the reported value lengths and check rendered text, not just CSS.
    nativeInput = 1_900_000; nativeOutput = 11_900; nativeCost = 0.6287;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.9M');
    await expect(page.getByTestId('token-stats-metric-output').locator('.overview-value')).toHaveText('11.9K');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveText('$0.63');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveAttribute('title', '$0.6287');
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toBeVisible();
      await expect.poll(() => page.locator('.overview-value').evaluateAll(nodes => nodes.filter(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), bounds = node.getBoundingClientRect();
        return text.width > bounds.width + 1 || getComputedStyle(node).textOverflow === 'ellipsis';
      }).length)).toBe(0);
    }
    await page.getByTestId('token-stats-overview').screenshot({ path: `${evidence}/token-overview-fitted-values.png` });
    nativeCost = 0.00012345;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveText('$0');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveAttribute('title', '$0.00012345');
    await expect.poll(() => page.locator('.overview-value').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length)).toBe(0);
    nativeInput = 1200; nativeOutput = 600; nativeCost = 0.078;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.2K');
    await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(13);
    // Programmatic Chart.js activation must drive the shared HTML tooltip, also on empty buckets.
    const setChartTooltip = (index: number | null) => page.evaluate(async index => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      const chart = Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!;
      if (typeof chart.options.plugins.tooltip.external !== 'function') throw new Error('Missing Chart.js external tooltip');
      chart.tooltip.setActiveElements(index === null ? [] : chart.data.datasets.map((_: unknown, datasetIndex: number) => ({ datasetIndex, index })), { x: 0, y: 0 });
    }, index);
    const nativeTooltip = page.getByTestId('token-stats-bucket-detail');
    await setChartTooltip(0);
    await expect(nativeTooltip).toBeVisible();
    await expect(nativeTooltip).toContainText(tokenManifest.translations['zh-CN']['ui.noCountedTokens']);
    await setChartTooltip(12);
    await expect(nativeTooltip).toContainText('450');
    await expect(page.locator('[data-token-stats-bucket-trigger]').last()).toHaveAttribute('aria-pressed', 'true');
    await setChartTooltip(null);
    await expect(nativeTooltip).toHaveCount(0);
    expect(nativeRequests.every(query => query.includes('range=1h'))).toBe(true);
    expect(nativeRequests.some(query => query.includes('groupBy=model'))).toBe(false);
    await page.screenshot({ path: `${evidence}/token-dashboard-desktop.png`, fullPage: true });
    await nativeCard.screenshot({ path: `${evidence}/token-trend-desktop.png` });
    await card('plugin:native:token-stats:token-stats-overview').screenshot({ path: `${evidence}/token-overview-desktop.png` });
    for (const width of [768, 1920]) {
      await page.setViewportSize({ width, height: 1080 });
      await checkKpiRegions(3);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`LLM template overflows at ${width}px`);
      await page.screenshot({ path: `${evidence}/template-llm-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('radio', { name: '12h', exact: true }).click();
    await expect.poll(() => nativeRequests.some(query => query.includes('range=12h'))).toBe(true);
    await expect(page.getByTestId('token-stats-trend-input')).toContainText('较上个1小时');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('token-stats-overview')).toBeVisible();
    await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(13);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Token dashboard causes horizontal overflow');
    await page.screenshot({ path: `${evidence}/token-dashboard-mobile.png`, fullPage: true });
    await page.getByRole('link', { name: '查看模型统计 →' }).click();
    await expect(page.getByTestId('token-stats-page')).toBeVisible();
    await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(24);
    await expect(page.getByTestId('token-stats-time-chart')).toHaveAttribute('data-bucket-ms', '3600000');
    await page.locator('[data-token-stats-bucket-trigger]').last().focus();
    await expect(page.getByTestId('token-stats-bucket-detail')).toContainText(tokenManifest.translations['zh-CN']['ui.noCountedTokens']);
    await expect(page.getByTestId('token-stats-bucket-detail')).toContainText('11/01');
    await page.keyboard.press('Escape');
    const rangeSelect = page.getByRole('combobox', { name: '时间范围' });
    await expect(rangeSelect).toContainText('本日');
    await expect(page.getByRole('radio', { name: '1 小时', exact: true })).toHaveCount(0);
    await rangeSelect.click();
    await expect(page.getByRole('option')).toHaveText(['本日', '本周', '本月', '最近1天', '最近7天', '最近30天']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('token-stats-composition')).toHaveCount(0);
    await expect(page.getByText('Token 构成', { exact: true })).toHaveCount(0);
    for (const [label, range, count, bucketMs] of [
      ['本日', 'day', 24, 3_600_000], ['最近7天', '7d', 7, 86_400_000], ['最近30天', '30d', 30, 86_400_000],
      ['本周', 'week', 7, 86_400_000], ['本月', 'month', 31, 86_400_000], ['最近1天', '1d', 24, 3_600_000],
    ] as const) {
      await rangeSelect.click();
      await page.getByRole('option', { name: label, exact: true }).click();
      await expect(rangeSelect).toContainText(label);
      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=model'))).toBe(true);
      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=time'))).toBe(true);
      await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(count);
      await expect(page.getByTestId('token-stats-time-chart')).toHaveAttribute('data-bucket-ms', String(bucketMs));
      await expect.poll(() => page.getByTestId('token-stats-chart-viewport').evaluate(node =>
        Math.max(node.scrollWidth - node.clientWidth, node.scrollHeight - node.clientHeight))).toBeLessThanOrEqual(1);
      if (range === '7d') await expect.poll(() => page.getByTestId('token-stats-page-axis').locator('span').evaluateAll(nodes => nodes.filter(node => node.textContent?.trim()).length)).toBe(7);
      if (range === '30d') {
        const legendBounds = (await page.getByTestId('token-stats-chart-legend').boundingBox())!;
        expect(legendBounds.x).toBeGreaterThanOrEqual(0);
        expect(legendBounds.x + legendBounds.width).toBeLessThanOrEqual(390);
        expect(await page.getByTestId('token-stats-page-axis').locator('span').evaluateAll(nodes => {
          const labels = nodes.filter(node => node.textContent?.trim()).map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return range.getBoundingClientRect();
          });
          return labels.every((label, i) => i === 0 || label.left - labels[i - 1].right >= 4);
        })).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    for (const calendarRange of ['day', 'week', 'month']) {
      expect(nativeRequests.some(query => query.includes(`range=${calendarRange}`) && query.includes('timeZone=Asia%2FShanghai'))).toBe(true);
    }
    await expect(page.getByTestId('token-stats-page')).not.toContainText(/请求数|尝试数|Token\s*数/);
    await expect(page.getByRole('radio', { name: 'Token', exact: true })).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    await expect(page.getByText('模型用量', { exact: true })).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    const modelMeters = () => page.getByTestId('token-stats-model-row').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [
      node.querySelector('strong')!.textContent, node.querySelector('[role="meter"]')!.outerHTML,
    ])));
    const tokenMeters = await modelMeters();
    const checkSortPosition = async () => {
      const sortBounds = (await page.getByRole('radiogroup', { name: '模型排序' }).boundingBox())!;
      const searchBounds = (await page.getByRole('textbox', { name: '搜索模型' }).boundingBox())!;
      expect(sortBounds.x + sortBounds.width).toBeLessThanOrEqual(searchBounds.x);
      expect(Math.abs(sortBounds.y - searchBounds.y)).toBeLessThan(5);
    };
    await checkSortPosition();
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-11');
    await expect(page.getByTestId('token-stats-model-row').first().getByRole('meter')).toHaveAttribute('aria-valuemax', '250');
    await expect(page.getByTestId('token-stats-model-row').first().getByRole('meter')).toHaveAttribute('aria-valuenow', '150');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last().getByRole('meter')).toHaveAttribute('aria-valuenow', '250');
    expect(await modelMeters()).toEqual(tokenMeters);
    await page.getByRole('radio', { name: 'Token', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    expect(await modelMeters()).toEqual(tokenMeters);
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索模型' }).fill('model-11');
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(1);
    await page.getByRole('textbox', { name: '搜索模型' }).fill('');
    await expect(rangeSelect).toContainText('最近1天');
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    const buckets = page.locator('[data-token-stats-bucket-trigger]');
    await buckets.first().focus(); await page.keyboard.press('End');
    const bucketDetail = page.getByTestId('token-stats-bucket-detail');
    await expect(bucketDetail).toBeVisible();
    await expect(bucketDetail).toContainText('450');
    await expect(bucketDetail).toContainText('model-5');
    await expect(bucketDetail).toContainText(tokenManifest.translations['zh-CN']['ui.unknownModel']);
    await expect(bucketDetail).not.toContainText(tokenManifest.translations['zh-CN']['ui.otherModels']);
    await page.keyboard.press('Escape');
    await expect(bucketDetail).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      return Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!.tooltip.getActiveElements().length;
    })).toBe(0);
    await buckets.last().evaluate(node => (node as HTMLElement).blur());
    await setChartTooltip(23);
    await expect(bucketDetail).toContainText('450');
    await setChartTooltip(null);
    await expect(bucketDetail).toHaveCount(0);
    // Touch retains the same tap-to-open / tap-again-to-close behavior through Chart.js.
    const touchLatestBucket = () => buckets.last().evaluate(node => {
      node.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      (node as HTMLElement).focus();
      node.dispatchEvent(new PointerEvent('click', { pointerType: 'touch', bubbles: true }));
    });
    await touchLatestBucket();
    await expect(bucketDetail).toBeVisible();
    await touchLatestBucket();
    await expect(bucketDetail).toHaveCount(0);
    await buckets.last().evaluate(node => (node as HTMLElement).blur());
    await page.screenshot({ path: `${evidence}/token-statistics-mobile.png`, fullPage: true });
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      if (width >= 768) await checkSortPosition();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(buckets).toHaveCount(24);
      await expect.poll(() => page.getByTestId('token-stats-chart-viewport').evaluate(node =>
        Math.max(node.scrollWidth - node.clientWidth, node.scrollHeight - node.clientHeight))).toBeLessThanOrEqual(1);
      // Page bars stay centered in date slots, capped at 40px, with unchanged colors.
      await expect.poll(() => page.evaluate(async () => {
        const module = await import((window as any).__chartModuleUrl);
        const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
        if (!Chart) throw new Error('Built Chart.js getChart export is missing');
        const plot = document.querySelector('[data-testid="token-stats-time-chart"]')!;
        const canvas = plot.querySelector('canvas')!;
        const chart = Chart.getChart(canvas)!;
        const triggers = [...plot.querySelectorAll<HTMLElement>('[data-token-stats-bucket-trigger]')];
        const legend = [...plot.querySelectorAll<HTMLElement>('span[title]')];
        const canvasBounds = canvas.getBoundingClientRect();
        const color = document.createElement('span');
        document.body.appendChild(color);
        const matchingColors = chart.data.datasets.every((dataset: any, index: number) => {
          color.style.backgroundColor = dataset.backgroundColor;
          return getComputedStyle(color).backgroundColor === getComputedStyle(legend[index].firstElementChild!).backgroundColor;
        });
        color.remove();
        const bars = chart.getDatasetMeta(0).data;
        const matchingBars = bars.every((bar: any, index: number) => {
          const trigger = triggers[index].getBoundingClientRect();
          return Math.abs(canvasBounds.left + bar.x - (trigger.left + trigger.width / 2)) < 1
            && bar.width > 0 && bar.width <= 40 && bar.width <= trigger.width
            && (trigger.width < 48 ? Math.abs(bar.width / trigger.width - 0.75) < 0.05 : trigger.width - bar.width >= 11);
        });
        const viewport = plot.querySelector<HTMLElement>('[data-testid="token-stats-chart-viewport"]')!;
        return matchingColors && matchingBars && canvasBounds.width <= viewport.clientWidth + 1
          && !chart.options.scales.x.display && !chart.options.scales.y.display;
      })).toBe(true);
    }
    await rangeSelect.click(); await page.getByRole('option', { name: '最近7天', exact: true }).click();
    await expect(buckets).toHaveCount(7);
    await expect.poll(() => page.evaluate(async () => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      const chart = Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!;
      return chart.getDatasetMeta(0).data.every((bar: any) => Math.abs(bar.width - 40) < 0.1);
    })).toBe(true);
    await page.getByTestId('token-stats-time-chart').screenshot({ path: `${evidence}/token-trend-seven-days.png` });
    await rangeSelect.click(); await page.getByRole('option', { name: '最近1天', exact: true }).click();
    await expect(buckets).toHaveCount(24);
    await buckets.last().hover();
    await expect(bucketDetail).toBeVisible();
    const originalTooltipStyle = await bucketDetail.evaluate(node => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderColor, borderWidth: style.borderWidth,
        paddingRem: parseFloat(style.padding) / parseFloat(getComputedStyle(document.documentElement).fontSize),
        fontSize: style.fontSize, overflowY: style.overflowY };
    });
    expect(originalTooltipStyle).toEqual({ background: 'rgb(21, 23, 28)', border: 'rgb(55, 61, 74)', borderWidth: '1px',
      paddingRem: 0.75, fontSize: '11px', overflowY: 'auto' });
    const tooltipBounds = (await bucketDetail.boundingBox())!;
    await page.mouse.move(tooltipBounds.x + 15, tooltipBounds.y + 15);
    await expect(bucketDetail).toBeVisible();
    await bucketDetail.screenshot({ path: `${evidence}/token-trend-tooltip.png` });
    await page.mouse.move(0, 0); await expect(bucketDetail).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/token-statistics-desktop.png`, fullPage: true });
    await page.getByTestId('token-stats-time-chart').screenshot({ path: `${evidence}/token-trend-statistics-desktop.png` });
    nativeFailure = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(tokenManifest.translations['zh-CN']['ui.loadFailed']);
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    nativeFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    nativeLargeNumbers = true; nativeInput = 1_000_000_000_000; nativeOutput = 1_000_000_000; nativeCost = 1234.56;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const summaryValues = page.getByTestId('token-stats-page-summary').locator('.kpi-value');
    await expect(summaryValues).toHaveText(['1T', '1B', '1T', '$1.23K']);
    await expect(summaryValues.nth(0)).toHaveAttribute('title', '1,000,000,000,000');
    await expect(summaryValues.nth(2)).toHaveAttribute('title', '1,001,000,000,000');
    await expect(summaryValues.nth(3)).toHaveAttribute('title', '$1,234.56');
    const largeRow = page.getByTestId('token-stats-model-row').first();
    await expect(largeRow).toContainText('1T Token · $1.23K');
    await expect(largeRow).toContainText('缓存读取 1M (<0.01%)');
    await expect(largeRow).toContainText('缓存写入 1.02K (<0.01%)');
    await expect(largeRow.locator('span[title="1,001,000,000,000"]')).toHaveText('1T Token');
    await expect(largeRow.locator('span[title="1,024"]')).toHaveText('1.02K');
    await expect(largeRow.getByRole('meter')).toHaveAttribute('aria-valuenow', '1001000000000');
    await buckets.last().focus();
    await expect(bucketDetail).toBeVisible();
    await expect(bucketDetail.locator('strong[title="3,003,000,000,000"]')).toHaveText('3T');
    await expect(bucketDetail.locator('strong[title="1,001,000,000,000"]')).toHaveCount(3);
    await expect(bucketDetail.locator('strong[title="1,001,000,000,000"]').first()).toHaveText('1T');
    await page.keyboard.press('Escape');
    await expect(bucketDetail).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: `${evidence}/token-statistics-large-numbers-mobile.png`, fullPage: true });
    await setChartTooltip(23);
    await expect(bucketDetail).toBeVisible();
    nativeLimitedModels = true;
    // Refresh without an outside pointer click, so Chart.js must clear the removed active datasets.
    await page.getByRole('button', { name: '刷新', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(async () => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      return Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!.data.datasets.length;
    })).toBe(1);
    await expect(bucketDetail).toHaveCount(0);
    await setChartTooltip(23);
    await expect(bucketDetail.locator('strong[title="1,001,000,000,000"]').first()).toHaveText('1T');
    await page.getByRole('link', { name: '价格设置', exact: true }).click();
    await expect(page.getByTestId('token-stats-page')).toHaveCount(0);
    await expect(page.getByTestId('token-stats-settings')).toBeVisible();
    await expect(bucketDetail).toHaveCount(0);
    await expect(page.getByTestId('price-mappings-save')).toBeEnabled();
    await expect(page.getByTestId('pricing-catalog-state')).toHaveText(tokenManifest.translations['zh-CN']['settings.empty']);
    await expect(page.getByTestId('pricing-catalog-version')).toHaveText(tokenManifest.translations['zh-CN']['settings.never']);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await page.goto(`${baseUrl}/#/plugins/models-dev${modelsDevManifest.contributes.settings}`);
    await expect(page.getByTestId('models-dev-settings')).toBeVisible();
    await expect(page.getByTestId('token-stats-settings')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(2);
    await expect(page.getByTestId('models-dev-interval')).toHaveValue('24');
    await expect(page.getByTestId('models-dev-timeout')).toHaveValue('15');
    await expect(page.getByTestId('models-dev-state')).toHaveText(modelsDevManifest.translations['zh-CN']['settings.empty']);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/models-dev-settings.png`, fullPage: true });
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
    console.log('Native Token Stats checks passed: LLM defaults, API template persistence, screenshot layout, undo/cancel/persistence, mobile templates, combined KPI, time chart, shared range, native page, sorting/search, keyboard chart, pricing, models.dev settings and responsive layout.');
    await browser.close();
    return;
  }
  if (previewOnly) {
    await expect(page.locator('.grid-stack-item')).toHaveCount(11);
    await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    console.log('Header control sizes:', await page.locator('.dashboard-live, .dashboard-range, [data-testid="dashboard-customize"]').evaluateAll(controls =>
      controls.map(control => ({ control: control.className, height: control.getBoundingClientRect().height }))));
    for (const [width, name] of [[1440, 'desktop'], [768, 'tablet'], [390, 'mobile-default']] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      await expect(page.locator(width < 768 ? '.dashboard-mobile-card' : '.grid-stack-item')).toHaveCount(11);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    }
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
    console.log('Dashboard previews captured with mock statistics and no test plugins.');
    await browser.close();
    return;
  }
  // Exercise status categories separately so the request-chain / attempt fixture remains intact.
  statusFixtures = true;
  await page.reload();
  await expect(statusRows).toHaveCount(4);
  await checkStatusRow(0, ['1,000', '5', '10', '5', '0'], ['98.0%', '0.5%', '1.0%', '0.5%', '0.0%']);
  await checkStatusRow(1, ['0', '0', '13', '0', '0'], ['0.0%', '0.0%', '100.0%', '0.0%', '0.0%']);
  await checkStatusRow(2, ['0', '0', '0', '0', '0'], ['0.0%', '0.0%', '0.0%', '0.0%', '0.0%']);
  await checkStatusRow(3, ['0', '0', '0', '0', '3'], ['0.0%', '0.0%', '0.0%', '0.0%', '100.0%']);
  statusFixtures = false;
  await page.reload();
  await expect(statusRows).toHaveCount(1);
  await edit();
  await recordSheetMotion();
  for (const [width, dismiss] of [[1440, 'escape'], [1024, 'overlay'], [768, 'close'], [390, 'escape'], [320, 'close']] as const) {
    await checkLibraryModal(width, dismiss);
  }
  // Motion preferences and repeated openings must release the lock and preserve library filters.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.dashboard-add-row').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(node => node.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  await closeLibrary();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await library();
  await page.getByRole('textbox', { name: '搜索卡片…' }).fill('请求数趋势');
  await page.getByRole('button', { name: '趋势图 4', exact: true }).click();
  await closeLibrary();
  await library();
  await expect(page.getByRole('textbox', { name: '搜索卡片…' })).toHaveValue('请求数趋势');
  await expect(page.getByRole('button', { name: '趋势图 4', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '定位', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card('chart.requests')).toBeInViewport();
  await expect(card('chart.requests').getByRole('button', { name: '移动「请求数趋势」', exact: true })).toBeFocused();
  await library();
  await page.getByRole('textbox', { name: '搜索卡片…' }).fill('');
  await page.getByRole('button', { name: '全部 15', exact: true }).click();
  await closeLibrary();
  await cancel();
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.grid-stack-item')).toHaveCount(15);
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Plugin demo"]').getByText('Test plugin widget')).toBeVisible();
  // The minimum-height KPI should leave only normal padding below its content.
  await expect.poll(() => page.locator('.dashboard-kpi-card').evaluateAll(cards => Math.max(...cards.map(card =>
    card.getBoundingClientRect().bottom - card.querySelector('[data-testid="kpi-trend"]')!.getBoundingClientRect().bottom
  )))).toBeLessThanOrEqual(28);
  await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 1024, height: 1000 });
  await checkKpiRegions();
  await page.setViewportSize({ width: 768, height: 1000 });
  await checkKpiRegions();
  await page.screenshot({ path: `${evidence}/tablet.png`, fullPage: true });
  const clippedMetrics = await page.locator('.dashboard-kpi-card').evaluateAll(cards => cards.flatMap(card => {
    const bounds = card.getBoundingClientRect();
    return [...card.querySelectorAll('.kpi-value, .kpi-unit, [data-testid="kpi-trend"]')].filter(metric => {
      const rect = metric.getBoundingClientRect();
      return rect.left < bounds.left || rect.right > bounds.right || rect.bottom > bounds.bottom;
    }).map(metric => ({ text: metric.textContent, card: bounds.toJSON(), metric: metric.getBoundingClientRect().toJSON(),
      body: getComputedStyle(card.querySelector('.nx-panel-body')!).padding }));
  }));
  if (clippedMetrics.length) throw new Error(`Clipped tablet metrics: ${JSON.stringify(clippedMetrics)}`);
  await edit();
  await page.screenshot({ path: `${evidence}/tablet-editing.png`, fullPage: true });
  await checkKpiRegions();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Tablet edit controls overflow');
  await cancel();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-mobile-card')).toHaveCount(15);
  await checkKpiRegions();
  await page.setViewportSize({ width: 320, height: 844 });
  await checkKpiRegions();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.dashboard-kpi-card').evaluateAll(cards => Math.max(...cards.map(card =>
    card.getBoundingClientRect().bottom - card.querySelector('[data-testid="kpi-trend"]')!.getBoundingClientRect().bottom
  )))).toBeLessThanOrEqual(20);
  await page.screenshot({ path: `${evidence}/mobile-default.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await edit();
  await expect(page.getByTestId('dashboard-save-layout')).toBeDisabled();
  await checkKpiRegions();
  await card('kpi.rpm').getByRole('button', { name: '移除「每分钟请求数」', exact: true }).click();
  await library();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidence}/library.png`, fullPage: true });
  await page.getByRole('textbox', { name: '搜索卡片…' }).fill('不存在的卡片');
  await expect(page.getByText('没有匹配的卡片', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索卡片…' }).fill('');
  await page.getByRole('button', { name: '指标 5', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加「响应时间趋势」', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加「每分钟请求数」', exact: true }).click();

  await closeLibrary();
  await expect(page.locator('.grid-stack-item')).toHaveCount(15);
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  const firstSaved = await stored();
  if (!firstSaved.cards.some((item: any) => item.id === 'kpi.rpm')) throw new Error('Added card was not saved');
  await page.reload();
  await expect(card('kpi.rpm')).toBeVisible();
  await edit();
  await card('kpi.rpm').getByRole('button', { name: '移除「每分钟请求数」', exact: true }).click();
  await expect(card('kpi.rpm')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.rpm')).toBeVisible();
  await expect(page.getByTestId('dashboard-save-layout')).toBeDisabled();
  // Presets and keyboard resizing must be reflected in actual geometry and persistence.
  await card('kpi.requests').locator('button[title="卡片尺寸"]').click();
  await page.getByRole('menuitemradio', { name: /半宽/ }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-w', '15');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-w', '6');
  const grip = card('kpi.requests').getByRole('button', { name: '移动「总请求数」' });
  await grip.focus(); await page.keyboard.press('Shift+ArrowDown');
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '5');
  await expect.poll(async () => {
    const liveRowHeight = await page.locator('.dashboard-grid').evaluate(node => Number.parseFloat((node as HTMLElement).style.getPropertyValue('--dashboard-row-height')));
    return Math.abs((await card('kpi.requests').boundingBox())!.height - (await card('kpi.rpm').boundingBox())!.height - liveRowHeight);
  }).toBeLessThan(1);
  expect(await card('kpi.requests').locator('.kpi-body').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(
    await card('kpi.rpm').locator('.kpi-body').evaluate(node => node.getBoundingClientRect().height));
  expect(await card('kpi.requests').locator('.kpi-footer').evaluate(node => node.getBoundingClientRect().height)).toBe(
    await card('kpi.rpm').locator('.kpi-footer').evaluate(node => node.getBoundingClientRect().height));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '4');
  // Pointer drag and resize, then cancel, must restore the last saved layout.
  await card('chart.errors').locator('header').scrollIntoViewIfNeeded();
  const header = await card('chart.errors').locator('header').boundingBox();
  await page.mouse.move(header!.x + 120, header!.y + 20); await page.mouse.down();
  await page.mouse.move(header!.x - 300, header!.y + 180, { steps: 15 }); await page.mouse.up();
  await expect(page.getByTestId('dashboard-save-layout')).toBeEnabled();
  await page.screenshot({ path: `${evidence}/editing.png`, fullPage: true });
  await page.getByRole('link', { name: '服务管理', exact: true }).click();
  await expect(page.getByTestId('confirmation-cancel')).toBeVisible();
  await page.getByTestId('confirmation-cancel').click();
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  await cancel();
  if (JSON.stringify(await stored()) !== JSON.stringify(firstSaved)) throw new Error('Cancel mutated the saved layout');
  for (const item of firstSaved.cards) {
    expect(await card(item.id).getAttribute('gs-x') ?? '0').toBe(String(item.x));
    expect(await card(item.id).getAttribute('gs-y') ?? '0').toBe(String(item.y));
    await expect(card(item.id)).toHaveAttribute('gs-w', String(item.w));
    await expect(card(item.id)).toHaveAttribute('gs-h', String(item.h));
  }
  await edit();
  const handle = card('chart.requests').locator('.ui-resizable-se');
  await handle.scrollIntoViewIfNeeded();
  const resizeBox = await handle.boundingBox();
  await page.mouse.move(resizeBox!.x + 14, resizeBox!.y + 14); await page.mouse.down();
  await page.mouse.move(resizeBox!.x + 14, resizeBox!.y + 100, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => Number(await card('chart.requests').getAttribute('gs-h'))).toBeGreaterThan(8);
  const resizedChartHeight = Number(await card('chart.requests').getAttribute('gs-h'));
  // A storage failure keeps the editable draft and the previous saved layout.
  await page.evaluate(key => {
    (window as any).__dashboardSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) { if (name === key) throw new Error('storage unavailable'); return (window as any).__dashboardSetItem.call(this, name, value); };
  }, LAYOUT_KEY);
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-save-layout')).toBeVisible();
  await expect(card('chart.requests')).toHaveAttribute('gs-h', String(resizedChartHeight));
  if (JSON.stringify(await stored()) !== JSON.stringify(firstSaved)) throw new Error('Failed save modified persisted layout');
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__dashboardSetItem; delete (window as any).__dashboardSetItem; });
  await cancel();
  // Automatic statistics refresh is paused while editing.
  await page.waitForLoadState('networkidle');
  await edit(); const beforeCalls = historyCalls;
  await page.clock.install(); await page.clock.fastForward(31_000);
  if (historyCalls !== beforeCalls) throw new Error('Statistics refreshed during layout editing');
  await cancel();
  // Mobile edits must preserve the saved desktop geometry.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-mobile-card')).toHaveCount(15);
  await page.screenshot({ path: `${evidence}/mobile.png`, fullPage: true });
  await edit();
  await page.locator('.dashboard-manage-row').filter({ hasText: '响应时间趋势' }).getByRole('button', { name: '移除「响应时间趋势」', exact: true }).click();
  await page.locator('.dashboard-add-row').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '趋势图 4', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加「响应时间趋势」', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加「响应时间趋势」', exact: true }).click();
  await closeLibrary();
  await expect(page.locator('.dashboard-manage-row')).toHaveCount(15);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.dashboard-manage-row')).toHaveCount(14);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.dashboard-manage-row')).toHaveCount(15);
  await page.screenshot({ path: `${evidence}/mobile-editing.png`, fullPage: true });
  const rows = page.locator('.dashboard-manage-row');
  await rows.first().getByRole('button', { name: '下移' }).click();
  await rows.first().getByRole('radio', { name: '加高' }).click();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  const mobileSaved = await stored();
  if (JSON.stringify(mobileSaved.cards) !== JSON.stringify(firstSaved.cards)) throw new Error('Mobile edit changed desktop geometry');
  if (mobileSaved.mobile[0].id !== 'kpi.success' || mobileSaved.mobile[0].height !== 'tall') throw new Error('Mobile edits were not saved');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Horizontal overflow at ${width}px`);
  }
  // Disabled plugins keep their slot on reload.
  disabledPlugin = true; await page.reload();
  await expect(page.getByText('插件已停用', { exact: true })).toBeVisible();
  // Failed statistics must display an error state; a successful retry restores the charts.
  historyFailure = true; await page.getByRole('button', { name: '立即刷新' }).click();
  await expect(page.getByText('部分运行数据暂时不可用', { exact: true })).toBeVisible();
  historyFailure = false; await page.getByRole('button', { name: '立即刷新' }).click();
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 4, cards: [], mobile: [] })), LAYOUT_KEY);
  await page.reload();
  await expect(page.getByTestId('dashboard-empty')).toBeVisible();
  await page.getByRole('button', { name: '布局模板', exact: true }).click();
  await page.getByTestId('dashboard-template-api').click();
  await expect(page.getByTestId('dashboard-save-layout')).toBeEnabled();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(card('kpi.requests')).toBeVisible();
  // A malformed saved layout falls back to usable defaults.
  await page.evaluate(key => localStorage.setItem(key, '{invalid'), LAYOUT_KEY); await page.reload();
  await expect(card('kpi.rpm')).toBeVisible();
  await expect(page.locator('.grid-stack-item')).toHaveCount(11);
  // Read the deployed v4 key; preserve dimensions while migrating to finer rows.
  await page.evaluate(({ key, coarseKey }) => {
    localStorage.removeItem(key);
    localStorage.setItem(coarseKey, JSON.stringify({ version: 4, cards: [
      { id: 'kpi.rpm', x: 0, y: 0, w: 6, h: 2 }, { id: 'chart.requests', x: 0, y: 2, w: 30, h: 4 },
    ], mobile: [{ id: 'chart.requests', height: 'tall' }, { id: 'kpi.rpm', height: 'compact' }] }));
  }, { key: LAYOUT_KEY, coarseKey: COARSE_LAYOUT_KEY });
  await page.reload();
  await expect(page.locator('.grid-stack-item')).toHaveCount(2);
  await expect(card('kpi.rpm')).toHaveAttribute('gs-h', '4');
  await expect(card('chart.requests')).toHaveAttribute('gs-y', '4');
  await expect(card('chart.requests')).toHaveAttribute('gs-h', '8');
  await edit();
  await card('chart.requests').getByRole('button', { name: '移动「请求数趋势」' }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.getByTestId('dashboard-save-layout').click();
  expect((await stored()).version).toBe(5);
  await page.reload();
  await expect(card('chart.requests')).toHaveAttribute('gs-h', '9');
  await page.evaluate(key => localStorage.removeItem(key), COARSE_LAYOUT_KEY);
  await page.evaluate(({ key, legacyKey }) => {
    localStorage.removeItem(key);
    localStorage.setItem(legacyKey, JSON.stringify({ version: 2,
      cards: [{ id: 'kpi.requests', x: 0, y: 0, w: 3, h: 2 }, { id: 'chart.requests', x: 0, y: 2, w: 12, h: 4 }],
      mobile: [{ id: 'chart.requests', height: 'tall' }, { id: 'kpi.requests', height: 'compact' }] }));
  }, { key: LAYOUT_KEY, legacyKey: LEGACY_LAYOUT_KEY });
  await page.reload();
  await expect(page.locator('.grid-stack-item')).toHaveCount(2);
  await expect(card('chart.requests')).toHaveAttribute('gs-w', '30');
  await edit();
  await card('kpi.requests').getByRole('button', { name: '移动「总请求数」' }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.getByTestId('dashboard-save-layout').click();
  const migrated = await stored();
  if (migrated.version !== 5 || migrated.mobile[0].id !== 'chart.requests' || migrated.mobile[0].height !== 'tall') throw new Error('Legacy layout migration lost mobile preferences');
  await page.evaluate(({ key, previousKey, legacyKey }) => {
    localStorage.removeItem(key); localStorage.removeItem(legacyKey);
    localStorage.setItem(previousKey, JSON.stringify({ version: 3,
      cards: [{ id: 'kpi.requests', x: 0, y: 0, w: 3, h: 2 }, { id: 'chart.requests', x: 3, y: 0, w: 12, h: 4 }],
      mobile: [{ id: 'chart.requests', height: 'tall' }, { id: 'kpi.requests', height: 'compact' }] }));
  }, { key: LAYOUT_KEY, previousKey: PREVIOUS_LAYOUT_KEY, legacyKey: LEGACY_LAYOUT_KEY });
  await page.reload();
  await expect(card('kpi.requests')).toHaveAttribute('gs-w', '6');
  await expect(card('chart.requests')).toHaveAttribute('gs-x', '6');
  await expect(card('chart.requests')).toHaveAttribute('gs-w', '24');
  await edit();
  await expect(page.getByTestId('dashboard-cancel-layout').locator('svg')).toHaveCount(1);
  const migratedHandle = card('chart.requests').locator('.ui-resizable-se');
  await expect(migratedHandle.locator('svg path')).toHaveAttribute('d', 'M12 0V12H0Z');
  await migratedHandle.focus(); await page.keyboard.press('ArrowLeft');
  await expect(card('chart.requests')).toHaveAttribute('gs-w', '23');
  await page.getByTestId('dashboard-save-layout').click();
  const updated = await stored();
  if (updated.version !== 5 || updated.mobile[0].height !== 'tall') throw new Error('Fifteen-column migration lost preferences');
  // Horizontal gaps must survive editing; only gaps above a card are filled.
  await page.evaluate(key => {
    const cards = [
      { id: 'kpi.requests', x: 6, y: 0, w: 6, h: 2 },
      { id: 'kpi.success', x: 12, y: 0, w: 6, h: 2 },
      { id: 'kpi.rpm', x: 12, y: 2, w: 6, h: 2 },
    ];
    localStorage.setItem(key, JSON.stringify({ version: 4, cards, mobile: cards.map(({ id }) => ({ id, height: 'standard' })) }));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(card('kpi.requests')).toHaveAttribute('gs-x', '6');
  await edit();
  await card('kpi.requests').getByRole('button', { name: '移除「总请求数」', exact: true }).click();
  await expect(card('kpi.requests')).toHaveCount(0);
  await expect(card('kpi.success')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '4');
  await card('kpi.success').getByRole('button', { name: '移除「请求成功率」', exact: true }).click();
  await expect.poll(async () => await card('kpi.rpm').getAttribute('gs-y') ?? '0').toBe('0');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '4');
  const successGrip = card('kpi.success').getByRole('button', { name: '移动「请求成功率」' });
  await successGrip.focus(); await page.keyboard.press('Shift+ArrowDown');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '5');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '4');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  const rpmHeader = await card('kpi.rpm').locator('header').boundingBox();
  const rpmBounds = await card('kpi.rpm').boundingBox();
  await page.mouse.move(rpmHeader!.x + 100, rpmHeader!.y + 20); await page.mouse.down();
  await page.mouse.move(rpmHeader!.x + 100 + rpmBounds!.width, rpmHeader!.y + 20, { steps: 15 }); await page.mouse.up();
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '18');
  await expect.poll(async () => await card('kpi.rpm').getAttribute('gs-y') ?? '0').toBe('0');
  await library();
  await page.getByRole('button', { name: '添加「总请求数」', exact: true }).click();
  await closeLibrary();
  await expect(card('kpi.requests')).toBeVisible();
  await expect(card('kpi.success')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '18');
  await page.getByTestId('dashboard-save-layout').click();
  const verticalLayout = await stored();
  expect(verticalLayout.cards.find((item: any) => item.id === 'kpi.rpm')).toMatchObject({ x: 18, y: 0 });
  await page.reload();
  await expect(card('kpi.success')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '18');
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
  console.log('Dashboard browser checks passed: persistence, undo, presets, keyboard resize, drag, cancel, refresh pause, mobile independence, responsive widths, plugin disablement, error recovery, corrupt storage, vertical-only gap filling, modal scroll isolation, focus restoration and enter/exit motion.');
} catch (error) { console.error('Browser errors:', pageErrors); console.error('Page text:', await page.locator('body').innerText()); await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }); throw error; } finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
