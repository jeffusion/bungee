import '../../../../src/app.css';
import { mount } from 'svelte';
import Host from './Host.svelte';
window.changes = [];
mount(Host, {target:document.body,props:{modern:new URL(location.href).searchParams.get('modern') === 'true'}});
