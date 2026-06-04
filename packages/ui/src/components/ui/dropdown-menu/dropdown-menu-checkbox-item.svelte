<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import Check from "lucide-svelte/icons/check";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		checked = $bindable(undefined),
		children,
		...restProps
	}: DropdownMenuPrimitive.CheckboxItemProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.CheckboxItem
	bind:checked
	class={cn(
		"data-[highlighted]:bg-carbon-700 data-[highlighted]:text-zinc-100 relative flex cursor-default select-none items-center py-1.5 pl-8 pr-2 text-sm font-mono text-zinc-300 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		className
	)}
	{...restProps}
>
	<span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
		<DropdownMenuPrimitive.CheckboxIndicator>
			<Check class="h-4 w-4" />
		</DropdownMenuPrimitive.CheckboxIndicator>
	</span>
	{@render children?.()}
</DropdownMenuPrimitive.CheckboxItem>
