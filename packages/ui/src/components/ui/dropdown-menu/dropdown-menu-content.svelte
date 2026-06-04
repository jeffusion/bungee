<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn, flyAndScale } from "$utils";

	let {
		class: className = undefined,
		sideOffset = 4,
		transition = flyAndScale,
		transitionConfig = undefined,
		children,
		...restProps
	}: DropdownMenuPrimitive.ContentProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.Content
	{transition}
	{transitionConfig}
	{sideOffset}
	class={cn(
		"bg-carbon-900 border-carbon-500 text-zinc-200 z-50 min-w-[8rem] border p-1 shadow-industrial-lg focus:outline-none",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</DropdownMenuPrimitive.Content>
