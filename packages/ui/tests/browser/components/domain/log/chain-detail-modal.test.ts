import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startUiRuntime } from '../../../../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/chain/index.html'], aliases: [
    { find: "$api/logs", replacement: fileURLToPath(new URL("../../../../fixtures/components/chain/api-logs.js", import.meta.url)) },
    { find: "$i18n", replacement: fileURLToPath(new URL("../../../../fixtures/components/chain/i18n.js", import.meta.url)) },
    { find: "$components/industrial", replacement: fileURLToPath(new URL("../../../../fixtures/components/chain/components-industrial.js", import.meta.url)) },
    { find: "./LogDetailContent.svelte", replacement: fileURLToPath(new URL("../../../../fixtures/components/chain/LogDetailContent.svelte", import.meta.url)) },
  ] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

for (const count of [0, 1, 3]) {
  test(`attempts=${count}: initialize last once; preserve manual collapse and switch`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${runtime.origin}/tests/fixtures/components/chain/index.html`);
      await page.waitForFunction(() => typeof (window as any).start === 'function');
      await page.evaluate(() => (window as any).start({ chainId: 'test-chain' }));
      await page.waitForSelector('[data-loading]');
      expect(await page.locator('[data-detail]').count()).toBe(0);
      await page.evaluate(count => {
        const chain = { chainId: 'test-chain', chainStatus: 200, method: 'POST', chainAttempts: count,
          chainDurationMs: 1234, chainStartTs: 0, path: '/test' };
        // The final-typed success is deliberately NOT last: no status-based selection/sorting.
        const attempts = Array.from({ length: count }, (_, i) => ({ requestId: `attempt-${i}`,
          status: i === 0 ? 200 : 502, requestType: i === 0 ? 'final' : 'retry', duration: 1234 + i,
          transportOutcome: i === 0 ? 'failed' : i === 1 ? 'cancelled' : 'completed',
          attemptUpstream: 'test-upstream-' + 'long-name-'.repeat(18) }));
        (window as any).resolveDetail({ chain, attempts });
      }, count);
      await page.waitForSelector('[data-loading]', { state: 'detached' });
      expect(await page.locator('[data-detail]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-detail'))))
        .toEqual(count ? [`attempt-${count - 1}`] : []);
      const buttons = page.locator('button').filter({ hasText: /^#/ });
      expect(await buttons.count()).toBe(count);
      if (count) {
        const last = buttons.last();
        expect(await last.getAttribute('aria-expanded')).toBe('true');
        const controlled = await last.getAttribute('aria-controls');
        expect(controlled).toBeTruthy();
        expect(await page.locator(`[id="${controlled}"] [data-detail]`).count()).toBe(1);
        if (process.env.CHAIN_DETAIL_SCREENSHOTS && count === 3) {
          await page.screenshot({ path: '/tmp/opencode/chain-detail-default-last.png' });
        }
        await last.focus();
        await page.keyboard.press('Enter');
        await page.evaluate(() => (window as any).refreshTranslation());
        expect(await page.locator('[data-detail]').count()).toBe(0);
        expect(await last.getAttribute('aria-expanded')).toBe('false');
        await page.keyboard.press('Space');
        expect(await last.getAttribute('aria-expanded')).toBe('true');
        if (count > 1) {
          await buttons.first().click();
          await page.evaluate(() => (window as any).refreshTranslation());
          expect(await page.locator('[data-detail]').getAttribute('data-detail')).toBe('attempt-0');
          expect(await last.getAttribute('aria-expanded')).toBe('false');
        }
        for (const width of [1280, 640, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await buttons.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true);
          expect(await buttons.evaluateAll(nodes => nodes.every(node => {
            const chips = node.children[1].children;
            const rects = [...chips].map(chip => chip.getBoundingClientRect());
            return rects.length === 3 && rects.every(rect => Math.abs(rect.top - rects[0].top) < 1 && rect.width > 0);
          }))).toBe(true);
          expect(await page.locator('[data-testid="chain-detail-modal"] > .overflow-y-auto').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          await page.keyboard.press('Tab');
          await buttons.first().focus();
          expect(await buttons.first().evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
          await buttons.first().hover();
          expect(await buttons.first().evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
          if (process.env.CHAIN_DETAIL_SCREENSHOTS && count === 3) {
            await buttons.first().focus();
            await page.screenshot({ path: `/tmp/opencode/chain-detail-${width}.png` });
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 15000);
}
