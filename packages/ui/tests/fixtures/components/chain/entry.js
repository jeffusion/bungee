import '../../../../src/app.css';

    import { mount } from 'svelte';
    import Detail from '../../../../src/components/domain/log/ChainDetailModal.svelte';
    window.start = chain => mount(Detail, { target: document.body, props: { chain, onClose() {} } });
