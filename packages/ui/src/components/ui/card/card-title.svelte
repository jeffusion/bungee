<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import type { HeadingLevel } from "./index.js";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		tag = "h3",
		children,
		...restProps
	}: HTMLAttributes<HTMLHeadingElement> & {
		tag?: HeadingLevel;
		children?: import("svelte").Snippet;
	} = $props();
</script>

<svelte:element
	this={tag}
	class={cn("font-mono text-sm font-semibold uppercase tracking-command text-zinc-100", className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>