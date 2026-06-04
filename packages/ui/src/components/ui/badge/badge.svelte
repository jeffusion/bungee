<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLAttributes } from "svelte/elements";
  import { cn } from "$utils";

  type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";

  let {
    class: className = "",
    variant = "default",
    href = undefined,
    children,
    ...restProps
  }: {
    class?: string;
    variant?: BadgeVariant;
    href?: string;
    children?: import("svelte").Snippet;
  } & HTMLAttributes<HTMLSpanElement> & HTMLAnchorAttributes = $props();

  const variantClasses: Record<BadgeVariant, string> = {
    default: "border-transparent bg-nexus-500 text-carbon-950 hover:bg-nexus-400",
    secondary: "border-carbon-500 bg-carbon-800 text-zinc-200 hover:bg-carbon-700",
    destructive: "border-transparent bg-red-500 text-white hover:bg-red-400",
    outline: "border-carbon-500 bg-transparent text-zinc-300 hover:bg-carbon-800",
    ghost: "border-transparent bg-transparent text-zinc-400 hover:bg-carbon-800 hover:text-zinc-100",
    link: "border-transparent bg-transparent text-nexus-400 underline-offset-4 hover:underline",
  };

  const classes = $derived(cn(
    "inline-flex items-center justify-center gap-1 whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-command transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nexus-500 disabled:pointer-events-none disabled:opacity-50",
    variantClasses[variant],
    className
  ));
</script>

{#if href}
  <a class={classes} {href} {...restProps}>
    {@render children?.()}
  </a>
{:else}
  <span class={classes} {...restProps}>
    {@render children?.()}
  </span>
{/if}