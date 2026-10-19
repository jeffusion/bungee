import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, expect, type Browser } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import {collectApiEvidence} from '../../../../packages/ui/tests/helpers/editors/api-evidence';
import { recordResponseDelivery, holdResponseJson, waitForResponseReceipt, releaseResponseJson, waitForResponseDelivery } from '../../../../packages/ui/tests/helpers/editors/response-delivery';
import { resolve } from 'node:path';
const fixture = resolve(import.meta.dir, '../fixtures/pricing-settings.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => { runtime = await startUiRuntime({ mode: 'component-fixture', entries: [fixture] });
  try { browser = await chromium.launch(); } catch(error) { await runtime.close(); throw error; }
},120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
test('pricing status remains visible while the provider directory loads and rejects superseded directory responses', async () => {
  for(const empty of [false,true]) {
    const context = await browser.newContext();
    try {
    const page = await context.newPage();
    const evidence=collectApiEvidence(page),errors=evidence.errors;
    let version: number | null = empty ? null : 1, calls = 0, statusCalls=0;
    await page.clock.install();
    await recordResponseDelivery(page, '/api/plugins/models-dev/control/catalog/providers',empty?[]:[{name:'provider-1',match:{method:'GET',path:'/api/plugins/models-dev/control/catalog/providers'}}]);
    await recordResponseDelivery(page,'/api/plugins/token-stats/control/pricing');
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') { errors.push(`Unexpected method ${route.request().method()} ${path}`); return route.fulfill({status:500,json:{error:'unexpected_method'}}); }
      if(path === '/api/plugins/token-stats/control/pricing') { statusCalls++; return route.fulfill({json:{state:version === null?'empty':'ready',version,modelCount:version===null?0:100,providerCount:1,fetchedAt:null,error:null}}); }
      if(path === '/api/plugins/token-stats/control/pricing/mappings') return route.fulfill({json:{mappings:[{source:'source',provider:'',model:''}]}});
      if(path === '/api/plugins/models-dev/control/catalog/providers') {
        calls++; const requestedVersion=version;
        return route.fulfill({json:{providers:requestedVersion===null?[]:[{provider:`provider-${requestedVersion}`,name:`Provider ${requestedVersion}`}]}});
      }
      if((path === '/api/plugins/token-stats/control/models' || path === '/api/plugins/token-stats/control/pricing/models')) return route.fulfill({json:{models:[],total:0,page:1,pageSize:50}});
      errors.push(`Unexpected API: ${path}`); return route.fulfill({json:{},status:500});
    });
      await page.goto(`${runtime.origin}/@fs${fixture}`);
      await page.waitForFunction(()=>typeof (window as unknown as {mountPricing?:()=>void}).mountPricing==='function');
      await page.clock.pauseAt(await page.evaluate(()=>Date.now()+60_000));
      await page.evaluate(()=>(window as unknown as {mountPricing:()=>void}).mountPricing());
      await expect(page.getByTestId('pricing-catalog-version')).toHaveText(empty?'No record yet':'1');
      const provider = page.getByRole('combobox', {name:'Pricing provider',exact:true});
      await expect(page.getByTestId('price-mappings-save')).toBeEnabled();
      await expect.poll(()=>calls).toBe(1);
      const oldProviderResponse=empty?undefined:await waitForResponseReceipt(page,'provider-1');
      await holdResponseJson(page,'first-pricing-poll',{method:'GET',path:'/api/plugins/token-stats/control/pricing'});
      await page.clock.runFor(2999); expect(calls).toBe(1);expect(statusCalls).toBe(1);
      await page.clock.runFor(1);
      const firstPollResponse=await waitForResponseReceipt(page,'first-pricing-poll');
      await releaseResponseJson(page,firstPollResponse);await waitForResponseDelivery(page,firstPollResponse);
      expect(calls).toBe(1);expect(statusCalls).toBe(2);
      version=empty?1:2;
      await page.clock.runFor(2999);
      await expect(page.getByTestId('pricing-catalog-version')).toHaveText(empty?'No record yet':'1');expect(statusCalls).toBe(2);
      await page.clock.runFor(1);
      await expect(page.getByTestId('pricing-catalog-version')).toHaveText(String(version));
      await expect.poll(()=>calls).toBe(2);expect(statusCalls).toBe(3);
      if(!empty) {
        await expect(provider).toBeEnabled(); await provider.click();
        await expect(page.getByRole('option',{name:/Provider 2/})).toBeVisible();
        await provider.press('Escape');
        await releaseResponseJson(page,oldProviderResponse!);
        await waitForResponseDelivery(page,oldProviderResponse!);
      }
      await expect(provider).toBeEnabled(); await provider.click();
      await expect(page.getByRole('option',{name:new RegExp(`Provider ${version}`)})).toBeVisible();
      if(!empty) await expect(page.getByRole('option',{name:/Provider 1/})).toHaveCount(0);
      expect(errors).toEqual([]);evidence.verify();
    } finally { await context.close(); }
  }
},90_000);
