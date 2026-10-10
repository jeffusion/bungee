import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, expect, type Browser } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { resolve } from 'node:path';
const fixture = resolve(import.meta.dir, '../fixtures/pricing-settings.html');
let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => { runtime = await startUiRuntime([fixture]);
  try { browser = await chromium.launch(); } catch(error) { await runtime.close(); throw error; }
},120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
test('pricing status remains visible while the provider directory loads and rejects superseded directory responses', async () => {
  for(const empty of [false,true]) {
    const context = await browser.newContext(), page = await context.newPage();
    const errors: string[] = []; page.on('pageerror',error=>errors.push(error.message)); page.on('response', response=>{if(response.status()>=400) errors.push(`${response.status()} ${response.url()}`)});
    let version: number | null = empty ? null : 1, calls = 0;
    const pending: Array<() => void> = [];
    await page.clock.install();
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{
      const path = new URL(route.request().url()).pathname;
      if(path.endsWith('/pricing')) return route.fulfill({json:{state:version === null?'empty':'ready',version,modelCount:version===null?0:100,providerCount:1,fetchedAt:null,error:null}});
      if(path.endsWith('/pricing/mappings')) return route.fulfill({json:{mappings:[{source:'source',provider:'',model:''}]}});
      if(path.endsWith('/catalog/providers')) {
        calls++; const requestedVersion=version;
        if(!empty) await new Promise<void>(resolve=>pending.push(resolve));
        return route.fulfill({json:{providers:requestedVersion===null?[]:[{provider:`provider-${requestedVersion}`,name:`Provider ${requestedVersion}`}]}});
      }
      if(path.endsWith('/models')) return route.fulfill({json:{models:[],total:0,page:1,pageSize:50}});
      errors.push(`Unexpected API: ${path}`); return route.fulfill({json:{},status:500});
    });
    try {
      await page.goto(`${runtime.origin}/@fs${fixture}`);
      await expect(page.getByTestId('pricing-catalog-version')).toHaveText(empty?'No record yet':'1');
      const provider = page.getByRole('combobox', {name:'Pricing provider',exact:true});
      await expect(page.getByTestId('price-mappings-save')).toBeEnabled();
      await expect.poll(()=>calls).toBe(1);
      await page.clock.fastForward(3100); expect(calls).toBe(1);
      version=empty?1:2;
      await page.clock.fastForward(3100);
      await expect(page.getByTestId('pricing-catalog-version')).toHaveText(String(version));
      await expect.poll(()=>calls).toBe(2);
      if(!empty) { pending[1]!(); await expect(provider).toBeEnabled(); pending[0]!(); }
      await expect(provider).toBeEnabled(); await provider.click();
      await expect(page.getByRole('option',{name:new RegExp(`Provider ${version}`)})).toBeVisible();
      if(!empty) await expect(page.getByRole('option',{name:/Provider 1/})).toHaveCount(0);
      expect(errors).toEqual([]);
    } catch(error) { throw new AggregateError([error, ...errors.map(message=>new Error(message))], 'Pricing component browser failed'); } finally { pending.forEach(release=>release()); await context.close(); }
  }
},90_000);
