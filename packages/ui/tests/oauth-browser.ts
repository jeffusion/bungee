/** Run: bun --cwd packages/ui tests/oauth-browser.ts
 * Isolated mounted interaction fixture. All API traffic is mocked; no core server or production browser. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import appConfig from '../vite.config';
const manifest = JSON.parse(await readFile(new URL('../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ ...appConfig, configFile: false, root,
  optimizeDeps: { entries: ['tests/fixtures/oauth.html'], include: ['deepmerge'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 5199, proxy: {} } });
await server.listen();
console.log('Fixture server ready');
const browser = await chromium.launch({ headless: true });
try {
  console.log('Fixture browser ready');
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  let starts = 0, statuses = 0, commits = 0, holdStart = true, holdAction = true, statusError = '', accountError = false, invalidStart = false;
  let releaseStart = () => {}, releaseAction = () => {};
  let callbackBody: any;
  const accounts = [{ id: 'account-1', label: 'Primary', available: true, status: 'active', identity: { email: 'test@example.test' } },
    { id: 'unavailable', label: 'Unavailable account', available: false, status: 'disabled' }];
  const serviceId = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
  const config = { logical_configuration: { plugins: [], routes: [], auth: { enabled: false, tokens: [] }, services: [
    { id: serviceId, name: 'existing-service', position: 0, plugins: [], endpoints: [] },
  ] }, plugin_activations: [] };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/__ui/api/') && !url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__ui/api/plugins') return respond([
      { name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
      { name: 'disabled-provider', enabled: false, metadata: { contributes: { upstreamSources: [{ ...manifest.contributes.upstreamSources[0], label: 'Disabled provider' }] } } },
    ]);
    if (url.pathname.includes('/control/accounts') && request.method() === 'GET') return accountError ? respond({ error: 'disposed' }, 503) : respond({ accounts });
    if (url.pathname.endsWith('/login/device') || url.pathname.endsWith('/login/pkce')) {
      starts++;
      if (holdStart) await new Promise<void>(resolve => releaseStart = resolve);
      return respond({ sessionId: invalidStart ? ' ' : `session-${starts}`, expiresAt: Date.now() + 300000, ...(url.pathname.endsWith('/device')
        ? { userCode: `CODE-${starts}`, verificationUri: 'https://auth.openai.com/codex/device' }
        : { authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' }) });
    }
    if (url.pathname.endsWith('/login/status')) {
      statuses++;
      return statusError ? respond({ error: statusError }, 404) : respond({ sessionId: `session-${starts}`, kind: 'device', state: 'pending', expiresAt: Date.now() + 300000 });
    }
    if (url.pathname.endsWith('/login/callback')) { callbackBody = request.postDataJSON(); return respond({ accepted: true }); }
    if (url.pathname.endsWith('/accounts/rename')) { if (holdAction) await new Promise<void>(resolve => releaseAction = resolve); return respond({}); }
    if (url.pathname.endsWith('/accounts/draft')) return respond({ target: 'https://chatgpt.com/backend-api/codex/responses', bindingOptions: { accountRef: 'account-1' } });
    if (request.method() === 'PUT') { commits++; return respond({ error: 'unexpected_commit' }, 500); }
    if (url.pathname.startsWith('/__ui/api/config')) return respond({ config, revision: 1, content_hash: 'fixture' });
    throw new Error(`Unmocked API: ${request.method()} ${url.pathname}`);
  });
  const address = server.httpServer!.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/__ui/tests/fixtures/oauth.html`;
  const dialog = page.getByRole('dialog');
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const busyCannotDismiss = async () => {
    await page.keyboard.press('Escape');
    await page.mouse.click(3, 3);
    assert.equal(await dialog.count(), 1);
    const buttons = await dialog.getByRole('button', { name: 'Close', exact: true }).all();
    assert(buttons.length >= 2);
    for (const button of buttons) assert(await button.isDisabled());
  };
  await page.goto(base);
  console.log('Fixture page mounted');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start login', exact: true }).click();
  await dialog.getByRole('button', { name: 'Creating session…', exact: true }).waitFor();
  await busyCannotDismiss();
  holdStart = false; releaseStart();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor(); assert.equal(starts, 1);
  assert.equal(await dialog.getByRole('button', { name: 'Start login', exact: true }).count(), 0);
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-account-id="account-1"]').getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Sign in again', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await dialog.getByText(/different account is in progress/).waitFor(); assert.equal(starts, 1);
  for (const code of ['not_found', 'expired']) {
    statusError = code;
    await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await dialog.getByRole('button', { name: 'Start login', exact: true }).waitFor();
    const count = statuses; await page.waitForTimeout(2200); assert.equal(statuses, count, `${code} must stop polling`);
    statusError = '';
    if (code === 'not_found') { await dialog.getByRole('button', { name: 'Start login', exact: true }).click(); await dialog.getByText('CODE-2', { exact: true }).waitFor(); }
  }
  invalidStart = true;
  await dialog.getByRole('button', { name: 'Start login', exact: true }).click();
  await dialog.getByText('Invalid server response. Refresh and try again.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Refresh status', exact: true }).count(), 0);
  assert(await dialog.getByRole('button', { name: 'Start login', exact: true }).isEnabled());
  invalidStart = false;
  // Callback input is never copied into storage or navigation.
  await dialog.getByRole('radio', { name: 'Browser sign-in (alternative)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start login', exact: true }).click();
  await dialog.getByLabel('Complete callback URL').fill('http://localhost/auth/callback?code=fixture-secret');
  await dialog.getByRole('button', { name: 'Submit callback URL', exact: true }).click();
  assert.equal(await dialog.getByLabel('Complete callback URL').inputValue(), '');
  assert.equal(callbackBody.callbackUrl, 'http://localhost/auth/callback?code=fixture-secret');
  assert(!page.url().includes('fixture-secret'));
  assert(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes('fixture-secret'));
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-account-id="account-1"]').getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Rename account', exact: true }).click();
  await dialog.getByLabel('Account name').fill('Renamed');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.getByRole('button', { name: 'Processing…', exact: true }).waitFor();
  await busyCannotDismiss(); holdAction = false; releaseAction(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Use with service', exact: true }).first().click();
  await dialog.getByLabel('Choose service', { exact: true }).click();
  await page.getByRole('option', { name: 'existing-service', exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue to service editor', exact: true }).click();
  await page.waitForURL(/#\/services\/edit\/existing-service\?/);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(commits, 0);
  const query = new URLSearchParams(page.url().split('?').at(-1));
  assert.equal(query.get('accountRef'), 'account-1'); assert.equal(query.get('serviceId'), serviceId);
  await page.evaluate(() => (window as any).setTestLocale('zh-CN'));
  await page.getByRole('button', { name: '添加账号', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/bungee-oauth-fixture.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: '/tmp/bungee-oauth-mobile-fixture.png' });
  await page.setViewportSize({ width: 1100, height: 850 });
  // Direct shadcn source/account primitives: disabled, missing current and retry states.
  await page.goto(`${base}?picker=manual`);
  await page.getByRole('radio', { name: 'ChatGPT OAuth', exact: true }).click();
  assert(await page.getByRole('radio', { name: /Disabled provider/ }).isDisabled());
  await page.getByRole('combobox').click();
  assert.equal(await page.getByRole('option', { name: /Unavailable account/ }).getAttribute('aria-disabled'), 'true');
  await page.getByRole('option', { name: 'Primary', exact: true }).click();
  await page.goto(`${base}?picker=missing`);
  await page.getByRole('combobox').click();
  assert.equal(await page.getByRole('option', { name: /missing-account/ }).getAttribute('aria-disabled'), 'true');
  accountError = true; await page.goto(`${base}?picker=missing`);
  await page.getByRole('alert').waitFor(); accountError = false;
  await page.getByRole('alert').getByRole('button').click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  assert.equal(commits, 0); assert.deepEqual(errors, []);
  console.log('PASS: mounted OAuth busy/reopen/polling/callback/i18n/service and radio/select disabled/missing/retry interactions');
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); await server.close(); }
