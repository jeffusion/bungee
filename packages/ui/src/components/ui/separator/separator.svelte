<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$utils";

  let {
    class: className = "",
    orientation = "horizontal",
    decorative = true,
    ...restProps
  }: {
    class?: string;
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  } & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
  role={decorative ? "none" : "separator"}
  aria-orientation={decorative ? undefined : orientation}
  class={cn(
    "shrink-0 bg-carbon-600",
    orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
    className
  )}
  {...restProps}
></div>