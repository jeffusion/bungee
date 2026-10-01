import { expect, test } from 'bun:test';
import { resolveNativeNavigation } from './navigation-resolution';
import type { Plugin } from '$api/plugins';
const plugin: Plugin = { name: 'token-stats', enabled: true, metadata: { contributes: {
  navigation: [{ label: 'Stats', path: '/statistics', component: 'TokenStatsPage' }],
} } };
test('native pages require an exact declared path and a registry entry owned by the plugin', () => {
  const component = () => {};
  expect(resolveNativeNavigation(plugin, '/statistics', { TokenStatsPage: component }, { TokenStatsPage: plugin.name }))
    .toEqual({ kind: 'native', component });
  expect(resolveNativeNavigation(plugin, '/statistics', {}, {})?.kind).toBe('error');
  expect(resolveNativeNavigation(plugin, '/statistics', { TokenStatsPage: component }, { TokenStatsPage: 'other' })?.kind).toBe('error');
  for (const path of ['/unknown', '/statistics/', '/statistics?extra=1']) expect(resolveNativeNavigation(plugin, path, {}, {})).toBeNull();
  expect(resolveNativeNavigation({ ...plugin, metadata: { contributes: {
    navigation: [{ label: 'x', path: '/x', component: 'toString' }],
  } } }, '/x', {}, {})?.kind).toBe('error');
});
