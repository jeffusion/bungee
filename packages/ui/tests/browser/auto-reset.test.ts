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
  const resetConfig = { enabled: false, leadMinutes: 30, lowBalanceEnabled: false, remainingPercent: 10 };
  let pending = false;
  let usageUnavailable = false;
  let accountReads = 0;
  const usageReads: string[] = [];
  const usageRequestWaiters: Array<() => void> = [];
  const waitForUsageRead = () => new Promise<void>(resolve => usageRequestWaiters.push(resolve));
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
      const body = request.postDataJSON() as typeof resetConfig & { accountRef: string };
      settings.push(body);
      Object.assign(resetConfig, body);
      return respond({});
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage/reset') {
      resets.push(request.postDataJSON()); pending = false;
      return respond({ outcome: 'already_redeemed', windowsReset: 0 });
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage') {
      usageReads.push(url.searchParams.get('accountRef') ?? '');
      usageRequestWaiters.shift()?.();
      return respond(usageUnavailable ? {
        usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' },
      } : {
        usage: { state: 'fresh', primary: { usedPercent: 50, windowSeconds: 18000 } },
        resetCredits: { state: 'fresh', availableCount: 0, credits: [] },
      });
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts') { accountReads++; return respond({ accounts: [{ id: 'simulation-account', label: 'Simulation',
      status: 'active', available: true, identity: { planType: 'plus' }, autoResetCredits: resetConfig.enabled, autoResetLeadMinutes: resetConfig.leadMinutes,
      autoResetOnLowBalance: resetConfig.lowBalanceEnabled, autoResetRemainingPercent: resetConfig.remainingPercent,
      ...(pending ? { pendingAutoReset: { creditId: 'simulation-credit', redeemRequestId: requestId, expiresAt, completed: false } } : {}),
    }] }); }
    if (url.pathname === '/api/plugins') return respond([{ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } }]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: { ...manifest } });
    throw new Error(`Unmocked simulation API: ${request.method()} ${url.pathname}`);
  });
  await page.goto(`${fixtureOrigin}/tests/fixtures/oauth.html`);
  const configure = page.getByRole('button', { name: 'Reset strategies' });
  await configure.waitFor();
  await configure.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const nearExpiry = dialog.getByRole('switch', { name: 'Reset before expiry' });
  const lowBalance = dialog.getByRole('switch', { name: 'Auto reset when weekly quota is low' });
  assert.equal(await nearExpiry.getAttribute('aria-checked'), 'false');
  assert.equal(await lowBalance.getAttribute('aria-checked'), 'false');
  assert.equal(settings.length, 0, 'opening settings must not enable automation');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(settings.length, 0, 'cancelling must not change reset strategies');

  await configure.click();
  await dialog.waitFor();
  await dialog.getByRole('spinbutton').nth(0).fill('45');
  await dialog.getByRole('spinbutton').nth(1).fill('20');
  await lowBalance.focus();
  await page.keyboard.press('Space');
  assert.equal(settings.length, 0, 'editing strategy values must not save or consume a card');
  await dialog.getByRole('button', { name: 'Save strategies', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(settings, [{ accountRef: 'simulation-account', enabled: false, leadMinutes: 45, lowBalanceEnabled: true, remainingPercent: 20 }]);
  assert.equal(resets.length, 0, 'the UI must not implement a browser-driven reset timer');

  await configure.click();
  await dialog.waitFor();
  assert.equal(await nearExpiry.getAttribute('aria-checked'), 'false', 'the near-expiry strategy remains independent');
  assert.equal(await lowBalance.getAttribute('aria-checked'), 'true');
  await nearExpiry.focus();
  await page.keyboard.press('Space');
  assert.equal(settings.length, 1, 'changing the other strategy must also wait for explicit save');
  await dialog.getByRole('button', { name: 'Save strategies', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(settings[1], { accountRef: 'simulation-account', enabled: true, leadMinutes: 45, lowBalanceEnabled: true, remainingPercent: 20 });

  const localRefresh = page.getByRole('button', { name: 'Refresh usage + reset-card data', exact: true });
  await localRefresh.and(page.locator('[aria-busy="false"]')).waitFor();
  const accountsBeforeLocalRefresh = accountReads, usageBeforeLocalRefresh = usageReads.length;
  const usageRead = waitForUsageRead();
  await localRefresh.click();
  await usageRead;
  assert.equal(accountReads, accountsBeforeLocalRefresh, 'per-account refresh must not reload the account list');
  assert.deepEqual(usageReads.slice(usageBeforeLocalRefresh), ['simulation-account'], 'per-account refresh must request only that account usage and reset-card data');

  pending = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve unknown reset' }).click();
  await dialog.getByRole('button', { name: 'Retry same credit', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(resets, [{ accountRef: 'simulation-account', creditId: 'simulation-credit', redeemRequestId: requestId }]);
  usageUnavailable = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
  await configure.waitFor();
  assert.deepEqual(errors, []);

} finally {
  try { await browser?.close(); } finally { await uiRuntime.close(); }
}
}, 240_000);
