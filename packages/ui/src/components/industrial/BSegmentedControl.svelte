<script lang="ts">
  import { cn } from "$utils";

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

  function select(next: string) {
    if (next === value) return;
    value = next;
    if (onchange) onchange(next);
  }
</script>

<div
  role="radiogroup"
  aria-label={ariaLabel}
  class={cn(
    "inline-flex border border-carbon-600 bg-carbon-900",
    stretch ? "w-full" : "",
    className
  )}
>
  {#each options as opt}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      tabindex={value === opt.value ? 0 : -1}
      class={cn(
        "px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-command transition-colors",
        stretch ? "flex-1" : "",
        value === opt.value
          ? "bg-nexus-500 text-black"
          : "text-zinc-400 hover:text-nexus-300 hover:bg-carbon-700"
      )}
      onclick={() => select(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
