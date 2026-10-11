import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { resolve, extname } from 'node:path';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

browserTest('paginated select', async () => {
const manifest = await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const dist = resolve(import.meta.dir, '../../dist');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(dist + '/')) return new Response(null, { status: 404 });
  return new Response(Bun.file(file), { headers: { 'Content-Type': {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  }[extname(file)] ?? 'application/octet-stream' } });
} });
const browser = await chromium.launch({ headless: true }).catch(async error => { await server.stop(true); throw error; });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1050 } });
const errors: string[] = [], queries: { kind: string; search: string; provider: string; page: number }[] = [];
let holdPage = false, releasePage: (() => void) | undefined, failPage = false, holdSearch = false, releaseSearch: (() => void) | undefined;
let version = 1;
let mappings = [{ source: 'saved-source', provider: 'alpha', model: 'alpha-saved' }];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  const json = (value: unknown) => route.fulfill({ json: value });
  if (path === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (path === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
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
    if (holdSearch && search === 'old-query') { holdSearch = false; await new Promise<void>(resolve => { releaseSearch = resolve; }); }
    if (failPage && requestedPage === 2) { failPage = false; return route.fulfill({ status: 500, json: { error: 'fixture_failure' } }); }
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
  return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
});
try {
  await page.goto(`${server.url}#/plugins/token-stats/pricing`);
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
  await expect(source).toBeFocused(); await expect(source).toHaveValue('');
  await expect(page.getByRole('option', { name: 'source-1-0', exact: true })).toBeVisible();
  // There is only one input for each field, never another search box in the popup.
  await expect(row.getByTestId('client-model-picker').getByRole('combobox')).toHaveCount(1);
  const footer = page.getByTestId('search-select-footer');
  holdPage = true;
  await scrollBottom();
  await expect.poll(() => typeof releasePage).toBe('function');
  await expect(source).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(50);
  await expect(footer).toContainText('加载中');
  await viewport.evaluate(element => { element.dispatchEvent(new Event('scroll')); });
  expect(queries.filter(query => query.kind === 'client' && query.page === 2)).toHaveLength(1);
  releasePage!();
  await expect(page.getByRole('option')).toHaveCount(100);
  await source.press('ArrowUp'); await source.press('Enter');
  await expect(source).toHaveValue('source-2-49'); await expect(source).toBeFocused();
  await expect(viewport).toHaveCount(0);
  await source.click();
  await expect(page.getByRole('option')).toHaveCount(50);
  await source.fill('uncommitted'); await source.press('Escape');
  await expect(source).toHaveValue('source-2-49'); await expect(source).toBeFocused();
  await source.click(); holdSearch = true; await source.fill('old-query');
  await expect.poll(() => typeof releaseSearch).toBe('function');
  await source.fill('new-query'); releaseSearch!();
  await expect(page.getByRole('option', { name: 'new-query', exact: true })).toBeVisible();
  expect(queries.find(query => query.search === 'new-query')?.page).toBe(1);
  await expect(page.getByRole('option', { name: 'old-query', exact: true })).toHaveCount(0);
  await source.fill('custom-alias');
  await page.getByRole('button', { name: '使用自定义标识： custom-alias', exact: true }).click();
  await expect(source).toHaveValue('custom-alias');
  await target.click(); await expect(target).toBeFocused();
  await expect(page.getByRole('option', { name: 'alpha-1-0', exact: true })).toBeVisible();
  failPage = true; await scrollBottom();
  await expect(page.getByRole('alert')).toContainText('价格模型列表加载失败');
  await expect(page.getByRole('option')).toHaveCount(50);
  await target.press('Tab');
  const retry = page.getByRole('button', { name: '重试搜索', exact: true });
  await expect(retry).toBeFocused(); await retry.press('Enter');
  await expect(page.getByRole('option')).toHaveCount(100);
  await expect(target).toBeFocused();
  expect(queries.filter(query => query.kind === 'catalog' && query.page === 2)).toHaveLength(2);
  // Keyboard crosses a batch boundary and moves only after the response arrives.
  await target.press('ArrowUp'); await target.press('ArrowDown');
  await expect(page.getByRole('option')).toHaveCount(101);
  await expect(target).toHaveAttribute('aria-activedescendant', /-100$/);
  await expect(footer).toContainText('已全部加载');
  const countAtEnd = queries.length;
  await scrollBottom(); await target.press('ArrowDown');
  expect(queries.length).toBe(countAtEnd);
  await target.fill('empty');
  await expect(page.getByRole('status').first()).toContainText('没有匹配');
  await expect(page.getByRole('button', { name: /使用自定义标识/ })).toHaveCount(0);
  await target.fill('saved-search');
  await expect(page.getByRole('option', { name: 'saved-search', exact: true })).toBeVisible();
  version = 2;
  await expect(target).toHaveValue('');
  await expect(page.getByRole('option', { name: 'alpha-1-0', exact: true })).toBeVisible();
  await expect(target).toHaveAttribute('placeholder', 'alpha-saved');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    await expect.poll(async () => { const bounds = (await footer.boundingBox())!; return bounds.x >= 0 && bounds.x + bounds.width <= width + 1; }).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: '/tmp/bungee-scroll-select.png', fullPage: true });
  await target.press('ArrowUp'); await target.press('Enter');
  await expect(target).toBeFocused();
  await page.getByTestId('price-mappings-save').click();
  expect(mappings[0]).toEqual({ source: 'custom-alias', provider: 'alpha', model: 'alpha-1-49' });
  // A second mapping must never resolve the first row's input; removing an active
  // search also releases its listeners and prevents a delayed response reopening it.
  await page.getByRole('button', { name: '添加映射', exact: true }).click();
  const second = page.getByTestId('price-model-mapping').last();
  const secondInput = second.getByTestId('client-model-input');
  await expect(page.getByTestId('client-model-input')).toHaveCount(2);
  await secondInput.click(); holdSearch = true; releaseSearch = undefined; await secondInput.fill('old-query');
  await expect.poll(() => typeof releaseSearch).toBe('function');
  await second.getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByTestId('price-model-mapping')).toHaveCount(1); releaseSearch!();
  await expect(source).toHaveValue('custom-alias'); await expect(viewport).toHaveCount(0);
  await page.goto(`${server.url}#/design`);
  const demo = page.getByTestId('design-search-select'); await expect(demo).toBeVisible();
  const demoInput = demo.getByRole('combobox', { name: '搜索选择 / Search selection' });
  await demoInput.focus(); await demoInput.press('ArrowDown');
  await expect(demoInput).toBeFocused();
  await expect(page.getByRole('option', { name: 'item-001', exact: true })).toBeVisible();
  await demoInput.press('Escape'); await expect(demoInput).toHaveValue('item-075'); await expect(demoInput).toBeFocused();
  const local = page.getByRole('combobox', { name: '本地搜索选择 / Local search selection' });
  await local.click(); await local.fill('local b');
  await expect(page.getByRole('option')).toHaveCount(1);
  await local.press('ArrowDown'); await local.press('Enter'); await expect(local).toHaveValue('Local B');
  await local.click(); await local.fill('disabled');
  await expect(page.getByRole('option')).toHaveCount(1);
  await local.press('ArrowDown'); await local.press('Enter');
  await expect(local).not.toHaveAttribute('aria-activedescendant');
  await local.press('Escape'); await expect(local).toHaveValue('Local B');
  await local.click(); await local.fill('Local');
  await local.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(local).toHaveAttribute('aria-expanded', 'true');
  await expect(local).toHaveValue('Local');
  await local.press('Escape');
  const custom = page.getByRole('combobox', { name: '自定义选择 / Custom selection' });
  await custom.click(); await custom.fill('custom-local'); await custom.press('Enter'); await expect(custom).toHaveValue('custom-local');
  await page.getByRole('button', { name: 'Clear selection' }).click(); await expect(custom).toHaveValue('');
  await page.goto(`${server.url}#/`);
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  await expect(page.getByTestId('token-stats-overview')).toHaveAttribute('aria-busy', 'false');
  expect(errors).toEqual([]);
  console.log('Unified searchable BSelect passed: field input, incremental mouse/keyboard loading, retained results and retry, cancellation/stale responses, filter reset, confirmed custom values, local filtering and responsive layout. APIs are fixtures.');
} catch (error) {
  console.log({ queries: queries.slice(-5), active: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250)), footer: await page.getByTestId('search-select-footer').textContent().catch(() => '') });
  await page.screenshot({ path: '/tmp/bungee-scroll-select-failure.png', fullPage: true }); throw error;
} finally { try { await browser.close(); } finally { await server.stop(true); } }
}, 240_000);
