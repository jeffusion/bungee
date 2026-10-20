<script lang="ts">
  import Dashboard from '$lib/routes/Dashboard.svelte';
  import { isLoading } from 'svelte-i18n';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { publicationRecovery } from '$stores/runtime';
  import { nativeWidgetRegistry } from '$components/native-widgets';
  import QuotaPropsProbe from './QuotaPropsProbe.svelte';
  import QuotaPeerProbe from './QuotaPeerProbe.svelte';
  // Keep the real generated owner map; probes only observe host-supplied props and mount identity.
  nativeWidgetRegistry.ChatgptQuotaWidget = QuotaPropsProbe as any;
  nativeWidgetRegistry.TokenStatsChart = QuotaPeerProbe as any;
  let mounted = $state(true);
  onMount(() => {
    Object.assign(window, { unmountDashboard: () => mounted = false, refreshTestPlugins: refreshPlugins,
      testRuntimeStatus: () => get(publicationRecovery).readStatus,
      pauseTestRuntimePolling: () => publicationRecovery.pause(),
      withdrawTestPlugin: () => pluginList.update(plugins => plugins.filter(plugin => plugin.name !== 'chatgpt-oauth')),
      disableTestPlugin: () => pluginList.update(plugins => plugins.map(plugin => ({ ...plugin, enabled: false }))) });
  });
</script>
{#if mounted}
  {#if !$isLoading}<Dashboard />{/if}
{/if}
