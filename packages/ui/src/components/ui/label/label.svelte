<script lang="ts">
  import type { HTMLLabelAttributes } from "svelte/elements";
  import { cn } from "$utils";

  let {
    class: className = "",
    children,
    ...restProps
  }: {
    class?: string;
    children?: import("svelte").Snippet;
  } & HTMLLabelAttributes = $props();
</script>

<label
  class={cn("font-mono text-[10px] font-semibold uppercase tracking-command text-zinc-500", className)}
  {...restProps}
>
  {@render children?.()}
</label>