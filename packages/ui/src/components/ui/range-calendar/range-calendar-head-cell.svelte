<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = RangeCalendarPrimitive.HeadCellProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<RangeCalendarPrimitive.HeadCell
	class={cn("text-zinc-500 w-9 text-[0.8rem] font-mono uppercase tracking-chiseled", className)}
	{...$$restProps}
>
	<slot />
</RangeCalendarPrimitive.HeadCell>
