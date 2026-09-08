import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import theme from '../../../../tailwind.config.js';

// Same in-memory Svelte/Playwright pattern as log-detail-body.test.ts.
// Only the API, translations and child detail are mocked; accordion state is real.
const directory = import.meta.dir;
const source = await Bun.file(`${directory}/ChainDetailModal.svelte`).text();
const modules: Record<string, string> = {
  'fixture:entry': `
    import { mount } from 'svelte';
    import Detail from './ChainDetailModal.svelte';
    window.start = chain => mount(Detail, { target: document.body, props: { chain, onClose() {} } });
  `,
  '$api/logs': `export const getChainDetail = () => new Promise(resolve => { window.resolveDetail = resolve; });`,
  '$i18n': `import { writable } from 'svelte/store';
    const translate = key => ({ 'logs.requestType_retry': '重试', 'logs.requestType_final': '最终请求',
      'logs.chain.timelineTitle': '尝试时间线', 'logs.chain.detailTitle': '请求链详情',
      'logs.chain.overview': '请求链概览' }[key] || '测试字段');
    export const _ = writable(translate);
    window.refreshTranslation = () => _.set(key => translate(key));`,
  '$components/industrial': `export { default as LoadingIndicator } from 'fixture:loading.svelte';`,
  'fixture:loading.svelte': '<span data-loading>loading</span>',
  './LogDetailContent.svelte': '<script>export let log; export let showHeader; export let embedded;</script><div data-detail={log.requestId}>测试详情（无真实日志正文）</div>',
};
const bundle = await Bun.build({
  entrypoints: ['fixture:entry'], target: 'browser', format: 'iife', conditions: ['browser'],
  plugins: [{ name: 'chain-detail-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/ChainDetailModal\.svelte$/ }, () => ({
      path: `${directory}/ChainDetailModal.svelte`, namespace: 'file',
    }));
    build.onResolve({ filter: /^(fixture:|\$|\.\/LogDetailContent\.svelte$)/ }, args => {
      if (args.path in modules) return { path: args.path, namespace: 'fixture' };
    });
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
      contents: args.path.endsWith('.svelte') ? compile(modules[args.path], { filename: args.path }).js.code : modules[args.path],
      loader: 'js', resolveDir: directory,
    }));
    build.onLoad({ filter: /ChainDetailModal\.svelte$/ }, args => ({
      contents: compile(source, { filename: args.path }).js.code, loader: 'js', resolveDir: directory,
    }));
  } }],
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'Component fixture compilation failed');
const script = await bundle.outputs[0].text();
// Compile only this fixture's utility CSS in memory, not the application build.
const css = (await postcss([tailwindcss({ ...theme, content: [{ raw: source, extension: 'svelte' }] })])
  .process(await Bun.file(new URL('../../../app.css', import.meta.url)).text(), { from: undefined })).css;

for (const count of [0, 1, 3]) {
  test(`attempts=${count}: initialize last once; preserve manual collapse and switch`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<!doctype html><html data-theme="industrial"><body></body></html>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as any).start({ chainId: 'test-chain' }));
      await page.waitForSelector('[data-loading]');
      expect(await page.locator('[data-detail]').count()).toBe(0);
      await page.evaluate(count => {
        const chain = { chainId: 'test-chain', chainStatus: 200, method: 'POST', chainAttempts: count,
          chainDurationMs: 1234, chainStartTs: 0, path: '/test' };
        // The final-typed success is deliberately NOT last: no status-based selection/sorting.
        const attempts = Array.from({ length: count }, (_, i) => ({ requestId: `attempt-${i}`,
          status: i === 0 ? 200 : 502, requestType: i === 0 ? 'final' : 'retry', duration: 1234 + i,
          attemptUpstream: 'test-upstream-' + 'long-name-'.repeat(18) }));
        (window as any).resolveDetail({ chain, attempts });
      }, count);
      await page.waitForSelector('[data-loading]', { state: 'detached' });
      expect(await page.locator('[data-detail]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-detail'))))
        .toEqual(count ? [`attempt-${count - 1}`] : []);
      const buttons = page.locator('button').filter({ hasText: /^#/ });
      expect(await buttons.count()).toBe(count);
      expect(await buttons.evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node.parentElement!);
        return [style.backgroundColor, style.borderTopWidth, style.padding];
      }))).toEqual(Array.from({ length: count }, () => ['rgb(10, 11, 14)', '1px', '0px']));
      expect(await page.locator('section[aria-labelledby="chain-timeline-title"]').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.backgroundColor, style.borderTopWidth, style.paddingLeft];
      })).toEqual(['rgba(0, 0, 0, 0)', '0px', '0px']);
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
        for (const width of [1280, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await buttons.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true);
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
      await browser.close();
    }
  }, 15000);
}
