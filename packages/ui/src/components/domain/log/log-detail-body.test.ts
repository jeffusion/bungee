import { afterEach, expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type BrowserContext } from 'playwright';

// Mount the real parent with real Svelte scheduling; mock only APIs, i18n
// and leaf controls. The body stub exposes the value passed to the viewer.
const directory = import.meta.dir;
const modules: Record<string, string> = {
  'fixture:entry': `
    import { mount } from 'svelte';
    import Detail from './LogDetailContent.svelte';
    window.start = log => mount(Detail, {
      target: document.body, props: { log, embedded: true, showHeader: false }
    });
  `,
  '$api/config': `
    export async function getConfig() {
      await Promise.resolve();
      if (window.scenario === 'config-failed') throw new Error('Config API 500');
      return { logging: { body: { enabled: window.scenario === 'missing-ids' } } };
    }
  `,
  '$api/logs': `
    window.bodyCalls = [];
    export async function loadBodyById(id) {
      window.bodyCalls.push(id);
      return { content: 'body-' + id };
    }
    export async function loadHeaderById(id) {
      return { 'x-test': 'header-' + id };
    }
  `,
  '$i18n': `import { readable } from 'svelte/store'; export const _ = readable(key => key);`,
  '$components/industrial': `
    export { default as SegmentedControl } from 'fixture:tabs.svelte';
    export { default as LoadingIndicator } from 'fixture:loading.svelte';
  `,
  'fixture:tabs.svelte': `<script>
    import { createEventDispatcher } from 'svelte';
    export let options; export let value; export let ariaLabel;
    const dispatch = createEventDispatcher();
    </script>
    {#each options as option}
      <button data-tab={option.value} on:click={() => dispatch('change', option.value)}>{option.label}</button>
    {/each}`,
  'fixture:loading.svelte': '<span>loading</span>',
  './JsonBodyViewer.svelte': '<script>export let value;</script><pre data-body>{JSON.stringify(value)}</pre>',
};

const bundle = await Bun.build({
  entrypoints: ['fixture:entry'], target: 'browser', format: 'iife', conditions: ['browser'],
  plugins: [{
    name: 'log-detail-fixture',
    setup(build) {
      build.onResolve({ filter: /^\.\/LogDetailContent\.svelte$/ }, () => ({
        path: `${directory}/LogDetailContent.svelte`, namespace: 'file',
      }));
      build.onResolve({ filter: /^(fixture:|\$|\.\/JsonBodyViewer\.svelte$)/ }, args => {
        if (args.path in modules) return { path: args.path, namespace: 'fixture' };
      });
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path.endsWith('.svelte')
          ? compile(modules[args.path], { filename: args.path }).js.code
          : modules[args.path],
        loader: 'js', resolveDir: directory,
      }));
      build.onLoad({ filter: /LogDetailContent\.svelte$/ }, async args => ({
        contents: compile(await Bun.file(args.path).text(), { filename: args.path }).js.code,
        loader: 'js', resolveDir: directory,
      }));
    },
  }],
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'Component fixture compilation failed');
const script = await bundle.outputs[0].text();
const tabs = ['original', 'transformed', 'response'];
let cleanup = async () => {};
afterEach(async () => { await cleanup(); });

for (const scenario of ['config-failed', 'body-disabled', 'missing-ids'] as const) {
  for (const target of tabs) {
    test(`historical body: ${scenario}, ${target}`, async () => {
      let browser: Browser | undefined;
      let context: BrowserContext | undefined;
      let closing: Promise<void> | undefined;
      // Keep cleanup local: a timed-out test's finally must not close the next test.
      const close = () => closing ??= (async () => {
        try { await context?.close(); }
        finally { await browser?.close(); }
      })();
      cleanup = close;
      try {
        // Isolate Chromium as well as its context; no failed session is reused.
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext();
        context.setDefaultTimeout(3000);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const consoleMessages: string[] = [];
        page.on('console', message => {
          consoleMessages.push(`${message.type()}: ${message.text()}`);
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: script });
        await page.evaluate((scenario) => {
          const fixture = window as any;
          fixture.scenario = scenario;
          fixture.start({
            requestId: 'test', timestamp: 0, method: 'POST', path: '/test', status: 200, duration: 1,
            ...(scenario === 'missing-ids' ? {} : {
              originalReqBodyId: 'original', reqBodyId: 'transformed', respBodyId: 'response',
            }),
            originalReqHeaderId: 'original', reqHeaderId: 'transformed', respHeaderId: 'response',
          });
        }, scenario);
        const visited = tabs.slice(0, tabs.indexOf(target) + 1);
        for (const tab of visited) {
          let phase = 'click';
          try {
            if (tab !== 'original') await page.locator(`[data-tab="${tab}"]`).click();
            phase = `header-${tab} and body`;
            await page.waitForFunction(({ tab, missing }) => {
              const root = document.querySelector('[data-testid="logs-detail-content"]');
              const body = root?.querySelector('[data-body]');
              return root?.textContent?.includes('header-' + tab)
                && (missing ? !body : body?.textContent?.includes('body-' + tab));
            }, { tab, missing: scenario === 'missing-ids' });
          } catch (error) {
            const dom = await page.locator('body').textContent().catch(() => '<unavailable>');
            throw new Error(`${scenario}, ${target}: ${tab} ${phase}\nDOM: ${dom}\nconsole: ${JSON.stringify(consoleMessages)}\npageerror: ${JSON.stringify(errors)}`, { cause: error });
          }
        }
        expect(await page.evaluate(() => (window as any).bodyCalls)).toEqual(
          scenario === 'missing-ids' ? [] : visited,
        );
        if (scenario === 'missing-ids') {
          expect(await page.locator('[data-body]').count()).toBe(0);
        } else {
          expect(await page.locator('[data-body]').textContent()).toContain('body-' + target);
        }
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 15000);
  }
}
