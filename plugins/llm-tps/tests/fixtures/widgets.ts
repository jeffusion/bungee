import { mount } from 'svelte';
import { addMessages, locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../../../packages/ui/src/app.css';
import Host from './WidgetsHost.svelte';
import manifest from '../../manifest.json';

for (const language of ['en', 'zh-CN'] as const) addMessages(language, { plugins: { 'llm-tps': manifest.translations[language] } });
locale.set('en'); await waitLocale('en');
mount(Host, { target: document.getElementById('app')! });
