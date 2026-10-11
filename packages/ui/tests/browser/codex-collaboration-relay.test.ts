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
  page.on('requestfailed', request => errors.push(`request failed: ${new URL(request.url()).pathname}`));
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
    if (url.pathname === '/api/plugins/codex-router/control/catalog') return route.fulfill({ json: { providers: [], status: { version: 1, modelCount: 0 } } });
    errors.push(`unexpected API: ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
  });
  return errors;
}

for (const language of ['zh-CN', 'en']) test(`collaboration relay enable, validate, save, reopen and remove: ${language}`, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const page = await context.newPage();
  try {
    const errors = await connectFixture(page);
    await page.addInitScript(language => localStorage.setItem('locale', language), language);
    const zh = language === 'zh-CN';
    const labels = { relay: zh ? '协作中继' : 'Collaboration relay', target: zh ? '中继路由 / 服务' : 'Relay route / service', model: zh ? '中继模型' : 'Relay model', edit: zh ? '编辑' : 'Edit' };
    await page.goto(`${runtime.origin}/@fs${fixture}`);
    await page.getByRole('button', { name: zh ? '添加插件' : 'Add Plugin', exact: true }).click();
    await page.getByRole('combobox', { name: zh ? '选择插件' : 'Select Plugin', exact: true }).click();
    await page.getByRole('option', { name: /Codex/ }).click();
    const dialog = page.getByRole('dialog');
    const save = dialog.getByTestId('plugin-config-save-button');
    const toggle = dialog.getByRole('switch', { name: labels.relay, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByRole('textbox', { name: labels.model, exact: true })).toHaveCount(0);
    await save.click();
    await expect(page.getByTestId('saved-bindings')).not.toContainText('collaborationRelay');
    await page.getByRole('button', { name: labels.edit, exact: true }).click();
    await toggle.click();
    await expect(save).toBeDisabled();
    const target = dialog.getByRole('combobox', { name: labels.target, exact: true });
    const model = dialog.getByRole('textbox', { name: labels.model, exact: true });
    await expect(target).toHaveAttribute('placeholder', zh ? '选择已有路由或服务' : 'Select an existing route or service');
    await expect(model).toHaveValue('');
    await target.fill('does-not-exist');
    await expect(page.getByRole('option')).toHaveCount(0);
    await target.press('Enter');
    await expect(save).toBeDisabled();
    await target.press('Escape');
    await expect(target).toBeFocused();
    await expect(dialog).toBeVisible();
    await target.fill('relay-service');
    await expect(page.getByRole('option')).toHaveCount(1);
    await target.press('ArrowDown'); await target.press('Enter');
    await expect(target).toHaveValue(zh ? '服务 · relay-service' : 'Service · relay-service');
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText(zh ? '请输入不含首尾空格的模型标识' : 'Enter a model ID without surrounding spaces');
    await model.fill('  relay-model  ');
    await expect(save).toBeDisabled();
    await model.fill('relay-model');
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
    await expect(page.getByTestId('saved-bindings')).toContainText(`"collaborationRelay":{"target":{"type":"service","id":"${serviceId}","protocol":"responses"},"model":"relay-model"}`);
    await expect(page.getByTestId('protocol-adapter-fixture')).toContainText(`relay-model · Responses · ${zh ? '服务' : 'Service'}: ${serviceId}`);
    await expect(page.getByTestId('protocol-adapter-fixture')).not.toContainText('[object Object]');
    await expect(page.getByTestId('protocol-adapter-fixture')).not.toContainText('plugins.codex-router');
    await page.getByRole('button', { name: labels.edit, exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(model).toHaveValue('relay-model');
    await expect(target).toHaveValue(zh ? '服务 · relay-service' : 'Service · relay-service');
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
    const errors = await connectFixture(page);
    await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
    const relay = { target: { type: invalid === 'invalid-type' ? 'upstream' : 'service', id: invalid === 'missing-target' ? 'missing-service' : serviceId, protocol: invalid === 'invalid-protocol' ? 'chat_completions' : 'responses' }, model: invalid === 'missing-model' ? '' : 'relay-model' };
    const plugins = [{ name: 'codex-router', options: { models: [], collaborationRelay: relay } }];
    await page.goto(`${runtime.origin}/@fs${fixture}?plugins=${encodeURIComponent(JSON.stringify(plugins))}`);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('plugin-config-save-button')).toBeDisabled();
    await expect(dialog.getByRole('alert')).toBeVisible();
    if (invalid === 'missing-target' || invalid === 'invalid-type') {
      const target = dialog.getByRole('combobox', { name: '中继路由 / 服务', exact: true });
      await expect(target).toHaveValue(/目标不可用/);
      await target.click();
      await expect(page.getByRole('option', { name: /目标不可用/ })).toBeDisabled();
      await target.press('Escape');
    }
    await page.screenshot({ path: `/tmp/codex-collaboration-relay-${invalid}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
