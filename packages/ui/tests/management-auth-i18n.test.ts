import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { get } from 'svelte/store';
import { _, addMessages, init, locale, waitLocale } from 'svelte-i18n';
import en from '../src/i18n/locales/en.json';
import zh from '../src/i18n/locales/zh-CN.json';
import manifest from '../../../plugins/local-accounts/manifest.json';
import { accountError } from '../src/components/domain/plugin/activation-state';

const surfaces = [
  '../../../plugins/local-accounts/ui/Login.svelte',
  '../../../plugins/local-accounts/ui/Settings.svelte',
  '../src/components/domain/plugin/PluginActivationDialog.svelte',
  '../src/components/domain/plugin/RecoveryHelp.svelte',
];
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const flatten = (value: Record<string, any>, prefix = ''): Record<string, string> => Object.fromEntries(
  Object.entries(value).flatMap(([key, text]) => typeof text === 'string' ? [[prefix + key, text]] : Object.entries(flatten(text, `${prefix}${key}.`)))
);

test('management authentication surfaces compile for client and SSR and keep copy in translations', async () => {
  for (const file of surfaces) {
    const source = await read(file);
    for (const generate of ['client', 'server'] as const) expect(compile(source, {filename: file, generate}).warnings).toEqual([]);
    const withoutCommand = source.replace('bun packages/core/dist/main.js --recover-admin /实际数据目录/bungee.db', '');
    expect(withoutCommand).not.toMatch(/\p{Script=Han}/u);
  }
  expect(manifest.metadata.name).toBe('metadata.name');
  expect(manifest.metadata.description).toBe('metadata.description');
});

test('both locales contain matching plugin and shared keys and valid interpolations', async () => {
  const core = flatten(en.pluginActivation);
  const chineseCore = flatten(zh.pluginActivation);
  expect(Object.keys(core).sort()).toEqual(Object.keys(chineseCore).sort());
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  // No plugin messages are registered: login errors and recovery copy must work independently.
  addMessages('en', en); addMessages('zh-CN', zh);
  init({initialLocale: 'en', fallbackLocale: 'zh-CN'});
  for (const language of ['en','zh-CN']) {
    locale.set(language); await waitLocale();
    const expected = language === 'en' ? core : chineseCore;
    for (const [key, text] of Object.entries(expected)) {
      const values = Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map(match => [match[1], `<${match[1]}>`]));
      expect(get(_)(`pluginActivation.${key}`, {values})).not.toBe(`pluginActivation.${key}`);
    }
    expect(accountError(new Error('invalid_credentials')).message).toBe(expected['errors.invalid_credentials']);
    expect(get(_)('pluginActivation.recovery.summary')).toBe(expected['recovery.summary']);
  }
  for (const file of surfaces.slice(0,2)) {
    const source = await read(file);
    for (const match of source.matchAll(/\bt\('(login\.[^']+|settings\.[^']+)'\)/g)) {
      expect(manifest.translations.en[match[1] as keyof typeof manifest.translations.en]).toBeTruthy();
      expect(manifest.translations['zh-CN'][match[1] as keyof typeof manifest.translations['zh-CN']]).toBeTruthy();
    }
    expect(source).toContain('error = result.key');
    expect(source).toContain('{core(error)}');
  }
  const dialog = await read(surfaces[2]);
  expect(dialog).toContain('message = translated.key');
  expect(dialog).toContain('{stageText(stage)}');
  expect(dialog).toContain("stage = 'submitting'");
  expect(dialog).not.toContain('message = translated.message');
});
