<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = MenubarPrimitive.TriggerProps;
	type $$Events = MenubarPrimitive.TriggerEvents;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<MenubarPrimitive.Trigger
	class={cn(
		"data-[highlighted]:bg-nexus-500/10 data-[state=open]:bg-nexus-500/10 data-[highlighted]:text-nexus-400 data-[state=open]:text-nexus-400 flex cursor-default select-none items-center px-3 py-1.5 text-sm font-medium outline-none",
		className
	)}
	on:click
	on:keydown
	on:pointerenter
	{...$$restProps}
>
	<slot />
</MenubarPrimitive.Trigger>
