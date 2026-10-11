<script lang="ts">
  import SegmentedControl from '../../../../src/components/industrial/SegmentedControl.svelte';
  import BSegmentedControl from '../../../../src/components/industrial/BSegmentedControl.svelte';
  let { modern }: { modern: boolean } = $props();
  let value = $state('12h');
  const options = [{ value: '1h', label: '1h' }, { value: '12h', label: '12h' }, { value: '24h', label: '24h' }];
  const changed = (next: string) => (window as any).changes.push(next);
</script>
<button data-before>Before</button>
{#if modern}
  <BSegmentedControl {options} bind:value ariaLabel="Time range" onchange={changed} />
{:else}
  <SegmentedControl {options} bind:value ariaLabel="Time range" on:change={event => changed(event.detail)} />
{/if}
<output data-value>{value}</output>
<button data-after>After</button>
