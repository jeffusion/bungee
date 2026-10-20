import { expect, test } from 'bun:test';
import { resolveNativeNavigation } from '../../src/components/native-widgets/navigation-resolution';
import { resolveNativeSettings } from '../../src/components/native-widgets/settings-resolution';
import accounts from '../../../../plugins/user-auth/manifest.json';
import budget from '../../../../plugins/token-budget/manifest.json';

test('user management and profile have owned menu pages, while sign-in configuration belongs to plugin settings', () => {
  expect(accounts.contributes.navigation.map(page => page.path)).toEqual(['/users', '/profile']);
  for (const manifest of [accounts, budget]) {
    for (const page of manifest.contributes.navigation) {
      expect(page.target).toBe('header');
      if (page.target !== 'header') throw new Error('Expected header navigation');
      const component = () => {};
      expect(resolveNativeNavigation({name: manifest.name, enabled: true, metadata: {contributes: {navigation: [{...page, target: page.target}]}}},
        page.path, {[page.component]: component}, {[page.component]: manifest.name})).toEqual({kind: 'native', component});
      expect(manifest.ui.components.some(item => item.name === page.component)).toBe(true);
    }
  }
  expect(accounts.contributes.settings).toBe('/settings');
  const component = () => {};
  const plugin = {name: accounts.name, enabled: true, metadata: {contributes: {settings: accounts.contributes.settings, nativeSettingsComponent: accounts.contributes.nativeSettingsComponent}}};
  expect(resolveNativeSettings(plugin, '/settings', {UserAuthSettings: component}, {UserAuthSettings: accounts.name})).toEqual({kind: 'native', component});
  expect(resolveNativeNavigation(plugin, '/settings', {UserAuthSettings: component}, {UserAuthSettings: accounts.name})).toBeNull();
  expect('settings' in budget.contributes).toBe(false);
  expect(accounts.management.loginComponent).toBe('UserAuthLogin');
  expect(budget.contributes.resourceExtensions[0]!.component).toBe('TokenBudgetKeyPolicy');
});
