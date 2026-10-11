import { afterAll, beforeAll, test } from 'bun:test';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { expect } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { createMasterPluginCatalogApi } from '../../../core/src/master-runtime/master-plugin-catalog-api';
import type { PluginManifestRecord } from '../../../core/src/plugin-manifest-catalog/types';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

const fixture = resolve(import.meta.dir, '../fixtures/protocol-adapter.html');
const manifest = await Bun.file(new URL('../../../../plugins/codex-router/manifest.json', import.meta.url)).json();
const catalogApi = createMasterPluginCatalogApi({ catalog: { records: () => [{ name: manifest.name, manifest, configSchema: manifest.configSchema } as PluginManifestRecord] } });
const catalogSnapshot = { aggregate: { plugin_activations: [{ plugin_name: manifest.name }] } } as never;
const routeId = '10000000-0000-4000-8000-000000000001';
const serviceId = '20000000-0000-4000-8000-000000000001';
let runtime: Awaited<ReturnType<typeof startUiRuntime>>;
let browser: Browser;

beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['index.html', fixture] });
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

async function connectFixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => {
    const path = new URL(request.url()).pathname;
    const reason = request.failure()?.errorText;
    // Search changes and dropdown dismissal intentionally abort catalog requests.
    if (path === '/api/plugins/codex-router/control/catalog' && reason === 'net::ERR_ABORTED') return;
    errors.push(`request failed: ${path}: ${reason}`);
  });
  const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
  config.config.logical_configuration.routes = [{ id: routeId, position: 0, path: '/relay-route', plugins: [] }];
  config.config.logical_configuration.services = [{ id: serviceId, position: 0, name: 'relay-service', plugins: [], endpoints: [] }];
  await page.route(`${runtime.origin}/api/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: runtime.origin } });
    if (url.pathname === '/api/config') return route.fulfill({ json: { revision: config.revision, content_hash: config.content_hash, config: config.config } });
    if (catalogApi.matches(url.pathname)) {
      const response = await catalogApi.handle(new Request(url), catalogSnapshot);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    }
    if (url.pathname === '/api/plugins/codex-router/control/catalog') {
      const provider = url.searchParams.get('provider');
      if (provider && provider !== 'openai') errors.push(`unexpected relay provider: ${provider}`);
      const search = url.searchParams.get('search') ?? '';
      const models = provider === 'openai' && (!search || 'gpt-relay'.includes(search))
        ? [{ provider: 'openai', providerName: 'OpenAI', model: 'gpt-relay', name: 'GPT Relay' }] : [];
      return route.fulfill({ json: { providers: [], models, total: models.length, page: 1, pageSize: 50, status: { version: 1, modelCount: 0 } } });
    }
    errors.push(`unexpected API: ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
  });
  return { errors, config };
}

