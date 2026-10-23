import { afterAll,beforeAll,test } from 'bun:test';
import assert from 'node:assert/strict';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { chromium,type Browser } from 'playwright';
import { collectApiEvidence } from '../helpers/editors/api-evidence';
import manifest from '../../../../plugins/chatgpt-oauth/manifest.json';
let uiRuntime:Awaited<ReturnType<typeof startUiRuntime>>,browser:Browser;
beforeAll(async()=>{uiRuntime=await startUiRuntime({mode:'component-fixture',entries:['tests/fixtures/oauth.html']});try{browser=await chromium.launch();}catch(error){await uiRuntime.close();throw error;}},120_000);
afterAll(async()=>{try{await browser?.close();}finally{await uiRuntime?.close();}});
test('route handoff-save',()=>runRouteScenario('handoff-save'),240_000);
test('route duplicate-binding',()=>runRouteScenario('duplicate-binding'),240_000);
test('route service-rejection',()=>runRouteScenario('service-rejection'),240_000);
test('route stale-reload',()=>runRouteScenario('stale-reload'),240_000);
test('route draft-cancel-template',()=>runRouteScenario('draft-cancel-template'),240_000);
test('route handoff-cancel',()=>runRouteScenario('handoff-cancel'),240_000);
test('route invalid-link',()=>runRouteScenario('invalid-link'),240_000);
test('route create-cas-retry',()=>runRouteScenario('create-cas-retry'),240_000);

async function runRouteScenario(scenario:string){
 // Exercise startup with a browser language different from the fixture's English assertions.
 const context=await browser.newContext({viewport:{width:1280,height:850},locale:'zh-CN'});
 try{
 const page=await context.newPage();
  page.setDefaultTimeout(15000);
  const evidence = collectApiEvidence(page);
  const errors = evidence.errors, requests: string[] = [], writes: any[] = [];
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
    const respond = (value: unknown, status = 200) => {
      if(status >= 400) evidence.expectStatus(route,status);
      return route.fulfill({status,json:value});
    };
    const path=url.pathname, method=req.method();
    const reads=['/api/config','/api/plugins','/api/plugins/schemas','/api/plugins/chatgpt-oauth/control/accounts/usage','/api/plugins/chatgpt-oauth/control/accounts/siwc','/api/plugins/chatgpt-oauth/control/accounts','/api/plugins/chatgpt-oauth/control/accounts/codex'];
    if (!(method === 'GET' && reads.includes(path)) && !(method === 'PUT' && path === '/api/config') && !(method === 'POST' && path === '/api/plugins/chatgpt-oauth/control/accounts/draft')) {
      errors.push(`Unexpected ${method} ${path}`);return route.fulfill({status:500,json:{error:'unexpected_request'}});
    }
    if (url.pathname === '/api/config' && req.method() === 'GET') return respond({ config, revision, content_hash: 'sha256:fixture' });
    if (url.pathname === '/api/config' && req.method() === 'PUT') {
      const body = req.postDataJSON(); writes.push(body);
      assert.equal(body.expected_revision,revision,'configuration writes carry the current CAS revision');
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
    if (url.pathname.endsWith('/control/accounts/siwc') && req.method() === 'GET') return respond({ accounts: [] });
    if ((url.pathname.endsWith('/control/accounts') || url.pathname.endsWith('/control/accounts/codex')) && req.method() === 'GET') return respond({ accounts: [
      { id: 'account-1', label: 'Primary', status: 'active', available: true },
      { id: 'account-2', label: 'Secondary', status: 'active', available: true },
    ] });
    if (url.pathname.endsWith('/control/accounts/draft')) {
      draftRef = req.postDataJSON().accountRef;
      return respond({ target, bindingOptions: { accountRef: draftRef } });
    }
    errors.push(`Unmocked ${req.method()} ${url.pathname}`);
    return respond({ error: 'unexpected_request' }, 500);
  });
  const base = `${uiRuntime.origin}/tests/fixtures/oauth.html?routeFlow=1#/accounts`;
  const account = (name: string) => page.locator('.account-card').filter({ hasText: name });
  const serviceDialog = page.getByRole('dialog', { name: 'Use with service', exact: true });
  const routeDialog = page.getByRole('dialog', { name: 'Use with route', exact: true });
  const assertOnlyDialog = async (dialog: typeof serviceDialog, label: string) => {
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.count(), 1, `exactly one ${label} dialog is open`);
    assert.equal(await page.getByRole('dialog').count(), 1, `${label} must not overlap any other dialog`);
  };
  const goAccounts = async () => {
    await page.goto(base);
    try { await account('Primary').getByRole('button', { name: 'Use with route' }).waitFor(); }
    catch(error) {
      const failures:unknown[]=[error];
      try { evidence.verify(); } catch(apiError) { failures.push(apiError); }
      throw new AggregateError(failures,`Account page did not initialize: ${JSON.stringify({url:page.url(),requests,body:await page.locator('body').innerText()})}`);
    }
  };
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

  const newEditor = base.replace('#/accounts', '#/routes/new');

