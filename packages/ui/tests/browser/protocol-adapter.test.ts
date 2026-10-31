import {collectApiEvidence} from '../helpers/editors/api-evidence';
import {afterAll,beforeAll,test} from 'bun:test';
import {resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {expect} from 'playwright/test';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';

const fixture=resolve(import.meta.dir,'../fixtures/protocol-adapter.html');
const manifest=await Bun.file(new URL('../../../../plugins/llm-protocol-adapter/manifest.json',import.meta.url)).json();
let runtime:Awaited<ReturnType<typeof startUiRuntime>>;
let browser:Browser;
beforeAll(async()=>{
  runtime=await startUiRuntime({mode:'component-fixture',entries:['index.html',fixture]});
  try {browser=await chromium.launch({headless:true});}
  catch(error){await runtime.close();throw error;}
},120_000);
afterAll(async()=>{try {await browser?.close();}finally{await runtime?.close();}});

const language = 'zh-CN';
test(`adapter independent protocol fields, validation and edit round trip: ${language}`,async()=>{

    const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
    try {
    const page = await context.newPage();
    await page.addInitScript(lang => localStorage.setItem('locale', lang), language);
    const evidence=collectApiEvidence(page),errors=evidence.errors;
    await page.route(`${runtime.origin}/api/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') { errors.push(`Unexpected method ${route.request().method()}`); return route.fulfill({status:500,json:{error:'unexpected_method'}}); }
      if (path === '/api/plugins') return route.fulfill({ json: [{ ...manifest, enabled: true }] });
      if (path === '/api/plugins/schemas') return route.fulfill({ json: { [manifest.name]: { ...manifest,
        configSchema: manifest.configSchema.map((field: any) => ({ ...field, label: `plugins.${manifest.name}.${field.label}`,
          options: field.options.map((option: any) => ({ ...option, label: `plugins.${manifest.name}.${option.label}` })) })) } } });
      if (path === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: runtime.origin } });
      return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
    });
    await page.goto(`${runtime.origin}/@fs${fixture}`);
    const zh = language === 'zh-CN';
    await page.getByRole('button', { name: zh ? '添加插件' : 'Add Plugin', exact: true }).click();
    await page.getByRole('combobox', { name: zh ? '选择插件' : 'Select Plugin' }).click();
    await page.getByRole('option', { name: /LLM/ }).click();
    const dialog = page.getByRole('dialog');
    const save = dialog.getByTestId('plugin-config-save-button');
    const source = dialog.getByRole('combobox', { name: zh ? '源协议' : 'Source protocol', exact: true });
    const target = dialog.getByRole('combobox', { name: zh ? '目标协议' : 'Target protocol', exact: true });
    await expect(source).toBeVisible(); await expect(target).toBeVisible();

    await save.click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await source.click(); await source.press('Home'); await source.press('Enter');
    await expect(source).toContainText('Responses');
    await target.click(); await page.getByRole('option', { name: 'Gemini GenerateContent', exact: true }).click();
    await expect(save).toBeEnabled();

    await save.click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('saved-bindings')).toContainText('"sourceProtocol":"responses","targetProtocol":"gemini_generate_content"');

    await expect(page.getByTestId('protocol-adapter-fixture')).toContainText('Gemini GenerateContent');

    await page.getByRole('button', { name: zh ? '编辑' : 'Edit', exact: true }).click();
    await expect(source).toContainText('Responses'); await expect(target).toContainText('Gemini GenerateContent');
    await source.click(); await page.getByRole('option', { name: 'Gemini GenerateContent', exact: true }).click();
    await target.click(); await page.getByRole('option', { name: 'Responses', exact: true }).click();
    await save.click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(save).toBeDisabled();
    await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();

    expect(errors).toEqual([]);evidence.verify();
    } finally { await context.close(); }
},60_000);

const mappingManifest = await Bun.file(new URL('../../../../plugins/model-mapping/manifest.json', import.meta.url)).json();

test(`model mapping catalog identity, provider conflict and save round trip: ${language}`, async () => {
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
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(JSON.parse((await page.getByTestId('saved-bindings').textContent())!)[0].options.modelMappings).toEqual(initial[0].options.modelMappings);
    await page.getByRole('button', { name: editLabel, exact: true }).click();

    await source.click();
    await expect(sourceProvider).toBeVisible();
    await sourceProvider.click(); await page.getByRole('option', { name: 'alpha', exact: true }).click();
    await expect(source).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option', { name: 'shared-model', exact: true })).toBeVisible();

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

    await save.click();
    await expect(dialog).toHaveCount(0);
    const expected = [{ source: 'ClientAlias', target: 'Provider/GLM-5.3', catalogModel: { provider: 'beta', model: 'shared-model' } }];
    const saved = JSON.parse((await page.getByTestId('saved-bindings').textContent())!);
    expect(saved[0].options.modelMappings).toEqual(expected);

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

    await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    expect(errors).toEqual([]);evidence.verify();
  } finally { await context.close(); }
}, 60_000);
