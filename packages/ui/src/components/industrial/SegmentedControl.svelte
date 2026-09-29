<!--
  SegmentedControl — A bordered group of equal-weight radio buttons with
  the selected option painted in the primary accent. The "1h / 12h / 24h"
  range selector on the Dashboard uses this.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  type Option = { value: string; label: string };

  /** Available options, rendered left-to-right. */
  /** Currently selected value (controlled). */
  /** Accessible label / aria-label for the radiogroup. */
  /** Stretch each option to fill available space evenly. */
  let {
    options = [],
    value = $bindable(''),
    ariaLabel = '',
    stretch = false,
    class: extraClass = '',
    onchange,
  }: {
    options: Option[];
    value?: string;
    ariaLabel?: string;
    stretch?: boolean;
    class?: string;
    onchange?: (next: string) => void;
  } = $props();

  const dispatch = createEventDispatcher<{ change: string }>();
  let selectedIndex = $derived(options.findIndex((option) => option.value === value));

  function select(next: string) {
    if (next === value) return;
    value = next;
    dispatch('change', next);
    onchange?.(next);
  }

  function handleKeydown(event: KeyboardEvent, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': nextIndex = (index + 1) % options.length; break;
      case 'ArrowLeft':
      case 'ArrowUp': nextIndex = (index - 1 + options.length) % options.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = options.length - 1; break;
      default: return;
    }
    event.preventDefault();
    select(options[nextIndex].value);
    ((event.currentTarget as HTMLButtonElement).parentElement?.children.item(nextIndex) as HTMLElement | null)?.focus();
  }
</script>

<div
  role="radiogroup"
  aria-label={ariaLabel}
  class="inline-flex border border-carbon-600 bg-carbon-900 {stretch ? 'w-full' : ''} {extraClass}"
>
  {#each options as opt, index (opt.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      tabindex={index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1}
      class="px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-command transition-colors {stretch ? 'flex-1' : ''}"
      class:bg-nexus-500={value === opt.value}
      class:text-black={value === opt.value}
      class:text-zinc-400={value !== opt.value}
      class:hover:text-nexus-300={value !== opt.value}
      class:hover:bg-carbon-700={value !== opt.value}
      onclick={() => select(opt.value)}
      onkeydown={(event) => handleKeydown(event, index)}
    >
      {opt.label}
    </button>
  {/each}
</div>
