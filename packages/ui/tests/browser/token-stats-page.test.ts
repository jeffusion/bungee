import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
const evidence = '/tmp/bungee-token-stats'; mkdirSync(evidence, { recursive: true });
async function chartModule(page: import('playwright').Page) {
 const chunk = (await readdir(new URL('../../dist/assets/', import.meta.url))).find(name => /^vendor-charts-.*\.js$/.test(name));
 if (!chunk) throw new Error('Current build has no Chart.js module');
 await page.addInitScript(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chunk}`);
}

test('Token statistics range, model sorting, chart keyboard and refresh recover independently', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { tokenManifest, nativeRequests, pageErrors } = fixture;
 await chartModule(page);
    const setChartTooltip = (index: number | null) => page.evaluate(async index => {
      const module = await import((window as any).__chartModuleUrl);
      const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
      if (!Chart) throw new Error('Built Chart.js getChart export is missing');
      const chart = Chart.getChart(document.querySelector('[data-testid="token-stats-time-chart"] canvas')!)!;
      if (typeof chart.options.plugins.tooltip.external !== 'function') throw new Error('Missing Chart.js external tooltip');
      chart.tooltip.setActiveElements(index === null ? [] : chart.data.datasets.map((_: unknown, datasetIndex: number) => ({ datasetIndex, index })), { x: 0, y: 0 });
    }, index);
const buckets = page.locator('[data-token-stats-bucket-trigger]');
    await page.goto(`${runtime.origin}/#/extensions/token-stats${tokenManifest.contributes.navigation[0].path}`);
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
      expect(await page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
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
      await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
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
    fixture.nativeFailure = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(tokenManifest.translations['zh-CN']['ui.loadFailed']);
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    fixture.nativeFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    fixture.nativeLargeNumbers = true; fixture.nativeInput = 1_000_000_000_000; fixture.nativeOutput = 1_000_000_000; fixture.nativeCost = 1234.56;
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
    expect(await page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
    await page.screenshot({ path: `${evidence}/token-statistics-large-numbers-mobile.png`, fullPage: true });
    await setChartTooltip(23);
    await expect(bucketDetail).toBeVisible();
    fixture.nativeLimitedModels = true;
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

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}, { viewport: { width: 390, height: 844 } }), 120_000);
