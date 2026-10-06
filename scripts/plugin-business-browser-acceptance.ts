/**
 * Real browser acceptance against the current dist, never an existing deployment.
 * Run: bun scripts/plugin-business-browser-acceptance.ts --evidence-dir /tmp/bungee-browser
 * Prerequisites: complete current build; Playwright and an existing Chromium cache.
 * No business API mocking, auth bypass, synthetic statistics, rebuild, or paid provider.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import {
  createModelsDevGatewayFixture, reservePortBlock, spawnMaster, waitForHealth,
  requestJson, waitUntil, recordOwnedWorkers, stopOwnedMaster, releasePortBlock,
  quarantinePortBlock, cleanupGatewayFixture, safeGatewayError,
  type GatewayFixture, type OwnedMaster, type PortLease,
} from '../tests/support/models-dev-gateway';
import { waitForAuthPublication } from '../tests/support/auth-publication-readiness';

const arg = process.argv.indexOf('--evidence-dir');
const evidence = resolve(arg >= 0 ? process.argv[arg + 1]! : `/tmp/bungee-browser-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const steps: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = [];
const network: Array<Record<string, unknown>> = [];
const requests: Array<Record<string, unknown>> = [];
const errors: string[] = [];
const consoleErrors: string[] = [];
const failedRequests: Array<Record<string, unknown>> = [];
let fixture: GatewayFixture | undefined;
let lease: PortLease | undefined;
let master: OwnedMaster | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let startupAttempted = false;
let csrf = '';
let management = '';
let proxy = '';
let activeStep = 'startup';
let upstreamRequests = 0;
const originals = ['BrowserCase-Original', ...Array.from({ length: 52 }, (_, i) => `BrowserPage-${String(i).padStart(3, '0')}`)];
const freeAlias = `FreeAlias-${randomUUID()}`;
const cleanup: Record<string, unknown> = {};
let catalogEvidence: Record<string, unknown> = {};
let settingsPerformance: Record<string, unknown> = {};

function log(message: string) { console.log(`${new Date().toISOString()} ${message}`); }
function cleanError(error: unknown): string { return fixture ? safeGatewayError(error, fixture) : String(error); }
async function capture(name: string) {
  if (!page || page.isClosed()) return;
  const slug = name.replace(/[^a-z0-9-]/gi, '-');
  await page.screenshot({ path: join(evidence, `${slug}.png`), fullPage: true, timeout: 10_000 });
  // DOM text excludes password values, session cookies, and auth response bodies.
  await writeFile(join(evidence, `${slug}.txt`), await page.locator('body').innerText());
}
async function step(name: string, run: () => Promise<void>) {
  activeStep = name;
  log(`START ${name}`);
  try { await run(); steps.push({ name, status: 'passed' }); log(`PASS ${name}`); }
  catch (error) { const message = cleanError(error); steps.push({ name, status: 'failed', error: message }); log(`FAIL ${name}: ${message}`); }
  await capture(`${name}-${steps.at(-1)!.status}`).catch(error => errors.push(`capture: ${cleanError(error)}`));
}
async function raw(path: string, init: RequestInit = {}) {
  return requestJson(management + path, init, fixture!);
}
async function get(path: string): Promise<any> {
  const response = await context!.request.get(management + path, { timeout: 15_000 });
  const text = await response.text();
  assert.equal(response.status(), 200, `${path}: ${response.status()} ${text}`);
  return JSON.parse(text);
}
async function mutateReady(path: string, body: unknown) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let last: any;
  await waitUntil(async () => {
    const result = await raw(path, init);
    last = { status: result.response.status, body: result.body };
    if (result.response.status === 202) return true;
    const payload = result.body as any;
    assert(result.response.status === 503 && payload.error === 'control_recovering'
      && ['admission_recovering', 'retired_pending', 'lease_margin'].includes(payload.reason), JSON.stringify(last));
    return false;
  }, `mutation admission did not clear: ${path}`, 45_000).catch(error => { throw new Error(`${cleanError(error)} last=${JSON.stringify(last)}`); });
}
async function publication(revision?: number, authenticated = false) {
  const state = await waitForAuthPublication({ base: management, revision, timeoutMs: 45_000,
    childExited: () => master!.child.exitCode !== null || master!.child.signalCode !== null,
    childDiagnostic: () => ({ pid: master!.child.pid, exitCode: master!.child.exitCode }),
    ...(authenticated ? { fetch: async (input: any, init: any) => {
      const response = await context!.request.get(String(input), { timeout: 10_000 });
      return new Response(await response.body(), { status: response.status(), headers: response.headers() });
    } } : {}),
  });
  assert.equal(state.workers.length, 2);
  await recordOwnedWorkers(master!, state.workers);
  return state;
}
async function navigate(plugin: string, path: string, id?: string) {
  await page!.goto(`${management}/#/plugins/${plugin}${path}`, { waitUntil: 'domcontentloaded' });
  if (id) await page!.getByTestId(id).waitFor({ timeout: 20_000 });
}
async function postModel(model: string, token?: string) {
  const result = await requestJson(proxy + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'isolated browser technical upstream' }] }),
  }, fixture!);
  assert.equal(result.response.status, 200, result.text);
  assert.equal((result.body as any).usage.prompt_tokens, 17);
}
async function selectPrice(row: Locator, target: { provider: string; model: string }) {
  // BSelect and PriceModelPicker are real interactive popovers.
  const provider = row.locator('button[role="combobox"]');
  await provider.click();
  const providerSuffix = new RegExp(`·\\s${target.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await page!.getByRole('option', { name: providerSuffix }).click();
  await row.locator('button[aria-haspopup="listbox"]').last().click();
  await page!.locator('[data-cmdk-input], [cmdk-input]').fill(target.model);
  await page!.getByRole('option', { name: target.model, exact: true }).click();
}
async function saveAliases(expected: any[]) {
  const [actual] = await Promise.all([
    page!.waitForResponse(r => r.url().endsWith('/token-stats/control/pricing/mappings') && r.request().method() === 'PUT'),
    page!.getByTestId('price-mappings-save').click(),
  ]);
  assert.equal(actual.status(), 200, await actual.text());
  assert.deepEqual((await get('/api/plugins/token-stats/control/pricing/mappings')).mappings, expected);
}
try {
  fixture = await createModelsDevGatewayFixture();
  for (const name of ['local-accounts', 'key-access', 'token-budget']) {
    await cp(resolve(`packages/core/dist/plugins/${name}`), join(fixture.pluginsPath, name), { recursive: true, errorOnExist: true });
  }
  lease = await reservePortBlock();
  management = `http://127.0.0.1:${lease.base}`;
  proxy = `http://127.0.0.1:${lease.block.ports[1]}`;
  upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 });
    const input = await request.json() as { model: string }; upstreamRequests++;
    return Response.json({ id: `technical-${upstreamRequests}`, object: 'chat.completion', model: input.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'technical fixture; no paid provider' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } } });
  } });
  startupAttempted = true;
  master = await spawnMaster(fixture, lease, owned => { master = owned; }, 'debug');
  await waitForHealth(master, lease.base, fixture);
  await publication();
  const initial = (await raw('/api/config')).body as any;
  const serviceId = randomUUID(), upstreamId = randomUUID(), routeId = randomUUID();
  const mutationId = randomUUID();
  const configInit = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    expected_revision: initial.revision, mutation_id: mutationId, aggregate: {
      plugin_activations: ['models-dev', 'token-metering', 'token-stats', 'model-mapping'].map(plugin_name => ({ plugin_name })),
      logical_configuration: { plugins: [], services: [{ id: serviceId, position: 1, name: 'browser-technical-upstream', plugins: [],
        endpoints: [{ id: upstreamId, position: 1, target: `http://127.0.0.1:${upstream.port}`, weight: 100, priority: 1, is_disabled: false, plugins: [] }] }],
        routes: [{ id: routeId, position: 1, path: '/v1/chat/completions', service_id: serviceId, plugins: [] }] },
    },
  }) };
  const configured = await raw('/api/config', configInit);
  assert.equal(configured.response.status, 202, configured.text);
  await publication(initial.revision + 1);
  // Initialization also goes through the real management API: no SQL seed writes.
  const settings = await raw('/api/plugins/models-dev/control/catalog/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoRefresh: false, intervalHours: 24, timeoutSeconds: 30 }),
  });
  assert.equal(settings.response.status, 200, settings.text);
  const password = `Browser-${randomBytes(12).toString('hex')}!`;
  await mutateReady('/api/plugins/local-accounts/enable', { expected_revision: initial.revision + 1, mutation_id: randomUUID(),
    managementSetup: { username: 'browser-owner', password, passwordConfirmation: password } });
  const denied = await fetch(management + '/api/config', { signal: AbortSignal.timeout(5000) });
  assert.equal(denied.status, 401, 'account mode must reject anonymous management');
  await denied.body?.cancel();
  const executable = process.env.BUNGEE_ACCEPTANCE_CHROMIUM ?? chromium.executablePath();
  await access(executable);
  browser = await chromium.launch({ headless: true, executablePath: executable });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: management });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push({ step: activeStep, url: request.url(), method: request.method(), error: request.failure()?.errorText }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ step: activeStep, path: url.pathname + url.search, method: request.method() });
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) network.push({ time: new Date().toISOString(), step: activeStep,
      path: url.pathname + url.search, method: response.request().method(), status: response.status() });
    if (url.pathname.startsWith('/api/plugins/') && (response.request().method() !== 'GET' || response.status() >= 400)) {
      void response.text().then(body => network.push({ step: activeStep, path: url.pathname, status: response.status(), body })).catch(() => undefined);
    }
  });
  await step('authenticated-plugin-login', async () => {
    await page!.goto(`${management}/#/plugins/models-dev/catalog/status`, { waitUntil: 'domcontentloaded' });
    await page!.locator('input[autocomplete="username"]').fill('browser-owner');
    await page!.locator('input[autocomplete="current-password"]').fill(password);
    const [result] = await Promise.all([page!.waitForResponse(r => r.url().endsWith('/api/auth/login')), page!.locator('form button').click()]);
    assert.equal(result.status(), 200, await result.text());
    csrf = (await result.json()).csrfToken;
    assert(csrf && (await context!.cookies()).some(cookie => cookie.httpOnly), 'real cookie session was not created');
    assert.equal((await get('/api/plugins/local-accounts/control/self')).administrator.username, 'browser-owner');
    await publication(initial.revision + 2, true);
    await navigate('models-dev', '/catalog/status', 'models-dev-settings');
    await page!.getByTestId('models-dev-interval').waitFor();
  });
  assert(csrf, 'browser login failed; dependent steps require a real authenticated session');
  await step('models-dev-settings-boundaries-and-save', async () => {
    const before = await get('/api/plugins/models-dev/control/catalog/status');
    assert.equal(await page!.getByTestId('models-dev-interval').inputValue(), '24');
    assert.equal((await page!.locator('label[for="models-dev-interval"]').innerText()).toLowerCase(), 'refresh interval (hours)');
    const start = requests.length;
    for (const [field, low, high, original, label] of [
      ['models-dev-interval', 1, 24, 24, 'Refresh interval (hours)'],
      ['models-dev-timeout', 5, 120, 30, 'Download timeout (seconds)'],
    ] as const) {
      const input = page!.getByTestId(field);
      const increase = page!.getByRole('button', { name: `Increase ${label}`, exact: true });
      const decrease = page!.getByRole('button', { name: `Decrease ${label}`, exact: true });
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(await input.getAttribute('inputmode'), 'numeric');
      assert.equal(await input.getAttribute('role'), 'spinbutton');
      await input.fill(String(low));
      await input.press('End');
      for (const key of ['.', '-', '+', 'e', 'a']) {
        await input.press(key);
        assert.equal(await input.inputValue(), String(low), `accepted key ${key}`);
      }
      for (const text of ['1.5', '15.5', '-2', '1e2', 'abc12']) {
        await page!.evaluate(text => navigator.clipboard.writeText(text), text);
        await input.press('Control+V');
        assert.equal(await input.inputValue(), String(low), `accepted invalid paste ${text}`);
      }
      await input.press('Control+A');
      await page!.evaluate(() => navigator.clipboard.writeText('12'));
      await input.press('Control+V');
      assert.equal(await input.inputValue(), '12');
      await input.press('ArrowLeft');
      await input.press('Backspace');
      assert.equal(await input.inputValue(), '2');
      await input.press('Control+A'); await input.pressSequentially('15');
      await input.press('ArrowLeft'); await input.press('.');
      assert.equal(await input.inputValue(), '15');
      assert.equal(await input.evaluate((node: HTMLInputElement) => node.selectionStart), 1);
      // Exercise non-cancelable input fallback and composition completion separately from real keyboard/paste.
      await input.evaluate((node: HTMLInputElement) => {
        node.value = '1.5'; node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '1.5', cancelable: false }));
      });
      assert.equal(await input.inputValue(), '15');
      await input.evaluate((node: HTMLInputElement) => {
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.value = '中文'; node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      });
      assert.equal(await input.inputValue(), '15');
      await input.fill('');
      await page!.getByTestId('models-dev-save').click();
      assert.equal(await input.inputValue(), '');
      assert.equal(await input.evaluate((node: HTMLInputElement) => node.validity.valueMissing), true);
      for (const [typed, expected] of [[String(low - 1), low], [String(high + 1), high], ['00012', 12]] as const) {
        await input.fill(typed);
        await input.press('Tab');
        assert.equal(await input.inputValue(), String(expected));
      }
      await input.fill(String(high));
      assert.equal(await increase.isDisabled(), true);
      await input.press('ArrowUp'); assert.equal(await input.inputValue(), String(high));
      await decrease.click(); assert.equal(await input.inputValue(), String(high - 1));
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      await input.fill(String(low)); assert.equal(await decrease.isDisabled(), true);
      await input.press('ArrowDown'); assert.equal(await input.inputValue(), String(low));
      await increase.focus(); await increase.press('Enter');
      assert.equal(await input.inputValue(), String(low + 1));
      await input.fill(''); await increase.click(); assert.equal(await input.inputValue(), String(low));
      await input.fill(String(original));
    }
    assert(!requests.slice(start).some(row => row.method === 'PUT' && String(row.path).endsWith('/catalog/settings')),
      'editing/stepping/invalid blank input submitted settings');
    assert.deepEqual((await get('/api/plugins/models-dev/control/catalog/status')).settings, before.settings);
    await page!.getByTestId('models-dev-interval').fill('2');
    await page!.getByTestId('models-dev-timeout').fill('45');
    const [response] = await Promise.all([
      page!.waitForResponse(r => r.url().endsWith('/models-dev/control/catalog/settings') && r.request().method() === 'PUT'),
      page!.getByTestId('models-dev-save').click(),
    ]); assert.equal(response.status(), 200, await response.text());
    assert.deepEqual((await get('/api/plugins/models-dev/control/catalog/status')).settings, { autoRefresh: false, intervalHours: 2, timeoutSeconds: 45 });
    await page!.reload({ waitUntil: 'domcontentloaded' }); await page!.getByTestId('models-dev-interval').waitFor();
    assert.equal(await page!.getByTestId('models-dev-interval').inputValue(), '2');
    assert.equal(await page!.getByTestId('models-dev-timeout').inputValue(), '45');
  });
  await step('models-dev-real-source-refresh', async () => {
    const [result] = await Promise.all([
      page!.waitForResponse(r => r.url().endsWith('/models-dev/control/catalog/refresh') && r.request().method() === 'POST'),
      page!.getByTestId('models-dev-refresh').click(),
    ]); assert.equal(result.status(), 202, await result.text());
    let status: any;
    await waitUntil(async () => { status = await get('/api/plugins/models-dev/control/catalog/status');
      return status.state === 'ready' && !status.refreshing && status.modelCount > 0 && status.providerCount > 0;
    }, 'real models.dev refresh did not become ready', 65_000);
    const read = new Database(fixture!.configDbPath, { readonly: true });
    try {
      const rows = read.query('SELECT key, payload FROM plugin_communication_records WHERE namespace = ? ORDER BY key').all('models-dev') as any[];
      const metaRow = rows.find(row => row.key.endsWith(`:${status.version}:m`));
      assert(metaRow, 'persisted Host catalog snapshot was not found');
      const meta = JSON.parse(Buffer.from(metaRow.payload).toString('utf8'));
      const prefix = metaRow.key.slice(0, -1) + 'c';
      const chunks = rows.filter(row => row.key.startsWith(prefix));
      assert.equal(chunks.length, meta.chunks);
      const body = Buffer.concat(chunks.map(row => Buffer.from(row.payload)));
      const digest = createHash('sha256').update(body).digest('hex');
      assert.equal(`sha256:${digest}`, meta.digest);
      const snapshot = JSON.parse(body.toString('utf8'));
      assert.equal(snapshot.version, status.version);
      catalogEvidence = { source: 'https://models.dev/api.json', fetchedAt: snapshot.fetchedAt, version: status.version,
        providerCount: status.providerCount, modelCount: status.modelCount, persistedSnapshotChunks: chunks.length,
        persistedSnapshotSHA256: digest, catalogSHA256: createHash('sha256').update(JSON.stringify(snapshot.catalog)).digest('hex'),
        hashScope: 'exact published snapshot bytes and its complete catalog JSON, checked against Host descriptor' };
    } finally { read.close(); }
    await writeFile(join(evidence, 'catalog.json'), JSON.stringify(catalogEvidence, null, 2));
    await waitUntil(async () => (await page!.getByTestId('models-dev-version').innerText()) === String(status.version), 'catalog version did not render');
  });
  await step('real-proxy-attempt-records', async () => {
    for (const model of originals) await postModel(model);
    await waitUntil(async () => (await get('/api/plugins/token-stats/control/models?pageSize=100')).total === originals.length,
      'real proxy attempt names did not become searchable', 40_000);
    assert.equal(upstreamRequests, originals.length);
    const recorded = await get('/api/plugins/token-stats/control/models?pageSize=100');
    assert.deepEqual([...recorded.models].sort(), [...originals].sort());
    await writeFile(join(evidence, 'real-attempt-models.json'), JSON.stringify(recorded, null, 2));
  });
  await step('token-settings-lazy-catalog-and-target-pagination', async () => {
    const start = requests.length;
    const started = performance.now();
    await navigate('token-stats', '/pricing', 'token-stats-settings');
    await page!.getByTestId('price-mappings-save').waitFor();
    await page!.getByRole('button', { name: /Add alias|添加映射/ }).waitFor();
    const renderedMs = performance.now() - started;
    const initial = requests.slice(start);
    assert(!initial.some(row => String(row.path).includes('/token-stats/control/pricing/models')), 'settings page preloaded model pages');
    settingsPerformance = { renderedMs, initialModelRequests: 0, catalog: catalogEvidence };
    const providers = await get('/api/plugins/models-dev/control/catalog/providers');
    const provider = providers.providers.find((item: any) => item.provider === 'openai' && item.modelCount > 50)
      ?? providers.providers.find((item: any) => item.modelCount > 50);
    assert(provider, 'real catalog needs a provider with more than one page');
    const second = await get(`/api/plugins/token-stats/control/pricing/models?provider=${encodeURIComponent(provider.provider)}&page=2&pageSize=50`);
    const target = second.models[0]; assert(target);
    await page!.getByRole('button', { name: /Add alias|添加映射/ }).click();
    const row = page!.getByTestId('price-model-mapping').last();
    await row.locator('button[role="combobox"]').click();
    const suffix = new RegExp(`·\\s${provider.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await page!.getByRole('option', { name: suffix }).click();
    const [first] = await Promise.all([
      page!.waitForResponse(r => r.url().includes('/token-stats/control/pricing/models?') && new URL(r.url()).searchParams.get('page') === '1'),
      row.locator('button[aria-haspopup="listbox"]').last().click(),
    ]);
    assert.equal(first.status(), 200);
    assert.equal((await first.json()).models.length, 50);
    const [next] = await Promise.all([
      page!.waitForResponse(r => r.url().includes('/token-stats/control/pricing/models?') && new URL(r.url()).searchParams.get('page') === '2'),
      page!.getByTestId('price-model-next-page').click(),
    ]);
    assert.equal(next.status(), 200);
    await page!.getByRole('option', { name: target.model, exact: true }).click();
    assert.equal(await row.locator('button[aria-haspopup="listbox"]').last().innerText(), target.model);
    // A real directory publication must requery an open picker without changing the saved value.
    await row.locator('button[aria-haspopup="listbox"]').last().click();
    await page!.getByTestId('price-model-next-page').waitFor();
    const before = await get('/api/plugins/models-dev/control/catalog/status');
    const requery = page!.waitForResponse(r => r.url().includes('/token-stats/control/pricing/models?')
      && new URL(r.url()).searchParams.get('provider') === provider.provider
      && new URL(r.url()).searchParams.get('page') === '1', { timeout: 80_000 });
    const refresh = await context!.request.post(management + '/api/plugins/models-dev/control/catalog/refresh', {
      headers: { origin: management, 'x-csrf-token': csrf },
    });
    assert.equal(refresh.status(), 202);
    await waitUntil(async () => (await get('/api/plugins/models-dev/control/catalog/status')).version > before.version,
      'real catalog update did not publish while picker was open', 65_000);
    await waitUntil(async () => (await page!.getByTestId('pricing-catalog-version').innerText()) !== String(before.version),
      'new catalog version did not reach settings', 15_000);
    const requeried = await requery;
    assert.equal(requeried.status(), 200);
    assert((await requeried.json()).models.every((model: any) => model.provider === provider.provider));
    await page!.getByTestId('price-model-next-page').waitFor();
    assert.equal(await row.locator('button[aria-haspopup="listbox"]').last().innerText(), target.model);
    await page!.keyboard.press('Escape');
    await row.getByRole('button', { name: /Remove|删除|移除/ }).click();
    settingsPerformance = { ...settingsPerformance, provider: provider.provider, selectedSecondPageModel: target.model, openPickerRequeriedAfterRefresh: true };
    await writeFile(join(evidence, 'settings-performance.json'), JSON.stringify(settingsPerformance, null, 2));
  });
  await step('client-model-search-select-keyboard-pagination', async () => {
    await navigate('token-stats', '/pricing', 'token-stats-settings');
    // A backend refusal is a business failure, not a reason to hide assertions.
    await get('/api/plugins/token-stats/control/pricing');
    await page!.getByRole('button', { name: /Add alias|添加映射/ }).click();
    const input = page!.getByTestId('client-model-input').first();
    await input.fill('browsercase');
    const option = page!.getByRole('option', { name: originals[0], exact: true }); await option.waitFor();
    await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), originals[0], 'original case must survive selection');
    await input.fill('BrowserPage-');
    await page!.getByTestId('client-model-next-page').waitFor();
    const [next] = await Promise.all([
      page!.waitForResponse(r => r.url().includes('/token-stats/control/models?') && new URL(r.url()).searchParams.get('page') === '2'),
      page!.getByTestId('client-model-next-page').click(),
    ]); assert.equal((await next.json()).page, 2);
    await page!.getByRole('option', { name: 'BrowserPage-050', exact: true }).waitFor();
    await input.fill('this-query-must-be-superseded'); await input.fill('browsercase');
    await page!.getByRole('option', { name: originals[0], exact: true }).click();
    assert.equal(await input.inputValue(), originals[0]);
    assert.equal((await get('/api/plugins/token-stats/control/models?search=BROWSERCASE')).models[0], originals[0]);
  });
  let target: { provider: string; model: string } | undefined;
  let beforeMappingStats: any;
  await step('price-provider-model-selection-and-persist', async () => {
    const providers = await get('/api/plugins/models-dev/control/catalog/providers');
    const preferred = providers.providers.find((item: any) => item.provider === 'zai') ?? providers.providers.find((item: any) => item.modelCount > 0);
    assert(preferred, 'no real catalog provider');
    const models = await get(`/api/plugins/models-dev/control/catalog/models?provider=${encodeURIComponent(preferred.provider)}&pageSize=100`);
    const model = models.models.find((item: any) => item.model === 'glm-5.3') ?? models.models[0]; assert(model);
    target = { provider: preferred.provider, model: model.model };
    const row = page!.getByTestId('price-model-mapping').first();
    assert.equal(await row.count(), 1, 'authenticated alias editor was not rendered');
    await row.getByTestId('client-model-input').fill(originals[0]); await row.getByTestId('client-model-input').press('Escape');
    await selectPrice(row, target);
    beforeMappingStats = await get(`/api/plugins/token-stats/control/stats?range=1h&groupBy=model&search=${encodeURIComponent(originals[0]!)}`);
    await saveAliases([{ source: originals[0], ...target }]);
  });
  await step('free-alias-keeps-recorded-model-catalog-honest', async () => {
    assert(target, 'previous real target selection did not finish');
    await get('/api/plugins/token-stats/control/pricing');
    await page!.getByRole('button', { name: /Add alias|添加映射/ }).click();
    const row = page!.getByTestId('price-model-mapping').last();
    await row.getByTestId('client-model-input').fill(freeAlias); await row.getByTestId('client-model-input').press('Escape');
    await selectPrice(row, target);
    await saveAliases([{ source: originals[0], ...target }, { source: freeAlias, ...target }]);
    const records = await get(`/api/plugins/token-stats/control/models?search=${encodeURIComponent(freeAlias)}`);
    assert.deepEqual(records.models, []); assert.equal(records.total, 0);
    await page!.reload({ waitUntil: 'domcontentloaded' }); await page!.getByTestId('client-model-input').last().waitFor();
    assert.equal(await page!.getByTestId('client-model-input').last().inputValue(), freeAlias);
  });
  await step('historical-cost-and-worker-reconciliation', async () => {
    assert(target && beforeMappingStats, 'real mappings must exist');
    const after = await get(`/api/plugins/token-stats/control/stats?range=1h&groupBy=model&search=${encodeURIComponent(originals[0]!)}`);
    assert.equal(after.estimatedCostUsd, beforeMappingStats.estimatedCostUsd, 'saving aliases must not reprice historical attempts');
    let stats: any;
    await waitUntil(async () => { await postModel(originals[0]!); stats = await get(`/api/plugins/token-stats/control/stats?range=1h&groupBy=model&search=${encodeURIComponent(originals[0]!)}`);
      if (typeof stats.estimatedCostUsd === 'number' && stats.estimatedCostUsd > 0) return true;
      await Bun.sleep(1000); return false;
    }, 'worker did not reconcile explicit price mapping', 45_000);
    await writeFile(join(evidence, 'metering.json'), JSON.stringify({ technicalUpstream: true, paidProvider: false, target, beforeMappingStats, after, stats }, null, 2));
  });
  await step('real-token-and-usd-budget-matches-statistics', async () => {
    assert(target && beforeMappingStats, 'an explicit price mapping is required for budget comparison');
    const mutate = async (path: string, method: 'POST' | 'PUT', body: unknown, expectedStatus: number): Promise<any> => {
      const response = await context!.request.fetch(management + path, { method,
        headers: { origin: management, 'x-csrf-token': csrf, 'content-type': 'application/json' }, data: body });
      const text = await response.text(); assert.equal(response.status(), expectedStatus, `${path}: ${response.status()} ${text}`);
      return JSON.parse(text);
    };
    const snapshot = await get('/api/config');
    const activation = { expected_revision: snapshot.revision, mutation_id: randomUUID() };
    let last: any;
    await waitUntil(async () => {
      const response = await context!.request.post(management + '/api/plugins/token-budget/enable', {
        headers: { origin: management, 'x-csrf-token': csrf }, data: activation });
      last = await response.json();
      if (response.status() === 202) return true;
      assert(response.status() === 503 && last.error === 'control_recovering'
        && ['admission_recovering', 'retired_pending', 'lease_margin'].includes(last.reason), JSON.stringify(last));
      return false;
    }, 'budget dependency activation admission did not clear', 45_000);
    await publication(snapshot.revision + 1, true);
    const issued = await mutate('/api/plugins/key-access/control/credentials', 'POST', { name: 'Browser Budget Consistency' }, 201);
    const keyId = issued.key.id, token = issued.token; assert(keyId && token);
    await mutate('/api/plugins/key-access/control/route-key', 'PUT', { keyId, routeId, protect: true }, 200);
    await publication(undefined, true);
    const policyPath = `/api/plugins/token-budget/control/keys/${encodeURIComponent(keyId)}`;
    await mutate(policyPath, 'PUT', { mode: 'cumulative', unit: 'tokens', limit: 24 }, 200);
    await postModel(originals[0]!, token);
    let tokenLedger: any, tokenStats: any;
    await waitUntil(async () => {
      tokenLedger = await get(policyPath);
      tokenStats = await get(`/api/plugins/token-stats/control/stats?range=1h&groupBy=model&keyId=${encodeURIComponent(keyId)}`);
      return tokenLedger.value.cumulative === 24 && tokenLedger.usage.attempts[0]?.status === 'settled' && tokenStats.upstreamAttempts === 1;
    }, 'budget token settlement and real statistics did not converge', 30_000);
    assert.equal(tokenLedger.value.cumulative, tokenStats.totalInputTokens + tokenStats.totalOutputTokens);
    assert.equal(tokenLedger.value.money.cumulativeNanoUsd, Math.round(tokenStats.estimatedCostUsd * 1_000_000_000));
    const calls = upstreamRequests;
    const input = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: originals[0], messages: [{ role: 'user', content: 'budget gate check' }] }) };
    const denied = await requestJson(proxy + '/v1/chat/completions', input, fixture!);
    assert.equal(denied.response.status, 429, denied.text); assert.equal(upstreamRequests, calls);
    await mutate(policyPath, 'PUT', { mode: 'cumulative', unit: 'usd', limit: 1 }, 200);
    await postModel(originals[0]!, token);
    let usdLedger: any, usdStats: any;
    await waitUntil(async () => {
      usdLedger = await get(policyPath);
      usdStats = await get(`/api/plugins/token-stats/control/stats?range=1h&groupBy=model&keyId=${encodeURIComponent(keyId)}`);
      return usdLedger.value.cumulative === 48 && usdLedger.usage.attemptCount === 2 && usdStats.upstreamAttempts === 2;
    }, 'budget USD settlement and real statistics did not converge', 30_000);
    assert.equal(usdLedger.value.money.cumulativeNanoUsd, Math.round(usdStats.estimatedCostUsd * 1_000_000_000));
    assert(usdStats.estimatedCostUsd > 0 && usdLedger.usage.attempts.every((attempt: any) => attempt.costStatus === 'known'));
    const beforeUnknown = upstreamRequests;
    const unknown = await requestJson(proxy + '/v1/chat/completions', { ...input, body: JSON.stringify({ model: freeAlias + '-unpriced', messages: [{ role: 'user', content: 'unpriced budget admission' }] }) }, fixture!);
    assert.equal(unknown.response.status, 422, unknown.text); assert.equal(upstreamRequests, beforeUnknown);
    assert.equal((unknown.body as any).error, 'token-budget.unpriceable');
    await writeFile(join(evidence, 'budget-consistency.json'), JSON.stringify({ technicalUpstream: true, paidProvider: false,
      keyId, tokenLedger, tokenStats, tokenDenied: { status: denied.response.status, body: denied.body }, usdLedger, usdStats,
      unknownPriceDenied: { status: unknown.response.status, body: unknown.body }, upstreamCallsBeforeUnknown: beforeUnknown, upstreamCallsAfterUnknown: upstreamRequests }, null, 2));
  });
  await step('model-mapping-directory-page-provider-and-refresh-source', async () => {
    await navigate('model-mapping', '/catalog');
    await page!.getByTestId('model-mapping-catalog-refresh').waitFor();
    await page!.locator('[aria-current="page"]').waitFor();
    const [next] = await Promise.all([
      page!.waitForResponse(r => r.url().includes('/model-mapping/control/catalog?') && new URL(r.url()).searchParams.get('page') === '2'),
      page!.getByRole('button', { name: /Next page|下一页/i }).click(),
    ]); assert.equal((await next.json()).page, 2);
    await waitUntil(async () => (await page!.locator('[aria-current="page"]').innerText()) === '2', 'model catalog page 2 did not render');
    const provider = page!.locator('input[aria-controls="catalog-provider-list"]');
    await provider.fill(target!.provider);
    await page!.getByRole('option', { name: target!.provider, exact: true }).click();
    await waitUntil(async () => {
      const cells = await page!.locator('tbody tr td:first-child').allTextContents();
      return cells.length > 0 && cells.every(text => text.trim() === target!.provider);
    }, 'provider selection did not filter real directory');
    const start = network.length;
    const [refreshed] = await Promise.all([
      page!.waitForResponse(r => r.url().endsWith('/models-dev/control/catalog/refresh') && r.request().method() === 'POST'),
      page!.getByTestId('model-mapping-catalog-refresh').click(),
    ]); assert.equal(refreshed.status(), 202);
    await waitUntil(async () => !(await page!.getByTestId('model-mapping-catalog-refresh').isDisabled()), 'directory refresh did not settle', 65_000);
    assert(!network.slice(start).some(row => String(row.path).includes('/token-stats/control/catalog/refresh') || String(row.path).includes('/pricecatalog')), 'legacy download endpoint used');
  });
  await step('legacy-catalog-download-apis-removed', async () => {
    for (const path of ['/api/plugins/token-stats/control/catalog/refresh', '/api/plugins/token-stats/control/pricecatalog', '/api/plugins/model-mapping/control/catalog/refresh']) {
      const response = await context!.request.post(management + path, { headers: { origin: management, 'x-csrf-token': csrf } });
      assert.equal(response.status(), 404, `${path}: ${response.status()} ${await response.text()}`);
    }
  });
  await step('browser-no-page-or-console-errors', async () => { assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); });
} catch (error) {
  steps.push({ name: activeStep === 'startup' ? 'startup' : 'dependent-business-steps', status: 'failed', error: cleanError(error) });
  log(`FATAL ${cleanError(error)}`); await capture('fatal').catch(() => undefined);
} finally {
  // Save application diagnostics before removing any successful owned fixture.
  if (master?.diagnostics) await writeFile(join(evidence, 'master.log'), await master.diagnostics()).catch(error => errors.push(cleanError(error)));
  cleanup.fixtureRoot = fixture?.root; cleanup.masterPid = master?.child.pid;
  cleanup.workers = master ? [...master.workers.values()].map(worker => ({ pid: worker.pid, workerInstanceId: worker.workerInstanceId })) : [];
  try { await browser?.close(); cleanup.browserClosed = true; } catch (error) { cleanup.browserError = cleanError(error); }
  let shutdownVerified = false, portsVerifiedClosed = false;
  try { if (master) { await stopOwnedMaster(master); shutdownVerified = true; } } catch (error) { cleanup.masterError = cleanError(error); }
  cleanup.shutdownVerified = shutdownVerified;
  const upstreamPort = upstream?.port;
  try {
    if (upstream) await upstream.stop(true);
    if (upstreamPort) { const probe = Bun.serve({ hostname: '127.0.0.1', port: upstreamPort, reusePort: false, fetch: () => new Response('closure proof') }); await probe.stop(true); }
    cleanup.upstreamClosed = true;
    if (lease) await releasePortBlock(lease);
    portsVerifiedClosed = true;
  } catch (error) { if (lease) quarantinePortBlock(lease); cleanup.portError = cleanError(error); }
  cleanup.portsVerifiedClosed = portsVerifiedClosed;
  if (fixture && steps.every(step => step.status === 'passed') && errors.length === 0 && consoleErrors.length === 0) {
    cleanup.fixtureRemoved = await cleanupGatewayFixture(fixture, { startupAttempted, master, shutdownVerified, portsVerifiedClosed });
  } else cleanup.fixtureRemoved = false; // Failure evidence is retained, never erased.
  const success = steps.length >= 10 && steps.every(step => step.status === 'passed') && errors.length === 0 && consoleErrors.length === 0
    && cleanup.browserClosed === true && shutdownVerified && portsVerifiedClosed;
  await writeFile(join(evidence, 'report.json'), JSON.stringify({ success, steps, errors, consoleErrors, failedRequests, network, requests,
    catalog: catalogEvidence, settingsPerformance, upstreamRequests, recordedClientModels: originals, cleanup }, null, 2));
  log(`RESULT ${success ? 'PASS' : 'FAIL'} evidence=${evidence}`);
  process.exitCode = success ? 0 : 1;
}
