import { mount } from 'svelte';
import { addMessages, locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../../../packages/ui/src/app.css';
import Component from '../../ui/TokenStatsSettings.svelte';
import manifest from '../../manifest.json';
addMessages('en', {plugins:{'token-stats':manifest.translations.en}});
locale.set('en'); await waitLocale('en');
mount(Component, {target:document.getElementById('app')!});
