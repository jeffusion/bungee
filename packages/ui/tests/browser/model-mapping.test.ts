import {collectApiEvidence} from '../helpers/editors/api-evidence';
import {afterAll,beforeAll,test} from 'bun:test';
import {resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {expect} from 'playwright/test';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';

const fixture=resolve(import.meta.dir,'../fixtures/protocol-adapter.html');
let runtime:Awaited<ReturnType<typeof startUiRuntime>>;
let browser:Browser;
beforeAll(async()=>{
  runtime=await startUiRuntime({mode:'component-fixture',entries:['index.html',fixture]});
  try {browser=await chromium.launch({headless:true});}
  catch(error){await runtime.close();throw error;}
},120_000);
afterAll(async()=>{try {await browser?.close();}finally{await runtime?.close();}});

const mappingManifest = await Bun.file(new URL('../../../../plugins/model-mapping/manifest.json', import.meta.url)).json();

for (const language of ['zh-CN', 'en']) test(`model mapping catalog identity, provider conflict and save round trip: ${language}`, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 950 } });
  try {
  const page = await context.newPage();
  const evidence=collectApiEvidence(page),errors=evidence.errors;
  const queries: Array<{ provider: string; search: string; page: number }> = [];
    await page.addInitScript(lang => localStorage.setItem('locale', lang), language);
    await page.route(`${runtime.origin}/api/**`, async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') { errors.push(`Unexpected method ${route.request().method()}`); return route.fulfill({status:500,json:{error:'unexpected_method'}}); }
      if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: runtime.origin } });
      if (url.pathname === '/api/plugins') return route.fulfill({ json: [{ ...mappingManifest, enabled: true }] });
      if (url.pathname === '/api/plugins/schemas') return route.fulfill({ json: { 'model-mapping': { ...mappingManifest,
        configSchema: mappingManifest.configSchema.map((field: any) => ({ ...field,
          label: `plugins.model-mapping.${field.label}`, description: `plugins.model-mapping.${field.description}` })) } } });
      if (url.pathname === '/api/plugins/model-mapping/control/catalog') {
        const provider = url.searchParams.get('provider') ?? '', search = url.searchParams.get('search') ?? '';
        const requestedPage = Number(url.searchParams.get('page') ?? 1);
        queries.push({ provider, search, page: requestedPage });
        const all = [
          { value: 'shared-model', provider: 'alpha', label: 'Beta label must not determine provider', description: 'Beta' },
          { value: 'shared-model', provider: 'beta', label: 'Alpha label must not determine provider', description: 'Alpha' },
          { value: 'second-page-model', provider: 'alpha', label: 'Second page' },
        ];
        const matched = all.filter(model => (!provider || model.provider === provider) && (!search || model.value.includes(search)));
        return route.fulfill({ json: { source: 'catalog', providers: ['alpha', 'beta'], models: matched.slice((requestedPage - 1) * 2, requestedPage * 2),
          matchedCount: matched.length, modelCount: all.length, providerCount: 2, fetchedAt: 1, page: requestedPage, pageSize: 2 } });
      }
      errors.push(`unexpected API: ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
    });
    const initial = [{ name: 'model-mapping', options: { modelMappings: [{ source: 'saved-source', target: 'GLM-5.3' }] } }];
    await page.goto(`${runtime.origin}/@fs${fixture}?plugins=${encodeURIComponent(JSON.stringify(initial))}`);
    const zh = language === 'zh-CN';
    const editLabel = zh ? '编辑' : 'Edit';
    const catalogLabel = zh ? '目录模型' : 'Catalog model';
    const catalogProviderLabel = zh ? '目录提供商筛选' : 'Catalog provider filter';
    const sourceLabel = zh ? '请求中的模型名称' : 'Model name in request';
    const sourceProviderLabel = zh ? '源模型提供商筛选' : 'Source provider filter';
    const targetLabel = zh ? '发给上游的模型名称' : 'Model name sent upstream';
    const allProvidersLabel = zh ? '全部提供商' : 'All providers';
    const clearLabel = zh ? '清除' : 'Clear association';
    const associateLabel = zh ? '关联目录模型' : 'Associate catalog model';
    const changeLabel = zh ? '更换' : 'Change';
    await page.getByRole('button', { name: editLabel, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const row = dialog.getByTestId('model-mapping-row').first();
    const source = row.getByRole('combobox', { name: sourceLabel, exact: true });
    const upstream = row.getByRole('textbox', { name: targetLabel, exact: true });
    const catalog = row.getByRole('combobox', { name: catalogLabel, exact: true });
    const catalogProvider = row.getByRole('combobox', { name: catalogProviderLabel, exact: true });
    const sourceProvider = row.getByRole('combobox', { name: sourceProviderLabel, exact: true });
    const save = dialog.getByTestId('plugin-config-save-button');
    await expect(source).toHaveValue('saved-source');
    await expect(upstream).toHaveValue('GLM-5.3');
    await expect(sourceProvider).toHaveCount(0);
    await expect(catalogProvider).toHaveCount(0);
    await expect(row.getByTestId('model-mapping-catalog-picker')).toHaveCount(0);
    const mobileSource = (await source.boundingBox())!, mobileTarget = (await upstream.boundingBox())!;
    expect(mobileTarget.y).toBeGreaterThan(mobileSource.y + mobileSource.height);
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(JSON.parse((await page.getByTestId('saved-bindings').textContent())!)[0].options.modelMappings).toEqual(initial[0].options.modelMappings);
    await page.getByRole('button', { name: editLabel, exact: true }).click();

    await source.click();
    await expect(sourceProvider).toBeVisible();
    await sourceProvider.click(); await page.getByRole('option', { name: 'alpha', exact: true }).click();
    await expect(source).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option', { name: 'shared-model', exact: true })).toBeVisible();
    await dialog.screenshot({ path: `/tmp/model-mapping-source-picker-${language}.png` });
    await page.getByRole('option', { name: 'shared-model', exact: true }).click();
    expect(queries.some(query => query.provider === 'alpha')).toBe(true);
    await source.fill('ClientAlias'); await source.press('Enter');
    await expect(source).toHaveValue('ClientAlias');
    await upstream.fill('Provider/GLM-5.3');

    await row.getByRole('button', { name: associateLabel, exact: true }).click();
    await catalog.click();
    await expect(page.getByRole('option', { name: 'shared-model · alpha', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'shared-model · beta', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'shared-model · beta', exact: true }).click();
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('beta/shared-model');
    await expect(catalog).toHaveCount(0);
    await expect(row.getByRole('button', { name: changeLabel, exact: true })).toBeFocused();
    await expect(upstream).toHaveValue('Provider/GLM-5.3');
    await expect(source).toHaveValue('ClientAlias');
    await row.getByRole('button', { name: changeLabel, exact: true }).click();
    await catalogProvider.click(); await page.getByRole('option', { name: 'alpha', exact: true }).click();
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('beta/shared-model');
    await catalog.click();
    await expect(page.getByRole('option', { name: 'shared-model · alpha', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'shared-model · beta', exact: true })).toBeDisabled();
    await catalog.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(row.getByTestId('model-mapping-catalog-picker')).toBeVisible();
    await row.getByTestId('model-mapping-catalog-picker').getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    await expect(catalogProvider).toHaveCount(0);
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('beta/shared-model');
    await row.getByRole('button', { name: changeLabel, exact: true }).click();
    await catalogProvider.click(); await page.getByRole('option', { name: allProvidersLabel, exact: true }).click();
    await catalog.click();
    await expect(page.getByRole('option', { name: 'shared-model · alpha', exact: true })).toBeVisible();
    await page.getByRole('button', { name: zh ? '加载更多' : 'Load more', exact: true }).click();
    await expect(page.getByRole('option', { name: 'second-page-model · alpha', exact: true })).toBeVisible();
    // A candidate from an earlier loaded page retains its exact provider identity.
    await page.getByRole('option', { name: 'shared-model · alpha', exact: true }).click();
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('alpha/shared-model');
    await row.getByRole('button', { name: changeLabel, exact: true }).click();
    await catalog.click(); await page.getByRole('option', { name: 'shared-model · beta', exact: true }).click();
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('beta/shared-model');
    await page.screenshot({ path: `/tmp/model-mapping-layout-mobile-${language}.png`, fullPage: true });
    await page.setViewportSize({ width: 1100, height: 950 });
    const desktopSource = (await source.locator('..').boundingBox())!, desktopTarget = (await upstream.boundingBox())!;
    expect(Math.abs(desktopSource.y - desktopTarget.y)).toBeLessThan(2);
    expect(desktopTarget.x).toBeGreaterThan(desktopSource.x + desktopSource.width);
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: `/tmp/model-mapping-layout-desktop-${language}.png` });
    await save.click();
    await expect(dialog).toHaveCount(0);
    const expected = [{ source: 'ClientAlias', target: 'Provider/GLM-5.3', catalogModel: { provider: 'beta', model: 'shared-model' } }];
    const saved = JSON.parse((await page.getByTestId('saved-bindings').textContent())!);
    expect(saved[0].options.modelMappings).toEqual(expected);
    await expect(page.getByTestId('plugin-config-summary')).toContainText(`ClientAlias → Provider/GLM-5.3 · ${catalogLabel}: beta/shared-model`);
    await expect(page.getByTestId('plugin-config-summary')).not.toContainText('[object Object]');

    // Reload through the existing saved-binding fixture, then verify editor readback.
    await page.goto(`${runtime.origin}/@fs${fixture}?plugins=${encodeURIComponent(JSON.stringify(saved))}`);
    await expect(page.getByTestId('plugin-config-summary')).toContainText('beta/shared-model');
    await page.getByRole('button', { name: editLabel, exact: true }).click();
    await expect(catalog).toHaveCount(0);
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveText('beta/shared-model');
    await row.getByRole('button', { name: changeLabel, exact: true }).click();
    await expect(catalog).toHaveValue('shared-model · beta');
    await expect(catalogProvider).toHaveValue('beta');
    await expect(source).toHaveValue('ClientAlias');
    await expect(upstream).toHaveValue('Provider/GLM-5.3');
    await row.getByRole('button', { name: clearLabel, exact: true }).click();
    await expect(catalog).toHaveCount(0);
    await expect(row.getByTestId('model-mapping-catalog-identity')).toHaveCount(0);
    await expect(source).toHaveValue('ClientAlias');
    await expect(upstream).toHaveValue('Provider/GLM-5.3');
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(JSON.parse((await page.getByTestId('saved-bindings').textContent())!)[0].options.modelMappings)
      .toEqual([{ source: 'ClientAlias', target: 'Provider/GLM-5.3' }]);
    await expect(page.getByTestId('plugin-config-summary')).not.toContainText('beta/shared-model');
    await page.getByRole('button', { name: editLabel, exact: true }).click();
    await row.getByRole('button', { name: associateLabel, exact: true }).click();
    await expect(catalog).toHaveValue('');
    await expect(upstream).toHaveValue('Provider/GLM-5.3');
    await catalog.press('Escape');
    await expect(catalog).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(row.getByRole('button', { name: associateLabel, exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    expect(errors).toEqual([]);evidence.verify();
  } finally { await context.close(); }
}, 60_000);
