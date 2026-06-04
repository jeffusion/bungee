<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { scale } from "svelte/transition";
	import { cn, flyAndScale } from "$utils";

	let {
		class: className = undefined,
		sideOffset = 4,
		inTransition = flyAndScale,
		inTransitionConfig = undefined,
		outTransition = scale,
		outTransitionConfig = {
			start: 0.95,
			opacity: 0,
			duration: 50,
		},
		children,
		...restProps
	}: SelectPrimitive.ContentProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<SelectPrimitive.Content
	{inTransition}
	{inTransitionConfig}
	{outTransition}
	{outTransitionConfig}
	{sideOffset}
	class={cn(
		"bg-carbon-900 border-carbon-500 text-zinc-200 relative z-50 min-w-[8rem] overflow-hidden border shadow-industrial-lg outline-none",
		className
	)}
	{...restProps}
>
	<div class="w-full p-1">
		{@render children?.()}
	</div>
</SelectPrimitive.Content>
