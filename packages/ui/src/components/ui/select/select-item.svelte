<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SelectPrimitive.ItemProps;
	type $$Events = SelectPrimitive.ItemEvents;

	let className: $$Props["class"] = undefined;
	export let value: $$Props["value"];
	export let label: $$Props["label"] = undefined;
	export let disabled: $$Props["disabled"] = undefined;
	export { className as class };
</script>

<SelectPrimitive.Item
	{value}
	{disabled}
	{label}
	class={cn(
		"relative flex w-full cursor-default select-none items-center py-1.5 px-2 text-sm text-zinc-300 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		"data-[selected]:bg-nexus-500/15 data-[selected]:text-nexus-400 data-[selected]:font-semibold",
		"data-[highlighted]:bg-carbon-700 data-[highlighted]:text-zinc-100",
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
	<slot>
		{label || value}
	</slot>
</SelectPrimitive.Item>