for (const language of ['zh-CN', 'en']) test(`collaboration relay enable, validate, save, reopen and remove: ${language}`, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const page = await context.newPage();
  try {
    const { errors } = await connectFixture(page);
    await page.addInitScript(language => localStorage.setItem('locale', language), language);
    const zh = language === 'zh-CN';
    const labels = { relay: zh ? '协作中继' : 'Collaboration relay', target: zh ? '中继目标' : 'Relay target', model: zh ? '中继模型' : 'Relay model', edit: zh ? '编辑' : 'Edit' };
    await page.goto(`${runtime.origin}/@fs${fixture}`);
    await page.getByRole('button', { name: zh ? '添加插件' : 'Add Plugin', exact: true }).click();
    await page.getByRole('combobox', { name: zh ? '选择插件' : 'Select Plugin', exact: true }).click();
    await page.getByRole('option', { name: /Codex/ }).click();
    const dialog = page.getByRole('dialog');
    const save = dialog.getByTestId('plugin-config-save-button');
    const toggle = dialog.getByRole('switch', { name: labels.relay, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByRole('combobox', { name: labels.model, exact: true })).toHaveCount(0);
    await save.click();
    await expect(page.getByTestId('saved-bindings')).not.toContainText('collaborationRelay');
    await page.getByRole('button', { name: labels.edit, exact: true }).click();
    await toggle.click();
    await expect(save).toBeDisabled();
    const type = dialog.getByRole('combobox', { name: zh ? '目标类型' : 'Target type', exact: true });
    const target = dialog.getByRole('combobox', { name: labels.target, exact: true });
    const model = dialog.getByRole('combobox', { name: labels.model, exact: true });
    await expect(type).toHaveValue(zh ? '路由' : 'Route');
    await expect(target).toHaveAttribute('placeholder', zh ? '选择路由' : 'Select a route');
    await expect(model).toHaveValue('');
    await target.fill('does-not-exist');
    await expect(page.getByRole('option')).toHaveCount(0);
    await target.press('Enter');
    await expect(save).toBeDisabled();
    await target.press('Escape');
    await expect(target).toBeFocused();
    await expect(dialog).toBeVisible();
    await type.click();
    await page.getByRole('option', { name: zh ? '服务' : 'Service', exact: true }).click();
    await expect(target).toHaveAttribute('placeholder', zh ? '选择服务' : 'Select a service');
    await target.fill('relay-service');
    await expect(page.getByRole('option')).toHaveCount(1);
    await target.press('ArrowDown'); await target.press('Enter');
    await expect(target).toHaveValue('relay-service');
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText(zh ? '请选择有效的中继模型' : 'Select a valid relay model');
    await model.fill('arbitrary-model');
    await expect(page.getByRole('option')).toHaveCount(0);
    await model.press('Enter');
    await expect(save).toBeDisabled();
    await model.press('Escape');
    await expect(model).toHaveValue('');
    await model.fill('gpt-relay');
    await expect(page.getByRole('option', { name: 'gpt-relay', exact: true })).toBeVisible();
    await model.press('ArrowDown'); await model.press('Enter');
    await expect(model).toHaveValue('gpt-relay');
    await expect(dialog.getByTestId('codex-collaboration-relay').getByText(zh ? '目标模型协议' : 'Target model protocol', { exact: true })).toHaveCount(0);
    await expect(save).toBeEnabled();
    const relay = dialog.getByTestId('codex-collaboration-relay');
    // Both rectangles belong to the same frame; input focus may scroll the dialog.
    expect(await relay.evaluate(node => {
      const target = node.querySelector('[role="combobox"]')!.getBoundingClientRect();
      const model = node.querySelector('input[id$="-model"]')!.getBoundingClientRect();
      return model.top > target.bottom;
    })).toBe(true);
    expect(await relay.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `/tmp/codex-collaboration-relay-${language}.png`, fullPage: true });
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('saved-bindings')).toContainText(`"collaborationRelay":{"target":{"type":"service","id":"${serviceId}","protocol":"responses"},"model":"gpt-relay"}`);
    await expect(page.getByTestId('protocol-adapter-fixture')).toContainText(`gpt-relay · Responses · ${zh ? '服务' : 'Service'}: relay-service`);
    await expect(page.getByTestId('protocol-adapter-fixture')).not.toContainText('[object Object]');
    await expect(page.getByTestId('protocol-adapter-fixture')).not.toContainText('plugins.codex-router');
    await page.getByRole('button', { name: labels.edit, exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(model).toHaveValue('gpt-relay');
    await expect(target).toHaveValue('relay-service');
    await expect(type).toHaveValue(zh ? '服务' : 'Service');
    await type.click();
    await page.getByRole('option', { name: zh ? '路由' : 'Route', exact: true }).click();
    await expect(target).toHaveValue('');
    await expect(model).toHaveValue('gpt-relay');
    await expect(save).toBeDisabled();
    await target.click();
    await expect(page.getByRole('option', { name: '/relay-route', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'relay-service', exact: true })).toHaveCount(0);
    await target.press('Escape');
    await target.fill('/relay-route');
    await target.press('ArrowDown'); await target.press('Enter');
    await expect(target).toHaveValue('/relay-route');
    await expect(save).toBeEnabled();
    await toggle.click();
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('saved-bindings')).not.toContainText('collaborationRelay');
    await page.getByRole('button', { name: labels.edit, exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(model).toHaveValue('');
    await expect(target).toHaveValue('');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);

for (const invalid of ['missing-target', 'invalid-type', 'invalid-protocol', 'missing-model']) test(`collaboration relay rejects loaded ${invalid}`, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  try {
    const { errors } = await connectFixture(page);
    await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
    const relay = { target: { type: invalid === 'invalid-type' ? 'upstream' : 'service', id: invalid === 'missing-target' ? 'missing-service' : serviceId, protocol: invalid === 'invalid-protocol' ? 'chat_completions' : 'responses' }, model: invalid === 'missing-model' ? '' : 'gpt-relay' };
    const plugins = [{ name: 'codex-router', options: { models: [], collaborationRelay: relay } }];
    await page.goto(`${runtime.origin}/@fs${fixture}?plugins=${encodeURIComponent(JSON.stringify(plugins))}`);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();
    await expect(dialog.getByRole('alert')).toBeVisible();
    if (invalid === 'missing-target') {
      const target = dialog.getByRole('combobox', { name: '中继目标', exact: true });
      await expect(target).toHaveValue(/目标不可用/);
      await target.click();
      await expect(page.getByRole('option', { name: /目标不可用/ })).toBeDisabled();
      await target.press('Escape');
    }
    if (invalid === 'invalid-type') {
      await expect(dialog.getByRole('combobox', { name: '目标类型', exact: true })).toHaveValue('');
      await expect(dialog.getByRole('combobox', { name: '中继目标', exact: true })).toBeDisabled();
      await expect(dialog).not.toContainText('upstream');
    }
    await page.screenshot({ path: `/tmp/codex-collaboration-relay-${invalid}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);

for (const language of ['zh-CN', 'en']) test(`Codex summaries resolve route paths and service names after reload: ${language}`, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  try {
    const { errors, config } = await connectFixture(page);
    await page.addInitScript(language => localStorage.setItem('locale', language), language);
    const zh = language === 'zh-CN';
    const plugins = [{ name: 'codex-router', options: {
      models: [{ source: 'gpt-client', provider: 'lab', model: 'target-model', target: { type: 'route', id: routeId, protocol: 'chat_completions' } }],
      collaborationRelay: { target: { type: 'service', id: serviceId, protocol: 'responses' }, model: 'gpt-relay' },
    } }];
    await page.goto(`${runtime.origin}/@fs${fixture}?plugins=${encodeURIComponent(JSON.stringify(plugins))}`);
    const summary = page.getByTestId('plugin-config-summary');
    await expect(summary).toContainText(`${zh ? '路由' : 'Route'}: /relay-route`);
    await expect(summary).toContainText(`${zh ? '服务' : 'Service'}: relay-service`);
    await expect(summary).not.toContainText(routeId);
    await expect(summary).not.toContainText(serviceId);
    await expect(summary).not.toContainText('plugins.codex-router');
    await expect(summary).not.toContainText('[object Object]');
    await expect(page.getByTestId('saved-bindings')).toContainText(routeId);
    await expect(page.getByTestId('saved-bindings')).toContainText(serviceId);
    await summary.screenshot({ path: `/tmp/codex-router-summary-${language}.png` });

    config.config.logical_configuration.routes[0].path = '/renamed-relay';
    config.config.logical_configuration.services[0].name = 'renamed-service';
    await page.reload();
    await expect(summary).toContainText(`${zh ? '路由' : 'Route'}: /renamed-relay`);
    await expect(summary).toContainText(`${zh ? '服务' : 'Service'}: renamed-service`);
    await expect(summary).not.toContainText('/relay-route');

    config.config.logical_configuration.routes = [];
    config.config.logical_configuration.services = [];
    await page.reload();
    await expect(summary).toContainText(`${zh ? '目标不可用' : 'Target unavailable'} (${routeId})`);
    await expect(summary).toContainText(`${zh ? '目标不可用' : 'Target unavailable'} (${serviceId})`);
    await expect(summary).not.toContainText('/renamed-relay');
    await expect(summary).not.toContainText('renamed-service');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
