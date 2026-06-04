<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<div class={cn("flex items-center gap-2 border-t border-carbon-600 p-4 pt-3", className)} {...restProps}>
	{@render children?.()}
</div>