import { afterAll, beforeAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { chromium, type Browser } from 'playwright';
import { expect } from 'playwright/test';
import { collectApiEvidence } from '../helpers/editors/api-evidence';
import { recordResponseDelivery, holdResponseJson, waitForResponseReceipt, releaseResponseJson, waitForResponseDelivery } from '../helpers/editors/response-delivery';
import manifest from '../../../../plugins/chatgpt-oauth/manifest.json';
const accountsFixture = resolve(import.meta.dir, '../fixtures/editors/oauth-accounts.html');
let uiRuntime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  uiRuntime = await startUiRuntime({mode:'component-fixture',entries:[accountsFixture]});
  try { browser = await chromium.launch(); } catch(error) { await uiRuntime.close(); throw error; }
},120_000);
afterAll(async () => { try { await browser?.close(); } finally { await uiRuntime?.close(); } });

test('account-business', () => runOAuthScenario('account-business'), 240_000);
test('login-session', () => runOAuthScenario('login-session'), 240_000);
test('login-polling', () => runOAuthScenario('login-polling'), 240_000);
test('callback-privacy', () => runOAuthScenario('callback-privacy'), 240_000);
test('account-dialogs', () => runOAuthScenario('account-dialogs'), 240_000);
test('account-layout', () => runOAuthScenario('account-layout'), 240_000);
test('session-fencing', () => runOAuthScenario('session-fencing'), 240_000);

