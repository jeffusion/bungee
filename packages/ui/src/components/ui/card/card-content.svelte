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

<div class={cn("p-4 pt-2", className)} {...restProps}>
	{@render children?.()}
</div>