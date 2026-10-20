import { expect, test } from 'bun:test';
import { resolveNativeNavigation } from '../../../../../packages/ui/src/components/native-widgets/navigation-resolution';

const manifest = await Bun.file(new URL('../../../manifest.json', import.meta.url)).json();

test('access control contributes an owned native menu page without a plugin settings entry', () => {
  expect(manifest.contributes.settings).toBeUndefined();
  expect(manifest.contributes.nativeSettingsComponent).toBeUndefined();
  expect(manifest.contributes.navigation.map(({ path, component }: { path: string; component: string }) => ({ path, component })))
    .toEqual([{ path: '/settings', component: 'KeyAccessKeyPolicy' }]);
  const component = () => {};
  expect(resolveNativeNavigation({ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
    '/settings', { KeyAccessKeyPolicy: component }, { KeyAccessKeyPolicy: manifest.name })).toEqual({ kind: 'native', component });
});
