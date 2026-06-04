<!--
  SegmentedControl — A bordered group of equal-weight radio buttons with
  the selected option painted in the primary accent. The "1h / 12h / 24h"
  range selector on the Dashboard uses this.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  type Option = { value: string; label: string };

  /** Available options, rendered left-to-right. */
  export let options: Option[] = [];

  /** Currently selected value (controlled). */
  export let value: string;

  /** Accessible label / aria-label for the radiogroup. */
  export let ariaLabel: string = '';

  /** Stretch each option to fill available space evenly. */
  export let stretch: boolean = false;

  let extraClass = '';
  export { extraClass as class };

  const dispatch = createEventDispatcher<{ change: string }>();

  function select(next: string) {
    if (next === value) return;
    value = next;
    dispatch('change', next);
  }
</script>

<div
  role="radiogroup"
  aria-label={ariaLabel}
  class="inline-flex border border-carbon-600 bg-carbon-900 {stretch ? 'w-full' : ''} {extraClass}"
>
  {#each options as opt}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      tabindex={value === opt.value ? 0 : -1}
      class="px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-command transition-colors {stretch ? 'flex-1' : ''}"
      class:bg-nexus-500={value === opt.value}
      class:text-black={value === opt.value}
      class:text-zinc-400={value !== opt.value}
      class:hover:text-nexus-300={value !== opt.value}
      class:hover:bg-carbon-700={value !== opt.value}
      on:click={() => select(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
