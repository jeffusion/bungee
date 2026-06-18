<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import ChevronRight from "lucide-svelte/icons/chevron-right";
	import { cn } from "$utils";

	type $$Props = ContextMenuPrimitive.SubTriggerProps & {
		inset?: boolean;
	};
	type $$Events = ContextMenuPrimitive.SubTriggerEvents;

	let className: $$Props["class"] = undefined;
	export let inset: $$Props["inset"] = undefined;
	export { className as class };
</script>

<ContextMenuPrimitive.SubTrigger
	class={cn(
		"data-[highlighted]:bg-nexus-500/10 data-[state=open]:bg-nexus-500/10 data-[highlighted]:text-nexus-400 data-[state=open]:text-nexus-400 flex cursor-default select-none items-center px-2 py-1.5 text-sm outline-none",
		inset && "pl-8",
		className
	)}
	{...$$restProps}
	on:click
	on:keydown
	on:focusin
	on:focusout
	on:pointerleave
	on:pointermove
>
	<slot />
	<ChevronRight class="ml-auto h-4 w-4" />
</ContextMenuPrimitive.SubTrigger>
