import { mount } from 'svelte';
import '../../src/app.css';
import Fixture from './CarouselFixture.svelte';
mount(Fixture, { target: document.getElementById('app')! });
