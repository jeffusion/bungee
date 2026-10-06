<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { Input } from '$components/ui/input';

  let { value = $bindable<number | string | undefined>(), ...props }: Omit<HTMLInputAttributes, 'type' | 'step' | 'value'> & {
    value?: number | string;
  } = $props();
</script>

<Input {...props} type="number" step={1} bind:value />
