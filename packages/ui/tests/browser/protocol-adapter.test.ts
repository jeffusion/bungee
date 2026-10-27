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
