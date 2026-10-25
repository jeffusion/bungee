import { serviceReference } from '../helpers/service-references';
import {afterAll,beforeAll,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright';
import {expect} from 'playwright/test';
import assert from 'node:assert/strict';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';
import {menuSnapshot,fulfillMenuIcons} from '../helpers/menus';
import {collectApiEvidence} from '../helpers/editors/api-evidence';
let runtime:Awaited<ReturnType<typeof startUiRuntime>>,browser:Browser;
beforeAll(async()=>{runtime=await startUiRuntime({mode:'built-page'});try{browser=await chromium.launch({headless:true,timeout:10_000});}catch(error){await runtime.close();throw error;}},120_000);
afterAll(async()=>{try{await browser?.close();}finally{await runtime?.close();}});
const endpoint = (id:string, target:string) => ({ id, position: 0, target, priority: 1, weight: 100, is_disabled: false, plugins: [] });
const logical = {
  log_level: 'info', auth: { enabled: false, tokens: [] }, logging: {}, plugins: [],
  services: [{ id: 'service-fixture', position: 0, name: 'fixture-service',
    endpoints: [endpoint('service-endpoint', 'https://example.test')], plugins: [] },
    { id: 'service-secondary', position: 1, name: 'secondary-service', endpoints: [endpoint('secondary-endpoint', 'https://secondary.test')], plugins: [] }],
  routes: [
    { id: 'route-service', position: 0, path: '/fixture-service/', service_references: [serviceReference('service-fixture')], plugins: [] },
    { id: 'route-custom', position: 1, path: '/fixture-custom/', endpoints: [endpoint('custom-endpoint', 'https://example.test')], plugins: [] },
  ],
};

const pluginSchemas=Object.fromEntries(['alpha','beta'].map(name=>[name,{name,version:'1.0.0',runtimeScope:'scoped',metadata:{name},configSchema:[]}]));
async function withEditor(run:(page:Page,state:{logical:any;writes:any[]})=>Promise<void>,plugins=false){
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1326,height:822},locale:'zh-CN'});
try{const state = {logical: structuredClone(logical) as any, writes: [] as any[]}; let revision = 1; const page=await context.newPage();page.setDefaultTimeout(4000);const evidence=collectApiEvidence(page),errors=evidence.errors;const origin=runtime.origin;
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{const request=route.request(),url=new URL(request.url()),method=request.method();
        const key = `${method} ${url.pathname}`;

        let body;
        if (key === 'GET /api/auth/mode') body = { mode: 'anonymous', publicOrigin: origin };
        else if (key === 'GET /api/auth/verify') body = { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } };
        else if (key === 'GET /api/ui/menus') body = menuSnapshot();
        else if (key === 'GET /api/ui/icons/data') return fulfillMenuIcons(route);
        else if (key === 'GET /api/plugins') body = plugins?Object.values(pluginSchemas).map(plugin=>({...plugin,enabled:true})):[];
        else if(key === 'GET /api/plugins/schemas' && plugins && url.searchParams.get('enabledOnly')==='true' && ['route','service','upstream'].includes(url.searchParams.get('scope')??'')) body=pluginSchemas;
        else if (key === 'GET /api/plugin-translations') body = {};
        else if (key === 'GET /api/config') body = { revision, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: state.logical, plugin_activations: [] } };
        else if (key === 'GET /api/config/runtime') body = { revision, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: state.logical, plugin_activations: [] }, workers: [],
          publication: { operation: null, recovery: null, retryable: false,
            serving_complete: false, serving_revision: null, target_revision: 1 } };
        else if (key === 'GET /api/runtime/upstreams') body = { workers: [], services: {}, availability: 'unknown', upstreams: [] };
        else if (key === 'PUT /api/config') { const payload = request.postDataJSON(); assert.equal(payload.expected_revision, revision); state.writes.push(payload); state.logical = payload.aggregate.logical_configuration; revision++; return route.fulfill({status:202,json:{operation_id:payload.mutation_id,revision,operation:{state:'converged',mutation_id:payload.mutation_id},workers:[]}}); }
        else if (key === 'POST /api/config/validate') body = { valid: true, errors: [] };
        else {
          errors.push(`Unexpected API ${key}`);

          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unhandled_test_api' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

});
try { await run(page,state); evidence.verify(); } catch(error) { throw new AggregateError([error, ...errors.map(message => new Error(message))], `Route editor browser failed: ${await page.locator('body').innerText()}`); }
}finally{await context.close();}
}

