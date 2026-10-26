import { systemUpdateStatusFixture } from '../helpers/system-updates';
import { serviceReference } from '../helpers/service-references';
import { test as browserTest } from 'bun:test';
import { expect, type Route } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
const uiRuntime = dashboardRuntime();
import { createMasterPluginCatalogApi } from '../../../core/src/master-runtime/master-plugin-catalog-api';
import type { PluginManifestRecord } from '../../../core/src/plugin-manifest-catalog/types';
import { observeNetwork } from '../helpers/dashboard/network';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';

browserTest('codex router settings', () => uiRuntime.run(async page => {
const manifest = await Bun.file(new URL('../../../../plugins/codex-router/manifest.json', import.meta.url)).json();
const catalogApi = createMasterPluginCatalogApi({ catalog: { records: () => [{ name: manifest.name, manifest, configSchema: manifest.configSchema } as PluginManifestRecord] } });
const catalogSnapshot = { aggregate: { plugin_activations: [{ plugin_name: manifest.name }] } } as never;
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const entryId = '10000000-0000-4000-8000-000000000001', serviceId = '20000000-0000-4000-8000-000000000001';
runtime.config.logical_configuration.services = [{ id: serviceId, position: 0, name: 'fixture-service', plugins: [], endpoints: [{ id: '30000000-0000-4000-8000-000000000001', position: 0, target: 'https://fixture.invalid', weight: 100, priority: 1, is_disabled: false, plugins: [] }] }];
runtime.config.logical_configuration.routes = [{ id: entryId, position: 0, path: '/codex', service_references: [serviceReference(serviceId)], plugins: [{ id: '40000000-0000-4000-8000-000000000001', position: 0, name: 'codex-router', enabled: true, options: { models: [] } }] }];
const requests: string[] = [], errors: string[] = [];
const catalogQueries: URLSearchParams[] = [];
let holdSourceCatalog: ((route: Route) => void) | undefined;
page.on('pageerror', error => errors.push(error.message));
const network = observeNetwork(page, errors);
page.on('request', request => requests.push(new URL(request.url()).pathname));
await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET') throw new Error(`Unexpected method: ${route.request().method()} ${url.pathname}`);
  const json = (value: unknown) => route.fulfill({ json: value });
  if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
  if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
  if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
  if (url.pathname === '/api/ui/menus') return json(menuSnapshot());
  if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
  if (url.pathname === '/api/config/runtime') return json(runtime);
  if (url.pathname === '/api/config') return json({ revision: runtime.revision, content_hash: runtime.content_hash, config: runtime.config });
  if (catalogApi.matches(url.pathname)) {
    const response = await catalogApi.handle(new Request(url), catalogSnapshot);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  }
  if (url.pathname === '/api/plugins/codex-router/control/catalog') {
    catalogQueries.push(url.searchParams);
    if (holdSourceCatalog && url.searchParams.get('provider') === 'openai') {
      const capture = holdSourceCatalog; holdSourceCatalog = undefined; capture(route); return;
    }
    const search = url.searchParams.get('search') ?? '';
    const provider = url.searchParams.get('provider') ?? 'fixture';
    const page = Number(url.searchParams.get('page') ?? 1);
    const model = search || (provider === 'openai' ? `gpt-original-${page}` : `org/model-${page}`);
    const length = search || page === 2 ? 1 : 50;
    return json({ models: Array.from({ length }, (_, index) => ({ provider, providerName: provider,
      model: index === 0 ? model : `${model}-${index}`, name: 'Fixture Model' })),
      total: search ? 1 : 51, page: search ? 1 : page, pageSize: 50,
      providers: [{ provider: 'fixture', name: 'Fixture', modelCount: 51 }, { provider: 'openai', name: 'OpenAI', modelCount: 51 }], status: { version: 1, modelCount: 102 } });
  }
  return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
});
try {
  expect(manifest.contributes.settings).toBeUndefined();
  expect(manifest.contributes.nativeSettingsComponent).toBeUndefined();
  expect(manifest.uiExtensionMode).toBe('none');
  await page.goto(`${uiRuntime.origin}/#/routes/edit/%2Fcodex`);
  await page.locator('aside button[data-testid$="-plugins"]').click();
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加模型替换', exact: true }).click();
  const row = dialog.getByTestId('codex-model-binding').first();
  await expect(row.getByRole('combobox', { name: '原始模型', exact: true })).toBeEnabled();

  await expect(row).not.toContainText('["route",""]');
  await expect(row.getByRole('combobox', { name: '源模型协议', exact: true })).toHaveValue('Responses');

  await row.getByRole('button', { name: '手动输入', exact: true }).click();
  await row.getByRole('textbox', { name: '原始模型', exact: true }).fill('manual-draft');
  await row.getByRole('button', { name: '从目录选择', exact: true }).click();
  await expect(row.getByRole('combobox', { name: '原始模型', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: '手动输入', exact: true }).click();
  await expect(row.getByRole('textbox', { name: '原始模型', exact: true })).toHaveValue('manual-draft');
  await row.getByRole('button', { name: '从目录选择', exact: true }).click();
  await expect(row.getByRole('combobox', { name: '原始提供商', exact: true })).toHaveCount(0);
  const heldCatalog = new Promise<Route>(resolve => { holdSourceCatalog = resolve; });
  await row.getByRole('combobox', { name: '原始模型', exact: true }).click();
  const cancelledCatalog = await heldCatalog;
  await network.expectAborts([cancelledCatalog.request()], () => row.getByRole('combobox', { name: '原始模型', exact: true }).press('Escape'));
  // Completion means requestfailed observed this captured request's client abort.
  await expect(dialog).toBeVisible();

  await row.getByRole('combobox', { name: '原始模型', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('option', { name: 'gpt-original-2', exact: true }).click();
  await row.getByRole('combobox', { name: '目标提供商', exact: true }).fill('Fixture');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: 'Fixture · fixture', exact: true }).click();
  await row.getByRole('combobox', { name: '目标模型', exact: true }).click();
  await page.getByRole('option', { name: 'org/model-1', exact: true }).click();
  const targetType = row.getByRole('combobox', { name: '目标类型', exact: true });
  const forwardingTarget = row.getByRole('combobox', { name: '转发目标', exact: true });

  await forwardingTarget.click();
  await expect(page.getByRole('option', { name: '/codex', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'fixture-service', exact: true })).toHaveCount(0);
  await forwardingTarget.press('Escape');
  await targetType.fill('服务');
  await targetType.press('ArrowDown'); await targetType.press('Enter');

  await forwardingTarget.click();
  await expect(page.getByRole('option', { name: '/codex', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
  // Changing the type invalidates the selected ID, while preserving model and protocol fields.
  await targetType.click();
  await page.getByRole('option', { name: '路由', exact: true }).click();
  await expect(forwardingTarget).toHaveValue('');
  await expect(row.getByRole('combobox', { name: '目标模型', exact: true })).toHaveValue('org/model-1');
  await targetType.click();
  await page.getByRole('option', { name: '服务', exact: true }).click();
  await forwardingTarget.fill('fixture');
  await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
  await expect(row.getByRole('combobox', { name: '目标模型协议', exact: true })).toHaveValue('');
  await row.getByRole('combobox', { name: '目标模型协议', exact: true }).click();
  await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
  await row.getByRole('combobox', { name: '原始模型', exact: true }).click();
  await expect(page.getByRole('option', { name: 'gpt-original-1', exact: true })).toBeVisible();
  await row.getByRole('combobox', { name: '原始模型', exact: true }).fill('gpt-original');
  await page.getByRole('option', { name: 'gpt-original', exact: true }).click();
  expect(catalogQueries.some(query => query.get('provider') === 'openai' && query.get('page') === '2')).toBe(true);
  expect(catalogQueries.some(query => query.get('provider') === 'openai' && query.get('search') === 'gpt-original')).toBe(true);
  expect(catalogQueries.some(query => query.get('provider') === 'fixture')).toBe(true);
  await row.getByRole('combobox', { name: '目标提供商', exact: true }).fill('OpenAI');
  await expect(page.getByRole('option', { name: 'OpenAI · openai', exact: true })).toHaveCount(0);
  await row.getByRole('combobox', { name: '目标提供商', exact: true }).press('Escape');
  await expect(row.getByRole('radio', { name: '替换模型', exact: true })).toHaveAttribute('aria-checked', 'true');
  await row.getByRole('radio', { name: '新增模型', exact: true }).click();
  await expect(row.getByTestId('codex-binding-source')).toHaveCount(0);
  await expect(row.getByRole('textbox', { name: /公开模型标识|模型别名/ })).toHaveCount(0);
  await row.getByRole('radio', { name: '新增模型', exact: true }).press('ArrowRight');

  await expect(row.getByRole('combobox', { name: '原始模型', exact: true })).toHaveValue('gpt-original');
  await expect(row.getByRole('combobox', { name: '目标模型', exact: true })).toHaveValue('org/model-1');
  await expect(row.getByRole('combobox', { name: '转发目标', exact: true })).toHaveValue('fixture-service');
  await row.getByText('能力限制（可选）', { exact: true }).click();
  await row.getByRole('spinbutton', { name: '上下文长度上限', exact: true }).fill('16000');
  await row.getByRole('button', { name: '增加上下文上限', exact: true }).click();
  await expect(row.getByRole('spinbutton', { name: '上下文长度上限', exact: true })).toHaveValue('16001');
  await row.getByRole('checkbox', { name: '禁用图片输入', exact: true }).check();

  await dialog.getByRole('button', { name: '添加模型替换', exact: true }).click();
  await expect(dialog.getByTestId('codex-model-binding')).toHaveCount(2);
  const secondRow = dialog.getByTestId('codex-model-binding').nth(1);
  await secondRow.getByRole('button', { name: '手动输入', exact: true }).click();
  await secondRow.getByRole('textbox', { name: '原始模型', exact: true }).fill('second-draft');
  await secondRow.getByRole('button', { name: '从目录选择', exact: true }).click();
  await expect(row.getByRole('combobox', { name: '原始模型', exact: true })).toHaveValue('gpt-original');
  await row.getByRole('combobox', { name: '目标模型协议', exact: true }).click();
  await page.getByRole('option', { name: 'Anthropic Messages', exact: true }).click();
  await expect(row.getByRole('combobox', { name: '目标模型协议', exact: true })).toHaveValue('Anthropic Messages');
  await row.getByRole('combobox', { name: '目标模型协议', exact: true }).click();
  await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
  await row.getByRole('combobox', { name: '原始模型', exact: true }).click();
  await expect(page.getByRole('option', { name: 'gpt-original-1', exact: true })).toBeVisible();
  await row.getByRole('combobox', { name: '原始模型', exact: true }).press('Escape');
  await expect(dialog).toBeVisible();

  await secondRow.getByRole('button', { name: '移除', exact: true }).click();

  await row.getByText('能力限制（可选）', { exact: true }).click();

  await dialog.getByTestId('plugin-config-save-button').click();
  await expect(dialog).toHaveCount(0);

  const summary = page.getByTestId('section-plugins');

  await expect(summary.getByTestId('plugin-config-summary')).not.toContainText(serviceId);

  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '原始模型', exact: true })).toHaveValue('gpt-original');
  await expect(dialog.getByRole('combobox', { name: '目标模型', exact: true })).toHaveValue('org/model-1');

  await expect(dialog.getByRole('combobox', { name: '转发目标', exact: true })).toHaveValue('fixture-service');
  await dialog.getByText('能力限制（可选）', { exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: '上下文长度上限', exact: true })).toHaveValue('16001');
  await expect(dialog.getByRole('checkbox', { name: '禁用图片输入', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '手动输入', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '原始模型', exact: true })).toHaveValue('gpt-original');
  await dialog.getByRole('textbox', { name: '原始模型', exact: true }).fill('custom-original');
  await dialog.getByTestId('plugin-config-save-button').click();
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '原始模型', exact: true })).toHaveValue('custom-original');
  await expect(dialog.getByRole('combobox', { name: '目标模型', exact: true })).toHaveValue('org/model-1');
  await dialog.getByRole('button', { name: '从目录选择', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '原始模型', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: '目标模型协议', exact: true })).toHaveValue('Chat Completions');
  await dialog.getByRole('button', { name: '手动输入', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '原始模型', exact: true })).toHaveValue('custom-original');
  await dialog.getByTestId('plugin-config-save-button').click();
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  const relay = dialog.getByTestId('codex-collaboration-relay');
  await expect(relay.getByRole('switch', { name: '协作中继', exact: true })).toHaveAttribute('aria-checked', 'false');
  await relay.getByRole('switch', { name: '协作中继', exact: true }).click();
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();
  await relay.getByRole('combobox', { name: '目标类型', exact: true }).click();
  await page.getByRole('option', { name: '服务', exact: true }).click();
  await relay.getByRole('combobox', { name: '中继目标', exact: true }).fill('fixture-service');
  await relay.getByRole('combobox', { name: '中继目标', exact: true }).press('ArrowDown');
  await relay.getByRole('combobox', { name: '中继目标', exact: true }).press('Enter');
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();
  const relayModel = relay.getByRole('combobox', { name: '中继模型', exact: true });
  await relayModel.fill('gpt-relay');
  await page.getByRole('option', { name: 'gpt-relay', exact: true }).click();
  expect(catalogQueries.some(query => query.get('provider') === 'openai' && query.get('search') === 'gpt-relay')).toBe(true);
  await expect(relay.getByText('目标模型协议', { exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeEnabled();
  await relay.scrollIntoViewIfNeeded();

  await dialog.getByTestId('plugin-config-save-button').click();

  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(relay.getByRole('combobox', { name: '中继模型', exact: true })).toHaveValue('gpt-relay');
  await relay.getByRole('switch', { name: '协作中继', exact: true }).click();
  await dialog.getByTestId('plugin-config-save-button').click();
  await expect(summary).not.toContainText('gpt-relay');
  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByRole('button', { name: '新增模型', exact: true }).click();
  const added = dialog.getByTestId('codex-model-binding').nth(1);
  await expect(added.getByRole('radio', { name: '新增模型', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(added.getByTestId('codex-binding-source')).toHaveCount(0);
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();
  await added.getByRole('combobox', { name: '目标提供商', exact: true }).fill('Fixture');
  await page.getByRole('option', { name: 'Fixture · fixture', exact: true }).click();
  await added.getByRole('combobox', { name: '目标模型', exact: true }).click();
  await page.getByRole('option', { name: 'org/model-1', exact: true }).click();
  await added.getByRole('combobox', { name: '目标类型', exact: true }).click();
  await page.getByRole('option', { name: '服务', exact: true }).click();
  await added.getByRole('combobox', { name: '转发目标', exact: true }).fill('fixture');
  await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
  await added.getByRole('combobox', { name: '目标模型协议', exact: true }).click();
  await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeEnabled();
  // Changing the target model changes the matching ID too, with no separate field.
  await added.getByRole('combobox', { name: '目标模型', exact: true }).fill('org/model-2');
  await page.getByRole('option', { name: 'org/model-2', exact: true }).click();

  await dialog.getByTestId('plugin-config-save-button').click();

  await page.getByTestId('section-plugins').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(added.getByRole('radio', { name: '新增模型', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(added.getByRole('combobox', { name: '目标模型', exact: true })).toHaveValue('org/model-2');
  // A second addition of the same model fails validation before saving.
  await dialog.getByRole('button', { name: '新增模型', exact: true }).click();
  const duplicate = dialog.getByTestId('codex-model-binding').nth(2);
  await duplicate.getByRole('combobox', { name: '目标提供商', exact: true }).fill('Fixture');
  await page.getByRole('option', { name: 'Fixture · fixture', exact: true }).click();
  await duplicate.getByRole('combobox', { name: '目标模型', exact: true }).fill('org/model-2');
  await page.getByRole('option', { name: 'org/model-2', exact: true }).click();
  await duplicate.getByRole('combobox', { name: '目标类型', exact: true }).click();
  await page.getByRole('option', { name: '服务', exact: true }).click();
  await duplicate.getByRole('combobox', { name: '转发目标', exact: true }).fill('fixture');
  await page.getByRole('option', { name: 'fixture-service', exact: true }).click();
  await duplicate.getByRole('combobox', { name: '目标模型协议', exact: true }).click();
  await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();

  await duplicate.getByRole('button', { name: '移除', exact: true }).click();
  await expect(dialog.getByTestId('plugin-config-save-button')).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  network.assertSettled(); expect(errors).toEqual([]);

} catch (error) {

  throw error;
}
}), 240_000);
