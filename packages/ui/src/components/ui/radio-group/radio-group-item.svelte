<script lang="ts">
	import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
	import { scale } from "svelte/transition";
	import { cn } from "$utils";

	type $$Props = RadioGroupPrimitive.ItemProps;
	type $$Events = RadioGroupPrimitive.ItemEvents;

	let className: $$Props["class"] = undefined;
	export let value: $$Props["value"];
	export { className as class };
</script>

<RadioGroupPrimitive.Item
	{value}
	class={cn(
		"border-carbon-500 focus-visible:ring-nexus-500 flex items-center justify-center h-[20px] w-[20px] border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	{...$$restProps}
	on:click
>
	<RadioGroupPrimitive.ItemIndicator>
		<div
			class="h-[12px] w-[12px] bg-nexus-500"
			in:scale={{ start: 0.55, duration: 120 }}
		></div>
	</RadioGroupPrimitive.ItemIndicator>
</RadioGroupPrimitive.Item>