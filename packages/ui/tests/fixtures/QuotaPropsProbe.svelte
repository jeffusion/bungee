<script lang="ts">
  import { onMount } from 'svelte';
  import Widget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  let props: { pluginName: string; selectedRange: string; onHeaderChange: NativeWidgetHeaderChange } = $props();
  onMount(() => {
    (window as any).quotaMounts = ((window as any).quotaMounts ?? 0) + 1;
    ((window as any).quotaHeaderCallbacks ??= []).push(props.onHeaderChange);
  });
  $effect(() => { (window as any).quotaHostProps = { pluginName: props.pluginName, selectedRange: props.selectedRange, headerReporterType: typeof props.onHeaderChange }; });
</script>
<Widget {...props} />
