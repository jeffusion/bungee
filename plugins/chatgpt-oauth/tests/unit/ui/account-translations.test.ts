import { expect, test } from 'bun:test';
const source = await Bun.file(new URL('../../../ui/AccountsPage.svelte', import.meta.url)).text();
test('all account UI and model messages have both plugin locales; no hardcoded visible Chinese', async () => {
  const manifest = await Bun.file(new URL('../../../manifest.json', import.meta.url)).json();
  const model = await Bun.file(new URL('../../../ui/account-model.js', import.meta.url)).text();
  expect(source + model).not.toMatch(/[\u3400-\u9fff]/);
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  const keys = [...(source + model).matchAll(/['"]((?:ui|login|account|errors)\.[a-zA-Z_]+)['"]/g)].map(match => match[1]);
  for (const key of keys) for (const lang of ['en', 'zh-CN']) expect(manifest.translations[lang][key]).toBeTruthy();
});
