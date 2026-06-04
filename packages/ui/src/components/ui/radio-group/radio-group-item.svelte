<script lang="ts">
	import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
	import Circle from "lucide-svelte/icons/circle";
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
		"aspect-square h-4 w-4 border-2 border-carbon-500 bg-carbon-950 text-nexus-500 transition-colors focus:outline-none focus-visible:border-nexus-500 focus-visible:shadow-glow-orange disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-nexus-500 data-[state=checked]:bg-carbon-900",
		className
	)}
	{...$$restProps}
	on:click
>
	<div class="flex items-center justify-center">
		<RadioGroupPrimitive.ItemIndicator>
			<Circle class="h-2 w-2 fill-current text-current" />
		</RadioGroupPrimitive.ItemIndicator>
	</div>
</RadioGroupPrimitive.Item>
