import { mount } from 'svelte';
import { locale, waitLocale } from 'svelte-i18n';
import '$i18n';
import '../../../src/app.css';
import Host from './rewrite.svelte';
locale.set('en'); await waitLocale('en');
mount(Host, { target: document.getElementById('app')! });
