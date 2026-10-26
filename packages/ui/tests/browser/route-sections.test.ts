import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['rewrite']);

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
