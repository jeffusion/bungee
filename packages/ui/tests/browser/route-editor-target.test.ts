import { serviceReference } from '../helpers/service-references';
import { systemUpdateStatusFixture } from '../helpers/system-updates';
import {afterAll,beforeAll,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright';
import {expect} from 'playwright/test';
import assert from 'node:assert/strict';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';
import {menuSnapshot,fulfillMenuIcons} from '../helpers/menus';
import {collectApiEvidence} from '../helpers/editors/api-evidence';
import {recordResponseDelivery,holdResponseJson,waitForResponseReceipt,releaseResponseJson,waitForResponseDelivery} from '../helpers/editors/response-delivery';
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
try{const state = {logical: structuredClone(logical) as any, writes: [] as any[]}; let revision = 1; const page=await context.newPage();page.setDefaultTimeout(4000);const evidence=collectApiEvidence(page),errors=evidence.errors;const origin=runtime.origin;const apiRequests:string[]=[];
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{const request=route.request(),url=new URL(request.url()),method=request.method();
        const key = `${method} ${url.pathname}`;
        apiRequests.push(key);

        let body;
        if (key === 'GET /api/auth/mode') body = { mode: 'anonymous', publicOrigin: origin };
        else if (key === 'GET /api/system/updates') body = systemUpdateStatusFixture;
        else if (key === 'GET /api/auth/verify') body = { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } };
        else if (key === 'GET /api/ui/menus') body = menuSnapshot();
        else if (key === 'GET /api/ui/icons/data') return fulfillMenuIcons(route);
        else if (key === 'GET /api/plugins') body = plugins?Object.values(pluginSchemas).map(plugin=>({...plugin,enabled:true})):[];
        else if(key === 'GET /api/plugins/schemas' && url.searchParams.get('enabledOnly')==='true' && ['route','service','upstream'].includes(url.searchParams.get('scope')??'')) body=plugins?pluginSchemas:{};
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
try { await run(page,state); evidence.verify(); } catch(error) {
  let body='';
  try {
    body=await page.locator('body').innerText();
    const save=page.getByTestId('route-save-button'),saveButtonCount=await save.count();
    console.error('Route editor browser failed:',{url:page.url(),body,
      saveButtonCount,saveButtonDisabled:saveButtonCount ? await save.isDisabled() : null,
      writeCount:state.writes.length,writes:state.writes,apiRequests,errors});
  } catch(captureError) { console.error('无法读取 Route 编辑器失败现场:',captureError); }
  throw new AggregateError([error, ...errors.map(message => new Error(message))], `Route editor browser failed: ${body}`);
}
}finally{await context.close();}
}

