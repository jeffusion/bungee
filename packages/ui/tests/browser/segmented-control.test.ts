import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/segmented/index.html'] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
const options = [{value:'1h'}, {value:'12h'}, {value:'24h'}];
for (const component of ['SegmentedControl', 'BSegmentedControl'] as const) {
  test(`${component}: real Svelte radios support roving keyboard selection and binding`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${runtime.origin}/tests/fixtures/components/segmented/index.html?modern=${component === 'BSegmentedControl'}`);
      await page.getByRole('radio').first().waitFor();
      const radios = page.getByRole('radio');
      const check = async (index: number, changes: string[]) => {
        expect(await radios.evaluateAll(nodes => nodes.map(node => ({
          checked: node.getAttribute('aria-checked'), tab: node.getAttribute('tabindex'),
        })))).toEqual(options.map((_, i) => ({ checked: String(i === index), tab: i === index ? '0' : '-1' })));
        expect(await page.locator('[data-value]').innerText()).toBe(options[index].value);
        expect(await page.evaluate(() => (window as any).changes)).toEqual(changes);
      };
      expect(await page.getByRole('radiogroup', { name: 'Time range' }).count()).toBe(1);
      await check(1, []);
      await radios.nth(1).focus();
      await page.keyboard.press('ArrowRight');
      await check(2, ['24h']);
      expect(await radios.nth(2).evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press('ArrowRight');
      await check(0, ['24h', '1h']);
      await page.keyboard.press('ArrowLeft');
      await check(2, ['24h', '1h', '24h']);
      await page.keyboard.press('ArrowUp');
      await check(1, ['24h', '1h', '24h', '12h']);
      await page.keyboard.press('ArrowDown');
      await check(2, ['24h', '1h', '24h', '12h', '24h']);
      await page.keyboard.press('Home');
      await check(0, ['24h', '1h', '24h', '12h', '24h', '1h']);
      await page.keyboard.press('End');
      await check(2, ['24h', '1h', '24h', '12h', '24h', '1h', '24h']);
      await page.keyboard.press('Tab');
      expect(await page.locator('[data-after]').evaluate(node => node === document.activeElement)).toBe(true);
      await radios.nth(1).click();
      await check(1, ['24h', '1h', '24h', '12h', '24h', '1h', '24h', '12h']);
      await page.keyboard.press('Space');
      await check(1, ['24h', '1h', '24h', '12h', '24h', '1h', '24h', '12h']);
      await page.keyboard.press('Enter');
      await check(1, ['24h', '1h', '24h', '12h', '24h', '1h', '24h', '12h']);
      await page.keyboard.press('Tab');
      expect(await page.locator('[data-after]').evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press('Shift+Tab');
      expect(await radios.nth(1).evaluate(node => node === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
}
