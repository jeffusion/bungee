import '../../../../src/app.css';

    import { mount } from 'svelte';
    import Detail from '../../../../src/components/domain/log/LogDetailContent.svelte';
    window.start = log => mount(Detail, {
      target: document.body, props: { log, embedded: true, showHeader: false }
    });