if(scenario === 'handoff-save'){
  await goAccounts();
  assert.equal(await page.locator('.account-card').count(), 2);
  assert(!/account-[12]|d68a6c29-6bb4-460b-ad67-4abdf1129999/.test(await page.locator('[data-testid="chatgpt-accounts-page"]').innerText()), 'card must not expose account or route IDs');

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

  await assertOnlyDialog(routeDialog, 'Use with route');

  await continueRoute();
  await targetSection().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'handoff must not prompt to restore the old new-route draft');
  assert.equal(await rows().count(), 1, 'new route replaces only the empty placeholder');

  assert.equal(writes.length, 0, 'opening a route draft must never commit');

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

  await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config'), page.getByTestId('route-save-button').click()]);
  assert.equal(writes.length, 2, 'explicit update commits');
  assert.equal(writes[1].aggregate.logical_configuration.routes.find((item: any) => item.path === '/custom').endpoints.length, 2);

}

if(scenario === 'duplicate-binding'){
  await goAccounts();
  await selectRoute('Primary', '/duplicate');
  await continueRoute();
  await targetSection().waitFor();
  assert.equal(await rows().count(), 1, 'duplicate handoff focuses the existing binding');

  assert.equal(writes.length, 0);

}

if(scenario === 'service-rejection'){
  await goAccounts();
  await selectRoute('Primary', '/service-route');

  assert(await routeDialog.getByRole('button', { name: 'Continue to route editor' }).isDisabled());
  assert.equal(writes.length, 0);
  await routeDialog.getByRole('button', { name: 'Edit referenced service' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/services/edit/service-a'));
  await routeDialog.waitFor({ state: 'hidden' });

}

if(scenario === 'stale-reload'){
  await goAccounts();
  await selectRoute('Primary', '/custom');
  await continueRoute();
  await targetSection().waitFor();
  const draftRows = await rows().count();
  config.logical_configuration.routes.find((item: any) => item.path === '/custom').description = 'changed elsewhere';
  await page.getByTestId('route-save-button').click();
  await page.getByTestId('route-stale-warning').waitFor();
  assert.equal(await rows().count(), draftRows, 'stale result preserves the editor draft');
  assert.equal(writes.length, 0, 'stale update must not PUT');

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
  assert.equal(await rows().count(), 1, 'confirmed reload reads the latest persisted route');
  await page.waitForFunction(() => document.querySelector('[data-testid="route-save-button"]')?.hasAttribute('disabled') === false);
  assert(await page.getByTestId('route-save-button').isEnabled(), 'confirmed reload restores a fresh editable baseline');
  assert.equal(writes.length, 0, 'reload is read-only');

}

if(scenario === 'draft-cancel-template'){
  await page.clock.install();
  await page.goto(newEditor);
  await page.getByTestId('route-nav-match').waitFor();
  await page.getByRole('textbox').first().fill('/cancel-test');
  // The editor autosaves the draft on a 30s interval; advance it to assert the persisted side effect.
  await page.clock.runFor(30_000);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('bungee-route-draft')!)).path, '/cancel-test', 'unsaved route edits persist to the draft slot');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('confirm-dialog-cancel').click();
  assert.match(await page.getByRole('textbox').first().inputValue(), /cancel-test/, 'cancel preserves unsaved input');
  assert.equal(await page.evaluate(() => location.hash), '#/routes/new');
  assert.equal(writes.length, 0);

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
  assert.equal(writes.length, 0);

  // RouteTemplates also dispatches a component event, not an onselect callback prop.
  await page.getByRole('button', { name: 'Use Template' }).click();
  await page.getByRole('button', { name: /Simple Proxy/ }).click();
  assert.equal(await page.getByRole('textbox').first().inputValue(), '/api');
  await page.getByTestId('route-nav-target').click();
  await targetSection().waitFor();
  assert.equal(await rows().count(), 1, 'the target section shows the template upstream');
  assert.match(await targetSection().innerText(), /api\.example\.com/, 'chapter navigation displays the selected template target');
  assert.equal(writes.length, 0, 'template and chapter navigation never publish');

  await page.waitForFunction(() => document.querySelector('[data-testid="route-save-button"]')?.hasAttribute('disabled') === false);
  await page.getByTestId('route-nav-forward').click();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('#route-first-response-ms').fill('900', { force: true });
  await page.locator('#route-request-ms').fill('100', { force: true });
  await page.evaluate(() => (document.querySelector('[data-testid="route-nav-match"]') as HTMLElement).click());
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-testid="section-match"]'))), true, 'left the forward section before saving');
  assert.equal(await page.evaluate(() => !(document.querySelector('[data-testid="route-save-button"]') as HTMLButtonElement).disabled), true, 'frozen debounce has not disabled save yet');
  await page.evaluate(() => (document.querySelector('[data-testid="route-save-button"]') as HTMLElement).click());
  await page.clock.resume();
  await page.getByTestId('section-forward').waitFor();
  assert.equal(writes.length, 0, 'invalid timeouts return to the forwarding policy without publishing');

}

