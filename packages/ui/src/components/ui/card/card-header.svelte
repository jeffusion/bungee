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

<div class={cn("flex flex-col gap-1.5 p-4 pb-2", className)} {...restProps}>
	{@render children?.()}
</div>