import { afterAll, beforeAll, test } from 'bun:test';
import { resolve } from 'node:path';
import { chromium, expect, type Browser, type Page } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { collectApiEvidence } from '../../../../packages/ui/tests/helpers/editors/api-evidence';
import type { TpsRange, TpsStatsResponse } from '../../contract';

const fixture = resolve(import.meta.dir, '../fixtures/widgets.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: [fixture] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

function stats(range: TpsRange, empty = false): TpsStatsResponse {
  const total = { tps: empty ? null : 20, outputTokens: empty ? 0 : 100, generationDurationMs: empty ? 0 : 5000,
    sampleCount: empty ? 0 : 3, estimatedSampleCount: empty ? 0 : 1 };
  return { range, asOfMs: Date.now(), total, reportingIncomplete: false, endpoints: empty ? [] : [
    { ...total, routeId: 'route-1', endpointId: 'slow', tps: 10 },
    { ...total, routeId: 'route-2', endpointId: 'fast', tps: 15 },
    { ...total, routeId: 'route-1', endpointId: 'fast', tps: 30 },
  ] };
}
async function open(page: Page) {
  await page.goto(`${runtime.origin}/@fs${fixture}`);
  await expect(page.getByTestId('overview-refresh')).toBeEnabled();
  await expect(page.getByTestId('endpoints-refresh')).toBeEnabled();
}

test('both cards share reads, range changes, refreshes and the polling timer; unmount resets headers', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const evidence = collectApiEvidence(page), calls: string[] = [];
    await page.clock.install();
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/plugins/llm-tps/control/stats' || route.request().method() !== 'GET') {
        evidence.errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`);
        return route.fulfill({ status: 500, json: { error: 'unexpected_request' } });
      }
      const range = url.searchParams.get('range') as TpsRange;
      calls.push(range); return route.fulfill({ json: stats(range) });
    });
    await open(page);
    expect(calls).toEqual(['24h']);
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(3);
    expect(await page.getByTestId('tps-endpoint-row').evaluateAll(rows => rows.map(row => [row.getAttribute('data-route-id'), row.getAttribute('data-endpoint-id')]))).toEqual([
      ['route-1', 'fast'], ['route-2', 'fast'], ['route-1', 'slow'],
    ]);
    await expect(page.getByTestId('tps-total-samples')).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toContain('Fast endpoint'); expect(text).toContain('较慢端点');
    await expect(page.getByTestId('tps-endpoint-row').first().getByText('/test', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tps-endpoint-row').nth(1).getByText('/other', { exact: true })).toBeVisible();
    expect(text).not.toContain('never-render');
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await expect(page.getByTestId('overview-refresh')).toBeEnabled();
    expect(calls).toEqual(['24h', '1h']);
    await page.getByTestId('endpoints-refresh').click();
    await expect(page.getByTestId('overview-refresh')).toBeEnabled();
    expect(calls).toEqual(['24h', '1h', '1h']);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const beforePoll = calls.length;
    await page.clock.runFor(60_000);
    await expect.poll(() => calls.length).toBe(beforePoll + 1);
    await expect(page.getByTestId('overview-refresh')).toBeEnabled();
    await page.screenshot({ path: '/tmp/llm-tps-widgets-wide.png', fullPage: true });
    await page.getByRole('button', { name: 'Toggle widgets' }).click();
    await expect(page.getByTestId('headers-reset')).toHaveText('reset');
    const afterUnmount = calls.length;
    await page.clock.runFor(60_000); expect(calls.length).toBe(afterUnmount);
    evidence.verify();
  } finally { await context.close(); }
}, 60_000);

test('failed reads clear values; empty and incomplete states remain distinct; all endpoint groups remain accessible', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const evidence = collectApiEvidence(page);
    let mode: 'ready' | 'failure' | 'empty' | 'many' = 'ready';
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/plugins/llm-tps/control/stats' || route.request().method() !== 'GET') {
        evidence.errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`);
        return route.fulfill({ status: 500, json: {} });
      }
      if (mode === 'failure') {
        evidence.expectStatus(route, 503);
        return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      }
      let data = stats(url.searchParams.get('range') as TpsRange, mode === 'empty');
      if (mode === 'many') data = { ...data, reportingIncomplete: true, endpoints: Array.from({ length: 45 }, (_, i) => ({
        ...data.total, routeId: i < 3 ? 'route-1' : `route-${i}`, endpointId: i === 0 ? 'fast' : i === 1 ? 'slow' : `endpoint-${i}`, tps: 100 - i,
      })) };
      return route.fulfill({ json: data });
    });
    await open(page);
    mode = 'failure'; await page.getByTestId('overview-refresh').click();
    await expect(page.getByTestId('tps-error')).toHaveCount(2);
    await expect(page.getByTestId('tps-total-value')).toHaveText('—');
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/llm-tps-widgets-failure.png', fullPage: true });
    mode = 'empty'; await page.getByTestId('overview-refresh').click();
    await expect(page.getByTestId('tps-empty')).toHaveCount(2);
    await expect(page.getByTestId('tps-error')).toHaveCount(0);
    mode = 'many'; await page.getByTestId('endpoints-refresh').click();
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(45);
    await expect(page.getByTestId('tps-incomplete')).toHaveCount(2);
    await page.getByTestId('tps-endpoint-list').focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('tps-endpoint-row').last()).toBeInViewport();
    await page.getByTestId('tps-endpoint-list').evaluate(element => { element.scrollTop = 0; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/llm-tps-widgets-narrow-en.png', fullPage: true });
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.getByTestId('overview-refresh')).toHaveText('刷新');
    await page.screenshot({ path: '/tmp/llm-tps-widgets-narrow-zh.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 780 });
    await page.screenshot({ path: '/tmp/llm-tps-widgets-320-zh.png', fullPage: true });
    evidence.verify();
  } finally { await context.close(); }
}, 60_000);
