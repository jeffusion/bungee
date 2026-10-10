import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, expect, type Browser } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import manifest from '../../manifest.json';

const editorFixture = resolve(import.meta.dir, '../../../../tests/fixtures/ui/editor-components.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>;
let browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime(['index.html', editorFixture]);
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

test('credential creation retains a saved token after publication or permission failure and never automatically repeats an unknown creation', async () => {
  for (const outcome of ['public', 'policy-failed', 'publication-pending', 'unknown'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    const key = { id: 'k', name: 'created-key', prefix: 'bk_fixture', createdAt: Date.now(), expiresAt: null, revokedAt: null };
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
      if (request.method() !== 'GET') writes.push({ path, method: request.method(), body: request.postDataJSON() });
      if (path === '/api/plugins') return json([{ name: 'key-access', enabled: true }]);
      if (path === '/api/config') return json({ revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
        config: { plugin_activations: [], logical_configuration: { routes: [{ id: 'public', path: '/public' }], services: [], plugins: [] } } });
      if (path === '/api/resources/api-key') return json({ keys: [] });
      if (path.endsWith('/control/credentials') && request.method() === 'POST') {
        if (outcome === 'unknown') return json({ error: 'operation_outcome_unknown' }, 503);
        const pending = outcome === 'publication-pending';
        return json({ key, token: 'fixture-one-time-token', persisted: true, ready: !pending, published: !pending }, pending ? 503 : 200);
      }
      if (path.endsWith('/control/keys/k')) return outcome === 'policy-failed' ? json({ error: 'policy_unavailable' }, 503) : json({ ready: true, published: true });
      if (path.endsWith('/control/routes')) return json({ protectedRouteIds: [], routeKeyBindings: {}, ready: true, published: true });
      throw new Error(`Unhandled Key policy fixture request: ${request.method()} ${path}`);
    });
    try {
      await page.goto(`${runtime.origin}/@fs${editorFixture}?scenario=keys`);
      const t = (key: keyof typeof manifest.translations.en) => manifest.translations.en[key];
      await page.getByRole('button', { name: t('ui.createKey'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(t('ui.name'), { exact: true }).fill('created-key');
      await dialog.getByRole('checkbox', { name: /\/public/ }).check();
      await dialog.getByRole('button', { name: t('ui.save'), exact: true }).click();
      if (outcome === 'unknown') {
        await expect(dialog.getByRole('alert')).toContainText('503');
        await expect(dialog.locator('code')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: t('ui.save'), exact: true })).toBeEnabled();
      } else {
        await expect(dialog.locator('code')).toHaveText('fixture-one-time-token');
        await expect(dialog.getByRole('status')).toContainText(outcome === 'public' ? 'public' : outcome === 'policy-failed' ? 'incomplete' : 'publication');
      }
      expect(writes.filter(write => write.method === 'POST')).toHaveLength(1);
      expect(writes.filter(write => write.path.endsWith('/control/routes'))).toEqual([]);
      expect(writes.filter(write => write.path.endsWith('/control/keys/k'))).toEqual(['unknown', 'publication-pending'].includes(outcome)
        ? [] : [{ path: '/api/plugins/key-access/control/keys/k', method: 'PUT', body: { routes: ['public'], models: null } }]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
}, 120_000);

test('editing permissions, granting an existing key and changing route protection make independent writes', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  const writes: Array<{path:string;body:any}> = [], errors: string[] = [];
  const key = {id:'k',name:'existing-key',prefix:'bk_fixture',createdAt:1,expiresAt:null,revokedAt:null};
  let protectedRouteIds = ['public'];
  let routeKeyBindings: Record<string,Array<{id:string;name:string}>> = {};
  const t = (key: keyof typeof manifest.translations.en) => manifest.translations.en[key];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{
    const request=route.request(),path=new URL(request.url()).pathname, method=request.method();
    const json=(value:unknown)=>route.fulfill({json:value});
    if(method !== 'GET') writes.push({path,body:request.postDataJSON()});
    if(path === '/api/plugins') return json([{name:'key-access',enabled:true}]);
    if(path === '/api/config') return json({revision:1,content_hash:`sha256:${'a'.repeat(64)}`,config:{plugin_activations:[],logical_configuration:{routes:[{id:'public',path:'/public'}],services:[],plugins:[]}}});
    if(path === '/api/resources/api-key') return json({keys:[key]});
    if(path.endsWith('/control/keys/k')) return json({value:{routes:['public'],models:null}});
    if(path.endsWith('/control/credentials/k')) return json({key:{...key,...request.postDataJSON()},ready:true,published:true});
    if(path.endsWith('/control/route-key')) routeKeyBindings={public:[{id:'k',name:key.name}]};
    else if(path.endsWith('/control/routes') && method === 'PUT') protectedRouteIds=request.postDataJSON().protectedRouteIds;
    else if(!path.endsWith('/control/routes')) { errors.push(`Unexpected ${method} ${path}`);return route.fulfill({status:500,json:{error:'unexpected_request'}}); }
    return json({protectedRouteIds,routeKeyBindings,ready:true,published:true});
  });
  try {
    await page.goto(`${runtime.origin}/@fs${editorFixture}?scenario=keys`);
    await page.getByRole('button',{name:t('ui.edit'),exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByLabel(t('ui.name'),{exact:true})).toHaveValue('existing-key');
    await dialog.getByLabel(t('ui.name'),{exact:true}).fill('renamed-key');
    await dialog.getByRole('button',{name:t('ui.save'),exact:true}).click();await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([{path:'/api/plugins/key-access/control/credentials/k',body:{name:'renamed-key',expiresAt:null,routes:['public'],models:null}}]);
    await page.getByRole('radio',{name:t('ui.routeAccess'),exact:true}).click();
    const routeRow=page.getByRole('row').filter({hasText:'/public'});
    await routeRow.getByRole('button',{name:t('ui.configureKey'),exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:t('ui.apply'),exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes.at(-1)).toEqual({path:'/api/plugins/key-access/control/route-key',body:{routeId:'public',keyId:'k'}});
    const publicSwitch=routeRow.getByRole('switch');await expect(publicSwitch).not.toBeChecked();await publicSwitch.click();await expect(publicSwitch).toBeChecked();
    expect(writes.at(-1)).toEqual({path:'/api/plugins/key-access/control/routes',body:{protectedRouteIds:[]}});
    expect(writes).toHaveLength(3);expect(errors).toEqual([]);
  } finally { await context.close(); }
},60_000);
