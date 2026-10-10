import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startUiRuntime } from '../../../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/lazy/index.html'], aliases: [
    { find: "$i18n", replacement: fileURLToPath(new URL("../../../fixtures/components/lazy/i18n.js", import.meta.url)) },
    { find: "$components/industrial/LoadingIndicator.svelte", replacement: fileURLToPath(new URL("../../../fixtures/components/lazy/loading.svelte", import.meta.url)) },
  ] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

test('lazy pages ignore stale loads, retain updated props and reload after a failed import', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${runtime.origin}/tests/fixtures/components/lazy/index.html`);
    await page.getByRole('status').waitFor();
    await page.evaluate(() => {
      (window as any).replaceLoader();
      (window as any).rename('latest');
    });
    await page.waitForFunction(() => typeof (window as any).finishNext === 'function');
    await page.evaluate(() => (window as any).finishFirst());
    await page.waitForTimeout(30);
    expect(await page.locator('[data-page]').count()).toBe(0);
    await page.evaluate(() => (window as any).finishNext());
    await page.locator('[data-page]').waitFor();
    expect(await page.locator('[data-page]').textContent()).toBe('latest');
    await page.evaluate(() => (window as any).rename('updated'));
    await page.waitForFunction(() => document.querySelector('[data-page]')?.textContent === 'updated');
    await page.evaluate(() => (window as any).failOnce());
    await page.getByRole('alert').waitFor();
    expect(await page.locator('[data-page]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).attempts)).toBe(1);
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.getByRole('button', { name: 'pageLoading.retry' }).click(),
    ]);
    await page.getByRole('status').waitFor();
    expect(await page.evaluate(() => (window as any).attempts)).toBeUndefined();
    await page.evaluate(() => (window as any).finishFirst());
    await page.locator('[data-page]').waitFor();
    expect(await page.locator('[data-page]').textContent()).toBe('first');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 15_000);
