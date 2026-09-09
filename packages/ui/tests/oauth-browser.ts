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
  optimizeDeps: { entries: ['tests/fixtures/oauth.html'], include: ['deepmerge', 'cmdk-sv', 'lucide-svelte/icons/search'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 5199, proxy: {} } });
await server.listen();
console.log('Fixture server ready');
const browser = await chromium.launch({ headless: true });
try {
  console.log('Fixture browser ready');
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  let starts = 0, statuses = 0, commits = 0, holdStart = true, holdAction = true, statusError = '', accountError = false, invalidStart = false;
  let holdRefresh = false, releaseRefresh = () => {};
  let releaseStart = () => {}, releaseAction = () => {};
  let callbackBody: any;
  const accounts = [{ id: 'account-1', label: 'Primary', available: true, status: 'active', identity: { email: 'test@example.test' } },
    { id: 'unavailable', label: 'Unavailable account', available: false, status: 'disabled' }];
  const serviceId = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
  const config = { logical_configuration: { plugins: [], routes: [], auth: { enabled: false, tokens: [] }, services: [
    { id: serviceId, name: 'existing-service', position: 0, plugins: [], endpoints: [] },
    ...Array.from({ length: 11 }, (_, index) => ({ id: `service-${index}`, name: `Service ${String(index + 1).padStart(2, '0')}`, position: index + 1, plugins: [], endpoints: [] })),
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
    if (url.pathname === '/__ui/api/plugins/schemas') return respond({ [manifest.name]: { name: manifest.name, version: manifest.version, metadata: manifest.metadata, configSchema: manifest.configSchema } });
    if (url.pathname.includes('/control/accounts') && request.method() === 'GET') {
      if (holdRefresh) await new Promise<void>(resolve => releaseRefresh = resolve);
      return accountError ? respond({ error: 'disposed' }, 503) : respond({ accounts });
    }
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
  const dialogGeometry: unknown[] = [];
  const standardDialog = async () => {
    await dialog.waitFor();
    await page.waitForTimeout(220);
    const labelledBy = await dialog.getAttribute('aria-labelledby'), describedBy = await dialog.getAttribute('aria-describedby');
    assert(labelledBy && describedBy);
    assert(await page.locator(`[id="${labelledBy}"]`).textContent());
    assert(await page.locator(`[id="${describedBy}"]`).textContent());
    assert.equal(await dialog.locator('button.absolute').count(), 1, 'Content owns the close button');
    assert(await dialog.evaluate(element => element.matches('.nx-panel-raised.nx-bracketed')));
    assert.equal(await dialog.locator('.nx-panel-head .nx-stripe').count(), 1);
    assert.equal(await dialog.locator('.nx-corner').count(), 4);
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).count(), 1);
    const structure = await dialog.evaluate(element => {
      const header = element.querySelector('header')!, footer = element.querySelector('footer')!, body = element.querySelector('[data-dialog-body]')!;
      const style = getComputedStyle(element);
      return { overflow: style.overflow, display: style.display, direction: style.flexDirection,
        headerShrink: getComputedStyle(header).flexShrink, footerShrink: getComputedStyle(footer).flexShrink,
        footerBorder: getComputedStyle(footer).borderTopWidth, footerPadding: getComputedStyle(footer).paddingTop,
        border: style.borderTopColor, radius: style.borderRadius,
        siblings: header.parentElement === body.parentElement && footer.parentElement === body.parentElement };
    });
    assert.equal(structure.overflow, 'visible'); assert.equal(structure.display, 'flex'); assert.equal(structure.direction, 'column');
    assert.equal(structure.headerShrink, '0'); assert.equal(structure.footerShrink, '0'); assert(structure.siblings);
    assert.equal(structure.footerBorder, '1px'); assert.notEqual(structure.footerPadding, '0px'); assert.equal(structure.radius, '0px');
    assert.notEqual(structure.border, 'rgb(255, 255, 255)');
    for (const button of await dialog.getByRole('button').all()) assert(await button.locator('svg, .nx-load-xs').count(), 'every action has an icon or standard loading');
    dialogGeometry.push(await dialog.evaluate(element => {
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, padding: style.padding, gap: style.gap };
    }));
  };
  const busyCannotDismiss = async () => {
    await page.keyboard.press('Escape');
    await page.mouse.click(3, 3);
    assert.equal(await dialog.count(), 1);
    const buttons = await dialog.getByRole('button', { name: 'Close', exact: true }).all();
    assert.equal(buttons.length, 1);
    for (const button of buttons) assert(await button.isDisabled());
  };
  await page.goto(base);
  console.log('Fixture page mounted');
  await page.locator('[data-account-id="account-1"]').waitFor();
  for (const button of await page.getByRole('button').all()) assert(await button.locator('svg').count(), 'account action icon missing');
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const idleWidth = (await refresh.boundingBox())!.width;
  const idleText = await refresh.innerText();
  holdRefresh = true; await refresh.click();
  await refresh.locator('.nx-load-xs').waitFor();
  assert(await refresh.isDisabled()); assert.equal(await refresh.getAttribute('aria-busy'), 'true');
  assert.equal(await refresh.innerText(), idleText);
  assert.equal(await refresh.locator('svg, .animate-spin').count(), 0);
  assert(Math.abs((await refresh.boundingBox())!.width - idleWidth) <= 1, 'refresh width must not jump');
  holdRefresh = false; releaseRefresh(); await refresh.locator('.nx-load-xs').waitFor({ state: 'hidden' });
  assert.equal(await refresh.getAttribute('aria-busy'), 'false');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await standardDialog();
  await dialog.getByRole('button', { name: 'Start login', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start login', exact: true }).locator('.nx-load-xs').waitFor();
  await busyCannotDismiss();
  holdStart = false; releaseStart();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/bungee-oauth-login-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-login-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1100, height: 850 });
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor(); assert.equal(starts, 1);
  assert.equal(await dialog.getByRole('button', { name: 'Start login', exact: true }).count(), 0);
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-account-id="account-1"]').getByRole('button', { name: /More actions/ }).click();
  for (const item of await page.getByRole('menuitem').all()) assert.equal(await item.locator('svg').count(), 1);
  await page.getByRole('menuitem', { name: 'Sign in again', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await dialog.getByText(/different account is in progress/).waitFor(); assert.equal(starts, 1);
  for (const code of ['not_found', 'expired']) {
    statusError = code;
    // Let the running poll consume the error; a manual click can race its response.
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
  await page.getByRole('menuitem', { name: 'Account impact', exact: true }).click();
  await dialog.getByText('Current configuration references only; runtime usage is unknown.', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await dialog.locator('footer').count(), 0, 'read-only references must not render a footer');
  assert(await dialog.evaluate(element => {
    const body = element.querySelector('[data-dialog-body]')!;
    const bottom = element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).borderBottomWidth);
    return Math.abs(body.getBoundingClientRect().bottom - bottom) <= 1;
  }), 'no empty strip below the references body');
  await page.screenshot({ path: '/tmp/bungee-oauth-references-no-footer.png' });
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-account-id="account-1"]').getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Rename account', exact: true }).click();
  await standardDialog();
  assert.equal(await dialog.locator('footer').count(), 1);
  assert(await dialog.locator('footer').getByRole('button', { name: 'Confirm', exact: true }).isVisible(), 'rename keeps its action footer');
  await page.screenshot({ path: '/tmp/bungee-oauth-action-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-action-mobile.png' });
  await page.setViewportSize({ width: 1100, height: 850 });
  await dialog.getByLabel('Account name').fill('Renamed');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).locator('.nx-load-xs').waitFor();
  await busyCannotDismiss(); holdAction = false; releaseAction(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Use with service', exact: true }).first().click();
  await standardDialog();
  assert.deepEqual(dialogGeometry[0], dialogGeometry[1]); assert.deepEqual(dialogGeometry[0], dialogGeometry[2]);
  assert((await dialog.boundingBox())!.width < 600, 'medium modal must not use an empty 900px chassis');
  const verifyDropdown = async (size: string) => {
    await dialog.getByLabel('Choose service', { exact: true }).click();
    const list = page.getByRole('listbox');
    await list.waitFor(); await page.waitForTimeout(250);
    assert.equal(await list.getByRole('option').count(), 13);
    const geometry = await list.evaluate(element => {
      const rect = element.getBoundingClientRect(), modal = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      const ancestors = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        ancestors.push({ tag: parent.tagName, overflowX: style.overflowX, overflowY: style.overflowY });
      }
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: innerHeight, width: innerWidth,
        outside: rect.bottom > modal.bottom || rect.top < modal.top,
        overflow: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight, ancestors };
    });
    assert(geometry.top >= 0 && geometry.left >= 0 && geometry.bottom <= geometry.height && geometry.right <= geometry.width);
    assert(geometry.outside, 'dropdown must visibly cross the modal boundary');
    assert.equal(geometry.overflow, 'auto'); assert(geometry.scrollable);
    assert(geometry.ancestors.every(parent => !['auto', 'scroll', 'hidden', 'clip'].includes(parent.overflowY) || parent.tag === 'BODY' || parent.tag === 'HTML'), 'no clipping/scrolling ancestor around inline dropdown');
    const last = list.getByRole('option').last();
    await last.scrollIntoViewIfNeeded();
    assert(await last.evaluate(element => {
      const r = element.getBoundingClientRect(), list = element.closest('[role="listbox"]')!.getBoundingClientRect();
      return r.top >= list.top && r.bottom <= list.bottom && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), 'last option is inside list viewport and actually hit-testable');
    await page.screenshot({ path: `/tmp/bungee-oauth-service-select-${size}.png` });
    await last.click();
    assert.match(await dialog.getByRole('combobox').innerText(), /Service 11/);
  };
  await page.screenshot({ path: '/tmp/bungee-oauth-service-desktop.png' });
  await verifyDropdown('desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-service-mobile.png' });
  assert((await dialog.boundingBox())!.width <= 362);
  await verifyDropdown('mobile');
  await page.setViewportSize({ width: 1100, height: 850 });
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
  assert.match(await page.getByRole('combobox').innerText(), /Primary/);
  await page.goto(`${base}?picker=missing`);
  await page.getByRole('combobox').click();
  assert.equal(await page.getByRole('option', { name: /missing-account/ }).getAttribute('aria-disabled'), 'true');
  accountError = true; await page.goto(`${base}?picker=missing`);
  await page.getByRole('alert').waitFor(); accountError = false;
  await page.getByRole('alert').getByRole('button').click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  // The real endpoint modal retains its own chassis, but UpstreamForm adds no second outer panel.
  await page.goto(`${base}?endpoint=modal`);
  await page.getByRole('button', { name: 'Open endpoint', exact: true }).click();
  const form = dialog.getByTestId('upstream-form');
  await form.getByText('Plugin-managed upstream', { exact: true }).waitFor();
  assert.equal((await form.getAttribute('class')) ?? '', '');
  assert.equal(await form.locator(':scope > .nx-panel-body').count(), 0);
  assert.equal(await dialog.locator(':scope > .nx-panel-raised.nx-bracketed').count(), 1);
  assert(await form.getByText('Plugin-managed upstream', { exact: true }).evaluate(element => !!element.closest('.nx-panel-raised, .nx-panel')));
  assert.deepEqual(await form.evaluate(element => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, background: style.backgroundColor, padding: style.padding };
  }), { border: '0px', background: 'rgba(0, 0, 0, 0)', padding: '0px' });
  await page.screenshot({ path: '/tmp/bungee-endpoint-modal-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-endpoint-modal-mobile.png' });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(`${base}?endpoint=inline`);
  await page.getByTestId('upstream-form').getByText('Plugin-managed upstream', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('upstream-form').getAttribute('class'), 'nx-panel-raised');
  assert.equal(await page.getByTestId('upstream-form').locator(':scope > .nx-panel-body').count(), 1);
  await page.goto(`${base}?design`);
  const exampleTrigger = page.getByRole('button', { name: /Open industrial dialog/ });
  await exampleTrigger.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-catalog.png' });
  await exampleTrigger.click(); await dialog.waitFor(); await page.waitForTimeout(250);
  const body = dialog.locator('[data-dialog-body]');
  const before = await dialog.locator('header, footer').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
  await body.evaluate(element => element.scrollTop = element.scrollHeight);
  assert(await body.evaluate(element => element.scrollTop > 0));
  assert.deepEqual(await dialog.locator('header, footer').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON())), before);
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-mobile.png' });
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus stays trapped'); }
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert(await exampleTrigger.evaluate(element => element === document.activeElement), 'focus returns to opener');
  await exampleTrigger.click(); await dialog.waitFor(); await page.waitForTimeout(250);
  await page.mouse.click(3, 3); await dialog.waitFor({ state: 'hidden' });
  assert.equal(commits, 0); assert.deepEqual(errors, []);
  console.log('PASS: shared industrial dialogs, stationary chrome, 13-option unclipped dropdown/last selection desktop+mobile, focus/Escape/outside/busy, live example, OAuth safety, existing Select and endpoint surfaces');
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); await server.close(); }
