<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: HTMLAttributes<HTMLParagraphElement> & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<p class={cn("text-xs text-zinc-500", className)} {...restProps}>
	{@render children?.()}
</p>