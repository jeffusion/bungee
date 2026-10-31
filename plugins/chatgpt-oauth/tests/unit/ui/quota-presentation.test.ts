import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadPluginArtifactManifest } from '../../../../../packages/core/src/plugin-artifact-contract';
import { accountSummary, accountUsage, creditCount, resetCardDisplayState, usageDisplayState, usageState } from '../../../ui/account-model.js';
const manifest = await Bun.file(new URL('../../../manifest.json', import.meta.url)).json();
test('strict manifest registers quota and account components', async () => {
  const parsed = await loadPluginArtifactManifest(fileURLToPath(new URL('../../..', import.meta.url)));
  expect(parsed.manifestContract).toBe('vnext');
  expect(parsed.uiAssetsPath).toBeDefined();
  expect(parsed.contributes?.nativeWidgets?.map(({ id, component }) => ({ id, component })))
    .toContainEqual({ id: 'chatgpt-quota-usage', component: 'ChatgptQuotaWidget' });
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

test('classifies usage loading, failure, missing and expired quota windows separately', () => {
  const now = 1900000000000;
  const empty = accountUsage({ usage: { state: 'fresh' }, resetCredits: { state: 'fresh', availableCount: 0, credits: [] } });
  const expired = accountUsage({ usage: { state: 'fresh', primary: { usedPercent: 80, resetAt: now - 1 } }, resetCredits: { state: 'unavailable' } });
  const partialExpired = accountUsage({ usage: { state: 'fresh', primary: { usedPercent: 80, resetAt: now - 1 }, secondary: { usedPercent: 20, resetAt: now + 1000 } }, resetCredits: { state: 'unavailable' } });
  const current = accountUsage({ usage: { state: 'fresh', primary: { usedPercent: 20, resetAt: now + 1000 } }, resetCredits: { state: 'unavailable' } });
  const stale = accountUsage({ usage: { state: 'stale', primary: { usedPercent: 20, resetAt: now + 1000 } }, resetCredits: { state: 'stale' } });
  const unavailable = accountUsage({ usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } });
  expect(usageDisplayState({ state: 'loading' }, false, now)).toBe('loading');
  expect(usageDisplayState({ state: 'unavailable' }, true, now)).toBe('failed');
  expect(usageDisplayState(current, true, now)).toBe('refreshFailed');
  expect(usageDisplayState(stale, false, now)).toBe('stale');
  expect(usageDisplayState(unavailable, false, now)).toBe('unavailable');
  expect(usageDisplayState(empty, false, now)).toBe('noWindows');
  expect(usageDisplayState(expired, false, now)).toBe('expired');
  expect(usageDisplayState(partialExpired, false, now)).toBe('partialExpired');
  expect(usageDisplayState(current, false, now)).toBe('fresh');
});

test('distinguishes reset-card loading, known zero, unavailable and failed data', () => {
  const zero = accountUsage({ usage: { state: 'fresh' }, resetCredits: { state: 'fresh', availableCount: 0, credits: [] } });
  const unknown = accountUsage({ usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } });
  const missing = accountUsage({ usage: { state: 'fresh' }, resetCredits: { state: 'fresh' } });
  const cards = accountUsage({ usage: { state: 'unavailable' }, resetCredits: { state: 'fresh', availableCount: 1, credits: [{ id: 'credit', status: 'available' }] } });
  expect(resetCardDisplayState({ state: 'loading' })).toBe('loading');
  expect(resetCardDisplayState(zero)).toBe('fresh');
  expect(creditCount({ usage: zero })).toBe(0);
  expect(resetCardDisplayState(unknown)).toBe('unavailable');
  expect(creditCount({ usage: unknown })).toBeUndefined();
  expect(resetCardDisplayState(missing)).toBe('unavailable');
  expect(creditCount({ usage: missing })).toBeUndefined();
  expect(resetCardDisplayState({ state: 'unavailable' }, true)).toBe('failed');
  expect(resetCardDisplayState(cards, true)).toBe('refreshFailed');
});
