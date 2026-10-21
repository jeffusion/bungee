<script lang="ts">
  import type { TimeRange } from '@bungee/plugin-sdk';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import TpsWidget from './TpsWidget.svelte';
  let { pluginName = 'llm-tps', selectedRange = '24h', onHeaderChange }:
    { pluginName?: string; selectedRange?: TimeRange; onHeaderChange?: NativeWidgetHeaderChange } = $props();
</script>

<TpsWidget {pluginName} {selectedRange} {onHeaderChange} mode="endpoints" />
