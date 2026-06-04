<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import Circle from "lucide-svelte/icons/circle";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		value,
		children,
		...restProps
	}: DropdownMenuPrimitive.RadioItemProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.RadioItem
	class={cn(
		"data-[highlighted]:bg-carbon-700 data-[highlighted]:text-zinc-100 relative flex cursor-default select-none items-center py-1.5 pl-8 pr-2 text-sm font-mono text-zinc-300 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		className
	)}
	{value}
	{...restProps}
>
	<span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
		<DropdownMenuPrimitive.RadioIndicator>
			<Circle class="h-2 w-2 fill-current" />
		</DropdownMenuPrimitive.RadioIndicator>
	</span>
	{@render children?.()}
</DropdownMenuPrimitive.RadioItem>
