<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$utils";

  let {
    class: className = "",
    value = $bindable(""),
    ...restProps
  }: {
    class?: string;
    value?: string;
  } & HTMLTextareaAttributes = $props();
</script>

<textarea
  class={cn("flex min-h-20 w-full min-w-0 border border-carbon-500 bg-carbon-900 px-3 py-2 text-sm font-mono text-zinc-100 shadow-industrial-sm transition-[color,box-shadow,border-color] outline-none placeholder:text-zinc-600 selection:bg-nexus-500/30 selection:text-zinc-50 hover:border-carbon-400 focus-visible:border-nexus-500 focus-visible:ring-1 focus-visible:ring-nexus-500/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red-500 aria-invalid:ring-red-500/30 resize-y", className)}
  bind:value={value}
  {...restProps}
></textarea>
