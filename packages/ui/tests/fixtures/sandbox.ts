import { mount } from 'svelte';
import '$i18n';
import '../../src/app.css';
import Fixture from './SandboxFixture.svelte';

mount(Fixture, { target: document.getElementById('app')! });
