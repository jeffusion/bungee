<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import ChevronRight from "lucide-svelte/icons/chevron-right";
	import { buttonVariants } from "$components/ui/button/index.js";
	import { cn } from "$utils";

	type $$Props = RangeCalendarPrimitive.NextButtonProps;
	type $$Events = RangeCalendarPrimitive.NextButtonEvents;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<RangeCalendarPrimitive.NextButton
	on:click
	class={cn(
		buttonVariants({ variant: "ghost" }),
		"h-7 w-7 border border-carbon-600 bg-carbon-800 p-0 text-zinc-400 hover:border-nexus-500 hover:text-nexus-300 hover:bg-carbon-700",
		className
	)}
	{...$$restProps}
	let:builder
>
	<slot {builder}>
		<ChevronRight class="h-4 w-4" />
	</slot>
</RangeCalendarPrimitive.NextButton>