for(const name of ['new-custom','edit-service','edit-custom']) test(`route target mode ${name}`,async()=>{
await withEditor(async page=>{
const serviceBacked=name==='edit-service';
const path=name==='new-custom'?'/routes/new':`/routes/edit/${encodeURIComponent(serviceBacked?'/fixture-service/':'/fixture-custom/')}`;
await page.goto(`${runtime.origin}/#${path}`);
const target=page.getByTestId('route-nav-target');await expect(target).toBeVisible();await target.click();
const targetPanel=page.locator('[data-testid="route-target-section"][data-testid-section="target"]');await expect(targetPanel).toBeVisible();
      if (serviceBacked) {
        const servicePanelText = await targetPanel.locator('..').innerText();
        assert.ok(servicePanelText.toLowerCase().includes('fixture-service'));
        await expect(targetPanel.getByTestId('service-reference-details')).toHaveCount(0);
        await targetPanel.getByRole('button', {name:'服务详情',exact:true}).click();
        await expect(targetPanel.getByTestId('service-reference-details')).toContainText('https://example.test');

      } else {

        if (name === 'edit-custom') assert.ok((await targetPanel.innerText()).includes('https://example.test'));
      }

      if (name === 'new-custom') {
        const modeService = targetPanel.locator('[data-testid="mode-service"]');
        const modeCustom = targetPanel.locator('[data-testid="mode-custom"]');
        const confirmation = page.locator('[role="dialog"]');
        await modeService.click({ timeout: 4000 });
        await confirmation.waitFor({ state: 'visible', timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });

        await modeService.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });
        await expect(confirmation).toHaveCount(0);

        await targetPanel.getByRole('button', { name: '引用服务', exact: true }).click();
        await targetPanel.getByRole('combobox').click();
        await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
        await expect(targetPanel.getByTestId('service-reference-details')).toHaveCount(0);
        await targetPanel.getByRole('button', {name:'服务详情',exact:true}).click();
        await expect(targetPanel.getByTestId('service-reference-details')).toContainText('https://example.test');
        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });

        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });

        await modeService.click({ timeout: 4000 });

        await page.getByRole('button', { name: /使用模板/ }).click({ timeout: 4000 });
        await page.getByRole('button', { name: /Simple Proxy/ }).click({ timeout: 4000 });

        assert.ok((await targetPanel.innerText()).includes('https://api.example.com'));
      }

await expect(page.getByTestId('configuration-publication-banner')).toHaveCount(0);
});
},240_000);