for(const name of ['new-custom','edit-service','edit-custom']) test(`route targets ${name}`,async()=>{
await withEditor(async (page,state)=>{
const serviceBacked=name==='edit-service';
const path=name==='new-custom'?'/routes/new':`/routes/edit/${encodeURIComponent(serviceBacked?'/fixture-service/':'/fixture-custom/')}`;
if(name==='new-custom') await openEditorWithHistory(page,path);
else await page.goto(`${runtime.origin}/#${path}`);
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
        await page.getByTestId('route-nav-match').click();
        await page.getByTestId('route-path-input').fill('/new-mixed/');
        await target.click();
        await targetPanel.getByTestId('upstream-endpoint-row').getByRole('button', {name:'编辑',exact:true}).click();
        await page.getByRole('dialog').getByPlaceholder('https://api.example.com', {exact:true}).fill('https://retained.example.test');
        await page.getByTestId('upstream-modal-save').click();
        await dismissTargetDialogWithShortcuts(page, targetPanel, state.writes);
        await targetPanel.getByTestId('route-upstream-add-button').click();
        const addDialog = page.getByRole('dialog');
        await addDialog.getByPlaceholder('https://api.example.com', {exact:true}).fill('https://cancelled.example.test');
        await addDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(targetPanel.getByTestId('upstream-endpoint-row')).toHaveCount(1);
        await expect(targetPanel.getByTestId('upstream-endpoint-row')).toContainText('https://retained.example.test');
        await targetPanel.getByTestId('route-upstream-add-button').click();
        await addDialog.getByRole('radio', { name: 'SVC 服务', exact: true }).click();
        await addDialog.getByRole('combobox').click();
        await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
        await addDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(addDialog).toHaveCount(0);
        await expect(targetPanel.getByTestId('service-reference-row')).toHaveCount(0);
        await addServiceReference(page, targetPanel, 'fixture-service');
        await expect(targetPanel.getByTestId('service-reference-row')).toHaveCount(1);
        await expect(targetPanel.getByTestId('upstream-endpoint-row')).toHaveCount(1);
        await expect(targetPanel.getByTestId('upstream-endpoint-row')).toContainText('https://retained.example.test');
        await expect(targetPanel.getByTestId('service-reference-details')).toHaveCount(0);
        assert.equal(state.writes.length,0);
        await targetPanel.getByRole('button', {name:'服务详情',exact:true}).click();
        await expect(targetPanel.getByTestId('service-reference-details')).toContainText('https://example.test');
        async function saveWithoutReordering(path: string) {
          const keys = await targetPanel.getByRole('listitem').evaluateAll(elements => elements.map(element => element.getAttribute('data-target-key')));
          assert.ok(keys[0]?.startsWith('endpoint:'));
          assert.ok(keys[1]?.startsWith('service:'));
          const writesBefore=state.writes.length;
          const [response]=await Promise.all([
            page.waitForResponse(response => response.request().method()==='PUT' && new URL(response.url()).pathname==='/api/config'),
            page.getByTestId('route-save-button').click(),
          ]);
          assert.equal(response.status(),202);
          assert.equal(await response.finished(),null);
          await page.waitForURL(`${runtime.origin}/#/routes`);
          await page.waitForLoadState('networkidle');
          assert.equal(state.writes.length,writesBefore+1);
          const saved = state.logical.routes.find((route:any) => route.path === path);
          assert.ok(saved,`保存后缺少 Route ${path}`);
          assert.equal(saved.endpoints[0].position,0);
          assert.equal(saved.service_references[0].position,1);
          assert.deepEqual([`endpoint:${saved.endpoints[0].id}`,`service:${saved.service_references[0].id}`],keys);
          await openEditorWithHistory(page,`/routes/edit/${encodeURIComponent(path)}`);
          await page.getByTestId('route-nav-target').click();
          await expect(targetPanel.getByTestId('service-reference-row')).toHaveCount(1);
          assert.deepEqual(await targetPanel.getByRole('listitem').evaluateAll(elements => elements.map(element => element.getAttribute('data-target-key'))),keys);
        }
        await saveWithoutReordering('/new-mixed/');
        await openEditorWithHistory(page,'/routes/new');
        await target.click();
        await page.getByRole('button', { name: /使用模板/ }).click({ timeout: 4000 });
        await page.getByRole('button', { name: /Simple Proxy/ }).click({ timeout: 4000 });

        assert.ok((await targetPanel.innerText()).includes('https://api.example.com'));
        await addServiceReference(page,targetPanel,'fixture-service');
        await saveWithoutReordering('/api');
        assert.equal(state.writes.length,2);
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

async function dismissTargetDialogWithShortcuts(page: Page, owner: ReturnType<Page['locator']>, writes: unknown[]) {
  const url = page.url(), writeCount = writes.length;
  await expect(page.getByTestId(/^(route|service)-save-button$/)).toBeEnabled();
  const opener = owner.getByTestId('route-upstream-add-button');
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await page.keyboard.press('ControlOrMeta+1');
  assert.equal(writes.length, writeCount);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page).toHaveURL(url);
  await expect(owner).toBeVisible();
  assert.equal(writes.length, writeCount);
}

async function addServiceReference(page: Page, owner: ReturnType<Page['locator']>, name: string) {
  await owner.getByTestId('route-upstream-add-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const serviceType = dialog.getByRole('radio', {name: 'SVC 服务', exact: true});
   await serviceType.click();
  await dialog.getByTestId('service-reference-picker').getByRole('combobox').click();
  await page.getByRole('option', {name, exact: true}).click();
  await dialog.getByTestId('service-reference-confirm').click();
  await expect(dialog).toHaveCount(0);
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

for (const serviceFirst of [false, true]) test(`Route mixed targets survive adding, reordering, save and reload (serviceFirst=${serviceFirst})`, async () => {
  await withEditor(async (page,state) => {
    const routeIndex = serviceFirst ? 0 : 1;
    const path = serviceFirst ? '/fixture-service/' : '/fixture-custom/';
    const original = structuredClone(state.logical.routes[routeIndex]);
    await openEditorWithHistory(page, `/routes/edit/${encodeURIComponent(path)}`);
    await page.getByTestId('route-nav-target').click();
    const target = page.getByTestId('route-target-section');
    if (serviceFirst) {
      await target.getByTestId('route-upstream-add-button').click();
      await page.getByRole('dialog').getByPlaceholder('https://api.example.com', {exact:true}).fill('https://added.example.test');
      await page.getByTestId('upstream-modal-save').click();
    } else await addServiceReference(page, target, 'secondary-service');
    await expect(target.getByTestId('upstream-endpoint-row')).toHaveCount(1);
    await expect(target.getByTestId('service-reference-row')).toHaveCount(1);
    assert.equal(state.writes.length,0);
    await target.getByRole('listitem').last().dragTo(target.getByRole('listitem').first(), {sourcePosition:{x:10,y:15},targetPosition:{x:10,y:1}});
    await target.getByTestId('upstream-endpoint-row').getByRole('spinbutton',{name:'权重',exact:true}).fill('45');
    await target.getByTestId('service-reference-row').getByRole('spinbutton',{name:'权重',exact:true}).fill('25');
    await target.getByTestId('service-reference-row').getByRole('switch').click();
    await target.getByTestId('service-load-balancing-section').getByRole('combobox').click();
    await page.getByRole('option',{name:/轮询/}).click();
    await target.getByRole('switch',{name:'启用自动故障转移',exact:true}).click();
    await page.screenshot({path:`/tmp/opencode/route-mixed-${serviceFirst ? 'service' : 'endpoint'}-desktop.png`});
    await page.setViewportSize({width:390,height:844});
    await target.evaluate(element => element.scrollIntoView({block:'start'}));
    await page.screenshot({path:`/tmp/opencode/route-mixed-${serviceFirst ? 'service' : 'endpoint'}-mobile.png`});
    await page.setViewportSize({width:1326,height:822});
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await page.getByTestId('route-save-button').click();
    await (await refreshed).finished(); await page.waitForLoadState('networkidle');
    await expect.poll(() => state.writes.length).toBe(1);
    const saved = state.logical.routes[routeIndex];
    assert.equal(saved.endpoints.length,1);
    assert.equal(saved.service_references.length,1);
    assert.equal(saved.endpoints[0].position,serviceFirst ? 0 : 1);
    assert.equal(saved.service_references[0].position,serviceFirst ? 1 : 0);
    assert.equal(saved.endpoints[0].weight,45);
    assert.equal(saved.service_references[0].weight,25);
    assert.equal(saved.service_references[0].is_disabled,true);
    assert.equal(saved.load_balancing.policy,'round_robin');
    assert.equal(saved.failover.enabled,true);
    if (serviceFirst) assert.equal(saved.service_references[0].id,original.service_references[0].id);
    else assert.equal(saved.endpoints[0].id,original.endpoints[0].id);
    const savedTargets = structuredClone({endpoints:saved.endpoints,service_references:saved.service_references});
    await page.goto(`${runtime.origin}/#/routes/edit/${encodeURIComponent(path)}`);
    await page.getByTestId('route-nav-target').click();
    await expect(target.getByTestId('upstream-endpoint-row')).toHaveCount(1);
    await expect(target.getByTestId('service-reference-row')).toHaveCount(1);
    await expect(target.getByTestId('upstream-endpoint-row').getByRole('spinbutton',{name:'权重',exact:true})).toHaveValue('45');
    await expect(target.getByTestId('service-reference-row').getByRole('spinbutton',{name:'权重',exact:true})).toHaveValue('25');
    assert.deepEqual({endpoints:state.logical.routes[routeIndex].endpoints,service_references:state.logical.routes[routeIndex].service_references},savedTargets);
  });
},120_000);

test('Service mixed targets share ordering and preserve endpoint and Service plugin editing', async () => {
  await withEditor(async (page,state) => {
    const url = `${runtime.origin}/#/services/edit/fixture-service`;
    await openEditorWithHistory(page, '/services/edit/fixture-service');await page.getByTestId('service-nav-endpoints').first().click();
    const targets = page.getByTestId('service-mixed-targets');
    await dismissTargetDialogWithShortcuts(page, page.getByTestId('service-nav-endpoints').last(), state.writes);
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
  for (const mode of ['service-endpoint', 'route-endpoint', 'route-reference']) await withEditor(async (page,state) => {
    const service = mode === 'service-endpoint';
    const target = service ? state.logical.services[0].endpoints[0]
      : mode === 'route-endpoint' ? state.logical.routes[1].endpoints[0] : state.logical.routes[0].service_references[0];
    target.weight = 3000000000;
    const path = service ? '/services/edit/fixture-service'
      : mode === 'route-endpoint' ? '/routes/edit/%2Ffixture-custom%2F' : '/routes/edit/%2Ffixture-service%2F';
    await openEditorWithHistory(page,path);
    await page.getByTestId(service ? 'service-nav-endpoints' : 'route-nav-target').first().click();
    const weight = page.getByTestId('service-mixed-targets').getByRole('spinbutton',{name:'权重',exact:true}).first();
    const save = page.getByTestId(service ? 'service-save-button' : 'route-save-button');
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
    const saved = service ? state.logical.services[0].endpoints[0]
      : mode === 'route-endpoint' ? state.logical.routes[1].endpoints[0] : state.logical.routes[0].service_references[0];
    assert.equal(saved.weight,45);
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

for (const scenario of ['custom','mixed','pending']) test(`extracting Route targets as a Service preserves bindings and scheduling (${scenario})`, async () => {
  const mixed = scenario !== 'custom', pending = scenario === 'pending';
  await withEditor(async (page,state) => {
    if (pending) await recordResponseDelivery(page,'/api/config');
    const initial = state.logical.routes[1].endpoints[0];
    initial.plugins = [{id:'endpoint-binding',position:0,name:'alpha',enabled:true,options:{keep:'value'}}];
    const references = mixed ? [serviceReference('service-secondary', {position:1,priority:2,weight:25,is_disabled:true})] : undefined;
    if (mixed) {
      state.logical.routes[1].service_references = references;
      state.logical.routes[1].load_balancing = {policy:'round_robin'};
      state.logical.routes[1].failover = {enabled:true,retry_on:[503]};
    }
    await openEditorWithHistory(page, '/routes/edit/%2Ffixture-custom%2F');
    await page.getByTestId('route-nav-target').click();
    const target = page.getByTestId('route-target-section');
    await target.getByPlaceholder('服务名称').fill('converted-service');
    if (pending) {
      await holdResponseJson(page,'extraction-snapshot',{method:'GET',path:'/api/config'});
      await holdResponseJson(page,'extraction-create',{method:'PUT',path:'/api/config'});
    }
    const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await target.getByRole('button',{name:'保存为服务',exact:true}).click();
    if (pending) {
      const snapshotRequest = await waitForResponseReceipt(page,'extraction-snapshot');
      await target.getByTestId('upstream-endpoint-row').getByRole('spinbutton',{name:'权重',exact:true}).fill('45');
      await target.getByTestId('service-reference-row').getByRole('spinbutton',{name:'权重',exact:true}).fill('35');
      await target.getByTestId('service-load-balancing-section').getByRole('combobox').click();
      await page.getByRole('option',{name:/最少请求/}).click();
      await releaseResponseJson(page,snapshotRequest);
      const createRequest = await waitForResponseReceipt(page,'extraction-create');
      await target.getByTestId('upstream-endpoint-row').getByRole('spinbutton',{name:'权重',exact:true}).fill('55');
      await target.getByPlaceholder('服务名称').fill('next-service');
      await releaseResponseJson(page,createRequest);
      await waitForResponseDelivery(page,createRequest);
    }
    await (await refresh).finished();
    if (pending) await expect(target.getByRole('button',{name:'保存为服务',exact:true})).toBeEnabled();
    else await expect(target.getByPlaceholder('服务名称')).toHaveValue('');
    const created = state.logical.services.at(-1);
    assert.equal(created.name,'converted-service');assert.notEqual(created.endpoints[0].id,initial.id);
    assert.equal(created.endpoints[0].position,initial.position);
    assert.equal(created.endpoints[0].weight,initial.weight);
    assert.notEqual(created.endpoints[0].plugins[0].id,'endpoint-binding');assert.equal(created.endpoints[0].plugins[0].options.keep,'value');
    if (mixed) {
      assert.equal(created.service_references.length,1);
      assert.notEqual(created.service_references[0].id,references![0].id);
      assert.deepEqual({...created.service_references[0],id:references![0].id},references![0]);
      assert.deepEqual(created.load_balancing,{policy:'round_robin'});
      assert.deepEqual(created.failover,{enabled:true,retry_on:[503]});
    }
    if (pending) {
      await expect(target.getByTestId('upstream-endpoint-row')).toHaveCount(1);
      await expect(target.getByTestId('service-reference-row')).toHaveCount(1);
      await expect(target.getByTestId('upstream-endpoint-row').getByRole('spinbutton',{name:'权重',exact:true})).toHaveValue('55');
      await expect(target.getByTestId('service-reference-row').getByRole('spinbutton',{name:'权重',exact:true})).toHaveValue('35');
      await expect(target.getByPlaceholder('服务名称')).toHaveValue('next-service');
      await target.getByTestId('route-upstream-add-button').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio',{name:'SVC 服务',exact:true}).click();
      await dialog.getByTestId('service-reference-picker').getByRole('combobox').click();
      await expect(page.getByRole('option',{name:'converted-service',exact:true})).toBeVisible();
      await page.getByRole('option',{name:'converted-service',exact:true}).click();
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      const committed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
      await page.getByTestId('route-save-button').click();
      await (await committed).finished();
      const saved = state.logical.routes[1];
      assert.equal(saved.endpoints[0].id,initial.id);
      assert.equal(saved.endpoints[0].weight,55);
      assert.deepEqual(saved.service_references,[{...references![0],weight:35}]);
      assert.deepEqual(saved.load_balancing,{policy:'least_requests'});
      assert.deepEqual(saved.failover,{enabled:true,retry_on:[503]});
      assert.equal(state.writes.length,2);
      return;
    }
    await expect(target.getByTestId('service-reference-row')).toHaveCount(1);
    const committed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
    await page.getByTestId('route-save-button').click();await (await committed).finished();await page.waitForLoadState('networkidle');
    await expect.poll(() => state.writes.length).toBe(2);
    assert.equal(state.logical.routes[1].endpoints,undefined);
    assert.equal(state.logical.routes[1].service_references[0].service_id,created.id);
    if (mixed) {
      assert.equal(state.logical.routes[1].load_balancing,undefined);
      assert.equal(state.logical.routes[1].failover,undefined);
    }
  },true);
},60_000);
