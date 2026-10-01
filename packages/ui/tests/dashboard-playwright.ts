import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';
import { LAYOUT_KEY, PREVIOUS_LAYOUT_KEY, LEGACY_LAYOUT_KEY } from '../src/components/dashboard/layout';
import * as fs from 'node:fs';

const baseUrl = process.env.DASHBOARD_BASE_URL ?? 'http://127.0.0.1:5185';
const evidence = process.env.DASHBOARD_EVIDENCE_DIR ?? '/tmp/bungee-dashboard-evidence';
const previewOnly = process.argv.includes('--preview');
const nativeOnly = process.argv.includes('--native');
const tokenManifest = nativeOnly ? await Bun.file(new URL('../../../plugins/token-stats/manifest.json', import.meta.url)).json() : null;
fs.mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', error => pageErrors.push(error.message));
let historyCalls = 0, historyFailure = false, disabledPlugin = false;
const nativeRequests: string[] = [];
const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = config.config.logical_configuration as any;
logical.services = ['openai-pool', 'anthropic-pool', 'gemini-pool', 'billing-api'].map((name, i) => ({ id: `service-${i}`, position: i, name,
  endpoints: Array.from({ length: i === 0 ? 3 : 2 }, (_, j) => ({ id: `ep-${i}-${j}`, position: j, url: `https://${name}.example.com`, weight: 1, priority: 0, is_disabled: false, plugins: [] })), plugins: [] }));
