import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { get } from 'svelte/store';
import { addMessages, init, locale, _ } from 'svelte-i18n';
import { IntlMessageFormat } from 'intl-messageformat';
import { getPluginText } from '../../../packages/ui/src/utils/plugin-i18n';
import { resolveNativeNavigation } from '../../../packages/ui/src/components/native-widgets/navigation-resolution';

const manifest = await Bun.file(new URL('../manifest.json', import.meta.url)).json();
const source = await Bun.file(new URL('../ui/KeyPolicy.svelte', import.meta.url)).text();
const flow = await Bun.file(new URL('../ui/key-flow.ts', import.meta.url)).text();
const languages = ['en', 'zh-CN'] as const;

test('access control contributes an owned native menu page without a plugin settings entry', () => {
  expect(manifest.contributes.settings).toBeUndefined();
  expect(manifest.contributes.nativeSettingsComponent).toBeUndefined();
  expect(manifest.contributes.navigation).toEqual([{ label: 'metadata.name', path: '/settings',
    component: 'KeyAccessKeyPolicy', target: 'header', icon: 'shield' }]);
  const component = () => {};
  expect(resolveNativeNavigation({ name: manifest.name, enabled: true, metadata: { contributes: manifest.contributes } },
    '/settings', { KeyAccessKeyPolicy: component }, { KeyAccessKeyPolicy: manifest.name })).toEqual({ kind: 'native', component });
});

test('access control metadata and every UI message have complete matching translations', () => {
  expect(manifest.metadata.name).toBe('metadata.name');
  expect(manifest.metadata.description).toBe('metadata.description');
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  const referencedKeys = new Set([...`${source}\n${flow}`.matchAll(/['"](ui\.[A-Za-z]+)['"]/g)].map(match => match[1]));
  referencedKeys.add(manifest.metadata.name);
  referencedKeys.add(manifest.metadata.description);
  for (const language of languages) {
    for (const key of referencedKeys) expect(manifest.translations[language][key]).toBeTruthy();
    for (const value of Object.values(manifest.translations[language]) as string[]) {
      const values = Object.fromEntries([...value.matchAll(/\{(\w+)(?:,|\})/g)].map(match => [match[1], match[1] === 'count' ? 2 : match[1] === 'status' ? 503 : 'example']));
      expect(new IntlMessageFormat(value, language).format(values)).toBeTruthy();
    }
  }
  // The shared keyStatus contract remains Chinese; all display text uses message keys.
  const withoutBusinessLabels = source.replaceAll("'有效'", "'active'").replaceAll("'已过期'", "'expired'");
  expect(withoutBusinessLabels).not.toMatch(/\p{Script=Han}/u);
});

test('stored nested notices and Key lists are translated again when locale changes', () => {
  for (const language of languages) addMessages(language, { plugins: { 'key-access': manifest.translations[language] } });
  init({ fallbackLocale: 'en', initialLocale: 'en' });
  const helper = source.match(/  function displayMessage\([\s\S]*?\n  }/)![0];
  const render = (notice: unknown, language: string) => {
    locale.set(language);
    const t = (key: string, values: Record<string, string | number>) => getPluginText(key, 'key-access', (id, options) => get(_)(id, { ...options, values }));
    return new Function('t', '$locale', new Bun.Transpiler({ loader: 'ts' }).transformSync(`${helper}\nreturn displayMessage;`))(t, language)(notice);
  };
  const notice = { key: 'ui.createdIncomplete', values: { stage: { key: 'ui.stageSavePolicy' }, reason: { key: 'ui.expirationFuture' } }, append: { key: 'ui.clipboardUnavailable' } };
  expect(render(notice, 'en')).toContain('Saving allowed routes and route protection');
  expect(render(notice, 'en')).toContain('Clipboard unavailable');
  expect(render(notice, 'zh-CN')).toContain('保存 Key 允许路由与路由保护');
  expect(render(notice, 'zh-CN')).toContain('剪贴板不可用');
  const names = { key: 'ui.publicBlockedReason', values: { keys: ['alpha', 'beta'] } };
  expect(render(names, 'en')).toContain('alpha and beta');
  expect(render(names, 'zh-CN')).toContain('alpha和beta');
  expect(render({ key: 'ui.publicationPending' }, 'en')).toContain('publication is still pending');
  expect(render({ key: 'ui.publicationPending' }, 'zh-CN')).toContain('发布尚未完成');
  for (const language of languages) {
    for (const count of [1, 2]) {
      expect(new IntlMessageFormat(manifest.translations[language]['ui.reviewWarning'], language).format({ count })).toContain(String(count === 1 && language === 'en' ? 'following route' : count));
    }
  }
});

test('access control compiles for client and SSR without warnings', () => {
  for (const generate of ['client', 'server'] as const) {
    expect(compile(source, { filename: 'KeyPolicy.svelte', generate }).warnings).toEqual([]);
  }
});
