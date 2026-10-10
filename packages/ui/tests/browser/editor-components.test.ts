import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { expect } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

const editorFixture = resolve(import.meta.dir, '../../../../tests/fixtures/ui/editor-components.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>;
let browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime(['index.html', editorFixture]);
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

async function withPage(query: string, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/api\/plugins(?:\/schemas)?(?:\?.*)?$/, async route => {
    const schema = { name: 'fixture-plugin', configSchema: [{ name: 'visible', type: 'string', label: 'Visible' }] };
    await route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/schemas')
      ? { 'fixture-plugin': schema } : [{ name: 'fixture-plugin', enabled: true }] });
  });
  await page.route('**/api/config', route => route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
    config: { plugin_activations: [], logical_configuration: { routes: [], services: [], plugins: [] } } } }));
  try {
    await page.goto(`${runtime.origin}/@fs${editorFixture}?${query}`);
    try { await run(page); } catch (error) { throw new AggregateError([error, ...errors.map(message => new Error(message))], 'Component browser assertion failed'); }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

test('single selection distinguishes an explicit empty option from its placeholder and emits once on clear', async () => {
  for (const placeholder of [false, true]) {
    await withPage(`scenario=select&value=final${placeholder ? '&placeholder' : ''}`, async page => {
      const select = page.getByRole('combobox', { name: 'Selection' });
      await expect(select).toContainText('Final');
      await select.hover();
      await page.getByRole('button', { name: 'Clear selection' }).click();
      await expect(select).toContainText(placeholder ? 'Choose a type' : 'All types');
      await expect(page.getByTestId('selection')).toContainText('"calls":[""]');
      await expect(page.getByRole('button', { name: 'Clear selection' })).toHaveCount(0);

    });
  }
  await withPage('scenario=select', async page => {
    const select = page.getByRole('combobox', { name: 'Selection' });
    await expect(select).toContainText('All types');
    await select.click();
    await page.getByRole('option', { name: 'Final', exact: true }).click();
    await expect(select).toContainText('Final');
    await expect(page.getByTestId('selection')).toContainText('"calls":["final"]');
  });
  await withPage('scenario=select&value=loading-model-id', async page => {
    await expect(page.getByRole('combobox', { name: 'Selection' })).toContainText('loading-model-id');
  });
}, 60_000);

test('multiple selection and tags remove and clear the bound value arrays', async () => {
  for (const mode of ['multiple', 'tags']) await withPage(`scenario=select&mode=${mode}`, async page => {
    await page.getByRole('button', { name: 'Remove All types' }).click();
    await expect(page.getByTestId('selection')).toContainText('"values":["final"]');
    await page.getByRole('button', { name: 'Remove Final' }).hover();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByTestId('selection')).toContainText('"values":[]');
    await expect(page.getByTestId('selection')).toContainText('"calls":[["final"],[]]');
  });
}, 60_000);

test('protected plugin bindings cannot be edited or removed', async () => {
  await withPage('scenario=plugin&protected', async page => {
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await expect(page.getByTestId('plugins')).toContainText('"_uid":"owner"');
  });
}, 60_000);

test('plugin editing preserves identity, disabled state and unknown options; cancelling leaves the original untouched', async () => {
  await withPage('scenario=plugin', async page => {
    const output = page.getByTestId('plugins');
    const original = await output.textContent();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('cancelled');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(output).toHaveText(original!);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByRole('textbox').fill('after');
    await page.getByTestId('plugin-config-save-button').click();
    await expect(output).toHaveText(JSON.stringify([{ _uid: 'owner', _position: 4, name: 'fixture-plugin', enabled: false,
      options: { accountRef: 'account', unknown: { nested: [1, 2] }, visible: 'after' } }]));
  });
}, 60_000);

test('filtered endpoint actions edit only the original endpoint and preserve hidden entries', async () => {
  await withPage('scenario=upstreams', async page => {
    const output = page.getByTestId('endpoints');
    const before = JSON.parse((await output.textContent())!);
    const search = page.getByRole('textbox', { name: 'Search endpoint address or description' });
    await search.fill(' ALPHA ');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    const row = page.getByRole('listitem');
    await row.getByRole('spinbutton').fill('45');
    await row.getByRole('switch').click();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const description = dialog.getByPlaceholder('e.g., Primary database server');
    await description.fill('edited');
    await page.getByTestId('upstream-modal-save').click();
    await expect(dialog).toHaveCount(0);
    const edited = JSON.parse((await output.textContent())!);
    expect(edited[0]).toEqual(before[0]);
    expect(edited[1]).toMatchObject({ _uid: 'visible', description: 'edited', weight: 45, is_disabled: true });
    await row.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    const copied = JSON.parse((await output.textContent())!);
    expect(copied[2]).toMatchObject({ description: 'edited', target: 'https://ALPHA.test-copy' });
    expect(copied[2]._uid).not.toBe('visible');
    await page.getByRole('listitem').first().getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(output).not.toContainText('"_uid":"visible"');
    expect(JSON.parse((await output.textContent())!)[0]).toEqual(before[0]);
    await search.fill('');
    await expect(page.getByRole('listitem')).toHaveCount(3);
  });
}, 60_000);

