import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { expect } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import manifest from '../../../../plugins/chatgpt-oauth/manifest.json';
let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/oauth.html'] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

test('source selection rejects stale account and draft responses and preserves missing account bindings after a failed refresh', async () => {
  for (const scenario of ['accounts', 'draft', 'missing']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let release = () => {}, started = false, fail = scenario === 'missing', drafts = 0;
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const path = new URL(route.request().url()).pathname;
      const respond = (json: unknown, status = 200) => route.fulfill({ json, status });
      if (path === '/api/plugins') return respond([
        { name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
        { name: 'disabled-provider', enabled: false, metadata: { contributes: { upstreamSources: [{ ...manifest.contributes.upstreamSources[0], label: 'Disabled provider' }] } } },
      ]);
      if (path.endsWith('/accounts/draft')) {
        drafts++; started = true;
        await new Promise<void>(resolve => release = resolve);
        return respond({ target: 'https://late.test', bindingOptions: { accountRef: 'account' } });
      }
      if (path.endsWith('/accounts') || path.endsWith('/accounts/codex')) {
        if (scenario === 'accounts') { started = true; await new Promise<void>(resolve => release = resolve); }
        return fail ? respond({ error: 'offline' }, 503) : respond({ accounts: [{ id: 'account', label: 'Available account', available: true }] });
      }
      errors.push(`Unexpected API: ${path}`); return respond({}, 500);
    });
    try {
      await page.goto(`${runtime.origin}/tests/fixtures/oauth.html?picker=${scenario === 'missing' ? 'missing' : 'manual'}`);
      const output = page.getByTestId('picker-upstream');
      if (scenario === 'missing') {
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(output).toContainText('"accountRef":"missing-account"');
        fail = false;
        await page.getByRole('alert').getByRole('button').click();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByRole('combobox')).toContainText('missing-account');
        await expect(output).toContainText('"accountRef":"missing-account"');
      } else {
        await expect(page.getByRole('radio', { name: /Disabled provider/ })).toBeDisabled();
        await page.getByRole('radio', { name: 'ChatGPT OAuth', exact: true }).click();
        if (scenario === 'draft') {
          await page.getByRole('combobox').click();
          await page.getByRole('option', { name: 'Available account', exact: true }).click();
          await page.getByTestId('upstream-account-apply').click();
        }
        await expect.poll(() => started).toBe(true);
        await page.getByRole('button', { name: scenario === 'accounts' ? 'Use manual upstream' : 'Edit endpoint', exact: true }).click();
        release();
        if (scenario === 'accounts') {
          await expect(page.getByRole('radio', { name: 'Manual URL', exact: true })).toBeChecked();
          await expect(output).toContainText('https://manual.test');
          await expect(page.getByRole('combobox')).toHaveCount(0);
        } else {
          await expect(page.getByTestId('upstream-account-apply')).toBeEnabled();
          await expect(output).toContainText('https://newer-edit.test');
          await expect(output).not.toContainText('managedBy');
          expect(drafts).toBe(1);
        }
      }
      expect(errors).toEqual([]);
    } finally { release(); await context.close(); }
  }
}, 90_000);
