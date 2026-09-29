import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright';

const directory = new URL('../src/components/industrial/', import.meta.url).pathname;
const options = [
  { value: '1h', label: '1h' },
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
];

for (const component of ['SegmentedControl', 'BSegmentedControl'] as const) {
  test(`${component}: real Svelte radios support roving keyboard selection and binding`, async () => {
    const parent = `<script>
      import Control from '${directory}/${component}.svelte';
      let value = $state('12h');
      let options = ${JSON.stringify(options)};
    </script>
    <button data-before>Before</button>
    <Control {options} bind:value ariaLabel="Time range"
      ${component === 'SegmentedControl'
        ? 'on:change={(event) => window.changes.push(event.detail)}'
        : 'onchange={(next) => window.changes.push(next)}'} />
    <output data-value>{value}</output>
    <button data-after>After</button>`;
    const bundle = await Bun.build({
      entrypoints: ['fixture:entry'], target: 'browser', format: 'iife', conditions: ['browser'],
      plugins: [{
        name: 'segmented-control-fixture',
        setup(build) {
          build.onResolve({ filter: /^fixture:entry$/ }, () => ({ path: 'fixture:entry', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `import { mount } from 'svelte'; import Parent from './parent.svelte'; window.changes = []; mount(Parent, { target: document.body });`,
            loader: 'js', resolveDir: directory,
          }));
          build.onResolve({ filter: /^\.\/parent\.svelte$/ }, () => ({ path: 'fixture:parent.svelte', namespace: 'parent' }));
          build.onLoad({ filter: /.*/, namespace: 'parent' }, () => ({
            contents: compile(parent, { filename: 'parent.svelte' }).js.code,
            loader: 'js', resolveDir: directory,
          }));
          build.onLoad({ filter: /\/industrial\/(?:B)?SegmentedControl\.svelte$/ }, async args => ({
            contents: compile(await Bun.file(args.path).text(), { filename: args.path }).js.code,
            loader: 'js', resolveDir: directory,
          }));
        },
      }],
    });
    if (!bundle.success) throw new AggregateError(bundle.logs, 'SegmentedControl fixture compilation failed');

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: await bundle.outputs[0].text() });
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
      await browser.close();
    }
  });
}
