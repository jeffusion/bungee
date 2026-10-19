import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['route', 'rewrite', 'failover']);

test('WebSocket switch reflects toggles, loaded routes and a fresh draft', async () => {
  for (const enabled of [false, true]) await withPage(`scenario=route${enabled ? '&edit' : ''}`, async page => {
    const setting = page.getByTestId('route-websocket-setting').getByRole('switch');
    await expect(setting).toHaveAttribute('aria-checked', String(enabled));
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', String(!enabled));
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', String(enabled));
  }, {hash:`#/routes/${enabled ? 'edit/%2Floaded' : 'new'}?section=forward`, beforeMount:async page=>{
    await page.route('**/api/config', route => route.request().method()==='GET'?route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
      config: { plugin_activations: [], logical_configuration: { routes: enabled ? [{ id: '20000000-0000-4000-8000-000000000081', position: 0, path: '/loaded', endpoints: [], plugins: [], websocket: { enabled: true } }] : [], services: [], plugins: [] } } } }):route.fallback());
  }});
}, 60_000);


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