for(const [name,path,nav] of [
 ['new route','/routes/new','route-nav-plugins'],
 ['existing route','/routes/edit/%2Ffixture-custom%2F','route-nav-plugins'],
 ['new service','/services/new','service-nav-plugins'],
 ['existing service','/services/edit/fixture-service','service-nav-plugins'],
])test(`${name} wires added plugin binding back into the editor`,async()=>{
 await withEditor(async page=>{
 await page.goto(`${runtime.origin}/#${path}`);
 await page.getByTestId(nav).first().click();
 await page.getByRole('button',{name:'添加插件',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('combobox').click();
 await page.getByRole('option',{name:'beta (v1.0.0)',exact:true}).click();
 await dialog.getByTestId('plugin-config-save-button').click();await expect(dialog).toHaveCount(0);
 await page.getByTestId('section-plugins').getByRole('button',{name:'编辑',exact:true}).click();
 await expect(dialog.getByRole('combobox')).toBeDisabled();await expect(dialog.getByRole('combobox')).toContainText('beta');
 await dialog.getByTestId('plugin-config-save-button').click();await expect(dialog).toHaveCount(0);
 },true);
},240_000);

async function openEditorWithHistory(page: Page, path: string) {
  await page.goto(`${runtime.origin}/#${path.startsWith('/services') ? '/services' : '/routes'}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(hash => location.hash = hash, path);
}

async function addServiceReference(page: Page, owner: ReturnType<Page['locator']>, name: string) {
  await owner.getByTestId('service-reference-picker').getByRole('button', {name: '引用服务', exact: true}).click();
  await owner.getByTestId('service-reference-picker').getByRole('combobox').click();
  await page.getByRole('option', {name, exact: true}).click();
}

async function addPlugin(page: Page, scope: ReturnType<Page['locator']>) {
  await scope.getByRole('button',{name:'添加插件',exact:true}).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.getByRole('combobox').click();
  await page.getByRole('option',{name:'beta (v1.0.0)',exact:true}).click();
  await dialog.getByTestId('plugin-config-save-button').click();
}

test('multiple Route references retain pool policy and Route plugin through save and reload', async () => {
  await withEditor(async (page,state) => {
    const url = `${runtime.origin}/#/routes/edit/%2Ffixture-service%2F`;
    await openEditorWithHistory(page, '/routes/edit/%2Ffixture-service%2F');
    await page.getByTestId('route-nav-plugins').click();
    await addPlugin(page, page.getByTestId('section-plugins'));
    await page.getByTestId('route-nav-target').click();
    const target = page.getByTestId('route-target-section');
    await addServiceReference(page, target, 'secondary-service');
    await target.getByRole('listitem').last().dragTo(target.getByRole('listitem').first(), {sourcePosition:{x:10,y:15},targetPosition:{x:10,y:1}});
    await expect(target.getByTestId('service-reference-row').first()).toContainText('secondary-service');
    const row = target.getByTestId('service-reference-row').filter({has:page.getByRole('button',{name:'secondary-service',exact:true})});
    await target.getByRole('listitem').first().dragTo(target.getByTestId('upstream-priority-boundary').last(), {sourcePosition:{x:10,y:15}});
    await expect(target.getByTestId('upstream-priority-group')).toHaveCount(2);
    await row.getByRole('spinbutton',{name:'权重',exact:true}).fill('25');
    await row.getByRole('switch').click();
    await target.getByTestId('service-load-balancing-section').getByRole('combobox').click();
    await page.getByRole('option',{name:/轮询/}).click();
    await target.getByRole('switch',{name:'启用自动故障转移',exact:true}).click();
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:'/tmp/bungee-route-service-references.png'});
    await page.setViewportSize({width:390,height:844});
    await page.getByTestId('service-mixed-targets').evaluate(element => element.scrollIntoView({block:'center'}));
    await page.screenshot({path:'/tmp/bungee-route-service-references-mobile.png'});
    await page.setViewportSize({width:1326,height:822});
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await page.getByTestId('route-save-button').click();
    await (await refreshed).finished(); await page.waitForLoadState('networkidle');
    await expect.poll(() => state.writes.length).toBe(1);
    const saved = state.logical.routes[0];
    assert.equal(saved.service_references.length, 2);
    assert.deepEqual(saved.service_references[1], {...saved.service_references[1],service_id:'service-secondary',priority:2,weight:25,is_disabled:true});
    assert.equal(saved.load_balancing.policy, 'round_robin');
    assert.equal(saved.failover.enabled, true);assert.equal(saved.failover.passive_health, undefined);
    assert.equal(saved.plugins[0].name,'beta');assert.equal(saved.endpoints,undefined);
    const referenceIds = saved.service_references.map((reference:any) => reference.id);
    await page.goto(url);await page.getByTestId('route-nav-target').click();
    await expect(target.getByTestId('service-reference-row')).toHaveCount(2);
    await expect(target.getByTestId('service-reference-row').last().getByRole('spinbutton',{name:'权重',exact:true})).toHaveValue('25');
    assert.deepEqual(state.logical.routes[0].service_references.map((reference:any) => reference.id), referenceIds);
  },true);
},120_000);

