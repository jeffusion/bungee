<script lang="ts" module>
  const slotClasses = {
    root: "border border-carbon-600 bg-carbon-900 text-zinc-100 shadow-industrial-sm",
    header: "flex flex-col gap-1.5 p-4 pb-2",
    title: "font-mono text-sm font-semibold uppercase tracking-command text-zinc-100",
    description: "text-xs text-zinc-500",
    content: "p-4 pt-2",
    footer: "flex items-center gap-2 border-t border-carbon-600 p-4 pt-3",
  } as const;
</script>

<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$utils";

  type CardSlot = keyof typeof slotClasses;

  let {
    class: className = "",
    part = "root",
    children,
    ...restProps
  }: {
    class?: string;
    part?: CardSlot;
    children?: import("svelte").Snippet;
  } & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn(slotClasses[part], className)} {...restProps}>
  {@render children?.()}
</div>