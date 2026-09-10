import { mount } from 'svelte';
import { addMessages, locale } from 'svelte-i18n';
import '$i18n';
import '../../src/app.css';
import manifestText from '@plugins/chatgpt-oauth/manifest.json?raw';
import Fixture from './QuotaFixture.svelte';
const manifest = JSON.parse(manifestText);
for (const language of ['en', 'zh-CN']) addMessages(language, { plugins: { 'token-stats': { ui: { widgetTitle: 'Peer fixture' } } } });
for (const [language, messages] of Object.entries(manifest.translations)) {
  const nested: Record<string, any> = {};
  for (const [key, value] of Object.entries(messages as Record<string, string>)) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((result, part) => result[part] ??= {}, nested);
    parent[parts.at(-1)!] = value;
  }
  addMessages(language, { plugins: { [manifest.name]: nested } });
}
mount(Fixture, { target: document.getElementById('app')! });
(window as any).setTestLocale = (language: string) => locale.set(language);
(window as any).setLongSummary = (long: boolean) => {
  for (const language of ['en', 'zh-CN']) addMessages(language, { plugins: { [manifest.name]: { ui: {
    accountCount: long ? '{available} available / {total} accounts — a deliberately long translated account summary for narrow headers' : manifest.translations[language]['ui.accountCount'],
  } } } });
};
