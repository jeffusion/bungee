/** Mounted route-account handoff flow; run: bun --cwd packages/ui tests/oauth-route-browser.ts */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import appConfig from '../vite.config';

const manifest = JSON.parse(await readFile(new URL('../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
const server = await createServer({ ...appConfig, configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
  optimizeDeps: { entries: ['tests/fixtures/oauth.html'], include: ['deepmerge', 'cmdk-sv', 'lucide-svelte/icons/search'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 0, proxy: {} } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [], requests: string[] = [], writes: any[] = [];
  let expectedConflictConsole = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text() === 'Failed to load resource: the server responded with a status of 409 (Conflict)') {
      expectedConflictConsole++;
      return;
    }
    errors.push(message.text());
  });
  const routeIds = {
    custom: 'd68a6c29-6bb4-460b-ad67-4abdf1129999',
    duplicate: '10f4319c-37c6-453d-9704-9e9bcc3f63fe',
    service: '73af25fa-0942-45da-9d3a-51de2cfc7102',
  };
  const target = 'https://chatgpt.com/backend-api/codex/responses';
  const bound = { id: 'a71610ce-fce6-4c2b-9fb4-60374f57a201', position: 0, target, weight: 100, priority: 1,
    managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId: 'd34977fa-25cf-4530-ab99-a77a2bafc177' },
    plugins: [{ id: 'd34977fa-25cf-4530-ab99-a77a2bafc177', position: 0, name: 'chatgpt-oauth', enabled: true, options: { accountRef: 'account-1' } }] };
  let config: any = { logical_configuration: { auth: { enabled: false, tokens: [] }, plugins: [],
    services: [{ id: '6f035eda-d9a1-47be-9ff5-c184b39db551', position: 0, name: 'service-a', endpoints: [], plugins: [] }],
    routes: [
      { id: routeIds.custom, position: 0, path: '/custom', endpoints: [{ id: '94a4618e-4973-4882-a83e-9543a05f1d34', position: 0, target: 'https://example.test/api', weight: 100, priority: 1, plugins: [] }], plugins: [] },
      { id: routeIds.duplicate, position: 1, path: '/duplicate', endpoints: [bound], plugins: [] },
      { id: routeIds.service, position: 2, path: '/service-route', service_id: '6f035eda-d9a1-47be-9ff5-c184b39db551', plugins: [] },
    ] }, plugin_activations: [] };
  let revision = 1, draftRef = '', resetConsume = 0, rejectNextCreatePut = false;
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(`${req.method()} ${url.pathname}`);
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/config' && req.method() === 'GET') return respond({ config, revision, content_hash: 'sha256:fixture' });
    if (url.pathname === '/api/config' && req.method() === 'PUT') {
      const body = req.postDataJSON(); writes.push(body);
      if (rejectNextCreatePut) {
        rejectNextCreatePut = false;
        config.logical_configuration.routes.find((item: any) => item.path === '/custom').description = 'another editor updated the config';
        revision++;
        return respond({ error: 'revision_changed' }, 409);
      }
      config = body.aggregate; revision++;
      return respond({ operation_id: body.mutation_id, revision, operation: { state: 'converged', result_status: 200, error_code: null }, workers: [] }, 202);
    }
    if (url.pathname === '/api/plugins') return respond([{ name: 'chatgpt-oauth', enabled: true, metadata: { contributes: manifest.contributes } }]);
    if (url.pathname === '/api/plugins/schemas') return respond({ 'chatgpt-oauth': { name: manifest.name, version: manifest.version, configSchema: manifest.configSchema } });
    if (url.pathname.endsWith('/control/accounts/usage/reset')) { resetConsume++; return respond({ error: 'forbidden' }, 403); }
    if (url.pathname.endsWith('/control/accounts/usage')) return respond({ usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } });
    if (url.pathname.endsWith('/control/accounts') && req.method() === 'GET') return respond({ accounts: [
      { id: 'account-1', label: 'Primary', status: 'active', available: true },
      { id: 'account-2', label: 'Secondary', status: 'active', available: true },
    ] });
    if (url.pathname.endsWith('/control/accounts/draft')) {
      draftRef = req.postDataJSON().accountRef;
      return respond({ target, bindingOptions: { accountRef: draftRef } });
    }
    throw new Error(`Unmocked ${req.method()} ${url.pathname}`);
  });
  const port = server.httpServer!.address(); assert(port && typeof port !== 'string');
  const base = `http://127.0.0.1:${port.port}/tests/fixtures/oauth.html?routeFlow=1#/accounts`;
  const account = (name: string) => page.locator('.account-card').filter({ hasText: name });
  const serviceDialog = page.getByRole('dialog', { name: 'Use with service', exact: true });
  const routeDialog = page.getByRole('dialog', { name: 'Use with route', exact: true });
  const assertOnlyDialog = async (dialog: typeof serviceDialog, label: string) => {
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.count(), 1, `exactly one ${label} dialog is open`);
    assert.equal(await page.getByRole('dialog').count(), 1, `${label} must not overlap any other dialog`);
  };
  const goAccounts = async () => { await page.goto(base); await account('Primary').getByRole('button', { name: 'Use with route' }).waitFor(); };
  const openRoute = async (name: string) => {
    await account(name).getByRole('button', { name: 'Use with route' }).click();
    await assertOnlyDialog(routeDialog, 'Use with route');
    assert.equal(await serviceDialog.count(), 0, 'opening a route cannot leave the service chooser visible');
  };
  const selectRoute = async (name: string, path: string) => {
    await openRoute(name);
    await routeDialog.getByRole('combobox', { name: 'Choose route' }).click();
    await page.getByRole('option', { name: path, exact: true }).click();
  };
  const continueRoute = async () => {
    await routeDialog.getByRole('button', { name: 'Continue to route editor' }).click();
    await routeDialog.waitFor({ state: 'hidden' });
  };
  const targetSection = () => page.getByTestId('route-target-section');
  const rows = () => targetSection().locator('[role="listitem"][draggable="true"]');
  await goAccounts();
  assert.equal(await page.locator('.account-card').count(), 2);
  assert(!/account-[12]|d68a6c29-6bb4-460b-ad67-4abdf1129999/.test(await page.locator('[data-testid="chatgpt-accounts-page"]').innerText()), 'card must not expose account or route IDs');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-accounts-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 850 });
  await account('Primary').getByRole('button', { name: 'Use with service' }).click();
  await assertOnlyDialog(serviceDialog, 'Use with service');
  assert.equal(await routeDialog.count(), 0, 'opening a service cannot leave the route chooser visible');
  await serviceDialog.getByRole('button', { name: 'Continue to service editor' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/services/new?'));
  await serviceDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'service navigation must clean up the dialog portal');
  assert.equal(writes.length, 0, 'existing service handoff remains an unsaved draft');
  await goAccounts();
  await page.evaluate(() => localStorage.setItem('bungee-route-draft', JSON.stringify({ path: '/old-draft', endpoints: [] })));
  await openRoute('Secondary');
  await page.setViewportSize({ width: 390, height: 844 });
  await assertOnlyDialog(routeDialog, 'Use with route');
  await routeDialog.screenshot({ path: '/tmp/opencode/bungee-oauth-route-chooser-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 850 });
  await continueRoute();
  await targetSection().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'handoff must not prompt to restore the old new-route draft');
  assert.equal(await rows().count(), 1, 'new route replaces only the empty placeholder');
  assert.match(await page.getByTestId('route-handoff-notice').innerText(), /explicitly save/i);
  assert.equal(writes.length, 0, 'opening a route draft must never commit');
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-new-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-new-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByTestId('route-nav-match').click();
  await page.getByRole('textbox').first().fill('/new-route');
  await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config'), page.getByTestId('route-save-button').click()]);
  assert.equal(writes.length, 1, 'explicit create commits');
  assert.equal(writes[0].aggregate.logical_configuration.routes.at(-1).endpoints[0].plugins[0].options.accountRef, 'account-2');
  await goAccounts();
  await selectRoute('Secondary', '/custom');
  await continueRoute();
  await targetSection().waitFor();
  assert.equal(await rows().count(), 2, 'custom route retains existing endpoint and appends managed endpoint');
  assert.equal(writes.length, 1, 'existing handoff remains unsaved');
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-existing-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-existing-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 850 });
  await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config'), page.getByTestId('route-save-button').click()]);
  assert.equal(writes.length, 2, 'explicit update commits');
  assert.equal(writes[1].aggregate.logical_configuration.routes.find((item: any) => item.path === '/custom').endpoints.length, 2);
  await goAccounts();
  await selectRoute('Primary', '/duplicate');
  await continueRoute();
  await targetSection().waitFor();
  assert.equal(await rows().count(), 1, 'duplicate handoff focuses the existing binding');
  assert.match(await page.getByTestId('route-handoff-notice').innerText(), /no duplicate/i);
  assert.equal(writes.length, 2);
  await goAccounts();
  await selectRoute('Primary', '/service-route');
  assert.match(await routeDialog.getByRole('alert').innerText(), /Edit that service/i);
  assert(await routeDialog.getByRole('button', { name: 'Continue to route editor' }).isDisabled());
  assert.equal(writes.length, 2);
  await routeDialog.getByRole('button', { name: 'Edit referenced service' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/services/edit/service-a'));
  await routeDialog.waitFor({ state: 'hidden' });
  await goAccounts();
  await selectRoute('Primary', '/custom');
  await continueRoute();
  await targetSection().waitFor();
  const draftRows = await rows().count();
  config.logical_configuration.routes.find((item: any) => item.path === '/custom').description = 'changed elsewhere';
  await page.getByTestId('route-save-button').click();
  await page.getByTestId('route-stale-warning').waitFor();
  assert.equal(await rows().count(), draftRows, 'stale result preserves the editor draft');
  assert.equal(writes.length, 2, 'stale update must not PUT');
  await page.screenshot({ path: '/tmp/opencode/bungee-oauth-route-stale-desktop.png' });
  // ConfirmDialog really renders these testids. Assert the modal opens before clicking either control.
  await page.getByTestId('route-stale-warning').getByRole('button', { name: 'Reload route' }).click();
  const reloadDialog = page.getByRole('dialog', { name: 'Reload latest route?' });
  await reloadDialog.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog').count(), 1, 'reload is the only open dialog');
  assert.equal(await reloadDialog.getByTestId('confirm-dialog-cancel').count(), 1, 'reload has exactly one cancel button');
  await reloadDialog.getByTestId('confirm-dialog-cancel').click();
  await reloadDialog.waitFor({ state: 'hidden' });
  assert(await page.getByTestId('route-stale-warning').isVisible(), 'cancel keeps the stale draft');
  assert.equal(await rows().count(), draftRows);
  assert(await page.getByTestId('route-save-button').isDisabled(), 'cancel must not unlock saving against a stale baseline');
  await page.getByTestId('route-stale-warning').getByRole('button', { name: 'Reload route' }).click();
  await reloadDialog.waitFor({ state: 'visible' });
  await reloadDialog.getByTestId('confirm-dialog-confirm').click();
  await reloadDialog.waitFor({ state: 'hidden' });
  await page.getByTestId('route-stale-warning').waitFor({ state: 'hidden' });
  assert.equal(await rows().count(), 2, 'confirmed reload reads the latest persisted route');
  await page.waitForFunction(() => document.querySelector('[data-testid="route-save-button"]')?.hasAttribute('disabled') === false);
  assert(await page.getByTestId('route-save-button').isEnabled(), 'confirmed reload restores a fresh editable baseline');
  assert.equal(writes.length, 2, 'reload is read-only');

  const newEditor = base.replace('#/accounts', '#/routes/new');
  await page.evaluate(() => localStorage.removeItem('bungee-route-draft'));
  await page.goto(newEditor);
  await page.getByTestId('route-nav-match').waitFor();
  await page.getByRole('textbox').first().fill('/cancel-test');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('confirm-dialog-cancel').click();
  assert.match(await page.getByRole('textbox').first().inputValue(), /cancel-test/, 'cancel preserves unsaved input');
  assert.equal(await page.evaluate(() => location.hash), '#/routes/new');
  assert.equal(writes.length, 2);

  await page.evaluate(() => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('bungee-route-draft', JSON.stringify({ path: '/restored-route', endpoints: [{ target: 'https://restore.example.test', weight: 100, priority: 1 }] }));
  });
  await page.reload();
  await page.getByTestId('route-nav-match').waitFor();
  const restoreDialog = page.getByRole('dialog', { name: 'Restore Draft' });
  await restoreDialog.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog').count(), 1, 'cold-start draft restore opens exactly one dialog');
  await restoreDialog.getByTestId('confirm-dialog-cancel').click();
  await restoreDialog.waitFor({ state: 'hidden' });
  assert.notEqual(await page.getByRole('textbox').first().inputValue(), '/restored-route', 'restore cancel keeps a fresh draft');
  await page.reload();
  await restoreDialog.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog').count(), 1, 'cold-start restore confirm has one dialog');
  await restoreDialog.getByTestId('confirm-dialog-confirm').click();
  await restoreDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('textbox').first().inputValue(), '/restored-route', 'restore confirm applies the saved draft');
  assert.equal(writes.length, 2);

  // RouteTemplates also dispatches a component event, not an onselect callback prop.
  await page.getByRole('button', { name: 'Use Template' }).click();
  await page.getByRole('button', { name: /Simple Proxy/ }).click();
  assert.equal(await page.getByRole('textbox').first().inputValue(), '/api');
  await page.getByTestId('route-nav-target').click();
  await targetSection().waitFor();
  assert.equal(await rows().count(), 1, 'the target section shows the template upstream');
  assert.match(await targetSection().innerText(), /api\.example\.com/, 'chapter navigation displays the selected template target');
  assert.equal(writes.length, 2, 'template and chapter navigation never publish');

  await page.evaluate(() => localStorage.removeItem('bungee-route-draft'));
  await goAccounts();
  await openRoute('Primary');
  await continueRoute();
  await targetSection().waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.waitForFunction(() => location.hash === '#/accounts');
  assert.equal(writes.length, 2, 'confirmed cancel discards the unsaved handoff');

  await page.goto(`${newEditor}?sourcePlugin=chatgpt-oauth&mode=existing`);
  await page.getByTestId('route-handoff-error').waitFor();
  assert.match(await page.getByTestId('route-handoff-error').innerText(), /handoff link is invalid/i);
  assert.equal(writes.length, 2);

  const existingEditor = base.replace('#/accounts', '#/routes/edit/%2Fcustom');
  await page.goto(`${existingEditor}?sourcePlugin=chatgpt-oauth&mode=existing`);
  await page.getByTestId('route-nav-match').waitFor();
  assert.match(await page.getByTestId('route-handoff-error').innerText(), /handoff link is invalid/i,
    'loading an authoritative existing route must not erase the invalid-handoff notice');
  assert.equal(writes.length, 2);

  await goAccounts();
  await openRoute('Primary');
  await continueRoute();
  await targetSection().waitFor();
  await page.getByTestId('route-nav-match').click();
  await page.getByRole('textbox').first().fill('/cas-create');
  rejectNextCreatePut = true;
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config' && response.status() === 409),
    page.getByTestId('route-save-button').click(),
  ]);
  assert.equal(writes.length, 3, 'first explicit create attempts a single PUT and receives CAS conflict');
  assert.equal(config.logical_configuration.routes.some((item: any) => item.path === '/cas-create'), false);
  assert.equal(await page.getByRole('textbox').first().inputValue(), '/cas-create', 'conflicting create retains unsaved input');
  assert.equal(await page.getByTestId('route-stale-warning').count(), 0, 'new route has no existing baseline to reload');
  await page.waitForFunction(() => document.querySelector('[data-testid="route-save-button"]')?.hasAttribute('disabled') === false);
  assert(await page.getByTestId('route-save-button').isEnabled(), 'create is only retried after another explicit click');
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config' && response.status() === 202),
    page.getByTestId('route-save-button').click(),
  ]);
  assert.equal(writes.length, 4, 'explicit second save performs exactly one new PUT');
  assert.equal(writes[3].expected_revision, writes[2].expected_revision + 1, 'second save re-reads the latest revision');
  assert(config.logical_configuration.routes.some((item: any) => item.path === '/cas-create'));
  assert.equal(config.logical_configuration.routes.find((item: any) => item.path === '/custom').description, 'another editor updated the config');
  assert.equal(resetConsume, 0);
  assert(expectedConflictConsole <= 1, 'at most the expected single CAS 409 may appear in the browser console');
  assert.deepEqual(errors, [], 'no uncaught errors or console errors');
  console.log('ROUTE HANDOFF browser: new, custom, duplicate, service rejection, stale reload cancel/confirm, draft restore, template, section navigation, localized new/existing malformed handoff, create CAS explicit retry; desktop/mobile screenshots; console clean; reset consume=0');
  console.log('REQUESTS', JSON.stringify(requests));
} finally { await browser.close(); await server.close(); }
