import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { readdir } from 'node:fs/promises';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
async function readyTokenWidgets(page: import('playwright').Page) {
 const branch = page.viewportSize()!.width < 768 ? '.dashboard-mobile-card' : '.grid-stack-item';
 const overview = page.locator(branch).filter({ has: page.getByTestId('token-stats-overview') });
 const time = page.locator(branch).filter({ has: page.getByTestId('plugin-widget-token-stats') });
 await expect(overview).toBeVisible(); await expect(time.locator('canvas')).toBeVisible();
 await expect(overview.getByTestId('token-stats-overview')).toHaveAttribute('aria-busy', 'false');
}
async function chartModule(page: import('playwright').Page) {
 const chunk = (await readdir(new URL('../../dist/assets/', import.meta.url))).find(name => /^vendor-charts-.*\.js$/.test(name));
 if (!chunk) throw new Error('Current build has no Chart.js module');
 await page.addInitScript(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chunk}`);
}

test('native Token host and shared range keep current metrics usable', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { card, tokenManifest, checkKpiRegions, nativeRequests, pageErrors } = fixture;
 await chartModule(page);
 await page.goto(runtime.origin);
 await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.2K');
    const setChartTooltip = (index: number | null) => page.evaluate(async index => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      const chart = Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!;
      if (typeof chart.options.plugins.tooltip.external !== 'function') throw new Error('Missing Chart.js external tooltip');
      chart.tooltip.setActiveElements(index === null ? [] : chart.data.datasets.map((_: unknown, datasetIndex: number) => ({ datasetIndex, index })), { x: 0, y: 0 });
    }, index);

    const nativeCard = card('plugin:native:token-stats:token-stats-time');
    const overviewCard = card('plugin:native:token-stats:token-stats-overview');
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
    fixture.cancellationFixture = true;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('50.0');
    // The LLM template omits the upstream failure card; its failure trend remains visible.
    await expect(card('chart.failures')).toHaveCount(0);
    await expect(card('chart.upstreams')).toContainText('成功请求 2 · 50.00%');
    await expect(card('chart.upstreams')).toContainText('失败请求 2 · 50.00%');
    await expect(card('chart.errors')).toContainText('失败率 50.00%');
    fixture.cancellationFixture = false;
    await page.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(card('kpi.success').locator('.kpi-value')).toHaveText('98.5');
    // Reproduce the reported value lengths and check rendered text, not just CSS.
    fixture.nativeInput = 1_900_000; fixture.nativeOutput = 11_900; fixture.nativeCost = 0.6287;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.9M');
    await expect(page.getByTestId('token-stats-metric-output').locator('.overview-value')).toHaveText('11.9K');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveText('$0.63');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveAttribute('title', '$0.6287');
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      await readyTokenWidgets(page);
      await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toBeVisible();
      await expect.poll(() => page.locator('.overview-value').evaluateAll(nodes => nodes.filter(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), bounds = node.getBoundingClientRect();
        return text.width > bounds.width + 1 || getComputedStyle(node).textOverflow === 'ellipsis';
      }).length)).toBe(0);
    }
    fixture.nativeCost = 0.00012345;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveText('$0');
    await expect(page.getByTestId('token-stats-metric-cost').locator('.overview-value')).toHaveAttribute('title', '$0.00012345');
    await expect.poll(() => page.locator('.overview-value').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length)).toBe(0);
    fixture.nativeInput = 1200; fixture.nativeOutput = 600; fixture.nativeCost = 0.078;
    await overviewCard.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('token-stats-metric-input').locator('.overview-value')).toHaveText('1.2K');
    await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(13);
    // Programmatic Chart.js activation must drive the shared HTML tooltip, also on empty buckets.
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
    for (const width of [768, 1920]) {
      await page.setViewportSize({ width, height: 1080 });
      await readyTokenWidgets(page);
      await checkKpiRegions(3);
      if (await page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)) throw new Error(`LLM template overflows at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await readyTokenWidgets(page);
    await page.getByRole('radio', { name: '12h', exact: true }).click();
    await expect.poll(() => nativeRequests.some(query => query.includes('range=12h'))).toBe(true);
    await expect(page.getByTestId('token-stats-trend-input')).toContainText('较上个1小时');
    await page.setViewportSize({ width: 390, height: 844 });
    await readyTokenWidgets(page);
    await expect(page.getByTestId('token-stats-overview')).toBeVisible();
    await expect(page.locator('[data-token-stats-bucket-trigger]')).toHaveCount(13);
    if (await page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)) throw new Error('Token dashboard causes horizontal overflow');

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);

test('Token templates save, undo and cancel independently', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { card, stored, edit, cancel, nativeRequests, pageErrors } = fixture;
 await chartModule(page);
 await page.goto(runtime.origin);
 await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.2K');
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
    // A saved API layout stays unchanged when plugin metadata arrives on reload.
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-api').click();
    await page.getByTestId('dashboard-save-layout').click();
    await page.reload();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await expect(page.locator('[data-card-id^="plugin:"]')).toHaveCount(0);
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await expect(page.getByTestId('dashboard-template-api')).toBeVisible();
    await page.getByTestId('dashboard-template-llm').click();
    await readyTokenWidgets(page);
    await expect(page.locator('.grid-stack-item')).toHaveCount(13);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-llm').click();
    await readyTokenWidgets(page);
    await cancel();
    await expect(page.locator('.grid-stack-item')).toHaveCount(10);
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-llm').click();
    await readyTokenWidgets(page);
    await page.getByTestId('dashboard-save-layout').click();
    await page.reload();
    await expect(page.locator('.grid-stack-item')).toHaveCount(13);
    await expect(card('plugin:native:token-stats:token-stats-time').locator('canvas')).toBeVisible();
    const before = await stored();
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-api').click();
    await cancel();
    await readyTokenWidgets(page);
    expect(await stored()).toEqual(before);
    await page.setViewportSize({ width: 390, height: 844 });
    await readyTokenWidgets(page);
    await expect(page.locator('.dashboard-mobile-card')).toHaveCount(13);
    await edit();
    await page.getByTestId('dashboard-templates').click();
    await page.getByTestId('dashboard-template-api').click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.dashboard-manage-row')).toHaveCount(13);
    await cancel();
    await readyTokenWidgets(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await readyTokenWidgets(page);

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);
