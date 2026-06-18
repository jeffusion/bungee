<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import { buttonVariants } from "$components/ui/button/index.js";
	import { cn } from "$utils";

	type $$Props = RangeCalendarPrimitive.DayProps;
	type $$Events = RangeCalendarPrimitive.DayEvents;

	export let date: $$Props["date"];
	export let month: $$Props["month"];
	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<RangeCalendarPrimitive.Day
	on:click
	{date}
	{month}
	class={cn(
		buttonVariants({ variant: "ghost" }),
		"h-9 w-9 p-0 font-normal text-zinc-300 data-[selected]:opacity-100",
		// Today (not selected)
		"[&[data-today]:not([data-selected])]:bg-nexus-500/10 [&[data-today]:not([data-selected])]:text-nexus-400",
		// Selection Start — nexus orange
		"data-[selection-start]:bg-nexus-500 data-[selection-start]:text-black data-[selection-start]:hover:bg-nexus-400 data-[selection-start]:hover:text-black data-[selection-start]:focus:bg-nexus-500 data-[selection-start]:focus:text-black",
		// Selection End — nexus orange
		"data-[selection-end]:bg-nexus-500 data-[selection-end]:text-black data-[selection-end]:hover:bg-nexus-400 data-[selection-end]:hover:text-black data-[selection-end]:focus:bg-nexus-500 data-[selection-end]:focus:text-black",
		// Outside months
		"data-[outside-month]:text-zinc-500 [&[data-outside-month][data-selected]]:bg-nexus-500/5 [&[data-outside-month][data-selected]]:text-zinc-500 data-[outside-month]:pointer-events-none data-[outside-month]:opacity-50 [&[data-outside-month][data-selected]]:opacity-30",
		// Disabled
		"data-[disabled]:text-zinc-500 data-[disabled]:opacity-50",
		// Unavailable
		"data-[unavailable]:text-red-400 data-[unavailable]:line-through",
		className
	)}
	{...$$restProps}
	let:disabled
	let:unavailable
	let:builder
>
	<slot {disabled} {unavailable} {builder}>
		{date.day}
	</slot>
</RangeCalendarPrimitive.Day>
