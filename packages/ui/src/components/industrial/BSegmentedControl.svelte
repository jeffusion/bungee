<script lang="ts">
  import SegmentedControl from './SegmentedControl.svelte';

  type Option = { value: string; label: string };

  let {
    options = [],
    value = $bindable(""),
    ariaLabel = "",
    stretch = false,
    class: className = "",
    onchange,
  }: {
    options: Option[];
    value?: string;
    ariaLabel?: string;
    stretch?: boolean;
    class?: string;
    onchange?: (next: string) => void;
  } = $props();
</script>

<SegmentedControl {options} bind:value {ariaLabel} {stretch} class={className} {onchange} />
