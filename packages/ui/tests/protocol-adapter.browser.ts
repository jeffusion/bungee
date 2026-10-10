// Local component server with fixture APIs only. No production instance or credentials.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from 'playwright/test';
import appConfig from '../vite.config';
const manifest = await Bun.file(new URL('../../../plugins/llm-protocol-adapter/manifest.json', import.meta.url)).json();
const root = fileURLToPath(new URL('../', import.meta.url));
// Svelte's PostCSS preprocessor resolves Tailwind from cwd, independently of Vite root.
process.chdir(root);
const server = await createServer({ ...appConfig, configFile: false, root,
  resolve: { ...appConfig.resolve, alias: [...appConfig.resolve!.alias as any[], { find: '@jeffusion/bungee-types', replacement: fileURLToPath(new URL('../../types/src/index.ts', import.meta.url)) }] }, cacheDir: '/tmp/bungee-adapter-ui-vite',
  optimizeDeps: { entries: ['tests/fixtures/protocol-adapter.html'], include: ['deepmerge', 'cmdk-sv', 'lucide-svelte/icons/search'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 0, proxy: {} } });
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const language of ['zh-CN', 'en']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    await page.addInitScript(lang => localStorage.setItem('locale', lang), language);
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Fixture error:', error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.route(`${origin}/api/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/plugins') return route.fulfill({ json: [{ ...manifest, enabled: true }] });
      if (path === '/api/plugins/schemas') return route.fulfill({ json: { [manifest.name]: { ...manifest,
        configSchema: manifest.configSchema.map((field: any) => ({ ...field, label: `plugins.${manifest.name}.${field.label}`,
          options: field.options.map((option: any) => ({ ...option, label: `plugins.${manifest.name}.${option.label}` })) })) } } });
      if (path === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: origin } });
      return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
    });
    await page.goto(`${origin}/tests/fixtures/protocol-adapter.html`);
    const zh = language === 'zh-CN';
    await page.getByRole('button', { name: zh ? '添加插件' : 'Add Plugin', exact: true }).click();
    await page.getByRole('combobox', { name: zh ? '选择插件' : 'Select Plugin' }).click();
    await page.getByRole('option', { name: /LLM/ }).click();
    const dialog = page.getByRole('dialog');
    const save = dialog.getByTestId('plugin-config-save-button');
    const source = dialog.getByRole('combobox', { name: zh ? '源协议' : 'Source protocol', exact: true });
    const target = dialog.getByRole('combobox', { name: zh ? '目标协议' : 'Target protocol', exact: true });
    await expect(source).toBeVisible(); await expect(target).toBeVisible();
    const a = (await source.boundingBox())!, b = (await target.boundingBox())!;
    expect(b.y).toBeGreaterThan(a.y + a.height); expect(Math.abs(a.x - b.x)).toBeLessThan(1);
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText(zh ? '源协议 为必填项' : 'Source protocol is required');
    await source.click(); await source.press('Home'); await source.press('Enter');
    await expect(source).toContainText('Responses');
    await target.click(); await page.getByRole('option', { name: 'Gemini GenerateContent', exact: true }).click();
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText(zh ? '不支持该协议组合' : 'Unsupported protocol pair');
    await expect(save).toBeDisabled();
    await page.screenshot({ path: `/tmp/llm-protocol-adapter-invalid-${language}.png`, fullPage: true });
    await target.click(); await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
    await expect(source).toContainText('Responses'); await expect(save).toBeEnabled();
    await page.screenshot({ path: `/tmp/llm-protocol-adapter-${language}.png`, fullPage: true });
    await save.click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('saved-bindings')).toContainText('"sourceProtocol":"responses","targetProtocol":"chat_completions"');
    await expect(page.getByTestId('protocol-adapter-fixture')).toContainText(zh ? '源协议' : 'Source protocol');
    await expect(page.getByTestId('protocol-adapter-fixture')).toContainText('Chat Completions');
    await expect(page.getByTestId('protocol-adapter-fixture')).not.toContainText('plugins.llm-protocol-adapter');
    await page.getByRole('button', { name: zh ? '编辑' : 'Edit', exact: true }).click();
    await expect(source).toContainText('Responses'); await expect(target).toContainText('Chat Completions');
    await source.click(); await source.press('Escape'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: zh ? '编辑' : 'Edit', exact: true })).toBeFocused();
    expect(errors).toEqual([]); await page.close();
  }
  expect(manifest.uiExtensionMode).toBe('none'); expect(manifest.contributes?.settings).toBeUndefined();
  console.log('Protocol Adapter isolated UI passed: zh/en, vertical independent selectors, keyboard, required fields, unsupported-pair rejection, corrected-pair save, summary and reopen.');
} finally { await browser.close(); await server.close(); }
