import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { observeNetwork } from '../helpers/dashboard/network';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('auto reset', async () => {
// Tailwind's content paths are relative to the UI package, including plugin UI.
const manifest = JSON.parse(await readFile(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
const uiRuntime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/oauth.html'] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
    browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors: string[] = [];
  observeNetwork(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  const fixtureOrigin = uiRuntime.origin;
  let enabled = false;
  let pending = false;
  let usageUnavailable = false;
  const settings: unknown[] = [];
  const resets: unknown[] = [];
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const expiresAt = Date.now() + 600000;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== fixtureOrigin) {
      if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.fulfill({ contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'text/plain', body: '' });
      errors.push(`Unexpected external resource: ${request.url()}`); return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const expectedMethod = ['/api/plugins/chatgpt-oauth/control/accounts/auto-reset', '/api/plugins/chatgpt-oauth/control/accounts/usage/reset'].includes(url.pathname) ? 'POST' : 'GET';
    if (request.method() !== expectedMethod) throw new Error(`Unexpected method: ${request.method()} ${url.pathname}`);
    const respond = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/auto-reset') {
      const body = request.postDataJSON(); settings.push(body); enabled = body.enabled;
      return respond({});
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage/reset') {
      resets.push(request.postDataJSON()); pending = false;
      return respond({ outcome: 'already_redeemed', windowsReset: 0 });
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage') return respond(usageUnavailable ? {
      usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' },
    } : {
      usage: { state: 'fresh', primary: { usedPercent: 50, windowSeconds: 18000 } },
      resetCredits: { state: 'fresh', availableCount: 0, credits: [] },
    });
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts') return respond({ accounts: [{ id: 'simulation-account', label: 'Simulation',
      status: 'active', available: true, autoResetCredits: enabled,
      ...(pending ? { pendingAutoReset: { creditId: 'simulation-credit', redeemRequestId: requestId, expiresAt, completed: false } } : {}),
    }] });
    if (url.pathname === '/api/plugins') return respond([{ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } }]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: { ...manifest } });
    throw new Error(`Unmocked simulation API: ${request.method()} ${url.pathname}`);
  });
  await page.goto(`${fixtureOrigin}/tests/fixtures/oauth.html`);
  const toggle = page.getByRole('switch', { name: 'Auto reset: Simulation' });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(settings.length, 0, 'opening the confirmation must not enable automation');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'the switch must reflect persisted state before confirmation');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(settings.length, 0, 'cancelling must not change automatic reset');
  await toggle.focus();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(settings, [{ accountRef: 'simulation-account', enabled: true }]);
  assert.equal(resets.length, 0, 'the UI must not implement a browser-driven reset timer');

  await toggle.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.deepEqual(settings[1], { accountRef: 'simulation-account', enabled: false });

  pending = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve unknown reset' }).click();
  await dialog.getByRole('button', { name: 'Retry same credit', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(resets, [{ accountRef: 'simulation-account', creditId: 'simulation-credit', redeemRequestId: requestId }]);
  usageUnavailable = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
  await toggle.waitFor();
  assert.deepEqual(errors, []);

} finally {
  try { await browser?.close(); } finally { await uiRuntime.close(); }
}
}, 240_000);
