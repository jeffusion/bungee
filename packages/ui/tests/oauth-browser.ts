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
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    let calls = 0; const original = crypto.randomUUID.bind(crypto);
    Object.defineProperty(window, '__oauthUuidCalls', { value: () => calls });
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => { calls++; return original(); } });
  });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    // Deliberate fake 404/409/503 responses exercise existing error handling below.
    if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (404|409|503)/.test(message.text())) errors.push(message.text());
  });
  let starts = 0, statuses = 0, commits = 0, holdStart = true, holdAction = true, statusError = '', accountError = false, invalidStart = false;
  let usageRequests = 0, usageInFlight = 0, maxUsageInFlight = 0, resetPosts = 0, primaryResetPosts = 0, holdReset = false, releaseReset = () => {}, resetUnknown = false;
  const resetBodies: any[] = [], primaryResetBodies: any[] = [];
  let holdRefresh = false, releaseRefresh = () => {};
  let releaseStart = () => {}, releaseAction = () => {};
  let callbackBody: any;
  const accounts = [{ id: 'account-1', label: 'Primary', available: true, status: 'active', identity: { email: 'test@example.test', planType: 'Plus' } },
    { id: 'stale-account', label: 'Stale account', available: true, status: 'active' },
    { id: 'unavailable-usage', label: 'Unavailable usage', available: true, status: 'active' },
    { id: 'partial-account', label: 'Partial account', available: true, status: 'active' },
    { id: 'zero-account', label: 'Zero account', available: true, status: 'active' },
    { id: 'usage-summary', label: 'Usage summary', available: true, status: 'active' },
    { id: 'multi-account', label: 'Multiple credits', available: true, status: 'active' },
    { id: 'primary-only', label: 'Primary only', available: true, status: 'active' },
    { id: 'monthly-free', label: 'Free monthly', available: true, status: 'active', identity: { planType: 'Free' } },
    { id: 'unavailable', label: 'Unavailable account', available: false, status: 'disabled' },
    { id: 'reauth-account', label: 'Reauth account with a long production workspace name', available: false, status: 'reauth_required' },
    { id: 'revoked-account', label: 'Revoked account', available: false, status: 'revoked' },
    { id: 'long-email-account', label: 'long.account.with.production.length@example.department.test', available: true, status: 'active', identity: { email: 'long.account.with.production.length@example.department.test', planType: 'Plus' }, expiresAt: Date.now() + 86400000 }];
  const usage = { usage: { state: 'fresh', primary: { usedPercent: 25, windowSeconds: 18000, resetAt: Date.now() + 18000000 }, secondary: { usedPercent: 50, windowSeconds: 604800, resetAt: Date.now() + 604800000 } },
    resetCredits: { state: 'fresh', availableCount: 1, credits: [{ id: 'credit-secret', status: 'available', resetType: 'codex_rate_limits', grantedAt: Date.now(), title: 'Upstream title must stay hidden', description: 'Upstream description must stay hidden', expiresAt: Date.now() + 86400000 }] } };
  const usageByRef: Record<string, any> = {
    'stale-account': { usage: { state: 'stale', primary: { usedPercent: 70, windowSeconds: 60, resetAt: Date.now() + 60000 } }, resetCredits: { state: 'fresh', availableCount: 1, credits: [] } },
    'unavailable-usage': { usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } },
    'partial-account': { usage: { state: 'fresh', primary: { usedPercent: 10, windowSeconds: 90, resetAt: Date.now() + 90000 } }, resetCredits: { state: 'fresh', availableCount: 1, credits: [{ id: 'partial-credit', status: 'unknown' }] } },
    'zero-account': { usage: { state: 'fresh', primary: { usedPercent: 0, windowSeconds: 60, resetAt: Date.now() + 60000 }, secondary: { usedPercent: 0, windowSeconds: 86400, resetAt: Date.now() + 86400000 } }, resetCredits: { state: 'fresh', availableCount: 0, credits: [] } },
    'usage-summary': { usage: { state: 'fresh', availableCount: 2, primary: { usedPercent: 40, windowSeconds: 18000, resetAt: Date.now() + 18000000 }, secondary: { usedPercent: 60, windowSeconds: 604800, resetAt: Date.now() + 604800000 } }, resetCredits: { state: 'unavailable' } },
    'multi-account': { usage: { state: 'fresh', primary: { usedPercent: 40, windowSeconds: 18000, resetAt: Date.now() + 18000000 }, secondary: { usedPercent: 60, windowSeconds: 604800, resetAt: Date.now() + 604800000 } }, resetCredits: { state: 'fresh', availableCount: 2, credits: [{ id: 'multi-credit-a', status: 'available', resetType: 'codex_rate_limits', expiresAt: Date.now() + 3600000 }, { id: 'multi-credit-b', status: 'available', resetType: 'other', expiresAt: Date.now() + 7200000 }] } },
    'primary-only': { usage: { state: 'fresh', primary: { usedPercent: 35, windowSeconds: 18000, resetAt: Date.now() + 18000000 }, secondary: null }, resetCredits: { state: 'fresh', availableCount: 1, credits: [{ id: 'primary-only-credit', status: 'available', resetType: 'codex_rate_limits', expiresAt: Date.now() + 3600000 }] } },
    'monthly-free': { usage: { state: 'fresh', primary: { usedPercent: 0, windowSeconds: 2592000, resetAt: Date.now() + 2592000000 }, secondary: null }, resetCredits: { state: 'fresh', availableCount: 1, credits: [{ id: 'monthly-credit', status: 'available', resetType: 'codex_rate_limits', expiresAt: Date.now() + 2592000000 }] } },
  };
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
    if (url.pathname.endsWith('/control/accounts/usage/reset') && request.method() === 'POST') {
      resetPosts++; const body = request.postDataJSON(); resetBodies.push(body);
      if (holdReset) await new Promise<void>(resolve => releaseReset = resolve);
      if (body.accountRef !== 'account-1') return respond({ outcome: 'reset', windowsReset: 1, usage });
      primaryResetPosts++; primaryResetBodies.push(body);
      if (primaryResetPosts === 1) { resetUnknown = true; return respond({ outcome: 'reset_outcome_unknown', usage }); }
      if (primaryResetPosts === 2) return respond({ error: 'reset_in_progress' }, 409);
      return respond({ outcome: 'reset', windowsReset: 1, usage });
    }
    if (url.pathname.endsWith('/control/accounts/usage') && request.method() === 'GET') {
      usageRequests++; usageInFlight++; maxUsageInFlight = Math.max(maxUsageInFlight, usageInFlight);
      await new Promise(resolve => setTimeout(resolve, 20)); usageInFlight--;
      const accountRef = url.searchParams.get('accountRef') ?? '';
      if (accountRef === 'account-1' && resetUnknown) return respond({ ...usage, resetCredits: { ...usage.resetCredits, availableCount: 0, credits: [] } });
      return respond(usageByRef[accountRef] ?? usage);
    }
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
  const primary = () => page.locator('.nx-panel-raised').filter({ hasText: 'Primary' }).first();
  const accountCards = () => page.locator('[data-testid="chatgpt-accounts-page"] .nx-panel-raised');
  const assertGrid = async (width: number, columns: number, screenshot: string) => {
    const postsBeforeLayout = resetPosts;
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(80);
    const zh = await page.getByRole('button', { name: '添加账号', exact: true }).count() > 0;
    const boxes = await accountCards().evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), width: box.width, height: box.height };
    }));
    const pageBox = await page.locator('main.nx-page').boundingBox();
    assert(pageBox && pageBox.width <= 1280, 'account page must keep the industrial 1280px max width');
    assert.equal(new Set(boxes.map(box => box.x)).size, columns, `${width}px must use ${columns} grid columns`);
    const unavailable = await page.locator('.nx-panel-raised').filter({ hasText: 'Unavailable usage' }).first().boundingBox();
    const multiple = await page.locator('.nx-panel-raised').filter({ hasText: 'Multiple credits' }).first().boundingBox();
    assert(unavailable && multiple && unavailable.height < multiple.height * 0.8, 'short unavailable card must not be stretched to match a credit-rich card');
    assert(boxes.every(box => box.width <= 430), 'desktop cards must stay near the 400px target width');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await accountCards().locator('.nx-corner').count(), 0, 'peer cards must not have corner brackets');
    for (const [index, card] of (await accountCards().all()).entries()) {
      const account = accounts[index];
      const status = card.getByTestId('account-status');
      const expected = account.available ? (zh ? '可用' : 'AVAILABLE') : account.status === 'disabled' ? (zh ? '已禁用' : 'DISABLED') : account.status === 'revoked' ? (zh ? '已移除' : 'REMOVED') : (zh ? '需要重新登录' : 'SIGN IN AGAIN REQUIRED');
      assert.equal((await status.innerText()).trim(), expected);
      assert.equal(await card.locator('header').getByTestId('account-status').count(), 1);
      assert.equal(await card.locator('.nx-panel-body').getByTestId('account-status').count(), 0);
      assert(await status.locator('span').evaluate((element, variant) => element.classList.contains(`nx-badge-${variant}`), account.available ? 'active' : account.status === 'revoked' ? 'muted' : 'standby'));
      assert.equal(await card.locator('.nx-panel-body > .space-y-3 > .space-y-2').first().locator('[class*="nx-badge-"]').count(), 0, 'identity body has no bare account status');
      const plan = account.identity?.planType;
      assert.equal(await card.getByTestId('account-type').count(), plan ? 1 : 0);
      if (plan) assert.equal(await card.getByTestId('account-type').innerText(), zh ? `账号类型：${plan}` : `Account type: ${plan}`);
      const header = card.locator('header');
      assert(await header.evaluate(element => {
        const title = element.querySelector('.truncate')!.getBoundingClientRect();
        const badge = element.querySelector('[data-testid="account-status"]')!;
        const box = badge.getBoundingClientRect(), bounds = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth && badge.scrollWidth <= badge.clientWidth
          && box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom
          && (title.right <= box.left || title.bottom <= box.top || box.bottom <= title.top);
      }), 'header title/status must not overlap, overflow or clip');
      assert(await card.evaluate(element => element.scrollWidth <= element.clientWidth), 'card content must not overflow');
      const footer = card.getByTestId('account-actions');
      assert.equal(await footer.evaluate(element => getComputedStyle(element).justifyContent), 'flex-end');
      for (const button of await card.locator('[data-testid="account-actions"] button, [data-testid="reset-credit"] button').all()) {
        const box = await button.boundingBox(); assert(box && box.height >= (width === 390 ? 44 : 40) && box.width >= 40, 'real button hit target');
      }
      const heading = card.getByTestId('reset-heading');
      if (await heading.count()) assert.equal(await heading.evaluate(element => getComputedStyle(element).justifyContent), 'normal');
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.screenshot({ path: screenshot.replace('.png', '-viewport.png') });
    await page.locator('.account-card').filter({ hasText: 'Multiple credits' }).screenshot({ path: screenshot.replace('.png', '-credits.png') });
    if (zh && [390, 1440].includes(width)) {
      await page.locator('.account-card').filter({ hasText: 'Free monthly' }).screenshot({ path: `/tmp/bungee-oauth-header-zh-${width}-plan.png` });
      await page.locator('.account-card').filter({ hasText: 'long.account.with.production.length@example.department.test' }).screenshot({ path: `/tmp/bungee-oauth-header-zh-${width}-long.png` });
      await page.locator('.account-card').filter({ hasText: 'Reauth account' }).screenshot({ path: `/tmp/bungee-oauth-header-zh-${width}-reauth.png` });
    }
    const cardDOM = await accountCards().evaluateAll(elements => elements.map(element => element.outerHTML).join('\n'));
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(cardDOM), 'no UUID in card text or attributes');
    assert.equal(resetPosts, postsBeforeLayout, 'layout inspection must never consume a credit');
    assert.equal(commits, 0);
    console.log(`GRID ${width}px: ${columns} columns, card ${boxes[0].width.toFixed(1)}px, no overflow, hit targets verified`);
  };
  await primary().waitFor();
  await page.getByText('Zero', { exact: true }).waitFor();
  assert(maxUsageInFlight <= 4, `usage GET concurrency exceeded 4: ${maxUsageInFlight}`);
  assert.equal(await page.locator('h1').count(), 0, 'accounts page must not add a duplicate title');
  const bodyText = await page.locator('body').innerText();
  const domSecrets = await page.locator('body *').evaluateAll(elements => elements.flatMap(element => [...Array.from(element.attributes, attribute => attribute.value), ...((element as HTMLInputElement).value ? [(element as HTMLInputElement).value] : [])]).join('\n'));
  assert(!bodyText.includes('account-1') && !bodyText.includes('credit-secret'), 'raw account or credit id leaked into visible text');
  for (const secret of [...accounts.map(account => account.id), 'credit-secret', 'partial-credit', 'multi-credit-a', 'multi-credit-b', 'primary-only-credit', 'monthly-credit']) assert(!domSecrets.includes(secret), `raw account or credit id leaked into DOM attributes/values: ${secret}`);
  for (const state of ['FRESH', 'STALE', 'UNAVAILABLE', 'PARTIAL', 'ZERO']) assert(bodyText.includes(state), `${state} usage state missing`);
  assert.equal(await primary().locator('.metric-bar').count(), 2);
  assert(/25% used/i.test(await primary().innerText()) && /50% used/i.test(await primary().innerText()));
  assert((await primary().innerText()).includes('Window 5h') && (await primary().innerText()).includes('Window 7d'));
  assert(/5-hour limit/i.test(await primary().innerText()) && /weekly limit/i.test(await primary().innerText()));
  assert((await primary().innerText()).includes('Codex rate-limit reset'));
  assert(!(await primary().innerText()).includes('Upstream title must stay hidden') && !(await primary().innerText()).includes('Upstream description must stay hidden'));
  const usageSummary = page.locator('.nx-panel-raised').filter({ hasText: 'Usage summary' }).first();
  assert((await usageSummary.innerText()).includes('2'));
  await usageSummary.getByText('Credit details unavailable', { exact: true }).waitFor();
  const primaryOnly = page.locator('.nx-panel-raised').filter({ hasText: 'Primary only' }).first();
  assert.equal(await primaryOnly.locator('.metric-bar').count(), 1);
  assert((await primaryOnly.innerText()).includes('FRESH') && !(await primaryOnly.innerText()).includes('PARTIAL'));
  const monthly = page.locator('.nx-panel-raised').filter({ hasText: 'Free monthly' }).first();
  assert.equal(await monthly.locator('.metric-bar').count(), 1);
  await monthly.getByText('30-day limit', { exact: true }).waitFor();
  assert(/30-day limit/i.test(await monthly.innerText()) && !/5-hour/i.test(await monthly.innerText()) && !/weekly/i.test(await monthly.innerText()));
  assert.equal((await primary().locator('.nx-panel-head-title').innerText()).trim(), 'PRIMARY');
  assert.equal(await primary().getByRole('button', { name: 'Use', exact: true }).count(), 1);
  assert(!bodyText.includes('Signing in does not publish a service'));
  const longEmailCard = accountCards().filter({ hasText: 'long.account.with.production.length@example.department.test' });
  assert.equal((await longEmailCard.innerText()).toLowerCase().split('long.account.with.production.length@example.department.test').length, 2, 'same label/email is displayed once');
  const multi = page.locator('.nx-panel-raised').filter({ hasText: 'Multiple credits' }).first();
  const multiCreditRows = multi.getByTestId('reset-credit');
  assert.equal(await multi.getByRole('button', { name: 'Use', exact: true }).count(), 2);
  const directUse = multiCreditRows.nth(1).getByRole('button', { name: 'Use', exact: true });
  await directUse.focus(); assert(await directUse.evaluate(element => element.matches(':focus-visible')));
  await page.screenshot({ path: '/tmp/bungee-oauth-use-focus.png' });
  await page.keyboard.press('Enter');
  await dialog.getByText('Rate-limit reset opportunity', { exact: true }).waitFor();
  await page.waitForTimeout(220);
  for (let index = 0; index < 4; index++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement))); }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, 0);
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="reset-credit"]'));
  assert(await directUse.evaluate(element => element === document.activeElement), 'cancel restores credit opener focus');
  await directUse.hover(); await page.screenshot({ path: '/tmp/bungee-oauth-use-hover.png' });
  await directUse.click();
  await dialog.getByRole('button', { name: 'Confirm use', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, 1); assert.equal(resetBodies[0].creditId, 'multi-credit-b');
  await assertGrid(390, 1, '/tmp/bungee-oauth-grid-390.png');
  await assertGrid(900, 2, '/tmp/bungee-oauth-grid-900.png');
  await assertGrid(1440, 3, '/tmp/bungee-oauth-grid-1440.png');
  await page.setViewportSize({ width: 1100, height: 850 });
  const useCredit = primary().getByRole('button', { name: 'Use', exact: true });
  await useCredit.click(); assert.equal(primaryResetPosts, 0); assert.equal(await page.evaluate(() => (window as any).__oauthUuidCalls()), 3);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(primaryResetPosts, 0);
  await useCredit.click(); assert.equal(await page.evaluate(() => (window as any).__oauthUuidCalls()), 4);
  const confirmCredit = dialog.getByRole('button', { name: 'Confirm use', exact: true });
  const usageBeforeUnknown = usageRequests;
  holdReset = true; const firstReset = confirmCredit.click(); await confirmCredit.locator('.nx-load-xs').waitFor(); const resetBox = await confirmCredit.boundingBox(); if (resetBox) await page.mouse.click(resetBox.x + resetBox.width / 2, resetBox.y + resetBox.height / 2);
  holdReset = false; releaseReset(); await firstReset;
  await dialog.getByRole('alert').filter({ hasText: /result is unknown/i }).waitFor(); assert.equal(primaryResetPosts, 1); assert(usageRequests > usageBeforeUnknown, 'unknown reset must refresh usage before retry');
  await primary().getByText('Reset result pending confirmation', { exact: true }).waitFor();
  const firstResetBody = JSON.stringify(primaryResetBodies[0]);
  const firstResetRequestId = primaryResetBodies[0].redeemRequestId;
  const dialogDom = await dialog.locator('*').evaluateAll(elements => elements.flatMap(element => [...Array.from(element.attributes, attribute => attribute.value), ...((element as HTMLInputElement).value ? [(element as HTMLInputElement).value] : [])]).join('\n'));
  for (const secret of [...accounts.map(account => account.id), 'credit-secret', 'partial-credit', 'multi-credit-a', 'multi-credit-b', 'primary-only-credit', 'monthly-credit', firstResetRequestId]) assert(!dialogDom.includes(secret), `reset identifier leaked into dialog DOM: ${secret}`);
  await close(); await dialog.waitFor({ state: 'hidden' });
  await primary().getByRole('button', { name: 'Resolve unknown reset', exact: true }).click(); assert.equal(await page.evaluate(() => (window as any).__oauthUuidCalls()), 4);
  assert.equal(await dialog.getByRole('button', { name: 'Retry same credit', exact: true }).count(), 1);
  const usageBeforeInProgress = usageRequests;
  await dialog.getByRole('button', { name: 'Retry same credit', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /still in progress/i }).waitFor();
  assert.equal(primaryResetPosts, 2); assert(usageRequests > usageBeforeInProgress, 'in-progress reset must refresh usage before retry');
  await dialog.getByRole('button', { name: 'Retry same credit', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); assert.equal(primaryResetPosts, 3); assert.equal(JSON.stringify(primaryResetBodies[1]), firstResetBody); assert.equal(JSON.stringify(primaryResetBodies[2]), firstResetBody);
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
  await primary().getByRole('button', { name: /More actions/ }).click();
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
  await primary().getByRole('button', { name: /More actions/ }).click();
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
  await primary().getByRole('button', { name: /More actions/ }).click();
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
  await page.goto(base);
  await page.getByRole('button', { name: 'Add account', exact: true }).waitFor();
  await page.evaluate(() => (window as any).setTestLocale('zh-CN'));
  await page.getByRole('button', { name: '添加账号', exact: true }).waitFor();
  const monthlyZh = page.locator('.nx-panel-raised').filter({ hasText: 'Free monthly' }).first();
  await monthlyZh.getByText('30 天限额', { exact: true }).waitFor();
  assert(!(await monthlyZh.innerText()).includes('Upstream title must stay hidden'));
  assert.equal(await monthlyZh.getByRole('button', { name: '使用', exact: true }).count(), 1);
  assert.match(await monthlyZh.getByTestId('reset-heading').innerText(), /1\s*次可用/);
  assert(!await page.getByText('账号登录不会自动发布服务。', { exact: false }).count());
  const multiZh = accountCards().filter({ hasText: 'Multiple credits' });
  assert.equal(await multiZh.getByRole('button', { name: '使用', exact: true }).count(), 2);
  const beforeZh = resetPosts;
  await multiZh.getByRole('button', { name: '使用', exact: true }).first().click();
  await dialog.getByText('Codex 限额重置', { exact: true }).waitFor();
  assert.equal(resetPosts, beforeZh);
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, beforeZh);
  await multiZh.getByRole('button', { name: '使用', exact: true }).first().click();
  await dialog.getByRole('button', { name: '确认使用', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, beforeZh + 1); assert.equal(resetBodies.at(-1).creditId, 'multi-credit-a');
  for (const [width, columns] of [[390, 1], [900, 2], [1440, 3]]) await assertGrid(width, columns, `/tmp/bungee-oauth-grid-zh-${width}.png`);
  const moreZh = multiZh.getByRole('button', { name: /更多操作/ });
  assert.equal(await moreZh.getAttribute('title'), '更多操作');
  await moreZh.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重新登录', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert(await moreZh.evaluate(element => element === document.activeElement));
  await page.evaluate(() => (window as any).setTestLocale('en'));
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
  console.log('PASS: shared industrial dialogs, stationary chrome, per-credit reset actions, 13-option unclipped dropdown desktop+mobile, focus/Escape/outside/busy, live example, OAuth safety, existing Select and endpoint surfaces');
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); await server.close(); }
