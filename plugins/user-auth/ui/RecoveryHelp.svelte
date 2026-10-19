<script lang="ts">
  import { isLoading } from 'svelte-i18n';
  import { _ } from '@bungee/plugin-sdk';
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.recovery.${key}`);
</script>

<details class="text-sm text-zinc-400 space-y-2">
  <summary class="cursor-pointer text-nexus-300">{t('summary')}</summary>
  <p>{t('intro')}</p>
  <ol class="list-decimal pl-5 space-y-2">
    <li>{t('step1')}</li>
    <li>{t('step2')}</li>
    <li>{t('step3')}</li>
  </ol>
  <code class="block border border-carbon-600 p-3 font-mono text-xs whitespace-pre-wrap break-all">bungee recover --plugin user-auth --action reset</code>
  <p>{t('docker')}</p>
  <code class="block border border-carbon-600 p-3 font-mono text-xs whitespace-pre-wrap break-all">bun packages/core/dist/main.js --recover /usr/app/data/bungee.db --plugin user-auth --action reset</code>
</details>
