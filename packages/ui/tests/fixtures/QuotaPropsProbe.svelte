<script lang="ts">
  import { onMount } from 'svelte';
  import Widget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
  let props: { pluginName: string; selectedRange: string } = $props();
  onMount(() => { (window as any).quotaMounts = ((window as any).quotaMounts ?? 0) + 1; });
  $effect(() => { (window as any).quotaHostProps = { pluginName: props.pluginName, selectedRange: props.selectedRange }; });
</script>
<Widget {...props} />
