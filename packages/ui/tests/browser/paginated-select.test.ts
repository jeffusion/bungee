import {collectApiEvidence} from '../helpers/editors/api-evidence';
import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { recordResponseDelivery, holdResponseJson, waitForResponseReceipt, releaseResponseJson, waitForResponseDelivery } from '../helpers/editors/response-delivery';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';


browserTest('paginated select', async () => {
const manifest = await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const uiRuntime=await startUiRuntime({mode:'built-page'});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
browser=await chromium.launch({headless:true});
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1050 } });
await recordResponseDelivery(page, '/api/plugins/token-stats/control/models');
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
const evidence=collectApiEvidence(page),errors=evidence.errors;
const queries: { kind: string; search: string; provider: string; page: number }[] = [];
let holdPage = false, releasePage: (() => void) | undefined, failPage = false;
let version = 1;
let mappings = [{ source: 'saved-source', provider: 'alpha', model: 'alpha-saved' }];
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  const method = route.request().method();
  if (method !== 'GET' && !(method === 'PUT' && path === '/api/plugins/token-stats/control/pricing/mappings')) { errors.push(`Unexpected ${method} ${path}`); return route.fulfill({status: 500, json: {error: 'unexpected_method'}}); }
  const json = (value: unknown) => route.fulfill({ json: value });
  if (path === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (path === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
  if (path === '/api/ui/menus') return json(menuSnapshot());
  if (path === '/api/ui/icons/data') return fulfillMenuIcons(route);
  if (path === '/api/config/runtime') return json(runtime);
  if (path === '/api/config') return json({ revision: runtime.revision, content_hash: runtime.content_hash, config: runtime.config });
  if (path === '/api/plugins/schemas') return json({ 'token-stats': { ...manifest, metadata: manifest.metadata } });
  if (path === '/api/plugins') return json([{ name: manifest.name, enabled: true, version: manifest.version, metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
  if (path === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
    .map(([language, messages]) => [language, { plugins: { [manifest.name]: messages } }])));
  if (path === '/api/plugins/token-stats/control/pricing') return json({ state: 'ready', version, modelCount: 202, providerCount: 2, fetchedAt: 1, error: null });
  if (path === '/api/plugins/models-dev/control/catalog/providers') return json({ providers: [
    { provider: 'alpha', name: 'Alpha', modelCount: 101 }, { provider: 'beta', name: 'Beta', modelCount: 101 }], version });
  if (path === '/api/plugins/token-stats/control/pricing/mappings') {
    if (route.request().method() === 'PUT') mappings = route.request().postDataJSON();
    return json({ mappings });
  }
  if (path === '/api/plugins/token-stats/control/models' || path === '/api/plugins/token-stats/control/pricing/models') {
    const kind = path.endsWith('/pricing/models') ? 'catalog' : 'client';
    const search = url.searchParams.get('search') ?? '', provider = url.searchParams.get('provider') ?? '';
    const requestedPage = Number(url.searchParams.get('page') ?? 1);
    queries.push({ kind, search, provider, page: requestedPage });
    if (holdPage && requestedPage === 2) { holdPage = false; await new Promise<void>(resolve => { releasePage = resolve; }); }
    if (failPage && requestedPage === 2) { failPage = false; evidence.expectStatus(route,500); return route.fulfill({ status: 500, json: { error: 'fixture_failure' } }); }
    const values = search === 'empty' || search === 'custom-alias' ? [] : search ? [search]
      : Array.from({ length: requestedPage === 3 ? 1 : 50 }, (_, index) => `${kind === 'client' ? 'source' : provider}-${requestedPage}-${index}`);
    const models = kind === 'client' ? values : values.map(model => ({ provider, model, name: model }));
    return json({ models, total: search ? values.length : 101, page: requestedPage, pageSize: 50 });
  }
  // Dashboard smoke uses the same empty fixtures as dashboard-loading.browser.ts.
  if (path === '/api/resources/api-key') return json({ keys: [] });
  if (path === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
    availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
  if (path === '/api/stats/dashboard') return json({ range: url.searchParams.get('range'), startTime: Date.now() - 3_600_000,
    endTime: Date.now(), units: { history: 'request_chain', upstreams: 'upstream_attempt' },
    history: { timestamps: [], requests: [], errors: [], responseTime: [], requestCounts: { success: [], failed: [] } },
    upstreams: [], requestCounts: { success: 0, failed: 0 } });
  if (path === '/api/plugins/token-stats/control/stats') return json({ groupBy: 'time', asOfMs: Date.now(), bucketMs: 300_000,
    data: [], logicalRequests: 0, upstreamAttempts: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0,
    authorityBreakdown: { input: {}, output: {} } });
  errors.push(`Unexpected API ${method} ${path}`);
  return route.fulfill({ status: 500, json: { error: 'unexpected_fixture_request' } });
});
try {
  await page.goto(`${uiRuntime.origin}/#/plugins/token-stats/pricing`);
  const settings = page.getByTestId('token-stats-settings');
  await expect(settings).toBeVisible();
  const row = page.getByTestId('price-model-mapping').first();
  const source = row.getByTestId('client-model-picker').getByRole('combobox', { name: '客户端模型别名', exact: true });
  const target = row.getByTestId('price-model-picker').getByRole('combobox', { name: '价格表模型', exact: true });
  const viewport = page.getByTestId('search-select-viewport');
  const scrollBottom = async () => viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(source).toHaveValue('saved-source');
  expect(queries).toHaveLength(0);
  await source.click();
   await expect(source).toHaveValue('');
  await expect(page.getByRole('option', { name: 'source-1-0', exact: true })).toBeVisible();
  // There is only one input for each field, never another search box in the popup.
  await expect(row.getByTestId('client-model-picker').getByRole('combobox')).toHaveCount(1);
  holdPage = true;
  await scrollBottom();
  await expect.poll(() => typeof releasePage).toBe('function');

  await expect(page.getByRole('option')).toHaveCount(50);

  await viewport.evaluate(element => { element.dispatchEvent(new Event('scroll')); });
  expect(queries.filter(query => query.kind === 'client' && query.page === 2)).toHaveLength(1);
  releasePage!();
  await expect(page.getByRole('option')).toHaveCount(100);
  await source.press('ArrowUp');
  await expect(page.getByRole('option')).toHaveCount(101);
  await source.press('Enter');
  await expect(source).toHaveValue('source-2-49');
  await expect(viewport).toHaveCount(0);
  await holdResponseJson(page,'reopen-source',{method:'GET',path:'/api/plugins/token-stats/control/models',query:{search:'',page:'1'}});
  await source.click();
  const reopenedResponse=await waitForResponseReceipt(page,'reopen-source');
  await releaseResponseJson(page,reopenedResponse);await waitForResponseDelivery(page,reopenedResponse);
  await expect(page.getByRole('option')).toHaveCount(50);
  await source.fill('uncommitted'); await source.press('Escape');
  await expect(source).toHaveValue('source-2-49');
  await holdResponseJson(page,'before-old-search',{method:'GET',path:'/api/plugins/token-stats/control/models',query:{search:'',page:'1'}});
  await source.click();
  const searchOpeningResponse=await waitForResponseReceipt(page,'before-old-search');
  await releaseResponseJson(page,searchOpeningResponse);await waitForResponseDelivery(page,searchOpeningResponse);
  await holdResponseJson(page,'old-search',{method:'GET',path:'/api/plugins/token-stats/control/models',query:{search:'old-query',page:'1'}});
  await source.fill('old-query');
  const oldSearchResponse=await waitForResponseReceipt(page,'old-search');
  await source.fill('new-query');
  await expect(page.getByRole('option', { name: 'new-query', exact: true })).toBeVisible();
  await releaseResponseJson(page,oldSearchResponse);
  await waitForResponseDelivery(page,oldSearchResponse);
  await expect(page.getByRole('option', { name: 'new-query', exact: true })).toBeVisible();
  expect(queries.find(query => query.search === 'new-query')?.page).toBe(1);
  await expect(page.getByRole('option', { name: 'old-query', exact: true })).toHaveCount(0);
  await source.fill('custom-alias');
  await page.getByRole('button', { name: '使用自定义标识： custom-alias', exact: true }).click();
  await expect(source).toHaveValue('custom-alias');
  await target.click();
  await expect(page.getByRole('option', { name: 'alpha-1-0', exact: true })).toBeVisible();
  failPage = true; await scrollBottom();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(50);
  await target.press('Tab');
  const retry = page.getByRole('button', { name: '重试搜索', exact: true });
   await retry.press('Enter');
  await expect(page.getByRole('option')).toHaveCount(100);

  expect(queries.filter(query => query.kind === 'catalog' && query.page === 2)).toHaveLength(2);
  // Keyboard crosses a batch boundary and moves only after the response arrives.
  await target.press('ArrowUp'); await target.press('ArrowDown');
  await expect(page.getByRole('option')).toHaveCount(101);
  await expect(target).toHaveAttribute('aria-activedescendant', /-100$/);

  const countAtEnd = queries.length;
  await scrollBottom(); await target.press('ArrowDown');
  expect(queries.length).toBe(countAtEnd);
  await target.fill('empty');
  await expect(page.getByRole('status').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /使用自定义标识/ })).toHaveCount(0);
  await target.fill('saved-search');
  await expect(page.getByRole('option', { name: 'saved-search', exact: true })).toBeVisible();
  version = 2;
  await expect(target).toHaveValue('');
  await expect(page.getByRole('option', { name: 'alpha-1-0', exact: true })).toBeVisible();

  await target.press('ArrowUp'); await target.press('Enter');

  await page.getByTestId('price-mappings-save').click();
  await expect.poll(()=>mappings[0]).toEqual({ source: 'custom-alias', provider: 'alpha', model: 'alpha-1-49' });
  // A second mapping must never resolve the first row's input; removing an active
  // search also releases its listeners and prevents a delayed response reopening it.
  await page.getByRole('button', { name: '添加映射', exact: true }).click();
  const second = page.getByTestId('price-model-mapping').last();
  const secondInput = second.getByTestId('client-model-input');
  await expect(page.getByTestId('client-model-input')).toHaveCount(2);
  await secondInput.click();
  await expect(page.getByRole('option',{name:'source-1-0',exact:true})).toBeVisible();
  await holdResponseJson(page,'removed-row-search',{method:'GET',path:'/api/plugins/token-stats/control/models',query:{search:'old-query',page:'1'}});
  await secondInput.fill('old-query');
  const removedRowResponse=await waitForResponseReceipt(page,'removed-row-search');
  expect(removedRowResponse).not.toBe(oldSearchResponse);
  await second.getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByTestId('price-model-mapping')).toHaveCount(1);
  await releaseResponseJson(page,removedRowResponse);
  await waitForResponseDelivery(page,removedRowResponse);
  await expect(source).toHaveValue('custom-alias'); await expect(viewport).toHaveCount(0);
  expect(errors).toEqual([]);evidence.verify();

} catch (error) {
  console.log({ queries: queries.slice(-5), active: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250)), footer: await page.getByTestId('search-select-footer').textContent().catch(() => '') });
   throw error;
} finally { releasePage?.(); }
} finally { try { await browser?.close(); } finally { await uiRuntime.close(); } }
}, 240_000);
