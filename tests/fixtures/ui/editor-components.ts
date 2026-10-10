import { mount } from 'svelte';
import { addMessages, locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../../packages/ui/src/app.css';
import Fixture from './EditorComponents.svelte';
import keyManifest from '@plugins/key-access/manifest.json';
for (const [language, messages] of Object.entries(keyManifest.translations)) {
  const nested: Record<string, any> = {};
  for (const [key, text] of Object.entries(messages)) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((object, part) => object[part] ??= {}, nested);
    parent[parts.at(-1)!] = text;
  }
  addMessages(language, { plugins: { 'key-access': nested } });
}
locale.set('en');
await waitLocale('en');
mount(Fixture, { target: document.getElementById('app')! });
