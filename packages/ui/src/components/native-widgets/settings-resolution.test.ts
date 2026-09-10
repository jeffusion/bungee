import { expect, test } from 'bun:test';
import { resolveNativeSettings } from './settings-resolution';
import type { Plugin } from '$api/plugins';

const plugin: Plugin = { name: 'chatgpt-oauth', enabled: true, metadata: { contributes: { settings: '/accounts', nativeSettingsComponent: 'ChatgptAccountsPage' } } };
test('native settings must be a statically registered component owned by this plugin', () => {
  const component = () => {};
  expect(resolveNativeSettings(plugin, '/accounts', { ChatgptAccountsPage: component }, { ChatgptAccountsPage: plugin.name })).toEqual({ kind: 'native', component });
  expect(resolveNativeSettings(plugin, '/accounts', {}, {}).kind).toBe('error');
  expect(resolveNativeSettings(plugin, '/accounts', { ChatgptAccountsPage: component }, { ChatgptAccountsPage: 'other' }).kind).toBe('error');
  expect(resolveNativeSettings({ ...plugin, metadata: { contributes: { settings: '/accounts', nativeSettingsComponent: 'toString' } } }, '/accounts', {}, {}).kind).toBe('error');
  for (const path of ['/', '', '/unknown', '/accounts/', '/accounts?extra=1']) {
    const result = resolveNativeSettings(plugin, path, { ChatgptAccountsPage: component }, { ChatgptAccountsPage: plugin.name });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('路径不匹配');
  }
});
test('external sandbox settings retain PluginHost while invalid native declarations cannot fall back to iframe', async () => {
  for (const path of ['/', '/unknown', '/settings']) expect(resolveNativeSettings({ name: 'external', enabled: true, metadata: { contributes: { settings: '/settings' } } }, path, {}, {})).toEqual({ kind: 'sandbox' });
  const layout = await Bun.file(new URL('../../routes/PluginDetailLayout.svelte', import.meta.url)).text();
  expect(layout.indexOf("settings?.kind === 'error'")).toBeLessThan(layout.indexOf('<PluginHost'));
  expect(layout).toContain("{#if settings?.kind === 'native'}");
  expect(layout.indexOf("{#if settings?.kind === 'native'}")).toBeLessThan(layout.indexOf('<PanelCard\n        title={plugin.name.toUpperCase()}'));
  expect(layout).not.toMatch(/import\s*\(/);
});