test('filtered drag targets use full-list group boundaries and keep hidden group members', async () => {
  for (const action of ['merge', 'before', 'after']) await withPage('scenario=upstreams', async page => {
    await page.getByRole('textbox', { name: 'Search endpoint address or description' }).fill('backup');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.setData('application/json', JSON.stringify({ originalIndex: 1 }));
      return data;
    });
    const target = action === 'merge'
      ? page.getByRole('group').filter({ has: page.getByRole('listitem') }).last()
      : page.getByRole('group', { name: 'Insert New Priority Group', exact: true }).nth(action === 'before' ? 0 : 1);
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    const endpoints = JSON.parse((await page.getByTestId('endpoints').textContent())!);
    expect(endpoints.map((item: { _uid: string }) => item._uid)).toEqual(action === 'after'
      ? ['hidden', 'other', 'visible'] : ['hidden', 'visible', 'other']);
    expect(endpoints.map((item: { priority: number }) => item.priority)).toEqual(action === 'merge' ? [1, 2, 2] : [1, 2, 3]);
    await transfer.dispose();
  });
}, 60_000);

test('service navigation follows seven visible sections and respects field and dialog shortcut boundaries', async () => {
  await withPage('scenario=service', async page => {
    await page.route('**/api/config', route => route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
      config: { plugin_activations: [], logical_configuration: { routes: [], services: [], plugins: [] } } } }));
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
    await page.route('**/api/config/validate',route=>route.fulfill({json:{valid:true,errors:[]}}));
    await page.route('**/api/config',route=>{
      if(route.request().method() !== 'PUT') return route.fallback();
      submissions++;return route.fulfill({status:422,json:{errors:[{path:'service',message:'fixture rejection'}]}});
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


test('WebSocket switch reflects toggles, loaded routes and a fresh draft', async () => {
  for (const enabled of [false, true]) await withPage(`scenario=route${enabled ? '&edit' : ''}`, async page => {
    await page.route('**/api/config', route => route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
      config: { plugin_activations: [], logical_configuration: { routes: enabled ? [{ id: '20000000-0000-4000-8000-000000000081', position: 0, path: '/loaded', endpoints: [], plugins: [], websocket: { enabled: true } }] : [], services: [], plugins: [] } } } }));
    await page.goto(`${runtime.origin}/@fs${editorFixture}?scenario=route&mount=loaded${enabled ? '&edit' : ''}#/routes/${enabled ? 'edit/%2Floaded' : 'new'}?section=forward`);
    const setting = page.getByTestId('route-websocket-setting').getByRole('switch');
    await expect(setting).toHaveAttribute('aria-checked', String(enabled));
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', String(!enabled));
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', String(enabled));
  });
}, 60_000);


test('automatic select width stays stable across a shorter selected label', async () => {
  await withPage('scenario=select&autoWidth', async page => {
    const select=page.getByRole('combobox',{name:'Selection'});
    await expect(select).toContainText('All types');const before=(await select.boundingBox())!.width;
    await select.click();await page.getByRole('option',{name:'Final',exact:true}).click();
    await expect(select).toContainText('Final');expect(Math.abs((await select.boundingBox())!.width-before)).toBeLessThanOrEqual(1);
  });
},60_000);

