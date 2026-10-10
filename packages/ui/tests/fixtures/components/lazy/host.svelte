
    <script>
      import LazyPage from '../../../../src/components/shell/LazyPage.svelte';
      import Page from './page.svelte';
      let load = $state(() => new Promise(resolve => { window.finishFirst = () => resolve({ default: Page }); }));
      let props = $state({ name: 'first' });
      window.rename = name => { props = { name }; };
      window.replaceLoader = () => {
        load = () => new Promise(resolve => { window.finishNext = () => resolve({ default: Page }); });
      };
      window.failOnce = () => {
        window.attempts = 0;
        load = () => ++window.attempts === 1
          ? Promise.reject(new Error('simulated network failure'))
          : Promise.resolve({ default: Page });
      };
    </script>
    <LazyPage {load} {props} />
