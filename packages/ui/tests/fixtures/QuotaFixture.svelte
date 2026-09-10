<script lang="ts">
  import Dashboard from '$lib/routes/Dashboard.svelte';
  import Widget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
  import { isLoading } from 'svelte-i18n';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import { onMount } from 'svelte';
  import { nativeWidgetRegistry } from '$components/native-widgets';
  import QuotaPropsProbe from './QuotaPropsProbe.svelte';
  import QuotaPeerProbe from './QuotaPeerProbe.svelte';
  // Keep the real generated owner map; probes only observe host-supplied props and mount identity.
  nativeWidgetRegistry.ChatgptQuotaWidget = QuotaPropsProbe as any;
  nativeWidgetRegistry.TokenStatsChart = QuotaPeerProbe as any;
  let mounted = $state(true);
  const race = new URLSearchParams(location.search).has('race');
  onMount(() => {
    Object.assign(window, { unmountDashboard: () => mounted = false, refreshTestPlugins: refreshPlugins,
      disableTestPlugin: () => pluginList.update(plugins => plugins.map(plugin => ({ ...plugin, enabled: false }))) });
  });
</script>
{#if mounted}
  {#if race}<Widget onHeaderChange={header => (window as any).raceHeader = header} />{:else if !$isLoading}<Dashboard />{/if}
{/if}
