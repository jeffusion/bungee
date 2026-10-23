import { expect, test } from 'bun:test';
import { resolveNativeSettings } from '../../../../src/components/native-widgets/settings-resolution';
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
  }
});
test('external sandbox settings retain PluginHost and native targets are never dynamically imported', async () => {
  for (const path of ['/', '/unknown', '/settings']) expect(resolveNativeSettings({ name: 'external', enabled: true, metadata: { contributes: { settings: '/settings' } } }, path, {}, {})).toEqual({ kind: 'sandbox' });
  // Browser coverage proves invalid declarations fail closed; this keeps the static-loading boundary.
  expect(await Bun.file(new URL('../../../../src/routes/PluginDetailLayout.svelte', import.meta.url)).text()).not.toMatch(/import\s*\(/);
});
