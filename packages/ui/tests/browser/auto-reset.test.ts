import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { observeNetwork } from '../helpers/dashboard/network';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('auto reset', async () => {
// Tailwind's content paths are relative to the UI package, including plugin UI.
const manifest = JSON.parse(await readFile(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
const uiRuntime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/oauth.html'] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let collectDiagnostics: (() => Promise<string>) | undefined;
try {
    browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  // Bounded, passive input trail for CI failures; never records text or key contents.
  await page.addInitScript(() => {
    const events: unknown[] = [];
    const ids = new WeakMap<Element, number>();
    let nextId = 0;
    const idOf = (element: Element) => {
      let id = ids.get(element);
      if (!id) ids.set(element, id = ++nextId);
      return id;
    };
    const describe = (element: Element | null) => element && {
      id: idOf(element), tag: element.tagName, role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'), checked: element.getAttribute('aria-checked'),
    };
    const push = (entry: unknown) => {
      events.push(entry);
      if (events.length > 200) events.shift();
    };
    const record = (type: string, phase: 'capture' | 'bubble', event: Event) => {
      const keyboard = event as KeyboardEvent;
      push({
        t: +performance.now().toFixed(2), type, phase,
        ...('key' in event && (keyboard.code === 'Space' || keyboard.key === ' ') ? { space: true, repeat: keyboard.repeat } : {}),
        target: describe(event.target instanceof Element ? event.target : null),
        active: describe(document.activeElement), defaultPrevented: event.defaultPrevented,
        isTrusted: event.isTrusted, hasFocus: document.hasFocus(),
      });
    };
    for (const type of ['keydown', 'keyup', 'keypress', 'click', 'focusin', 'focusout']) {
      window.addEventListener(type, event => record(type, 'capture', event), true);
      window.addEventListener(type, event => record(type, 'bubble', event), false);
    }
    new MutationObserver(records => {
      for (const entry of records) {
        const target = entry.target;
        if (target instanceof Element && target.getAttribute('role') === 'switch')
          push({ t: +performance.now().toFixed(2), type: 'aria-checked', target: describe(target),
            from: entry.oldValue, to: target.getAttribute('aria-checked') });
      }
    }).observe(document, { attributes: true, attributeFilter: ['aria-checked'], attributeOldValue: true, subtree: true });
    (window as any).__autoResetDiagnostics = () => events.slice();
  });
  collectDiagnostics = async () => JSON.stringify(await page.evaluate(() => (window as any).__autoResetDiagnostics?.() ?? []));
  const errors: string[] = [];
  observeNetwork(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  const fixtureOrigin = uiRuntime.origin;
  const resetConfig = { enabled: false, leadMinutes: 30, lowBalanceEnabled: false, remainingPercent: 10 };
  const settings: unknown[] = [];
  const resets: unknown[] = [];
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
      resets.push(request.postDataJSON());
      return respond({ outcome: 'already_redeemed', windowsReset: 0 });
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage') {
      return respond({
        usage: { state: 'fresh', primary: { usedPercent: 50, windowSeconds: 18000 } },
        resetCredits: { state: 'fresh', availableCount: 0, credits: [] },
      });
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts') { return respond({ accounts: [{ id: 'simulation-account', label: 'Simulation',
      status: 'active', available: true, identity: { planType: 'plus' }, autoResetCredits: resetConfig.enabled, autoResetLeadMinutes: resetConfig.leadMinutes,
      autoResetOnLowBalance: resetConfig.lowBalanceEnabled, autoResetRemainingPercent: resetConfig.remainingPercent,
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
  await lowBalance.press('Space');
  await expect(lowBalance).toHaveAttribute('aria-checked', 'true');
  assert.equal(settings.length, 0, 'editing strategy values must not save or consume a card');
  await dialog.getByRole('button', { name: 'Save strategies', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(settings, [{ accountRef: 'simulation-account', enabled: false, leadMinutes: 45, lowBalanceEnabled: true, remainingPercent: 20 }]);

  // Reproduce focus entering the switch before the dialog's delayed autofocus runs.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await configure.press('Enter');
  await dialog.waitFor();
  assert.equal(await nearExpiry.getAttribute('aria-checked'), 'false', 'the near-expiry strategy remains independent');
  assert.equal(await lowBalance.getAttribute('aria-checked'), 'true');
  await nearExpiry.focus();
  await page.clock.runFor(1);
  await page.keyboard.press('Space');
  await page.clock.resume();
  await expect(nearExpiry).toHaveAttribute('aria-checked', 'true');
  assert.equal(settings.length, 1, 'changing the other strategy must also wait for explicit save');
  await dialog.getByRole('button', { name: 'Save strategies', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(settings[1], { accountRef: 'simulation-account', enabled: true, leadMinutes: 45, lowBalanceEnabled: true, remainingPercent: 20 });
  await expect(configure).toBeEnabled();
  assert.equal(resets.length, 0, 'the UI must not implement a browser-driven reset timer');

  assert.deepEqual(errors, []);

} catch (error) {
  try {
    const diagnostics = await collectDiagnostics?.();
    if (diagnostics) console.error(`[auto-reset diagnostics] ${diagnostics}`);
  } catch {
    // Diagnostics must never replace the original failure.
  }
  throw error;
} finally {
  try { await browser?.close(); } finally { await uiRuntime.close(); }
}
}, 240_000);
