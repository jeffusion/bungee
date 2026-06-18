<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = RangeCalendarPrimitive.CellProps;

	export let date: $$Props["date"];
	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<RangeCalendarPrimitive.Cell
	{date}
	class={cn(
		"[&:has([data-selected]):not(:has([data-highlighted]))]:bg-nexus-500/10 [&:has([data-selected][data-outside-month])]:bg-nexus-500/5 relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20",
		className
	)}
	{...$$restProps}
>
	<slot />
</RangeCalendarPrimitive.Cell>
