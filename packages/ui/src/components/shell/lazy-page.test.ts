import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright';

const directory = import.meta.dir;
const source = await Bun.file(`${directory}/LazyPage.svelte`).text();
const modules: Record<string, string> = {
  'fixture:entry': `
    import { mount } from 'svelte';
    import Host from 'fixture:host.svelte';
    mount(Host, { target: document.body });
  `,
  'fixture:host.svelte': `
    <script>
      import LazyPage from './LazyPage.svelte';
      import Page from 'fixture:page.svelte';
      let load = $state(() => new Promise(resolve => { window.finishFirst = () => resolve({ default: Page }); }));
      let props = $state({ name: 'first' });
      window.rename = name => { props = { name }; };
      window.replaceLoader = () => {
        load = () => new Promise(resolve => { window.finishNext = () => resolve({ default: Page }); });
      };
      window.failOnce = () => {
        window.attempts = 0;
        load = () => ++window.attempts === 1
          ? Promise.reject(new Error('simulated network failure'))
          : Promise.resolve({ default: Page });
      };
    </script>
    <LazyPage {load} {props} />
  `,
  'fixture:page.svelte': '<script>let { name } = $props();</script><p data-page>{name}</p>',
  '$i18n': `import { writable } from 'svelte/store'; export const _ = writable(key => key);`,
  '$components/industrial/LoadingIndicator.svelte': '<div role="status">Loading</div>',
};
const compiled = compile(source, { filename: `${directory}/LazyPage.svelte` });
expect(compiled.warnings).toEqual([]);
const bundle = await Bun.build({
  entrypoints: ['fixture:entry'], target: 'browser', format: 'iife', conditions: ['browser'],
  plugins: [{ name: 'lazy-page-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/LazyPage\.svelte$/ }, () => ({
      path: `${directory}/LazyPage.svelte`, namespace: 'file',
    }));
    build.onResolve({ filter: /^(fixture:|\$)/ }, args => {
      if (args.path in modules) return { path: args.path, namespace: 'fixture' };
    });
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
      contents: args.path.endsWith('.svelte') ? compile(modules[args.path], { filename: args.path }).js.code : modules[args.path],
      loader: 'js', resolveDir: directory,
    }));
    build.onLoad({ filter: /LazyPage\.svelte$/ }, () => ({
      contents: compiled.js.code, loader: 'js', resolveDir: directory,
    }));
  } }],
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'Lazy page fixture compilation failed');
const script = await bundle.outputs[0].text();

test('lazy pages ignore stale loads, retain updated props and reload after a failed import', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://lazy-page.test/', route => route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><html><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }));
    await page.goto('https://lazy-page.test/');
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
  } finally { await browser.close(); }
}, 15_000);
