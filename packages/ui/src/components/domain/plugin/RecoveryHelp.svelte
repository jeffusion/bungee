<script lang="ts">
  import { _, isLoading } from 'svelte-i18n';
  const t = (key: string) => $isLoading ? '' : $_(`pluginActivation.recovery.${key}`);
</script>

<details class="text-sm text-zinc-400 space-y-2">
  <summary class="cursor-pointer text-nexus-300">{t('summary')}</summary>
  <p>{t('intro')}</p>
  <ol class="list-decimal pl-5 space-y-2">
    <li>{t('step1')}</li>
    <li>{t('step2')}</li>
    <li>{t('step3')}</li>
  </ol>
  <code class="block border border-carbon-600 p-3 font-mono text-xs whitespace-pre-wrap break-all">bun packages/core/dist/main.js --recover-admin /path/to/data/bungee.db</code>
  <p>{t('docker')}</p>
  <p class="text-xs">{t('note')}</p>
</details>
