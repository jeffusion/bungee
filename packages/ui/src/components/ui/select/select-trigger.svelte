<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronDown from "lucide-svelte/icons/chevron-down";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: SelectPrimitive.TriggerProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<SelectPrimitive.Trigger
	class={cn(
		"border-carbon-500 bg-carbon-900 text-zinc-200 font-mono flex h-9 w-full items-center justify-between border px-3 py-1 text-sm transition-[color,box-shadow,border-color] outline-none placeholder:text-zinc-600 hover:border-carbon-400 focus-visible:border-nexus-500 focus-visible:ring-1 focus-visible:ring-nexus-500/60 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<div>
		<ChevronDown class="h-4 w-4 opacity-50" />
	</div>
</SelectPrimitive.Trigger>
