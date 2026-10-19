import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage, fixtureUrl } = editorFixture(['service']);

test('service navigation follows seven visible sections and respects field and dialog shortcut boundaries', async () => {
  await withPage('scenario=service', async (page,evidence) => {
    await page.route('**/api/config', route => route.request().method()==='GET'?route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
      config: { plugin_activations: [], logical_configuration: { routes: [], services: [], plugins: [] } } } }):route.fallback());
    // Mount after installing the configuration response.
    await page.reload();
    const order = ['identity', 'endpoints', 'transport', 'availability', 'plugins', 'consumers', 'review'];
    await expect(page.getByTestId('service-builder-nav').locator('nav button')).toHaveCount(7);
    for (const [index, section] of order.entries()) {
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      await page.keyboard.press(`ControlOrMeta+${index + 1}`);
      await expect(page.getByTestId(`service-nav-${section}`).filter({ hasNot: page.locator('[data-never]') }).first()).toHaveAttribute('aria-current', 'page');
    }
    await page.getByTestId('service-nav-identity').first().click();
    const name = page.getByTestId('service-name-input');
    await name.fill('fixture-service');
    await name.press('ControlOrMeta+2');
    await expect(page.getByTestId('service-nav-identity').first()).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('service-nav-endpoints').first().click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').first().focus();
    await page.keyboard.press('ControlOrMeta+7');
    await expect(page.getByTestId('service-nav-endpoints').first()).toHaveAttribute('aria-current', 'page');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').filter({hasNot: page.locator('[never]')}).first().fill('https://example.test');
    await page.getByTestId('upstream-modal-save').click();await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('service-save-button')).toBeEnabled();
    let submissions=0;
    await page.route('**/api/config/validate',route=>route.request().method()==='POST'?route.fulfill({json:{valid:true,errors:[]}}):route.fallback());
    await page.route('**/api/config',route=>{
      if(route.request().method() !== 'PUT') return route.fallback();
      submissions++;evidence.expectStatus(route,422);return route.fulfill({status:422,json:{errors:[{path:'service',message:'fixture rejection'}]}});
    });
    await page.getByTestId('service-nav-identity').first().click();await name.focus();await name.press('ControlOrMeta+s');
    await expect.poll(()=>submissions).toBe(1);
    for(const width of [390,1440]) {
      await page.setViewportSize({width,height:900});await page.getByTestId('service-nav-review').first().click();
      await page.getByTestId('service-review-summary').scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      const save=await page.getByTestId('service-save-button').boundingBox();expect(save!.y+save!.height).toBeLessThanOrEqual(901);
    }
  });
}, 60_000);


test('service account handoff consumes its URL, prepares a draft and focuses an existing binding without duplicate creation', async () => {
  for (const duplicate of [false, true]) await withPage('scenario=service', async page => {
    const serviceId = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
    const bindingId = '60000000-0000-4000-8000-000000000001';
    let drafts = 0, writes = 0;
    const plugin = { name: 'test-provider', enabled: true, metadata: { contributes: {
      upstreamSources: [{ id: 'source', label: 'Source', listAccounts: 'accounts', createDraft: 'draft', credentialPolicy: { allowedOrigins: [], allowedRequests: [], allowedHeaderNames: [] } }],
      api: [{ path: '/accounts', methods: ['GET'], handler: 'accounts', execution: 'control' }, { path: '/draft', methods: ['POST'], handler: 'draft', execution: 'control' }],
    } } };
    await page.route('**/api/plugins', route => route.request().method()==='GET'?route.fulfill({ json: [plugin] }):route.fallback());
    await page.route('**/api/plugins/test-provider/control/accounts', route => route.request().method()==='GET'?route.fulfill({ json: { accounts: [{ id: 'account', label: 'Account', available: true }] } }):route.fallback());
    await page.route('**/api/plugins/test-provider/control/draft', route => {
      if(route.request().method()!=='POST')return route.fallback();
      drafts++; expect(route.request().postDataJSON()).toEqual({ accountRef: 'account' });
      return route.fulfill({ json: { target: 'https://authoritative.test/responses', bindingOptions: { accountRef: 'account' } } });
    });
    await page.route('**/api/config', route => {
      if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 500, json: { error: 'unexpected_write' } }); }
      return route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`, config: {
        plugin_activations: [], logical_configuration: { routes: [], plugins: [], services: [{ id: serviceId, position: 0, name: 'existing', plugins: [], endpoints: [{
          id: '70000000-0000-4000-8000-000000000001', position: 0, target: duplicate ? 'https://authoritative.test/responses' : 'https://manual.test', weight: 100, priority: 1,
          ...(duplicate ? { managedBy: { plugin: 'test-provider', contributionId: 'source', bindingId }, plugins: [{ id: bindingId, position: 0, name: 'test-provider', enabled: true, options: { accountRef: 'account' } }] } : { plugins: [] }),
        }] }] },
      } } });
    });
    await page.goto(`${fixtureUrl('service')}?scenario=service&edit#/services/edit/existing?serviceId=${serviceId}&sourcePlugin=test-provider&sourceId=source&accountRef=account&mode=existing`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/#\/services\/edit\/existing$/);
    await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('https://authoritative.test/responses');
    expect(drafts).toBe(duplicate ? 0 : 1);expect(writes).toBe(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('listitem').filter({has:page.getByRole('button',{name:'Edit',exact:true})})).toHaveCount(duplicate ? 1 : 2);
  });
}, 60_000);
