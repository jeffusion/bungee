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
    endpoints: [endpoint('service-endpoint', 'https://example.test')], plugins: [] }],
  routes: [
    { id: 'route-service', position: 0, path: '/fixture-service/', service_id: 'service-fixture', plugins: [] },
    { id: 'route-custom', position: 1, path: '/fixture-custom/', endpoints: [endpoint('custom-endpoint', 'https://example.test')], plugins: [] },
  ],
};


const pluginSchemas=Object.fromEntries(['alpha','beta'].map(name=>[name,{name,version:'1.0.0',runtimeScope:'scoped',metadata:{name},configSchema:[]}]));
async function withEditor(run:(page:Page)=>Promise<void>,plugins=false){
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:900},locale:'zh-CN'});
try{const page=await context.newPage();page.setDefaultTimeout(4000);const evidence=collectApiEvidence(page),errors=evidence.errors;const origin=runtime.origin;
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{const request=route.request(),url=new URL(request.url()),method=request.method();
        const key = `${method} ${url.pathname}`;

        let body;
        if (key === 'GET /api/auth/mode') body = { mode: 'anonymous', publicOrigin: origin };
        else if (key === 'GET /api/auth/verify') body = { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } };
        else if (key === 'GET /api/ui/menus') body = menuSnapshot();
        else if (key === 'GET /api/ui/icons/data') return fulfillMenuIcons(route);
        else if (key === 'GET /api/plugins') body = plugins?Object.values(pluginSchemas).map(plugin=>({...plugin,enabled:true})):[];
        else if(key === 'GET /api/plugins/schemas' && plugins && url.searchParams.get('enabledOnly')==='true' && ['route','service'].includes(url.searchParams.get('scope')??'')) body=pluginSchemas;
        else if (key === 'GET /api/plugin-translations') body = {};
        else if (key === 'GET /api/config') body = { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: logical, plugin_activations: [] } };
        else if (key === 'GET /api/config/runtime') body = { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: logical, plugin_activations: [] }, workers: [],
          publication: { operation: null, recovery: null, retryable: false,
            serving_complete: false, serving_revision: null, target_revision: 1 } };
        else if (key === 'GET /api/runtime/upstreams') body = { workers: [], services: {}, availability: 'unknown', upstreams: [] };
        else if (key === 'POST /api/config/validate') body = { valid: true, errors: [] };
        else {
          errors.push(`Unexpected API ${key}`);

          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unhandled_test_api' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

});
await run(page);evidence.verify();
}finally{await context.close();}
}

const navigationStyle = async (page:Page, testId:string) => page.locator(`button[data-testid="${testId}"]`).evaluate((button:HTMLElement) => {
  const style = getComputedStyle(button);
  const keyStyle = getComputedStyle(button.closest('aside')!.querySelector('kbd')!);
  return {
    display: style.display, fullWidth: button.offsetWidth === button.parentElement!.clientWidth,
    alignItems: style.alignItems,
    keyDisplay: keyStyle.display, keyHeight: keyStyle.height, keyBorder: keyStyle.borderTopWidth,
  };
});

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
        assert.ok((await targetPanel.innerText()).includes('https://example.test'));
        assert.match((await targetPanel.locator('[data-testid="mode-service"]').getAttribute('class'))!, /bg-nexus-500/);
      } else {
        assert.match((await targetPanel.locator('[data-testid="mode-custom"]').getAttribute('class'))!, /bg-nexus-500/);
        if (name === 'edit-custom') assert.ok((await targetPanel.innerText()).includes('https://example.test'));
      }

      if (name === 'new-custom') {
        const modeService = targetPanel.locator('[data-testid="mode-service"]');
        const modeCustom = targetPanel.locator('[data-testid="mode-custom"]');
        const confirmation = page.locator('[role="dialog"]');
        await modeService.click({ timeout: 4000 });
        await confirmation.waitFor({ state: 'visible', timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/);
        await modeService.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });
        await expect(confirmation).toHaveCount(0);
        await expect(modeService).toHaveClass(/bg-nexus-500/);
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/, 'manual service selection without route.service must persist');
        await targetPanel.getByRole('button', { name: /fixture-service/ }).click({ timeout: 4000 });
        assert.ok((await targetPanel.innerText()).includes('https://example.test'));
        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/);
        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/);
        await modeService.click({ timeout: 4000 });
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/);
        await page.getByRole('button', { name: /使用模板/ }).click({ timeout: 4000 });
        await page.getByRole('button', { name: /Simple Proxy/ }).click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/, 'replacing route object must derive the new mode');
        assert.ok((await targetPanel.innerText()).includes('https://api.example.com'));
      }


await page.screenshot({path:`/tmp/bungee-route-target-${name}.png`});
await expect(page.getByTestId('configuration-publication-banner')).toHaveCount(0);
});
},240_000);

test('built editor CSS survives cold entry in either editor and a route-service-route round trip without leaking to unrelated controls',async()=>{
for(const first of ['route','service']) await withEditor(async page=>{
const routePath='/routes/edit/%2Ffixture-service%2F';
await page.goto(`${runtime.origin}/#${first==='route'?routePath:'/services/edit/fixture-service'}`);
if(first==='service') {
await expect(page.getByTestId('service-nav-identity').first()).toBeVisible();
await expect.poll(()=>navigationStyle(page,'service-nav-identity')).toEqual({display:'inline-flex',fullWidth:true,alignItems:'center',keyDisplay:'flex',keyHeight:'18px',keyBorder:'1px'});
await expect(page.getByTestId('service-name-input')).toHaveValue('fixture-service');
await page.screenshot({path:'/tmp/bungee-service-cold-entry.png'});
await page.evaluate(path=>location.hash=path,routePath);
}
await expect(page.getByTestId('route-nav-match').first()).toBeVisible();
await expect.poll(()=>navigationStyle(page,'route-nav-match')).toMatchObject({display:'inline-flex',fullWidth:true,alignItems:'center',keyDisplay:'flex',keyBorder:'1px'});
const cold=await navigationStyle(page,'route-nav-match');
await page.keyboard.press('ControlOrMeta+8');await expect(page.getByTestId('section-review')).toBeVisible();
await page.keyboard.press('ControlOrMeta+1');await expect(page.getByTestId('section-match')).toBeVisible();
await page.evaluate(()=>location.hash='/services/edit/fixture-service');
await expect(page.getByTestId('service-nav-identity').first()).toBeVisible();
await page.keyboard.press('ControlOrMeta+7');await expect(page.getByTestId('service-review-summary')).toBeVisible();
await page.evaluate(path=>location.hash=path,routePath);
await expect(page.getByTestId('route-nav-match').first()).toBeVisible();
await expect.poll(()=>navigationStyle(page,'route-nav-match')).toEqual(cold);
if(first==='route') {
const isolated=await page.evaluate(()=>{
const host=document.createElement('div');host.innerHTML='<button class="nav-button is-active">Unrelated</button><kbd>Key</kbd>';document.body.append(host);
try{return {display:getComputedStyle(host.querySelector('button')!).display,keyBorder:getComputedStyle(host.querySelector('kbd')!).borderTopWidth};}finally{host.remove();}
});
expect(isolated).toEqual({display:'inline-block',keyBorder:'0px'});
await page.evaluate(()=>location.hash='/design');await expect(page.getByTestId('design-form-text-roles')).toBeVisible();
await page.screenshot({path:'/tmp/bungee-design-after-editors.png'});
}
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
