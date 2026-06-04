<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		inset = undefined,
		children,
		onclick = undefined,
		onkeydown = undefined,
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		inset?: boolean;
		children?: import("svelte").Snippet;
		onclick?: (e: MouseEvent) => void;
		onkeydown?: (e: KeyboardEvent) => void;
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	class={cn(
		"relative flex cursor-default select-none items-center px-2 py-1.5 text-sm font-mono text-zinc-300 outline-none transition-colors data-[highlighted]:bg-carbon-700 data-[highlighted]:text-zinc-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		inset && "pl-8",
		className
	)}
	on:click={onclick}
	on:keydown={onkeydown}
	{...restProps}
>
	{@render children?.()}
</DropdownMenuPrimitive.Item>