test('form labels, editable values, placeholder hints and disabled controls have distinct rendered roles in both languages',async()=>{
  await withPage('scenario=design',async page=>{
    const roles=page.getByTestId('design-form-text-roles');
    for(const language of ['zh','en']) {
      const input=roles.locator(`#form-value-${language}`), empty=roles.locator(`#form-placeholder-${language}`), disabled=roles.locator(`#form-disabled-${language}`);
      const original=await input.inputValue();expect(original.length).toBeGreaterThan(0);
      await input.fill('edited');await expect(input).toHaveValue('edited');await expect(disabled).toBeDisabled();
      expect(await empty.getAttribute('placeholder')).toBeTruthy();await expect(empty).toHaveValue('');
      const styles=await roles.evaluate((root,language)=>{
        const value=root.querySelector<HTMLInputElement>(`#form-value-${language}`)!;
        const hint=root.querySelector<HTMLTextAreaElement>(`#form-placeholder-${language}`)!;
        const blocked=root.querySelector<HTMLInputElement>(`#form-disabled-${language}`)!;
        const label=root.querySelector<HTMLLabelElement>(`label[for="form-value-${language}"]`)!;
        const help=root.querySelector(`#${value.getAttribute('aria-describedby')}`)!;
        return {labelWeight:Number(getComputedStyle(label).fontWeight),valueWeight:Number(getComputedStyle(value).fontWeight),
          hintWeight:Number(getComputedStyle(hint,'::placeholder').fontWeight),labelSize:parseFloat(getComputedStyle(label).fontSize),
          valueSize:parseFloat(getComputedStyle(value).fontSize),help:help.textContent,disabledOpacity:parseFloat(getComputedStyle(blocked).opacity)};
      },language);
      expect(styles.labelWeight).toBeGreaterThan(styles.valueWeight);expect(styles.valueWeight).toBe(400);expect(styles.hintWeight).toBe(400);
      expect(styles.labelSize).toBeGreaterThanOrEqual(styles.valueSize);expect(styles.help).toBeTruthy();expect(styles.disabledOpacity).toBeLessThan(1);
    }
  });
},60_000);

test('two route sections share rewrites without restoring a deleted rule',async()=>{
  await withPage('scenario=rewrite',async page=>{
    const model=page.getByTestId('rewrite-model');
    await expect(model).toContainText('"^/before":"/after"');
    await page.getByRole('button',{name:'Delete',exact:true}).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(model).not.toContainText('path_rewrite');
    await page.getByTestId('route-path-input').fill('/changed');
    await expect(model).toContainText('"path":"/changed"');await expect(model).not.toContainText('path_rewrite');
    const messages=await Bun.file(new URL('../../src/i18n/locales/en.json',import.meta.url)).json();
    await page.getByRole('button',{name:messages.routeEditor.addPathRewriteRule,exact:true}).click();
    const inputs=page.getByRole('textbox');await inputs.nth(1).fill('^/changed');await inputs.nth(2).fill('/new');
    await expect(model).toContainText('"^/changed":"/new"');
  });
},60_000);

test('response retry keywords can be added, edited and removed through the bound failover component',async()=>{
  await withPage('scenario=failover',async page=>{
    const messages=await Bun.file(new URL('../../src/i18n/locales/en.json',import.meta.url)).json();
    const model=page.getByTestId('failover-model'), field=page.getByPlaceholder(messages.routeEditor.retryOnResponseBodyPlaceholder);
    await expect(field).toHaveValue('before');await field.fill(' after ');await expect(model).toContainText('"retry_on_response":["after"]');
    await page.getByRole('button',{name:messages.routeEditor.retryOnResponseRemove,exact:true}).click();
    await expect(model).not.toContainText('retry_on_response');await expect(field).toHaveCount(0);
    await page.getByRole('button',{name:`+ ${messages.routeEditor.retryOnResponseAdd}`,exact:true}).click();
    await field.fill('new-keyword');await expect(model).toContainText('"retry_on_response":["new-keyword"]');
  });
},60_000);


test('service account handoff consumes its URL, prepares a draft and focuses an existing binding without duplicate creation', async () => {
  for (const duplicate of [false, true]) await withPage('scenario=service', async page => {
    const serviceId = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
    const bindingId = '60000000-0000-4000-8000-000000000001';
    let drafts = 0, writes = 0;
    const plugin = { name: 'test-provider', enabled: true, metadata: { contributes: {
      upstreamSources: [{ id: 'source', label: 'Source', listAccounts: 'accounts', createDraft: 'draft', credentialPolicy: { allowedOrigins: [], allowedRequests: [], allowedHeaderNames: [] } }],
      api: [{ path: '/accounts', methods: ['GET'], handler: 'accounts', execution: 'control' }, { path: '/draft', methods: ['POST'], handler: 'draft', execution: 'control' }],
    } } };
    await page.route('**/api/plugins', route => route.fulfill({ json: [plugin] }));
    await page.route('**/api/plugins/test-provider/control/accounts', route => route.fulfill({ json: { accounts: [{ id: 'account', label: 'Account', available: true }] } }));
    await page.route('**/api/plugins/test-provider/control/draft', route => {
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
    await page.goto(`${runtime.origin}/@fs${editorFixture}?scenario=service&edit#/services/edit/existing?serviceId=${serviceId}&sourcePlugin=test-provider&sourceId=source&accountRef=account&mode=existing`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/#\/services\/edit\/existing$/);
    await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('https://authoritative.test/responses');
    expect(drafts).toBe(duplicate ? 0 : 1);expect(writes).toBe(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('listitem').filter({has:page.getByRole('button',{name:'Edit',exact:true})})).toHaveCount(duplicate ? 1 : 2);
  });
}, 60_000);
