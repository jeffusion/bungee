<script lang="ts">
	import { Calendar as CalendarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = CalendarPrimitive.HeadCellProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<CalendarPrimitive.HeadCell
	class={cn("text-zinc-500 w-9 text-[0.8rem] font-mono uppercase tracking-chiseled", className)}
	{...$$restProps}
>
	<slot />
</CalendarPrimitive.HeadCell>
