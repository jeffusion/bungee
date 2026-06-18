<script lang="ts">
	import { Calendar as CalendarPrimitive } from "bits-ui";
	import { buttonVariants } from "$components/ui/button/index.js";
	import { cn } from "$utils";

	type $$Props = CalendarPrimitive.DayProps;
	type $$Events = CalendarPrimitive.DayEvents;

	export let date: $$Props["date"];
	export let month: $$Props["month"];
	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<CalendarPrimitive.Day
	on:click
	{date}
	{month}
	class={cn(
		buttonVariants({ variant: "ghost" }),
		"h-9 w-9 p-0 font-normal text-zinc-300",
		// Today (not selected)
		"[&[data-today]:not([data-selected])]:bg-nexus-500/10 [&[data-today]:not([data-selected])]:text-nexus-400",
		// Selected — nexus orange
		"data-[selected]:bg-nexus-500 data-[selected]:text-black data-[selected]:hover:bg-nexus-400 data-[selected]:hover:text-black data-[selected]:focus:bg-nexus-500 data-[selected]:focus:text-black data-[selected]:opacity-100",
		// Disabled
		"data-[disabled]:text-zinc-500 data-[disabled]:opacity-50",
		// Unavailable
		"data-[unavailable]:text-red-400 data-[unavailable]:line-through",
		// Outside months
		"data-[outside-month]:text-zinc-500 [&[data-outside-month][data-selected]]:bg-nexus-500/5 [&[data-outside-month][data-selected]]:text-zinc-500 data-[outside-month]:pointer-events-none data-[outside-month]:opacity-50 [&[data-outside-month][data-selected]]:opacity-30",
		className
	)}
	{...$$restProps}
	let:selected
	let:disabled
	let:unavailable
	let:builder
>
	<slot {selected} {disabled} {unavailable} {builder}>
		{date.day}
	</slot>
</CalendarPrimitive.Day>
