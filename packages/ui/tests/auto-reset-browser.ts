/** All accounts and control endpoints are simulated. No production server or browser profile. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import appConfig from '../vite.config';

const cacheDir = await mkdtemp(join(tmpdir(), 'bungee-auto-reset-ui-'));
const root = fileURLToPath(new URL('../', import.meta.url));
// Tailwind's content paths are relative to the UI package, including plugin UI.
process.chdir(root);
const manifest = JSON.parse(await readFile(new URL('../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
const server = await createServer({ ...appConfig, configFile: false, root, cacheDir,
  optimizeDeps: { entries: ['tests/fixtures/oauth.html'], include: ['deepmerge', 'cmdk-sv', 'lucide-svelte/icons/search'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 0, proxy: {} } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.httpServer!.address();
  assert(address && typeof address !== 'string');
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  let enabled = false;
  let pending = false;
  let usageUnavailable = false;
  const settings: unknown[] = [];
  const resets: unknown[] = [];
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const expiresAt = Date.now() + 600000;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== fixtureOrigin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/control/accounts/auto-reset')) {
      const body = request.postDataJSON(); settings.push(body); enabled = body.enabled;
      return respond({});
    }
    if (url.pathname.endsWith('/control/accounts/usage/reset')) {
      resets.push(request.postDataJSON()); pending = false;
      return respond({ outcome: 'already_redeemed', windowsReset: 0 });
    }
    if (url.pathname.endsWith('/control/accounts/usage')) return respond(usageUnavailable ? {
      usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' },
    } : {
      usage: { state: 'fresh', primary: { usedPercent: 50, windowSeconds: 18000 } },
      resetCredits: { state: 'fresh', availableCount: 0, credits: [] },
    });
    if (url.pathname.endsWith('/control/accounts')) return respond({ accounts: [{ id: 'simulation-account', label: 'Simulation',
      status: 'active', available: true, autoResetCredits: enabled,
      ...(pending ? { pendingAutoReset: { creditId: 'simulation-credit', redeemRequestId: requestId, expiresAt, completed: false } } : {}),
    }] });
    if (url.pathname === '/api/plugins') return respond([{ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } }]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: { ...manifest } });
    throw new Error(`Unmocked simulation API: ${request.method()} ${url.pathname}`);
  });
  await page.goto(`${fixtureOrigin}/tests/fixtures/oauth.html`);
  const status = page.getByTestId('auto-reset-status');
  const toggle = page.getByRole('switch', { name: 'Auto reset: Simulation' });
  await status.getByText('Automatic reset disabled', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(/The server refreshes the credit list every 5 minutes/).waitFor();
  assert.equal(settings.length, 0, 'opening the confirmation must not enable automation');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'the switch must reflect persisted state before confirmation');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(settings.length, 0, 'cancelling must not change automatic reset');
  await toggle.focus();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await status.getByText('Automatic reset enabled (30 minutes before expiry)', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(settings, [{ accountRef: 'simulation-account', enabled: true }]);
  assert.equal(resets.length, 0, 'the UI must not implement a browser-driven reset timer');
  await page.setViewportSize({ width: 320, height: 850 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'English narrow layout must not overflow');

  await page.evaluate(() => (window as any).setTestLocale('zh'));
  await status.getByText('自动重置已开启（到期前 30 分钟）', { exact: true }).waitFor();
  const chineseToggle = page.getByRole('switch', { name: '自动重置: Simulation' });
  for (const width of [1100, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const heading = await page.getByTestId('reset-heading').boundingBox();
    const button = await chineseToggle.boundingBox();
    const track = await page.getByTestId('auto-reset-track').boundingBox();
    assert(heading && button && track);
    assert.equal(track.width, 30); assert.equal(track.height, 16);
    assert.equal(button.height, 24);
    assert(Math.abs(heading.x + heading.width - button.x - button.width) <= 1, 'toggle stays at the right of the heading');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'narrow layout must not overflow');
  }
  await page.screenshot({ path: '/tmp/bungee-auto-reset-toggle-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.screenshot({ path: '/tmp/bungee-auto-reset-toggle-desktop.png', fullPage: true });
  await chineseToggle.click();
  await dialog.getByText(/停止为此账号安排自动重置/).waitFor();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await status.getByText('自动重置已关闭', { exact: true }).waitFor();
  assert.equal(await chineseToggle.getAttribute('aria-checked'), 'false');
  assert.deepEqual(settings[1], { accountRef: 'simulation-account', enabled: false });

  pending = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '处理未知重置结果' }).click();
  await dialog.getByRole('button', { name: '重试相同额度', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(resets, [{ accountRef: 'simulation-account', creditId: 'simulation-credit', redeemRequestId: requestId }]);
  usageUnavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('额度详情不可用', { exact: true }).waitFor();
  await chineseToggle.waitFor();
  await page.getByRole('button', { name: '更多操作: Simulation' }).click();
  assert.equal(await page.getByRole('menuitem', { name: /自动重置/ }).count(), 0, 'automatic reset is no longer hidden in the dropdown');
  assert.deepEqual(errors, []);
  console.log('PASS: simulated compact heading switch, keyboard/cancel, English/Chinese, narrow layouts, unavailable usage and pending reset resolution');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
