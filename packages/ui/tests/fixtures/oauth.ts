import { mount } from 'svelte';
import { addMessages, locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../src/app.css';
import manifestText from '@plugins/chatgpt-oauth/manifest.json?raw';
import Fixture from './OAuthFixture.svelte';
const manifest = JSON.parse(manifestText) as { name: string; translations: Record<string, Record<string, string>> };

for (const [language, messages] of Object.entries(manifest.translations)) {
  const nested: Record<string, any> = {};
  for (const [key, text] of Object.entries(messages)) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((object, part) => object[part] ??= {}, nested);
    parent[parts.at(-1)!] = text;
  }
  addMessages(language, { plugins: { [manifest.name]: nested } });
}
locale.set('en');
await waitLocale('en');
mount(Fixture, { target: document.getElementById('app')! });
(window as any).setTestLocale = (language: string) => locale.set(language);
