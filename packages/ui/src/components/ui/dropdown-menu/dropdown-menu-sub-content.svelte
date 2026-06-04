<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn, flyAndScale } from "$utils";

	let {
		class: className = undefined,
		transition = flyAndScale,
		transitionConfig = {
			x: -10,
			y: 0,
		},
		children,
		...restProps
	}: DropdownMenuPrimitive.SubContentProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.SubContent
	{transition}
	{transitionConfig}
	class={cn(
		"bg-carbon-900 border-carbon-500 text-zinc-200 z-50 min-w-[8rem] border p-1 shadow-industrial-lg focus:outline-none",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</DropdownMenuPrimitive.SubContent>
