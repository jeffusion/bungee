import { mount } from 'svelte';
import { locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../../src/app.css';
import Fixture from './system-updates.svelte';
locale.set(new URLSearchParams(location.search).get('language') ?? 'en');
await waitLocale();
mount(Fixture, { target: document.getElementById('app')! });
