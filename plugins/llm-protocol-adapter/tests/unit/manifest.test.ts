import { expect, test } from 'bun:test';
const manifest=await Bun.file(new URL('../../manifest.json',import.meta.url)).json();
test('protocol adapter contributes bindings without a separate settings page', () => {
  expect(manifest.uiExtensionMode).toBe('none');
  expect(manifest.contributes?.settings).toBeUndefined();
});