if(scenario === 'handoff-cancel'){
  await goAccounts();
  await openRoute('Primary');
  await continueRoute();
  await targetSection().waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.waitForFunction(() => location.hash === '#/accounts');
  assert.equal(writes.length, 0, 'confirmed cancel discards the unsaved handoff');

}

if(scenario === 'invalid-link'){
  await page.goto(`${newEditor}?sourcePlugin=chatgpt-oauth&mode=existing`);
  await page.getByTestId('route-handoff-error').waitFor();

  assert.equal(writes.length, 0);

  const existingEditor = base.replace('#/accounts', '#/routes/edit/%2Fcustom');
  await page.goto(`${existingEditor}?sourcePlugin=chatgpt-oauth&mode=existing`);
  await page.getByTestId('route-nav-match').waitFor();

  assert.equal(writes.length, 0);

}

if(scenario === 'create-cas-retry'){
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
  assert.equal(writes.length, 1, 'first explicit create attempts a single PUT and receives CAS conflict');
  assert.equal(config.logical_configuration.routes.some((item: any) => item.path === '/cas-create'), false);
  assert.equal(await page.getByRole('textbox').first().inputValue(), '/cas-create', 'conflicting create retains unsaved input');
  assert.equal(await page.getByTestId('route-stale-warning').count(), 0, 'new route has no existing baseline to reload');
  await page.waitForFunction(() => document.querySelector('[data-testid="route-save-button"]')?.hasAttribute('disabled') === false);
  assert(await page.getByTestId('route-save-button').isEnabled(), 'create is only retried after another explicit click');
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config' && response.status() === 202),
    page.getByTestId('route-save-button').click(),
  ]);
  assert.equal(writes.length, 2, 'explicit second save performs exactly one new PUT');
  assert.equal(writes[1].expected_revision, writes[0].expected_revision + 1, 'second save re-reads the latest revision');
  assert(config.logical_configuration.routes.some((item: any) => item.path === '/cas-create'));
  assert.equal(config.logical_configuration.routes.find((item: any) => item.path === '/custom').description, 'another editor updated the config');

}
assert.equal(resetConsume,0);assert.deepEqual(errors,[]);evidence.verify();
}finally{await context.close();}
}
