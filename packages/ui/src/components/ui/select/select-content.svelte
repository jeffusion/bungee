<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { scale } from "svelte/transition";
	import { cn, flyAndScale } from "$utils";

	let {
		sideOffset = 4, inTransition = flyAndScale, inTransitionConfig = undefined,
		outTransition = scale, outTransitionConfig = { start: 0.95, opacity: 0, duration: 50 },
		class: className, children, ...restProps
	}: SelectPrimitive.ContentProps & { children?: import('svelte').Snippet } = $props();
</script>

<SelectPrimitive.Content
	{inTransition}
	{inTransitionConfig}
	{outTransition}
	{outTransitionConfig}
	{sideOffset}
	class={cn(
		"bg-carbon-800 text-zinc-100 relative z-50 min-w-[8rem] max-h-[min(18rem,calc(100dvh-2rem))] overflow-y-auto border border-carbon-600 shadow-industrial outline-none",
		className
	)}
	{...restProps}
	on:keydown
>
	<div class="p-1">
		{@render children?.()}
	</div>
</SelectPrimitive.Content>
