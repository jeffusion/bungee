import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadPluginArtifactManifest } from '../../../../../packages/core/src/plugin-artifact-contract';
import { accountSummary, accountUsage, creditCount, usageState } from '../../../ui/account-model.js';
const manifest = await Bun.file(new URL('../../../manifest.json', import.meta.url)).json();
test('strict manifest registers a medium read-only native widget, preserving account settings', async () => {
  const parsed = await loadPluginArtifactManifest(fileURLToPath(new URL('../../..', import.meta.url)));
  expect(parsed.manifestContract).toBe('vnext');
  expect(parsed.uiAssetsPath).toBeDefined();
  expect(parsed.contributes?.nativeWidgets).toContainEqual({ id: 'chatgpt-quota-usage', title: 'ui.widgetTitle', component: 'ChatgptQuotaWidget', size: 'medium' });
  expect(manifest.ui.components).toContainEqual({ name: 'ChatgptQuotaWidget', entry: 'ui/ChatgptQuotaWidget.svelte' });
  expect(manifest.ui.components).toContainEqual({ name: 'ChatgptAccountsPage', entry: 'ui/AccountsPage.svelte' });
});
test('credit count prefers authoritative fresh credit data then fresh usage; unknown never becomes zero', () => {
  const snapshot = (usageState: string, creditState: string) => ({ usage: accountUsage({ usage: { state: usageState, availableCount: 3 }, resetCredits: { state: creditState, availableCount: 1 } }) });
  expect(creditCount(snapshot('fresh', 'fresh'))).toBe(1);
  expect(creditCount(snapshot('fresh', 'stale'))).toBe(3);
  expect(creditCount(snapshot('unavailable', 'unavailable'))).toBeUndefined();
  expect(creditCount({})).toBeUndefined();
  expect(creditCount({ usage: accountUsage({ usage: { state: 'fresh', availableCount: 0 }, resetCredits: { state: 'unavailable' } }) })).toBe(0);
});

test('failed reads retain only real snapshots; inactive accounts remain unavailable', () => {
  const account = accountSummary({ id: 'a', label: 'Account', status: 'active', available: true });
  const empty = accountUsage({ usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } });
  const window = accountUsage({ usage: { state: 'fresh', primary: { usedPercent: 12, windowSeconds: 18000 } }, resetCredits: { state: 'unavailable' } });
  const count = accountUsage({ usage: { state: 'unavailable' }, resetCredits: { state: 'fresh', availableCount: 0 } });
  expect(usageState({ account, usage: empty })).toBe('unavailable');
  expect([empty, window, count].map(usage => usageState({ account, usage, error: 'offline' }))).toEqual(['unavailable', 'stale', 'stale']);
  expect(usageState({ account }, true)).toBe('loading');
  expect(usageState({ account: { ...account, status: 'disabled' }, usage: window })).toBe('unavailable');
});
