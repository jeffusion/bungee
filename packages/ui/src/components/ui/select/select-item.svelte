<script lang="ts">
	import Check from "lucide-svelte/icons/check";
	import { Select as SelectPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		value,
		label = undefined,
		disabled = undefined,
		children,
		...restProps
	}: SelectPrimitive.ItemProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<SelectPrimitive.Item
	{value}
	{disabled}
	{label}
	class={cn(
		"relative flex w-full cursor-default select-none items-center py-1.5 pl-8 pr-2 text-sm font-mono text-zinc-300 outline-none transition-colors data-[highlighted]:bg-carbon-700 data-[highlighted]:text-zinc-100 data-[selected]:bg-nexus-500/20 data-[selected]:text-nexus-300 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		className
	)}
	{...restProps}
>
	<span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
		<SelectPrimitive.ItemIndicator>
			<Check class="h-4 w-4" />
		</SelectPrimitive.ItemIndicator>
	</span>
	{#if children}
		{@render children()}
	{:else}
		{label || value}
	{/if}
</SelectPrimitive.Item>
