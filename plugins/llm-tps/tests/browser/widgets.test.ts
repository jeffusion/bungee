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
  return { range, asOfMs: Date.now(), total, history: empty ? [] : Array.from({ length: 12 }, (_, i) => ({ ...total, bucketStartMs: i * 60000, tps: [38,42,40,48,46,53,49,58,55,63,59,56.2][i]! })), reportingIncomplete: false, endpoints: empty ? [] : [
    { ...total, routeId: '/chat/', upstreamHost: 'slow.actual.example.com', tps: 10 },
    { ...total, routeId: '/agents/', upstreamHost: 'fast.actual.example.com:8443', tps: 15 },
    { ...total, routeId: '/chat/', upstreamHost: 'fast.actual.example.com:8443', tps: 30 },
  ], models: empty ? [] : [
    { ...total, routeId: '/chat/', model: 'gpt-4.1-mini', tps: 94.6 },
    { ...total, routeId: '/agents/', model: 'gpt-4.1-mini', tps: 71.3 },
    { ...total, routeId: '/chat/', model: 'gemini-2.5-pro', tps: 63.8 },
  ] };
}
async function open(page: Page) {
  await page.goto(`${runtime.origin}/@fs${fixture}`);
  await expect(page.getByTestId('overview-refresh')).toBeEnabled();
  await expect(page.getByTestId('endpoints-refresh')).toBeEnabled();
  await expect(page.getByTestId('models-refresh')).toBeEnabled();
}

test('all three cards share reads, range changes, refreshes and the polling timer; unmount resets headers', async () => {
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
      calls.push(range);
      return route.fulfill({ json: stats(range) });
    });
    await open(page);
    expect(calls).toEqual(['24h']);
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(3);
    expect(await page.getByTestId('tps-endpoint-row').evaluateAll(rows => rows.map(row => [row.getAttribute('data-route-id'), row.getAttribute('data-upstream-host')]))).toEqual([
      ['/chat/', 'fast.actual.example.com:8443'], ['/agents/', 'fast.actual.example.com:8443'], ['/chat/', 'slow.actual.example.com'],
    ]);
    await expect(page.getByTestId('tps-endpoint-row').last().getByText('slow.actual.example.com', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tps-endpoint-row').first().getByText('fast.actual.example.com:8443', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tps-endpoint-row').first().getByText('/chat/', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tps-endpoint-row').nth(1).getByText('/agents/', { exact: true })).toBeVisible();
    expect(await page.getByTestId('tps-model-row').evaluateAll(rows => rows.map(row => [row.getAttribute('data-route-id'), row.getAttribute('data-model')]))).toEqual([
      ['/chat/', 'gpt-4.1-mini'], ['/agents/', 'gpt-4.1-mini'], ['/chat/', 'gemini-2.5-pro'],
    ]);
    await expect(page.getByTestId('tps-model-row').first().getByText('/chat/', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tps-model-row').nth(1).getByText('/agents/', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await expect(page.getByTestId('overview-refresh')).toBeEnabled();
    expect(calls).toEqual(['24h', '1h']);
    await page.getByTestId('models-refresh').click();
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

test('failed reads clear all cards; model-only empty results remain distinct; every group remains accessible', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const evidence = collectApiEvidence(page);
    let mode: 'ready' | 'failure' | 'empty' | 'models-empty' | 'many' = 'ready';
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
      if (mode === 'models-empty') data = { ...data, models: [] };
      if (mode === 'many') data = { ...data, reportingIncomplete: true, endpoints: Array.from({ length: 45 }, (_, i) => ({
        ...data.total, routeId: i < 3 ? '/chat/' : `/route-${i}/`, upstreamHost: i === 0 ? '[2001:db8::1]:8443' : `upstream-${i}.example.com`, tps: 100 - i,
      })), models: Array.from({ length: 45 }, (_, i) => ({
        ...data.total, routeId: '/chat/', model: i === 0 ? 'model-with-an-unusually-long-name-that-must-remain-readable-in-narrow-cards' : `model-${i}`, tps: 400 - i,
      })) };
      return route.fulfill({ json: data });
    });
    await open(page);
    mode = 'models-empty'; await page.getByTestId('models-refresh').click();
    await expect(page.getByTestId('tps-models').getByTestId('tps-empty')).toBeVisible();
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(3);
    await expect(page.getByTestId('tps-model-row')).toHaveCount(0);
    const readyTotal = await page.getByTestId('tps-total-value').innerText();
    mode = 'failure'; await page.getByTestId('overview-refresh').click();
    await expect(page.getByTestId('tps-error')).toHaveCount(3);
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(0);
    expect(await page.getByTestId('tps-total-value').innerText()).not.toBe(readyTotal);
    await page.screenshot({ path: '/tmp/llm-tps-widgets-failure.png', fullPage: true });
    mode = 'empty'; await page.getByTestId('overview-refresh').click();
    await expect(page.getByTestId('tps-empty')).toHaveCount(3);
    await expect(page.getByTestId('tps-error')).toHaveCount(0);
    mode = 'many'; await page.getByTestId('endpoints-refresh').click();
    await expect(page.getByTestId('tps-endpoint-row')).toHaveCount(45);
    await expect(page.getByTestId('tps-model-row')).toHaveCount(45);
    evidence.verify();
  } finally { await context.close(); }
}, 60_000);
