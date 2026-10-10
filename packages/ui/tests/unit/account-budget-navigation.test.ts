import { expect, test } from 'bun:test';
import { resolveNativeNavigation } from '../../src/components/native-widgets/navigation-resolution';
import accounts from '../../../../plugins/local-accounts/manifest.json';
import budget from '../../../../plugins/token-budget/manifest.json';

test('account and budget menus resolve owned native pages without plugin settings entries', () => {
  for (const manifest of [accounts, budget]) {
    expect('settings' in manifest.contributes).toBe(false);
    expect('nativeSettingsComponent' in manifest.contributes).toBe(false);
    const page = manifest.contributes.navigation[0]!;
    expect(page.target).toBe('header');
    const component = () => {};
    expect(resolveNativeNavigation({ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
      page.path, { [page.component]: component }, { [page.component]: manifest.name })).toEqual({ kind: 'native', component });
    expect(manifest.ui.components.some(item => item.name === page.component)).toBe(true);
  }
  expect(accounts.translations['zh-CN'][accounts.contributes.navigation[0]!.label]).toBe('认证管理');
  expect(budget.translations['zh-CN'][budget.contributes.navigation[0]!.label]).toBe('Token预算');
  expect(accounts.management.loginComponent).toBe('LocalAccountsLogin');
  expect(budget.contributes.resourceExtensions[0]!.component).toBe('TokenBudgetKeyPolicy');
});
