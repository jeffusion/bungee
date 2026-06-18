<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import ChevronLeft from "lucide-svelte/icons/chevron-left";
	import { buttonVariants } from "$components/ui/button/index.js";
	import { cn } from "$utils";

	type $$Props = RangeCalendarPrimitive.PrevButtonProps;
	type $$Events = RangeCalendarPrimitive.PrevButtonEvents;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<RangeCalendarPrimitive.PrevButton
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
		<ChevronLeft class="h-4 w-4" />
	</slot>
</RangeCalendarPrimitive.PrevButton>