test('Service mixed targets share ordering and preserve endpoint and Service plugin editing', async () => {
  await withEditor(async (page,state) => {
    const url = `${runtime.origin}/#/services/edit/fixture-service`;
    await openEditorWithHistory(page, '/services/edit/fixture-service');await page.getByTestId('service-nav-endpoints').first().click();
    const targets = page.getByTestId('service-mixed-targets');
    await addServiceReference(page, page.getByTestId('service-nav-endpoints').last(), 'secondary-service');
    await targets.getByRole('listitem').last().dragTo(targets.getByRole('listitem').first(), {sourcePosition:{x:10,y:15},targetPosition:{x:10,y:1}});
    await targets.getByRole('button',{name:'编辑',exact:true}).click();
    const endpointDialog = page.getByRole('dialog');
    await addPlugin(page, endpointDialog);
    await page.getByTestId('upstream-modal-save').click();
    await page.getByTestId('service-nav-plugins').first().click();
    await addPlugin(page, page.getByTestId('section-plugins'));
    await page.getByTestId('service-nav-endpoints').first().click();
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:'/tmp/bungee-service-mixed-targets.png'});
    await page.setViewportSize({width:390,height:844});
    await page.getByTestId('service-mixed-targets').evaluate(element => element.scrollIntoView({block:'center'}));
    await page.screenshot({path:'/tmp/bungee-service-mixed-targets-mobile.png'});
    await page.setViewportSize({width:1326,height:822});
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await page.getByTestId('service-save-button').click();
    await (await refreshed).finished(); await page.waitForLoadState('networkidle');
    await expect.poll(() => state.writes.length).toBe(1);
    const saved = state.logical.services[0];
    assert.equal(saved.endpoints.length,1);assert.equal(saved.endpoints[0].position,1);
    assert.equal(saved.service_references[0].position,0);assert.equal(saved.service_references[0].service_id,'service-secondary');
    assert.equal(saved.endpoints[0].plugins[0].name,'beta');assert.equal(saved.plugins[0].name,'beta');
    await page.goto(url);await page.getByTestId('service-nav-endpoints').first().click();
    await expect(targets.getByTestId('service-reference-row')).toHaveCount(1);
    await targets.getByRole('button',{name:'编辑',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:'编辑',exact:true})).toBeVisible();
  },true);
},120_000);

test('missing, duplicate and cyclic references surface visible errors and disable saving', async () => {
  for (const mode of ['missing','duplicate','cycle']) await withEditor(async (page,state) => {
    const references = state.logical.routes[0].service_references;
    if (mode === 'missing') references[0].service_id = 'missing-service';
    if (mode === 'duplicate') references.push(serviceReference('service-fixture',{position:1}));
    if (mode === 'cycle') state.logical.services[0].service_references = [serviceReference('service-fixture')];
    await page.goto(`${runtime.origin}/#/routes/edit/%2Ffixture-service%2F`);
    await page.getByTestId('route-nav-target').click();
    await expect(page.getByTestId('route-target-section').getByRole('alert').first()).toBeVisible();
    await expect(page.getByTestId('route-save-button')).toBeDisabled();
    assert.equal(state.writes.length,0);
  });
},120_000);

