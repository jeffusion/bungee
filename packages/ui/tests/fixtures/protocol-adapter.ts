import { mount } from 'svelte';
import { addMessages, locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../src/app.css';
import text from '@plugins/llm-protocol-adapter/manifest.json?raw';
import Fixture from './ProtocolAdapterFixture.svelte';
const manifest = JSON.parse(text);
for (const [language, messages] of Object.entries(manifest.translations)) {
  const nested: Record<string, any> = {};
  for (const [key, value] of Object.entries(messages as Record<string, string>)) {
    const parts = key.split('.');
    const parent = parts.slice(0, -1).reduce((object, part) => object[part] ??= {}, nested);
    parent[parts.at(-1)!] = value;
  }
  addMessages(language, { plugins: { [manifest.name]: nested } });
}
const language = localStorage.getItem('locale') || 'zh-CN';
locale.set(language);
await waitLocale(language);
mount(Fixture, { target: document.getElementById('app')! });
