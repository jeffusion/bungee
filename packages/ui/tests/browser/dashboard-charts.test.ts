import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
import { BUILTIN_CARDS, LAYOUT_KEY } from '../../src/components/dashboard/layout';
const runtime = dashboardRuntime();
const evidence = '/tmp/bungee-dashboard-charts'; mkdirSync(evidence, { recursive: true });
async function open(page: import('playwright').Page, ids = BUILTIN_CARDS.map(card => card.id)) {
 const fixture = await connectDashboard(page);
 await page.addInitScript(({ key, ids }) => {
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 5,
   cards: ids.map((id, i) => ({ id, x: i % 2 * 15, y: Math.floor(i / 2) * 8, w: 15, h: 8 })),
   mobile: ids.map(id => ({ id, height: 'standard' })),
  }));
 }, { key: LAYOUT_KEY, ids });
 const chartChunk = (await readdir(new URL('../../dist/assets/', import.meta.url))).find(name => /^vendor-charts-.*\.js$/.test(name));
 if (!chartChunk) throw new Error('Current build has no Chart.js chunk');
 await page.addInitScript(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chartChunk}`);
 await page.goto(runtime.origin); await expect(fixture.card(ids[0])).toBeVisible();
 await expect(page.getByTestId('header-top-menu').locator('[data-menu-icon] svg').first()).toBeVisible();
 await expect.poll(() => page.getByTestId('header-top-menu').locator('[data-menu-icon]').evaluateAll(nodes => nodes.every(node => node.querySelector('svg')))).toBe(true);
 return fixture;
}

test('KPI trends apply range responses and distinguish growth, new, idle and stopped', () => runtime.run(async page => {
 const fixture = await open(page);
 const { card, pageErrors } = fixture;
    const trend = (id: string) => card(id).getByTestId('kpi-trend');
    const refresh = () => page.getByRole('button', { name: '立即刷新', exact: true }).click();
    fixture.trendScenario = 'growth';
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
    fixture.trendScenario = 'new';
    await refresh();
    await expect(trend('kpi.requests')).toContainText('↑ 新增');
    await expect(trend('kpi.rpm')).toContainText('↑ 新增');
    await expect(trend('kpi.requests').locator('.kpi-trend-value')).toHaveClass(/text-emerald-400/);
    for (const scenario of ['idle', 'stopped'] as const) {
      fixture.trendScenario = scenario;
      await refresh();
      await expect(trend('kpi.requests')).toContainText(scenario === 'idle' ? '→ +0.0%' : '↓ -100.0%');
      await expect(trend('kpi.success').locator('.kpi-trend-value')).toHaveText('—');
      await expect(trend('kpi.latency').locator('.kpi-trend-value')).toHaveText('—');
    }
    fixture.trendScenario = 'default';
    await refresh();
    await expect(trend('kpi.requests')).toContainText('↓ -6.1%');

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);

test('linked Dashboard chart tooltips follow real canvas hover, keyboard dismissal and reduced motion', () => runtime.run(async page => {
 const fixture = await open(page, ['chart.requests', 'chart.latency', 'chart.success', 'chart.errors']);
 const { card, pageErrors } = fixture;
    // A real canvas hover drives shared HTML tooltips on all four linked charts.
    await card('chart.requests').scrollIntoViewIfNeeded();
    const hoverTrend = async (index: number | null) => {
      if (index === null) await page.mouse.move(0, 0);
      else {
        const point = await page.evaluate(async index => {
          const module = await import((window as any).__chartModuleUrl);
          const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
          if (!Chart) throw new Error('Built Chart.js getChart export is missing');
          const canvas = document.querySelector<HTMLCanvasElement>('[data-card-id="chart.requests"] canvas')!;
          const chart = Chart.getChart(canvas), point = chart.getDatasetMeta(0).data[index];
          const bounds = canvas.getBoundingClientRect();
          return { x: bounds.left + point.x * bounds.width / chart.width, y: bounds.top + point.y * bounds.height / chart.height };
        }, index);
        await page.mouse.move(point.x, point.y);
      }
      return page.evaluate(async () => {
        const module = await import((window as any).__chartModuleUrl);
        const Chart = Object.values(module).find((value: any) => typeof value?.getChart === 'function') as any;
        return new Promise(resolve => requestAnimationFrame(() => {
          const charts = ['chart.requests', 'chart.latency', 'chart.success', 'chart.errors'].map(id => Chart.getChart(document.querySelector(`[data-card-id="${id}"] canvas`)));
          resolve({ dataDuration: charts[0].options.datasets.line.animation.duration,
            tooltips: charts.map(chart => ({ native: chart.options.plugins.tooltip.enabled,
              external: typeof chart.options.plugins.tooltip.external, index: chart.tooltip.getActiveElements()[0]?.index })) });
        }));
      });
    };
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

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);

test('Dashboard HTTP categories and refresh failure recover independently', () => runtime.run(async page => {
 const fixture = await open(page);
 const { pageErrors } = fixture;
  const statusRows = page.getByTestId('upstream-status-row');
  async function checkStatusRow(index: number, counts: string[], percentages: string[]) {
    for (const [segmentIndex, key] of ['status2xx', 'status3xx', 'status4xx', 'status5xx', 'statusOther'].entries()) {
      const segment = statusRows.nth(index).locator(`[data-status="${key}"]`);
      await expect(segment.locator('dt')).toHaveText(key === 'statusOther' ? '其他' : key.slice(6));
      await expect(segment.locator('dd span').first()).toHaveText(counts[segmentIndex]);
      await expect(segment.locator('dd span').last()).toHaveText(percentages[segmentIndex]);
    }
  }
  // Exercise status categories separately so the request-chain / attempt fixture remains intact.
  fixture.statusFixtures = true;
  await page.reload();
  await expect(statusRows).toHaveCount(4);
  await checkStatusRow(0, ['1,000', '5', '10', '5', '0'], ['98.0%', '0.5%', '1.0%', '0.5%', '0.0%']);
  await checkStatusRow(1, ['0', '0', '13', '0', '0'], ['0.0%', '0.0%', '100.0%', '0.0%', '0.0%']);
  await checkStatusRow(2, ['0', '0', '0', '0', '0'], ['0.0%', '0.0%', '0.0%', '0.0%', '0.0%']);
  await checkStatusRow(3, ['0', '0', '0', '0', '3'], ['0.0%', '0.0%', '0.0%', '0.0%', '100.0%']);
  fixture.statusFixtures = false;
  await page.reload();
  await expect(statusRows).toHaveCount(1);

  fixture.historyFailure = true; await page.getByRole('button', { name: '立即刷新', exact: true }).click();
  await expect(page.getByText('部分运行数据暂时不可用', { exact: true })).toBeVisible();
  fixture.historyFailure = false; await page.getByRole('button', { name: '立即刷新', exact: true }).click();
  await expect(page.getByText('部分运行数据暂时不可用', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);
