import { mount } from 'svelte';
import Fixture from './NumberInputHarness.svelte';
import '../../src/app.css';
mount(Fixture, { target: document.getElementById('fixture')! });