async function runOAuthScenario(scenario: string) {
  const context = await browser.newContext({viewport:{width:1100,height:850}});
  let releaseStart = () => {}, releaseAction = () => {}, releaseReset = () => {}, releaseRefresh = () => {}, releaseUsage = () => {}, releaseStatus = () => {}, releaseCallback = () => {};
  const firstUsageBatch: Array<() => void> = [];
  let holdInitialUsage=true;
  try {
  const page = await context.newPage();
  if(scenario === 'login-polling') await page.clock.install();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  await recordResponseDelivery(page, '/api/plugins/chatgpt-oauth/control/accounts');
  await recordResponseDelivery(page, '/api/plugins/chatgpt-oauth/control/login/status');
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    let calls = 0; const original = crypto.randomUUID.bind(crypto);
    Object.defineProperty(window, '__oauthUuidCalls', { value: () => calls });
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => { calls++; return original(); } });
  });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  const evidence = collectApiEvidence(page);
  const errors = evidence.errors;
  let starts = 0, statuses = 0, commits = 0, holdStart = true, holdAction = true, statusError = '', accountError = false, invalidStart = false;
  let usageRequests = 0, usageInFlight = 0, maxUsageInFlight = 0, resetPosts = 0, primaryResetPosts = 0, holdReset = false, resetUnknown = false;
  const sessionKinds: Record<string, string> = {};
  const resetBodies: any[] = [], primaryResetBodies: any[] = [];
  let holdRefresh = false, holdNextRefresh = false, refreshResponseAccounts: any[] | undefined;
  let accountGets = 0, holdUsage = '', usageFailure = '';
  const usageGets: Record<string, number> = {}, loginResults: Record<string, string> = {};
  let holdStatus = false, holdStatusSession = '', statusHeld = false;
  releaseStart = () => {}; releaseAction = () => {};
  let callbackBody: any, holdCallback = false, failCallback = false, actionPosts=0;
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
    { id: 'long-email-account', label: 'long.account.with.production.length@example.department.test', available: true, status: 'active', identity: { email: 'long.account.with.production.length@example.department.test', planType: 'Plus' }, expiresAt: Date.now() + 86400000 },
    { id: 'many-credits-account', label: 'Many credits', available: true, status: 'active' }];
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
  usageByRef['many-credits-account'] = { ...usage, resetCredits: { state: 'fresh', availableCount: 256, credits: Array.from({ length: 256 }, (_, index) => ({ id: `bulk-credit-${index}`, status: 'available', resetType: 'codex_rate_limits', expiresAt: Date.now() + (index + 1) * 3600000 })) } };
  const serviceId = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
  const config = { logical_configuration: { plugins: [], routes: [], auth: { enabled: false, tokens: [] }, services: [
    { id: serviceId, name: 'existing-service', position: 0, plugins: [], endpoints: [] },
    ...Array.from({ length: 11 }, (_, index) => ({ id: `service-${index}`, name: `Service ${String(index + 1).padStart(2, '0')}`, position: index + 1, plugins: [], endpoints: [] })),
  ] }, plugin_activations: [] };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown, status = 200) => {
      if (status >= 400) evidence.expectStatus(route, status);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    };
    const method = request.method(), path = url.pathname;
    const key = `${method} ${path}`;
    const reads = ['/api/plugins', '/api/plugins/schemas', '/api/config', '/api/plugins/chatgpt-oauth/control/accounts', '/api/plugins/chatgpt-oauth/control/accounts/codex', '/api/plugins/chatgpt-oauth/control/accounts/siwc', '/api/plugins/chatgpt-oauth/control/accounts/usage', '/api/plugins/chatgpt-oauth/control/login/status'];
    const writes = ['/api/plugins/chatgpt-oauth/control/accounts/usage/reset', '/api/plugins/chatgpt-oauth/control/login/device', '/api/plugins/chatgpt-oauth/control/login/pkce', '/api/plugins/chatgpt-oauth/control/login/callback', '/api/plugins/chatgpt-oauth/control/accounts/rename', '/api/plugins/chatgpt-oauth/control/accounts/draft'];
    if (!(method === 'GET' && reads.includes(path)) && !(method === 'POST' && writes.includes(path))) {
      if (method !== 'GET') commits++;
      errors.push(`Unexpected API ${key}`); return route.fulfill({status:500,json:{error:'unexpected_request'}});
    }
    if (url.pathname === '/api/plugins') return respond([
      { name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
      { name: 'disabled-provider', enabled: false, metadata: { contributes: { upstreamSources: [{ ...manifest.contributes.upstreamSources[0], label: 'Disabled provider' }] } } },
    ]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: { name: manifest.name, version: manifest.version, metadata: manifest.metadata, configSchema: manifest.configSchema } });
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
      if (holdInitialUsage) await new Promise<void>(resolve => firstUsageBatch.push(resolve));
      usageInFlight--;
      const accountRef = url.searchParams.get('accountRef') ?? '';
      usageGets[accountRef] = (usageGets[accountRef] ?? 0) + 1;
      if (holdUsage === accountRef) await new Promise<void>(resolve => releaseUsage = resolve);
      if (usageFailure === accountRef) return respond({ error: 'upstream_unavailable' }, 503);
      if (accountRef === 'account-1' && resetUnknown) return respond({ ...usage, resetCredits: { ...usage.resetCredits, availableCount: 0, credits: [] } });
      return respond(usageByRef[accountRef] ?? usage);
    }
    if (['/api/plugins/chatgpt-oauth/control/accounts', '/api/plugins/chatgpt-oauth/control/accounts/codex', '/api/plugins/chatgpt-oauth/control/accounts/siwc'].includes(url.pathname) && request.method() === 'GET') {
      accountGets++;
      if (holdNextRefresh) {
        holdNextRefresh = false;
        return respond({ accounts });
      }
      if (holdRefresh) await new Promise<void>(resolve => releaseRefresh = resolve);
      return accountError ? respond({ error: 'disposed' }, 503) : respond({ accounts: refreshResponseAccounts ?? accounts });
    }
    if (url.pathname.endsWith('/login/device') || url.pathname.endsWith('/login/pkce')) {
      starts++; sessionKinds[`session-${starts}`] = url.pathname.split('/').at(-1)!;
      if (holdStart) await new Promise<void>(resolve => releaseStart = resolve);
      return respond({ sessionId: invalidStart ? ' ' : `session-${starts}`, expiresAt: Date.now() + 300000, ...(url.pathname.endsWith('/device')
        ? { userCode: `CODE-${starts}`, verificationUri: 'https://auth.openai.com/codex/device' }
        : { authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' }) });
    }
    if (url.pathname.endsWith('/login/status')) {
      statuses++;
      const sessionId = url.searchParams.get('sessionId')!;
      const state = loginResults[sessionId] ?? 'pending';
      if (holdStatus && (!holdStatusSession || holdStatusSession === sessionId)) { statusHeld = true; await new Promise<void>(resolve => releaseStatus = resolve); }
      return statusError ? respond({ error: statusError }, 404) : respond({ sessionId, kind: sessionKinds[sessionId] ?? 'device', state, expiresAt: Date.now() + 300000 });
    }
    if (url.pathname.endsWith('/login/callback')) { callbackBody = request.postDataJSON(); if (holdCallback) await new Promise<void>(resolve => releaseCallback = resolve); return failCallback ? respond({error:'offline'},503) : respond({ accepted: true }); }
    if (url.pathname.endsWith('/accounts/rename')) { actionPosts++; if (holdAction) await new Promise<void>(resolve => releaseAction = resolve); return respond({}); }
    if (url.pathname.endsWith('/accounts/draft')) return respond({ target: 'https://chatgpt.com/backend-api/codex/responses', bindingOptions: { accountRef: 'account-1' } });
    if (request.method() === 'PUT') { commits++; return respond({ error: 'unexpected_commit' }, 500); }
    if (url.pathname === '/api/config') return respond({ config, revision: 1, content_hash: 'fixture' });
    throw new Error(`Unmocked API: ${request.method()} ${url.pathname}`);
  });
  const base = `${uiRuntime.origin}/@fs${accountsFixture}`;
  const dialog = page.getByRole('dialog');
  const startLogin = async () => {
    const siwc = dialog.getByRole('radio', { name: 'Sign in with ChatGPT', exact: true });
    if (await siwc.count() && await siwc.isChecked()) await dialog.getByRole('radio', {name:'Codex device code',exact:true}).click();
    await dialog.getByRole('button', { name: 'Start login', exact: true }).click();
  };
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const settleDialog = async () => {
    await dialog.waitFor();
    await dialog.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    await expect.poll(() => dialog.evaluate(element => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return transform.a === 1 && transform.d === 1;
    }), { timeout: 10000 }).toBe(true);
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
  await expect.poll(()=>firstUsageBatch.length).toBeGreaterThan(0);
  holdInitialUsage=false;firstUsageBatch.forEach(release=>release());
  const primary = () => page.locator('.nx-panel-raised').filter({ hasText: 'Primary' }).first();
  const accountCards = () => page.locator('[data-testid="chatgpt-accounts-page"] .nx-panel-raised');
  await primary().waitFor();
  await expect(accountCards().filter({hasText:'Many credits'}).getByRole('button',{name:'Use',exact:true})).toHaveCount(256);
  await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();

  if (scenario === 'account-business') {
  await primary().waitFor();
  await page.getByText('Zero', { exact: true }).waitFor();
  assert(maxUsageInFlight <= 4, `usage GET concurrency exceeded 4: ${maxUsageInFlight}`);
  assert.equal(await page.locator('h1').count(), 0, 'accounts page must not add a duplicate title');
  const bodyText = await page.locator('body').innerText();
  const domSecrets = await page.locator('body *').evaluateAll(elements => elements.flatMap(element => [...Array.from(element.attributes, attribute => attribute.value), ...((element as HTMLInputElement).value ? [(element as HTMLInputElement).value] : [])]).join('\n'));
  assert(!bodyText.includes('account-1') && !bodyText.includes('credit-secret'), 'raw account or credit id leaked into visible text');
  for (const secret of [...accounts.map(account => account.id), 'credit-secret', 'partial-credit', 'multi-credit-a', 'multi-credit-b', 'primary-only-credit', 'monthly-credit']) assert(!domSecrets.includes(secret), `raw account or credit id leaked into DOM attributes/values: ${secret}`);
  for (const state of ['Stale', 'Unavailable', 'Partial', 'Zero']) assert(bodyText.toLowerCase().includes(state.toLowerCase()), `${state} usage state missing`);
  assert.equal(await accountCards().getByText('Fresh', { exact: true }).count(), 0, 'decorative fresh badge is replaced by a refresh action');
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
  assert(!(await primaryOnly.innerText()).toLowerCase().includes('partial'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
  const quotaRefresh = primary().getByRole('button', { name: 'Refresh quota usage', exact: true });
  const beforeQuota = { ...usageGets }, quotaAccounts = accountGets, quotaPosts = resetPosts;
  const quotaBox = (await quotaRefresh.boundingBox())!;
  holdUsage = 'account-1'; await quotaRefresh.click();
  await quotaRefresh.locator('.nx-load-xs').waitFor();
  await expect.poll(()=>usageGets['account-1']).toBe(beforeQuota['account-1']+1);
  assert(await quotaRefresh.isDisabled()); assert.equal(await quotaRefresh.getAttribute('aria-busy'), 'true');
  assert.equal((await quotaRefresh.boundingBox())!.width, quotaBox.width);
  assert.equal((await quotaRefresh.boundingBox())!.height, 28);
  assert.equal(await quotaRefresh.locator('svg, .animate-spin').count(), 0);
  await quotaRefresh.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await primary().screenshot({ path: '/tmp/bungee-oauth-usage-refresh-busy.png' });
  assert.deepEqual(usageGets, { ...beforeQuota, 'account-1': beforeQuota['account-1'] + 1 });
  assert.equal(accountGets, quotaAccounts); assert.equal(resetPosts, quotaPosts);
  console.log('QUOTA REFRESH: one account GET, no other account GET/POST, busy disabled, stable 28px button');
  usageFailure = 'account-1'; holdUsage = ''; releaseUsage();
  await primary().getByText('Usage could not be loaded. Refresh to try again.', { exact: true }).waitFor();
  assert.equal(await primary().getByRole('button', { name: 'Use', exact: true }).count(), 0, 'stale credits cannot be consumed');
  usageFailure = ''; await quotaRefresh.click(); await primary().getByRole('button', { name: 'Use', exact: true }).waitFor();
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
  await multiCreditRows.first().getByRole('button', { name: 'Use', exact: true }).focus();
  await page.keyboard.press('Tab'); assert(await directUse.evaluate(element => element === document.activeElement && element.matches(':focus-visible')));
  await page.screenshot({ path: '/tmp/bungee-oauth-use-focus.png' });
  await page.keyboard.press('Enter');
  await dialog.getByText('Rate-limit reset opportunity', { exact: true }).waitFor();
  await settleDialog();
  for (let index = 0; index < 4; index++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement))); }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, 0);
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="reset-credit"]'));
  assert(await directUse.evaluate(element => element === document.activeElement), 'cancel restores credit opener focus');
  await directUse.hover(); await page.screenshot({ path: '/tmp/bungee-oauth-use-hover.png' });
  await directUse.click();
  await dialog.getByRole('button', { name: 'Confirm use', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, 1); assert.equal(resetBodies[0].creditId, 'multi-credit-b');
  await page.setViewportSize({ width: 1100, height: 850 });
  const useCredit = primary().getByRole('button', { name: 'Use', exact: true });
  await useCredit.click(); assert.equal(primaryResetPosts, 0); assert.equal(await page.evaluate(() => (window as any).__oauthUuidCalls()), 3);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(primaryResetPosts, 0);
  await useCredit.click(); assert.equal(await page.evaluate(() => (window as any).__oauthUuidCalls()), 4);
  const confirmCredit = dialog.getByRole('button', { name: 'Confirm use', exact: true });
  const usageBeforeUnknown = usageRequests, resetPostsBeforeUnknown=resetPosts;
  holdReset = true; const firstReset = confirmCredit.click(); await confirmCredit.locator('.nx-load-xs').waitFor(); const resetBox = await confirmCredit.boundingBox(); if (resetBox) await page.mouse.click(resetBox.x + resetBox.width / 2, resetBox.y + resetBox.height / 2);
  await expect.poll(()=>resetPosts).toBe(resetPostsBeforeUnknown+1);
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

  }

  if (scenario === 'login-session') {
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const idleWidth = (await refresh.boundingBox())!.width;
  const idleText = await refresh.innerText();
  holdRefresh = true; await refresh.click();
  await refresh.locator('.nx-load-xs').waitFor();
  assert(await refresh.isDisabled()); assert.equal(await refresh.getAttribute('aria-busy'), 'true');
  assert.equal(await refresh.innerText(), idleText);
  assert(Math.abs((await refresh.boundingBox())!.width - idleWidth) <= 1, 'refresh width must not jump');
  holdRefresh = false; releaseRefresh(); await refresh.locator('.nx-load-xs').waitFor({ state: 'hidden' });
  assert.equal(await refresh.getAttribute('aria-busy'), 'false');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await settleDialog();
  await startLogin();
  await dialog.getByRole('button', { name: 'Start login', exact: true }).locator('.nx-load-xs').waitFor();
  await busyCannotDismiss();
  await expect.poll(()=>starts).toBe(1);
  holdStart = false; releaseStart();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/bungee-oauth-login-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-login-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1100, height: 850 });
  // Keep the next status response pending while inspecting the cross-account notice.
  // An unrelated successful background poll legitimately clears transient notices.
  const statusRefreshBeforeReopen = dialog.getByRole('button', { name: 'Refresh status', exact: true });
  await expect(statusRefreshBeforeReopen).toBeEnabled();
  holdStatus = true; holdStatusSession = 'session-1'; statusHeld = false;
  await statusRefreshBeforeReopen.evaluate(element => (element as HTMLButtonElement).click());
  await statusRefreshBeforeReopen.locator('.nx-load-xs').waitFor();
  await expect.poll(() => statusHeld, { timeout: 10000 }).toBe(true);
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor(); assert.equal(starts, 1);
  assert.equal(await dialog.getByRole('button', { name: 'Start login', exact: true }).count(), 0);
  await close(); await dialog.waitFor({ state: 'hidden' });
  await primary().getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Sign in again', exact: true }).click();
  await dialog.getByText('CODE-1', { exact: true }).waitFor();
  await dialog.getByText(/different account is in progress/).waitFor(); assert.equal(starts, 1);

  }

  if (scenario === 'login-polling') {
  holdStart=false;
  await page.getByRole('button',{name:'Add account',exact:true}).click();
  await startLogin();
  await dialog.getByText('CODE-1',{exact:true}).waitFor();
  for (const code of ['not_found', 'expired']) {
    statusError = code;
    if (code === 'not_found') { holdStatus = false; holdStatusSession = ''; releaseStatus(); }
    // Let the running poll consume the error; a manual click can race its response.
    await dialog.getByRole('button', { name: 'Start login', exact: true }).waitFor();
    const count = statuses; await page.clock.runFor(2200); assert.equal(statuses, count, `${code} must stop polling`);
    statusError = '';
    if (code === 'not_found') { await startLogin(); await dialog.getByText('CODE-2', { exact: true }).waitFor(); }
  }
  invalidStart = true;
  await startLogin();
  await dialog.getByText('Invalid server response. Refresh and try again.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Refresh status', exact: true }).count(), 0);
  assert(await dialog.getByRole('button', { name: 'Start login', exact: true }).isEnabled());
  invalidStart = false;

  }

  if (scenario === 'callback-privacy') {
  holdStart=false;
  await page.getByRole('button',{name:'Add account',exact:true}).click();
  // Callback input is never copied into storage or navigation.
  await dialog.getByRole('radio', { name: 'Codex browser sign-in', exact: true }).click();
  await startLogin();
  await dialog.getByLabel('Complete callback URL').fill('http://localhost/auth/callback?code=fixture-secret');
  holdCallback = true; failCallback = true;
  const callbackRequest = page.waitForRequest(request => request.url().endsWith('/login/callback'));
  await dialog.getByRole('button', { name: 'Submit callback URL', exact: true }).click();
  await callbackRequest;
  await expect.poll(()=>callbackBody?.callbackUrl).toBe('http://localhost/auth/callback?code=fixture-secret');
  assert.equal(await dialog.getByLabel('Complete callback URL').inputValue(), '');
  assert.deepEqual(Object.keys(callbackBody).sort(), ['callbackUrl', 'sessionId']);
  assert(callbackBody.sessionId);
  assert(await dialog.getByRole('button', { name: 'Submit callback URL', exact: true }).isDisabled());
  holdCallback = false; releaseCallback();
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  assert.equal(await dialog.getByLabel('Complete callback URL').inputValue(), '');
  failCallback = false;
  assert.equal(callbackBody.callbackUrl, 'http://localhost/auth/callback?code=fixture-secret');
  assert(!page.url().includes('fixture-secret'));
  assert(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes('fixture-secret'));
  await close(); await dialog.waitFor({ state: 'hidden' });

  }

  if (scenario === 'account-dialogs') {
  await primary().getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Account impact', exact: true }).click();
  await dialog.getByText('Current configuration references only; runtime usage is unknown.', { exact: true }).waitFor();
  await settleDialog();
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
  await settleDialog();
  assert.equal(await dialog.locator('footer').count(), 1);
  assert(await dialog.locator('footer').getByRole('button', { name: 'Confirm', exact: true }).isVisible(), 'rename keeps its action footer');
  await page.screenshot({ path: '/tmp/bungee-oauth-action-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-action-mobile.png' });
  await page.setViewportSize({ width: 1100, height: 850 });
  await dialog.getByLabel('Account name').fill('Renamed');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).locator('.nx-load-xs').waitFor();
  await busyCannotDismiss(); await expect.poll(()=>actionPosts).toBe(1); holdAction = false; releaseAction(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Use with service', exact: true }).first().click();
  await settleDialog();

  assert((await dialog.boundingBox())!.width < 600, 'medium modal must not use an empty 900px chassis');
  await page.screenshot({ path: '/tmp/bungee-oauth-service-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-oauth-service-mobile.png' });
  assert((await dialog.boundingBox())!.width <= 362);
  await page.setViewportSize({ width: 1100, height: 850 });
  await dialog.getByLabel('Choose service', { exact: true }).click();
  await page.getByRole('option', { name: 'existing-service', exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue to service editor', exact: true }).click();
  await page.waitForURL(/#\/services\/edit\/existing-service\?/);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(commits, 0);
  const query = new URLSearchParams(page.url().split('?').at(-1));
  assert.equal(query.get('accountRef'), 'account-1'); assert.equal(query.get('serviceId'), serviceId);

  }

  if (scenario === 'account-layout') {
  const assertGrid = async (width: number, columns: number, screenshot: string) => {
    const postsBeforeLayout = resetPosts;
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => accountCards().evaluateAll(elements =>
      new Set(elements.map(element => Math.round(element.getBoundingClientRect().x))).size)).toBe(columns);
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
    // Keep the original accessible button scope: the 24px auto-reset switch has a distinct role.
    const buttonHeights = await Promise.all((await accountCards().all()).map(card =>
      card.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))));
    // Sample the same rendered contracts once per viewport, including every credit button.
    const details = await accountCards().evaluateAll(cards => cards.map(card => {
      const status = card.querySelector('[data-testid="account-status"]')!;
      const header = card.querySelector('header')!;
      const title = header.querySelector('.truncate')!.getBoundingClientRect();
      const box = status.getBoundingClientRect(), bounds = header.getBoundingClientRect();
      const viewport = card.querySelector<HTMLElement>('[data-testid="credit-viewport"]');
      const heading = card.querySelector<HTMLElement>('[data-testid="reset-heading"]');
      return {
        status: (status as HTMLElement).innerText.trim(), variant: status.querySelector('span')!.className,
        headerStatuses: header.querySelectorAll('[data-testid="account-status"]').length,
        bodyStatuses: card.querySelector('.nx-panel-body')!.querySelectorAll('[data-testid="account-status"]').length,
        identityBadges: card.querySelector('[data-testid="account-identity"]')!.querySelectorAll('[class*="nx-badge-"]').length,
        types: [...card.querySelectorAll<HTMLElement>('[data-testid="account-type"]')].map(node => node.innerText),
        headerFits: header.scrollWidth <= header.clientWidth && status.scrollWidth <= status.clientWidth
          && box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom
          && (title.right <= box.left || title.bottom <= box.top || box.bottom <= title.top),
        fits: card.scrollWidth <= card.clientWidth,
        footerAlignment: getComputedStyle(card.querySelector('[data-testid="account-actions"]')!).justifyContent,
        creditViewport: viewport ? { height: viewport.clientHeight, overflow: getComputedStyle(viewport).overflowY } : null,
        headingVisible: heading ? heading.checkVisibility() && heading.getBoundingClientRect().height > 0 : null,
      };
    }));
    for (const [index, detail] of details.entries()) {
      const account = accounts[index];
      const expected = account.available ? (zh ? '可用' : 'AVAILABLE') : account.status === 'disabled' ? (zh ? '已禁用' : 'DISABLED') : account.status === 'revoked' ? (zh ? '已移除' : 'REMOVED') : (zh ? '需要重新登录' : 'SIGN IN AGAIN REQUIRED');
      assert.equal(detail.status, expected);
      assert.equal(detail.headerStatuses, 1); assert.equal(detail.bodyStatuses, 0);
      const variant = account.available ? 'active' : account.status === 'revoked' ? 'muted' : 'standby';
      assert(detail.variant.split(' ').includes(`nx-badge-${variant}`));
      assert.equal(detail.identityBadges, 0, 'identity body has no bare account status');
      const plan = account.identity?.planType;
      assert.deepEqual(detail.types, plan ? [zh ? `账号类型：${plan}` : `Account type: ${plan}`] : []);
      assert(detail.headerFits, 'header title/status must not overlap, overflow or clip');
      assert(detail.fits, 'card content must not overflow');
      assert.equal(detail.footerAlignment, 'flex-end');
      assert(buttonHeights[index].every(height => height === 28), 'every card button keeps the actual 28px primitive sm size');
      if (detail.creditViewport) assert.deepEqual(detail.creditViewport, { height: 112, overflow: 'auto' });
      if (detail.headingVisible !== null) assert(detail.headingVisible, 'reset heading remains readable');
    }
    if (width === 1440) {
      const pair = page.locator('.account-card').filter({ hasText: /Multiple credits|Primary only/ });
      const geometry = await pair.evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, footer: element.querySelector('[data-testid="account-actions"]')!.getBoundingClientRect().bottom })));
      assert.equal(geometry.length, 2); assert(Math.abs(geometry[0].top - geometry[1].top) <= 1);
      assert(Math.abs(geometry[0].height - geometry[1].height) <= 1 && Math.abs(geometry[0].footer - geometry[1].footer) <= 1, 'one/two credit cards and footers align');
      console.log('CREDIT ALIGNMENT', JSON.stringify(geometry));
      if (zh) {
        await pair.first().scrollIntoViewIfNeeded();
        const a = (await pair.first().boundingBox())!, b = (await pair.last().boundingBox())!;
        await page.screenshot({ path: '/tmp/bungee-oauth-credit-pair-zh-1440.png', clip: { x: a.x, y: a.y, width: b.x + b.width - a.x, height: a.height } });
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    // Responsive DOM assertions cover all widths/locales; representative success images cover both languages and mobile/desktop.
    if (width === 1440 || zh && width === 390) {
      await page.screenshot({ path: screenshot, fullPage: true });
      await page.locator('.account-card').filter({ hasText: 'Multiple credits' }).screenshot({ path: screenshot.replace('.png', '-credits.png') });
    }
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
  for (const [width, columns] of [[390,1],[900,2],[1440,3]]) await assertGrid(width, columns, `/tmp/bungee-oauth-grid-${width}.png`);
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
  await page.setViewportSize({ width: 390, height: 844 });
  const many = accountCards().filter({ hasText: 'Many credits' });
  const manyViewport = many.getByTestId('credit-viewport');
  assert.equal(await many.getByRole('button', { name: '使用', exact: true }).count(), 256);
  assert(await manyViewport.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight === 112));
  const manyPosts = resetPosts, manyGets = usageRequests;
  await manyViewport.focus();
  for (let index = 0; index < 256; index++) {
    await page.keyboard.press('Tab');
    assert(await many.getByRole('button', { name: '使用', exact: true }).nth(index).evaluate(element => element === document.activeElement), `credit ${index + 1} reachable by Tab`);
  }
  assert(await manyViewport.evaluate(element => element.scrollTop > 0));
  await many.screenshot({ path: '/tmp/bungee-oauth-many-credits-zh-390.png' });
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: '确认使用', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(resetPosts, manyPosts); assert.equal(usageRequests, manyGets);
  console.log('CREDIT VIEWPORT: 112px, all 256 actions keyboard reachable, last credit opens/cancels without POST');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 900 });
  const moreZh = multiZh.getByRole('button', { name: /更多操作/ });
  assert.equal(await moreZh.getAttribute('title'), '更多操作');
  await moreZh.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重新登录', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('更多操作:'));
  assert(await moreZh.evaluate(element => element === document.activeElement));
  await page.evaluate(() => (window as any).setTestLocale('en'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1100, height: 850 });

  }

  if (scenario === 'session-fencing') {
  holdStart = false;
  // Success must close before a held account refresh, and never close a subsequently opened login.
  const loginResetPosts = resetPosts;
  for (const method of ['device', 'pkce']) {
    await page.goto(base); await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    if (method === 'pkce') await dialog.getByRole('radio', { name: 'Codex browser sign-in', exact: true }).click();
    await startLogin();
    await dialog.getByText('Waiting for sign-in', { exact: true }).waitFor();
    const current = `session-${starts}`, beforeAccounts = accountGets;
    await page.screenshot({ path: `/tmp/bungee-oauth-${method}-success-before.png` });
    loginResults[current] = 'success';
    if (method === 'device') {
      const winner = { id: 'refresh-winner', label: 'Refresh winner', available: true, status: 'active' };
      refreshResponseAccounts = [...accounts, winner]; holdNextRefresh = true;
      await holdResponseJson(page,'old-account-refresh',{method:'GET',path:'/api/plugins/chatgpt-oauth/control/accounts'});
      const oldRequested = page.waitForRequest(request => request.url().endsWith('/control/accounts'));
      const oldRefresh = page.getByRole('button', { name: 'Refresh', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await oldRequested;
      const oldAccountResponse=await waitForResponseReceipt(page,'old-account-refresh');
      const secondRequested = page.waitForRequest(request => request.url().endsWith('/control/accounts'));
      const statusRefresh = dialog.getByRole('button', { name: 'Refresh status', exact: true }).and(page.locator('[aria-busy="false"]'));
      await statusRefresh.waitFor(); await statusRefresh.click();
      await secondRequested; await dialog.waitFor({ state: 'hidden' });
      await page.getByText('Refresh winner', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add account', exact: true }).click();
      await startLogin();
      await dialog.getByText('Waiting for sign-in', { exact: true }).waitFor();
      assert(`session-${starts}` !== current);
      await releaseResponseJson(page,oldAccountResponse);await oldRefresh;
      await waitForResponseDelivery(page,oldAccountResponse);
      await page.getByText('Refresh winner', { exact: true }).waitFor();
      refreshResponseAccounts = undefined;
      await page.screenshot({ path: `/tmp/bungee-oauth-${method}-success-after.png` });
      assert.equal(accountGets, beforeAccounts + 2, 'latest programmatic refresh must not be swallowed');
      assert(await dialog.isVisible(), 'late account refresh from prior success does not close new session');
      console.log(`LOGIN SUCCESS ${method}: latest refresh won; old response ignored, replacement dialog remains open`);
    } else {
      holdRefresh = true;
      const refreshRequested = page.waitForRequest(request => request.url().endsWith('/control/accounts'));
      await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await refreshRequested; await dialog.waitFor({ state: 'hidden' });
      assert.equal(accountGets, beforeAccounts + 1);
      assert(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), 'slow refresh still held after dialog closes');
      await page.screenshot({ path: `/tmp/bungee-oauth-${method}-success-after.png` });
      await page.getByRole('button', { name: 'Add account', exact: true }).click();
      await startLogin();
      await dialog.getByText('Waiting for sign-in', { exact: true }).waitFor();
      assert(`session-${starts}` !== current);
      holdRefresh = false; releaseRefresh();
      await page.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
      assert(await dialog.isVisible(), 'late account refresh from prior success does not close new session');
      console.log(`LOGIN SUCCESS ${method}: closed before held refresh, accounts GET +1, replacement dialog remains open`);
    }
  }
  // A real pagehide clears the old session; a held old poll must not close the replacement dialog.
  const oldSession = `session-${starts}`;
  loginResults[oldSession] = 'success';
  await holdResponseJson(page,'old-session-status',{method:'GET',path:'/api/plugins/chatgpt-oauth/control/login/status',query:{sessionId:oldSession}});
  await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await dialog.getByRole('button', { name: 'Refresh status', exact: true }).locator('.nx-load-xs').waitFor();
  const oldSessionResponse=await waitForResponseReceipt(page,'old-session-status');
  await close(); await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const newStatusBaseline = statuses;
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await startLogin();
  await dialog.getByText(`CODE-${starts}`, { exact: true }).waitFor();
  await releaseResponseJson(page,oldSessionResponse);
  await waitForResponseDelivery(page,oldSessionResponse);
  assert(statuses > newStatusBaseline, 'replacement session must poll automatically while old poll is held');
  await dialog.getByRole('button', { name: 'Refresh status', exact: true }).and(page.locator('[aria-busy="false"]')).waitFor();
  assert(await dialog.isVisible());
  for (const state of ['failed', 'cancelled', 'expired']) {
    loginResults[`session-${starts}`] = state;
    await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await dialog.getByRole('button', { name: 'Start login', exact: true }).waitFor();
    assert(await dialog.isVisible(), `${state} is not auto-closed`);
    if (state !== 'expired') {
      await startLogin();
      await dialog.getByText('Waiting for sign-in', { exact: true }).waitFor();
    }
  }
  assert.equal(resetPosts, loginResetPosts); assert.equal(commits, 0);
  console.log('LOGIN FENCING: old-session success ignored; failed/cancelled/expired remain open; no reset POST');

  }
  assert.equal(commits,0); evidence.verify();
  } finally {
    releaseStart(); releaseAction(); releaseReset(); releaseRefresh(); releaseUsage(); releaseStatus(); releaseCallback(); firstUsageBatch.forEach(release => release());
    await context.close();
  }
}