test('target weights preserve large values and reject cleared required input before saving', async () => {
  await withEditor(async (page,state) => {
    state.logical.services[0].endpoints[0].weight = 3000000000;
    await openEditorWithHistory(page,'/services/edit/fixture-service');
    await page.getByTestId('service-nav-endpoints').first().click();
    const weight = page.getByTestId('service-mixed-targets').getByRole('spinbutton',{name:'权重',exact:true}).first();
    const save = page.getByTestId('service-save-button');
    await weight.focus(); await weight.press('Tab');
    await expect(weight).toHaveValue('3000000000');
    await weight.fill('9007199254740992');
    await expect(save).toBeDisabled();
    await weight.press('Tab');
    await expect(weight).toHaveValue(String(Number.MAX_SAFE_INTEGER));
    await weight.fill('');
    await expect(save).toBeDisabled();
    await weight.press('Tab');
    await expect(weight).toHaveValue('');
    await expect(save).toBeDisabled();
    assert.equal(state.writes.length,0);
    await weight.fill('45'); await weight.press('Tab');
    await expect(save).toBeEnabled();
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await save.click(); await (await refreshed).finished(); await page.waitForLoadState('networkidle');
    assert.equal(state.logical.services[0].endpoints[0].weight,45);
  });
},120_000);

test('Service consumers show direct Route and Service references by stable identity', async () => {
  await withEditor(async (page,state) => {
    state.logical.services[0].service_references = [serviceReference('service-secondary')];
    state.logical.routes[0].service_references.push(serviceReference('service-secondary',{position:1}));
    await page.goto(`${runtime.origin}/#/services/edit/secondary-service`);
    await page.getByTestId('service-nav-consumers').first().click();
    const consumers = page.getByTestId('service-consumers-list');
    await expect(consumers.getByRole('button',{name:'fixture-service',exact:true})).toBeVisible();
    await expect(consumers.getByRole('button',{name:'/fixture-service/',exact:true})).toBeVisible();
    assert.equal(state.writes.length,0);
    await page.goto(`${runtime.origin}/#/services`);
    const card = page.getByTestId('services-board').getByRole('article').filter({has: page.locator('[title="secondary-service"]')});
    await card.getByRole('button',{name:'显示',exact:true}).click();
    await card.getByRole('button',{name:'删除',exact:true}).click();
    const blocked = page.getByTestId('delete-service-modal');
    await expect(blocked.getByRole('button',{name:'fixture-service',exact:true})).toBeVisible();
    await expect(blocked.getByRole('button',{name:'/fixture-service/',exact:true})).toBeVisible();
    await expect(blocked.getByTestId('confirm-delete-btn')).toHaveCount(0);
    assert.equal(state.writes.length,0);
  });
},60_000);

test('saving custom endpoints as a Service creates fresh endpoint bindings and stores its stable reference', async () => {
  await withEditor(async (page,state) => {
    const initial = state.logical.routes[1].endpoints[0];
    initial.plugins = [{id:'endpoint-binding',position:0,name:'alpha',enabled:true,options:{keep:'value'}}];
    await openEditorWithHistory(page, '/routes/edit/%2Ffixture-custom%2F');
    await page.getByTestId('route-nav-target').click();
    const target = page.getByTestId('route-target-section');
    await target.getByPlaceholder('Service 名称').fill('converted-service');
    const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await target.getByRole('button',{name:'保存为 Service',exact:true}).click();
    await (await refresh).finished();
    await expect(target.getByTestId('service-reference-row')).toHaveCount(1);
    const created = state.logical.services.at(-1);
    assert.equal(created.name,'converted-service');assert.notEqual(created.endpoints[0].id,initial.id);
    assert.notEqual(created.endpoints[0].plugins[0].id,'endpoint-binding');assert.equal(created.endpoints[0].plugins[0].options.keep,'value');
    const committed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await page.getByTestId('route-save-button').click();await (await committed).finished();await page.waitForLoadState('networkidle');
    await expect.poll(() => state.writes.length).toBe(2);
    assert.equal(state.logical.routes[1].endpoints,undefined);
    assert.equal(state.logical.routes[1].service_references[0].service_id,created.id);
  },true);
},60_000);
