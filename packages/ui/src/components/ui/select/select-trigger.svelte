<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronDown from "lucide-svelte/icons/chevron-down";
	import { cn } from "$utils";

	let {
		class: className = "",
		hideIcon = false,
		children,
		...restProps
	}: SelectPrimitive.TriggerProps & { hideIcon?: boolean } = $props();
</script>

<SelectPrimitive.Trigger
	class={cn(
		"border-carbon-500 bg-carbon-900 focus-visible:ring-nexus-500 aria-[invalid]:border-red-500 data-[placeholder]:[&>span]:text-zinc-600 flex h-[34px] w-full items-center justify-between border px-3 py-2 text-left text-sm text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	{#if !hideIcon}
		<div>
			<ChevronDown class="h-4 w-4 opacity-50" />
		</div>
	{/if}
</SelectPrimitive.Trigger>
