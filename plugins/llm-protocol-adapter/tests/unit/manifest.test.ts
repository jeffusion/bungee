import { expect, test } from 'bun:test';
const manifest=await Bun.file(new URL('../../manifest.json',import.meta.url)).json();
test('protocol adapter contributes bindings without a separate settings page', () => {
  expect(manifest.uiExtensionMode).toBe('none');
  expect(manifest.contributes?.settings).toBeUndefined();
});

test('manifest and service expose only the supported Gemini conversion direction',()=>{
 const pairs=manifest.configConstraints[0].tuples;
 expect(pairs).toHaveLength(15);expect(pairs).toContainEqual(['responses','gemini_generate_content']);
 expect(pairs).not.toContainEqual(['gemini_generate_content','responses']);
});
