import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { expect } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { recordResponseDelivery, holdResponseJson, waitForResponseReceipt, releaseResponseJson, waitForResponseDelivery } from '../helpers/editors/response-delivery';
import { collectApiEvidence } from '../helpers/editors/api-evidence';
import manifest from '../../../../plugins/chatgpt-oauth/manifest.json';
const fixture=resolve(import.meta.dir,'../fixtures/editors/source-picker.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: [fixture] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

test('source selection rejects stale account and draft responses and preserves missing account bindings after a failed refresh', async () => {
  for (const scenario of ['accounts', 'draft', 'missing']) {
    const context = await browser.newContext();
    try {
    const page = await context.newPage();
    await recordResponseDelivery(page, '/api/plugins/chatgpt-oauth/control/accounts/codex');
    await recordResponseDelivery(page, '/api/plugins/chatgpt-oauth/control/accounts/draft');
    const evidence=collectApiEvidence(page),errors=evidence.errors;
    let started = false, fail = scenario === 'missing', drafts = 0;
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const path = new URL(route.request().url()).pathname;
      const respond = (json: unknown, status = 200) => {if(status>=400)evidence.expectStatus(route,status);return route.fulfill({json,status});};
      if (path === '/api/plugins' && route.request().method() === 'GET') return respond([
        { name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
        { name: 'disabled-provider', enabled: false, metadata: { contributes: { upstreamSources: [{ ...manifest.contributes.upstreamSources[0], label: 'Disabled provider' }] } } },
      ]);
      if (path === '/api/plugins/chatgpt-oauth/control/accounts/draft' && route.request().method() === 'POST') {
        drafts++; started = true;
        return respond({ target: 'https://late.test', bindingOptions: { accountRef: 'account' } });
      }
      if ((path === '/api/plugins/chatgpt-oauth/control/accounts' || path === '/api/plugins/chatgpt-oauth/control/accounts/codex') && route.request().method() === 'GET') {
        if (scenario === 'accounts') started = true;
        return fail ? respond({ error: 'offline' }, 503) : respond({ accounts: [{ id: 'account', label: 'Available account', available: true }, {id:'unavailable',label:'Unavailable account',available:false}] });
      }
      errors.push(`Unexpected API: ${path}`); return respond({}, 500);
    });
      await page.goto(`${runtime.origin}/@fs${fixture}?picker=${scenario === 'missing' ? 'missing' : 'manual'}`);
      const output = page.getByTestId('picker-upstream');
      if (scenario === 'missing') {
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(output).toContainText('"accountRef":"missing-account"');
        fail = false;
        await page.getByRole('alert').getByRole('button').click();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByRole('combobox')).toContainText('missing-account');
        await page.getByRole('combobox').click();
        await expect(page.getByRole('option', {name:/missing-account/})).toHaveAttribute('aria-disabled','true');
        await page.keyboard.press('Escape');
        await expect(output).toContainText('"accountRef":"missing-account"');
      } else {
        await holdResponseJson(page,'superseded-source',{method:scenario === 'accounts'?'GET':'POST',path:scenario === 'accounts'?'/api/plugins/chatgpt-oauth/control/accounts/codex':'/api/plugins/chatgpt-oauth/control/accounts/draft'});
        await expect(page.getByRole('radio', { name: /Disabled provider/ })).toBeDisabled();
        await page.getByRole('radio', { name: 'ChatGPT OAuth', exact: true }).click();
        if (scenario === 'draft') {
          await page.getByRole('combobox').click();
          await expect(page.getByRole('option', {name:'Unavailable account · Unavailable',exact:true})).toHaveAttribute('aria-disabled','true');
          await page.getByRole('option', { name: 'Available account', exact: true }).click();
          await page.getByTestId('upstream-account-apply').click();
        }
        await expect.poll(() => started).toBe(true);
        const oldSourceResponse=await waitForResponseReceipt(page,'superseded-source');
        await page.getByRole('button', { name: scenario === 'accounts' ? 'Use manual upstream' : 'Edit endpoint', exact: true }).click();
        await releaseResponseJson(page,oldSourceResponse);
        await waitForResponseDelivery(page,oldSourceResponse);
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
      expect(errors).toEqual([]); evidence.verify();
    } finally { await context.close(); }
  }
}, 90_000);
