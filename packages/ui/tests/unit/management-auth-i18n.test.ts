import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { get } from 'svelte/store';
import { _, addMessages, init, locale, waitLocale } from 'svelte-i18n';
import en from '../../src/i18n/locales/en.json';
import zh from '../../src/i18n/locales/zh-CN.json';
import manifest from '../../../../plugins/user-auth/manifest.json';
import { accountError } from '../../src/components/domain/plugin/activation-state';
import { loginFailure } from '../../../../plugins/user-auth/ui/login-errors';

const surfaces = [
  '../../../../plugins/user-auth/ui/Login.svelte',
  '../../../../plugins/user-auth/ui/Settings.svelte',
  '../../src/components/domain/plugin/PluginActivationDialog.svelte',
  '../../src/routes/Setup.svelte',
  '../../../../plugins/user-auth/ui/Setup.svelte',
  '../../../../plugins/user-auth/ui/RecoveryHelp.svelte',
  '../../../../plugins/user-auth/ui/Profile.svelte',
  '../../../../plugins/user-auth/ui/Users.svelte',
  '../../../../plugins/user-auth/ui/LoginSettings.svelte',
  '../../../../plugins/user-auth/ui/SessionPolicy.svelte',
];
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const flatten = (value: Record<string, any>, prefix = ''): Record<string, string> => Object.fromEntries(
  Object.entries(value).flatMap(([key, text]) => typeof text === 'string' ? [[prefix + key, text]] : Object.entries(flatten(text, `${prefix}${key}.`)))
);

test('management authentication surfaces compile for client and SSR and keep copy in translations', async () => {
  for (const file of surfaces) {
    const source = await read(file);
    for (const generate of ['client', 'server'] as const) expect(compile(source, { filename: file, generate }).warnings).toEqual([]);
    expect(source).not.toMatch(/\p{Script=Han}/u);
  }
  expect(manifest.metadata.name).toBe('metadata.name');
  expect(manifest.metadata.description).toBe('metadata.description');
  expect(await Bun.file(new URL('../../src/components/domain/plugin/RecoveryHelp.svelte', import.meta.url)).exists()).toBe(false);
  expect(en.pluginActivation).not.toHaveProperty('recovery');
  expect(zh.pluginActivation).not.toHaveProperty('recovery');
});

test('fresh login uses bundled plugin messages in both locales without loading the protected catalog', async () => {
  const generated = await read('../../src/components/native-widgets/generated.ts');
  const encoded = generated.match(/export const generatedPluginTranslations = ([\s\S]*?) as const;/)?.[1];
  expect(encoded).toBeTruthy();
  const bundled = JSON.parse(encoded!) as Record<string, { plugins: Record<string, Record<string, string>> }>;
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  addMessages('en', en); addMessages('zh-CN', zh);
  // The login path registers only the selected provider, not /plugin-translations.
  for (const language of ['en', 'zh-CN']) {
    const messages = bundled[language].plugins['user-auth'];
    expect(messages).toEqual(manifest.translations[language as keyof typeof manifest.translations]);
    addMessages(language, { plugins: { 'user-auth': messages } });
  }
  init({ initialLocale: 'en', fallbackLocale: 'zh-CN' });
  for (const language of ['en', 'zh-CN']) {
    locale.set(language); await waitLocale();
    const messages = bundled[language].plugins['user-auth'];
    for (const [key, text] of Object.entries(messages)) {
      const values = Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map(match => [match[1], `<${match[1]}>`]));
      const rendered = get(_)(`plugins.user-auth.${key}`, { values });
      expect(rendered).toBe(text.replace(/\{(\w+)\}/g, (_, name) => `<${name}>`));
    }
    expect(get(_)(`plugins.user-auth.${loginFailure(new Error('invalid_credentials')).key}`)).toBe(messages['login.errors.invalid_credentials']);
    expect(get(_)('plugins.user-auth.recovery.summary')).toBe(messages['recovery.summary']);
    for (const key of ['loginTitle', 'setupTitle', 'stateUnavailable', 'initializationFailed', 'loginComponentUnavailable', 'setupComponentUnavailable', 'setupRecovery']) {
      expect(get(_)(`management.${key}`)).not.toBe(`management.${key}`);
    }
  }
  const loader = await read('../../src/i18n/plugin-translations.ts');
  const publicRegistration = loader.slice(loader.indexOf('export function registerStaticPluginTranslations'), loader.indexOf('export async function fetchPluginTranslations'));
  expect(publicRegistration).toContain('plugins[pluginName]');
  expect(publicRegistration).not.toContain('api.get');
  expect(loader).toContain('if (!isCurrent()) return false');
});

test('activation and user profile retain translated errors while provider login owns recovery', async () => {
  const core = flatten(en.pluginActivation);
  expect(Object.keys(core).sort()).toEqual(Object.keys(flatten(zh.pluginActivation)).sort());
  expect(Object.keys(flatten(en.management)).sort()).toEqual(Object.keys(flatten(zh.management)).sort());
  addMessages('en', en); addMessages('zh-CN', zh);
  init({ initialLocale: 'en', fallbackLocale: 'zh-CN' });
  for (const language of ['en', 'zh-CN']) {
    locale.set(language); await waitLocale();
    const expected = flatten(language === 'en' ? en.pluginActivation : zh.pluginActivation);
    for (const [key, text] of Object.entries(expected)) {
      const values = Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map(match => [match[1], `<${match[1]}>`]));
      expect(get(_)(`pluginActivation.${key}`, { values })).not.toBe(`pluginActivation.${key}`);
    }
    expect(accountError(new Error('invalid_credentials')).message).toBe(expected['errors.invalid_credentials']);
  }
  const login = await read(surfaces[0]);
  expect(login).toContain('error = failure.key');
  expect(login).toContain('{t(error)}');
  expect(login).not.toContain('core(error)');
  const profile = await read(surfaces[6]);
  expect(profile).toContain('settings.errors.');
  expect(profile).toContain('{t(error)}');
  const dialog = await read(surfaces[2]);
  expect(dialog).toContain('message = translated.key');
  expect(dialog).toContain('{stageText(stage)}');
  expect(dialog).toContain("stage = 'submitting'");
  expect(dialog).not.toContain('message = translated.message');
  for (const file of [surfaces[0], surfaces[1], ...surfaces.slice(6)]) {
    const source = await read(file);
    for (const match of source.matchAll(/\bt\('(login\.[^']+|settings\.[^']+)'/g)) {
      expect(manifest.translations.en[match[1] as keyof typeof manifest.translations.en]).toBeTruthy();
      expect(manifest.translations['zh-CN'][match[1] as keyof typeof manifest.translations['zh-CN']]).toBeTruthy();
    }
  }
});