logical.routes = ['/v1/chat/completions', '/v1/messages', '/v1beta/models', '/api/billing'].map((path, i) => ({ id: `route-${i}`, position: i, path, service_id: `service-${i}`, plugins: [] }));
const statistics = { timestamps: Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 30, 4, i * 5)).toISOString()),
  requests: [1240,1360,1450,1510,1590,1650,1810,1800,1710,1660,1520,1450], errors: [8,27,9,11,9,9,16,14,18,11,7,20],
  responseTime: [85,88,84,90,94,87,83,79,84,82,85,90], successRate: [99.35,98.01,99.38,99.27,99.43,99.45,99.12,99.22,98.95,99.33,99.54,98.62] };
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true } });
  if (nativeOnly && url.pathname === '/api/plugin-translations') return route.fulfill({ json: Object.fromEntries(
    Object.entries(tokenManifest.translations).map(([language, messages]) => [language, { plugins: { 'token-stats': messages } }])) });
  if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
  if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
  if (url.pathname === '/api/runtime/upstreams') return route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null,
    admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: logical.services.flatMap((service: any) => service.endpoints.map((endpoint: any, j: number) => ({
      state_key: service.name, upstream_id: endpoint.id, circuit_state: service.name === 'gemini-pool' && j === 1 ? 'HALF_OPEN' : 'HEALTHY',
      active_request_count: 0, last_used_time: null, last_used_complete: true, last_failure_time: null, last_failure_complete: true, workers: [],
    }))) } });
  if (url.pathname === '/api/stats/history/v2') { historyCalls++; return historyFailure ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) : route.fulfill({ json: statistics }); }
  if (url.pathname === '/api/stats/upstream-stats') return route.fulfill({ json: { type: url.searchParams.get('type'), data: [
    { upstream: 'https://api.openai.com', count: 1000, failedRequests: 20, percentage: 62.5 }, { upstream: 'https://api.anthropic.com', count: 600, failedRequests: 10, percentage: 37.5 },
  ] } });
  if (url.pathname === '/api/stats/upstream-status-codes') return route.fulfill({ json: { data: [{ upstream: 'https://api.openai.com', status2xx: 1000, status3xx: 5, status4xx: 10, status5xx: 5, totalRequests: 1020 }] } });
  if (url.pathname === '/api/plugins/demo/sandbox') return route.fulfill({ json: { sandbox: 'allow-scripts', allowedHostActions: [], controlAllowlist: [] } });
  if (url.pathname === '/api/plugins/token-stats/control/stats') {
    nativeRequests.push(url.search);
    return route.fulfill({ json: { groupBy: 'model', logicalRequests: 12, upstreamAttempts: 12,
      totalInputTokens: 1200, totalOutputTokens: 600, estimatedCostUsd: 0.02,
      authorityBreakdown: { input: { official: 12 }, output: { official: 12 } },
      data: Array.from({ length: 12 }, (_, i) => ({ dimension: `model-${i}`, logicalRequests: 1, upstreamAttempts: 1,
        officialInputTokens: 100, officialOutputTokens: 50, estimatedCostUsd: 0.001,
        authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } })),
    } });
  }
  if (url.pathname === '/api/plugins') return route.fulfill({ json: previewOnly ? [] : nativeOnly
    ? [{ name: 'token-stats', enabled: true, metadata: { ...tokenManifest, contributes: { ...tokenManifest.contributes,
        nativeWidgets: tokenManifest.contributes.nativeWidgets.map((widget: any) => ({ ...widget, props: { pluginName: 'intruder', selectedRange: '24h' } })),
      } } },
      { name: 'intruder', enabled: true, metadata: { contributes: { nativeWidgets: tokenManifest.contributes.nativeWidgets } } }]
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

try {
  await page.goto(baseUrl);
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  await expect(card('kpi.requests')).toBeVisible();
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  // Exercise a real hover event: both the source and linked tooltips must animate.
  const tooltipMotion = await page.evaluate(async () => {
    const moduleUrl = '/node_modules/.vite/deps/chart__js.js';
    const { Chart } = await import(moduleUrl);
    const canvas = document.querySelector<HTMLCanvasElement>('[data-card-id="chart.requests"] canvas')!;
    const chart = Chart.getChart(canvas);
    const point = chart.getDatasetMeta(0).data[2];
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: bounds.left + point.x, clientY: bounds.top + point.y }));
    const motion = await new Promise<{ dataDuration: number; tooltips: { position: boolean; opacity: boolean }[] }>(resolve => requestAnimationFrame(() => {
      const tooltips = ['chart.requests', 'chart.latency', 'chart.success', 'chart.errors'].map(id => {
        const linked = Chart.getChart(document.querySelector(`[data-card-id="${id}"] canvas`));
        const animations = linked.tooltip.$animations;
        return { position: !!animations?.x?.active(), opacity: !!animations?.opacity?.active() };
      });
      resolve({ dataDuration: chart.options.datasets.line.animation.duration, tooltips });
    }));
    canvas.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    return motion;
  });
  expect(tooltipMotion.dataDuration).toBe(0);
  expect(tooltipMotion.tooltips).toEqual(Array.from({ length: 4 }, () => ({ position: true, opacity: true })));
  if (nativeOnly) {
    const nativeCard = card('plugin:native:token-stats:token-stats-chart');
    await expect(nativeCard).toHaveAttribute('gs-w', '30');
    await expect(page.locator('[data-card-id^="plugin:native:intruder:"]')).toHaveCount(0);
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    expect(nativeRequests.length).toBeGreaterThan(0);
    expect(nativeRequests.every(query => query.includes('range=1h'))).toBe(true);
    const checkContent = async () => {
      const list = page.getByTestId('token-stats-model-list');
      const bounds = await list.boundingBox();
      if (!bounds || bounds.height < 50) throw new Error('Native model list has no usable height');
      await expect.poll(() => list.evaluate(node => {
        node.scrollTop = node.scrollHeight;
        return node.lastElementChild!.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom;
      })).toBeLessThanOrEqual(1);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Native widget causes horizontal overflow');
    };
    await checkContent();
    await page.getByRole('radio', { name: '12h', exact: true }).click();
    await expect.poll(() => nativeRequests.some(query => query.includes('range=12h'))).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.dashboard-mobile-card[data-card-id="plugin:native:token-stats:token-stats-chart"]')).toBeVisible();
    await checkContent();
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
    console.log('Native Token Stats checks passed: ownership guard, protected host props, full-width default, scrollable model list, shared range and mobile height.');
    await browser.close();
    process.exit(0);
  }
  if (previewOnly) {
    await expect(page.locator('.grid-stack-item')).toHaveCount(14);
    await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    console.log('Header control sizes:', await page.locator('.dashboard-live, .dashboard-range, [data-testid="dashboard-customize"]').evaluateAll(controls =>
      controls.map(control => ({ control: control.className, height: control.getBoundingClientRect().height }))));
    for (const [width, name] of [[1440, 'desktop'], [768, 'tablet'], [390, 'mobile-default']] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      await expect(page.locator(width < 768 ? '.dashboard-mobile-card' : '.grid-stack-item')).toHaveCount(14);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    }
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
    console.log('Dashboard previews captured with mock statistics and no test plugins.');
    await browser.close();
    process.exit(0);
  }
  await expect(page.locator('.grid-stack-item')).toHaveCount(15);
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Plugin demo"]').getByText('Test plugin widget')).toBeVisible();
  // The minimum-height KPI should leave only normal padding below its content.
  await expect.poll(() => page.locator('.dashboard-kpi-card').evaluateAll(cards => Math.max(...cards.map(card =>
    card.getBoundingClientRect().bottom - card.querySelector('[data-testid="kpi-trend"]')!.getBoundingClientRect().bottom
  )))).toBeLessThanOrEqual(28);
  await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
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
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Tablet edit controls overflow');
  await cancel();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-mobile-card')).toHaveCount(15);
  await expect.poll(() => page.locator('.dashboard-kpi-card').evaluateAll(cards => Math.max(...cards.map(card =>
    card.getBoundingClientRect().bottom - card.querySelector('[data-testid="kpi-trend"]')!.getBoundingClientRect().bottom
  )))).toBeLessThanOrEqual(20);
  await page.screenshot({ path: `${evidence}/mobile-default.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await edit();
  await expect(page.getByTestId('dashboard-save-layout')).toBeDisabled();
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
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '3');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '2');
  // Pointer drag and resize, then cancel, must restore the last saved layout.
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
  await expect(card('chart.requests')).toHaveAttribute('gs-h', '5');
  // A storage failure keeps the editable draft and the previous saved layout.
  await page.evaluate(key => {
    (window as any).__dashboardSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) { if (name === key) throw new Error('storage unavailable'); return (window as any).__dashboardSetItem.call(this, name, value); };
  }, LAYOUT_KEY);
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-save-layout')).toBeVisible();
  await expect(card('chart.requests')).toHaveAttribute('gs-h', '5');
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
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.getByTestId('dashboard-save-layout')).toBeEnabled();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(card('kpi.requests')).toBeVisible();
  // A malformed saved layout falls back to usable defaults.
  await page.evaluate(key => localStorage.setItem(key, '{invalid'), LAYOUT_KEY); await page.reload();
  await expect(card('kpi.requests')).toBeVisible();
  await expect(page.locator('.grid-stack-item')).toHaveCount(14);
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
  if (migrated.version !== 4 || migrated.mobile[0].id !== 'chart.requests' || migrated.mobile[0].height !== 'tall') throw new Error('Legacy layout migration lost mobile preferences');
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
  if (updated.version !== 4 || updated.mobile[0].height !== 'tall') throw new Error('Fifteen-column migration lost preferences');
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
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '2');
  await card('kpi.success').getByRole('button', { name: '移除「成功率」', exact: true }).click();
  await expect.poll(async () => await card('kpi.rpm').getAttribute('gs-y') ?? '0').toBe('0');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '2');
  const successGrip = card('kpi.success').getByRole('button', { name: '移动「成功率」' });
  await successGrip.focus(); await page.keyboard.press('Shift+ArrowDown');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '3');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '2');
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
  console.log('Dashboard browser checks passed: persistence, undo, presets, keyboard resize, drag, cancel, refresh pause, mobile independence, responsive widths, plugin disablement, error recovery, corrupt storage, vertical-only gap filling.');
} catch (error) { console.error('Browser errors:', pageErrors); console.error('Page text:', await page.locator('body').innerText()); await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }); throw error; } finally { await browser.close(); }
