// Built management UI; all business APIs are fixtures, no production configuration writes.
import { chromium, expect } from 'playwright/test';
import { resolve, extname } from 'node:path';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';

const dist = resolve(import.meta.dir, '../dist');
const manifest = await Bun.file(new URL('../../../plugins/codex-router/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const entryId = '10000000-0000-4000-8000-000000000001', serviceId = '20000000-0000-4000-8000-000000000001';
runtime.config.logical_configuration.services = [{ id: serviceId, position: 0, name: 'fixture-service', llm_protocol: 'responses', plugins: [], endpoints: [{ id: '30000000-0000-4000-8000-000000000001', position: 0, url: 'https://fixture.invalid', plugins: [] }] }];
runtime.config.logical_configuration.routes = [{ id: entryId, position: 0, path: '/codex', service_id: serviceId, plugins: [{ id: '40000000-0000-4000-8000-000000000001', position: 0, name: 'codex-router', enabled: true, options: { models: [] } }] }];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(dist + '/')) return new Response(null, { status: 404 });
  return new Response(Bun.file(file), { headers: { 'Content-Type': {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  }[extname(file)] ?? 'application/octet-stream' } });
} });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: 'zh-CN' });
const requests: string[] = [], errors: string[] = [];
const catalogQueries: URLSearchParams[] = [];
let holdNextPage = false, releasePage: (() => void) | undefined;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(new URL(request.url()).pathname));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = (value: unknown) => route.fulfill({ json: value });
  if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
  if (url.pathname === '/api/config/runtime') return json(runtime);
  if (url.pathname === '/api/config') return json({ revision: runtime.revision, content_hash: runtime.content_hash, config: runtime.config });
  if (url.pathname === '/api/plugins/schemas') return json({ 'codex-router': { ...manifest, metadata: manifest.metadata } });
  if (url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled: true,
    version: manifest.version, metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
  if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(
    Object.entries(manifest.translations).map(([language, messages]) => [language, { plugins: { [manifest.name]: messages } }])));
  if (url.pathname === '/api/plugins/codex-router/control/catalog') {
    catalogQueries.push(url.searchParams);
    const search = url.searchParams.get('search') ?? '';
    const page = Number(url.searchParams.get('page') ?? 1);
    if (holdNextPage && page === 2) {
      holdNextPage = false;
      await new Promise<void>(resolve => { releasePage = resolve; });
    }
    return json({ models: [{ provider: 'fixture', providerName: 'Fixture', model: search || `org/model-${page}`, name: 'Fixture Model' }],
      total: search ? 1 : 51, page: search ? 1 : page, pageSize: 50,
      providers: [{ provider: 'fixture', name: 'Fixture', modelCount: 51 }], status: { version: 1, modelCount: 51 } });
  }
  return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
});
try {
  await page.goto(`${server.url}#/plugins/codex-router`);
  const settings = page.getByTestId('codex-router-settings');
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/#\/plugins\/codex-router\/catalog$/);
  await expect(settings).toContainText('org/model-1');
  await expect(settings.getByRole('link', { name: '打开路由管理' })).toHaveAttribute('href', '#/routes');
  await expect(settings.getByRole('link', { name: '管理 models.dev 目录' })).toHaveAttribute('href', '#/plugins/models-dev/catalog/status');
  await settings.getByRole('button', { name: '下一页' }).click();
  await expect(settings).toContainText('org/model-2');
  await settings.getByRole('textbox', { name: '搜索模型' }).fill('org/searched');
  await expect(settings).toContainText('org/searched');
  await expect(settings.getByRole('button', { name: '下一页' })).toBeDisabled();
  // An old page response arriving during the search debounce cannot reset the new search to page 2.
  await settings.getByRole('textbox', { name: '搜索模型' }).fill('');
  await expect(settings).toContainText('org/model-1');
  holdNextPage = true;
  await settings.getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => typeof releasePage).toBe('function');
  await settings.getByRole('textbox', { name: '搜索模型' }).fill('org/raced');
  releasePage!();
  await expect(settings).toContainText('org/raced');
  expect(catalogQueries.find(query => query.get('search') === 'org/raced')?.get('page')).toBe('1');
  await expect(settings.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(requests.filter(path => path.endsWith('/sandbox') || path === '/plugins/codex-router/index.html')).toEqual([]);
  expect(requests).not.toContain('/api/config');
  await page.goto(`${server.url}#/routes/edit/%2Fcodex`);
  await page.locator('aside button[data-testid$="-plugins"]').click();
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加模型绑定', exact: true }).click();
  const row = dialog.getByTestId('codex-model-binding');
  await row.getByRole('textbox', { name: '原始模型', exact: true }).fill('gpt-original');
  await row.getByRole('combobox', { name: '目标提供商', exact: true }).click();
  await page.getByRole('option', { name: 'Fixture · fixture', exact: true }).click();
  await row.getByRole('button', { name: '目标模型', exact: true }).click();
  await page.getByRole('option', { name: 'org/model-1', exact: true }).click();
  await row.getByRole('combobox', { name: '转发路由 / 服务', exact: true }).click();
  await page.getByRole('option', { name: 'fixture-service · service · responses', exact: true }).click();
  await row.getByText('能力限制（可选）', { exact: true }).click();
  await row.getByRole('spinbutton', { name: '上下文长度上限', exact: true }).fill('16000');
  await row.getByRole('button', { name: '增加上下文上限', exact: true }).click();
  await expect(row.getByRole('spinbutton', { name: '上下文长度上限', exact: true })).toHaveValue('16001');
  await row.getByRole('checkbox', { name: '禁用图片输入', exact: true }).check();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(row.getByRole('textbox', { name: '原始模型', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/codex-router-bindings-redesign.png', fullPage: true });
  await dialog.getByTestId('plugin-config-save-button').click();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '原始模型', exact: true })).toHaveValue('gpt-original');
  await expect(dialog.getByRole('button', { name: '目标模型', exact: true })).toContainText('org/model-1');
  await expect(dialog.getByRole('combobox', { name: '转发路由 / 服务', exact: true })).toContainText('fixture-service');
  await dialog.getByText('能力限制（可选）', { exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: '上下文长度上限', exact: true })).toHaveValue('16001');
  await expect(dialog.getByRole('checkbox', { name: '禁用图片输入', exact: true })).toBeChecked();
  expect(errors).toEqual([]);
  console.log('Codex Router UI passed: native settings; search/pagination race; separate source/provider/model/route-service binding retained in actual plugin editor; Token Stats picker; no overflow at 1440/768/390/320px. All APIs are fixtures.');
} finally {
  await browser.close();
  server.stop(true);
}
