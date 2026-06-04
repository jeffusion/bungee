<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import ChevronRight from "lucide-svelte/icons/chevron-right";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		inset = undefined,
		children,
		...restProps
	}: DropdownMenuPrimitive.SubTriggerProps & {
		inset?: boolean;
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.SubTrigger
	class={cn(
		"data-[highlighted]:bg-carbon-700 data-[state=open]:bg-carbon-700 data-[highlighted]:text-zinc-100 data-[state=open]:text-zinc-100 flex cursor-default select-none items-center px-2 py-1.5 text-sm font-mono text-zinc-300 outline-none transition-colors",
		inset && "pl-8",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronRight class="ml-auto h-4 w-4" />
</DropdownMenuPrimitive.SubTrigger>
