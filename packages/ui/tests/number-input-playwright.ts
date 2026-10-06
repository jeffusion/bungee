import { createServer } from 'vite';
import { chromium, expect } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const evidence = process.env.NUMBER_INPUT_EVIDENCE_DIR ?? '/tmp/bungee-number-input-evidence';
await mkdir(evidence, { recursive: true });
const errors: string[] = [];
const checks: string[] = [];
const entry = '/__number-input-entry.js';
const uiRoot = resolve('packages/ui');
process.chdir(uiRoot);
const server = await createServer({ root: uiRoot, configFile: resolve('vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
  plugins: [{ name: 'number-input-test-page',
    resolveId(id) { if (id === entry) return id; },
    load(id) { if (id === entry) return `import {mount} from 'svelte';
      import Fixture from '/tests/fixtures/NumberInputHarness.svelte'; import '/src/app.css';
      mount(Fixture,{target:document.getElementById('fixture')});`; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__number-input-test') return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml(request.url, `<!doctype html><html><body>
            <main id="fixture"></main><script type="module" src="${entry}"></script></body></html>`));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let success = false;
try {
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/__number-input-test`);
  const input = page.getByTestId('number');
  const bound = page.getByTestId('bound-value');
  const increase = page.getByRole('button', { name: 'Increase seconds' });
  const decrease = page.getByRole('button', { name: 'Decrease seconds' });
  await expect(input).toHaveValue('15'); await expect(bound).toHaveText('15');
  checks.push('initial value and binding');
  await page.getByRole('button', { name: 'Set external value' }).click();
  await expect(input).toHaveValue('20'); await expect(bound).toHaveText('20');
  await page.getByRole('button', { name: 'Clear external value' }).click();
  await expect(input).toHaveValue(''); await expect(bound).toHaveText('empty');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('submits')).toHaveText('0');
  expect(await input.evaluate((node: HTMLInputElement) => node.validity.valueMissing)).toBe(true);
  await increase.click(); await expect(input).toHaveValue('5'); await expect(bound).toHaveText('5');
  checks.push('external updates, empty binding and required form validation');
  await input.fill('00015'); await input.press('Tab');
  await expect(input).toHaveValue('15'); await expect(bound).toHaveText('15');
  await input.fill('121'); await input.press('Enter');
  await expect(input).toHaveValue('120'); await expect(bound).toHaveText('120');
  await expect(page.getByTestId('submits')).toHaveText('1');
  await expect(increase).toBeDisabled(); await expect(input).toHaveAttribute('aria-valuenow', '120');
  checks.push('normalization, Enter clamp before submission and boundary accessibility');
  await input.fill('15');
  await page.getByRole('button', { name: 'Toggle readonly' }).click();
  await expect(input).toHaveJSProperty('readOnly', true);
  await expect(increase).toBeDisabled(); await expect(decrease).toBeDisabled();
  await input.press('ArrowUp'); await input.pressSequentially('22');
  await expect(input).toHaveValue('15'); await expect(bound).toHaveText('15');
  await input.evaluate((node: HTMLInputElement) => {
    node.value = '99'; node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect(input).toHaveValue('15'); await expect(bound).toHaveText('15');
  checks.push('readonly actual prop blocks typing, stepping and fallback writes');
  await page.getByRole('button', { name: 'Toggle readonly' }).click();
  await page.getByRole('button', { name: 'Toggle disabled' }).click();
  await expect(input).toBeDisabled(); await expect(increase).toBeDisabled(); await expect(decrease).toBeDisabled();
  await input.evaluate((node: HTMLInputElement) => {
    node.value = '99'; node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect(input).toHaveValue('15'); await expect(bound).toHaveText('15');
  await page.getByRole('button', { name: 'Set external value' }).click();
  await expect(input).toHaveValue('20'); await expect(bound).toHaveText('20');
  checks.push('disabled actual prop blocks editing but accepts external state');
  await page.screenshot({ path: resolve(evidence, 'component.png') });
  expect(errors).toEqual([]);
  success = true;
} finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ success, checks, errors, browserClosed: true, serverClosed: true }, null, 2));
}
