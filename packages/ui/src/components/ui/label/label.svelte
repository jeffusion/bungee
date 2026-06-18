<script lang="ts">
	import { Label as LabelPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = LabelPrimitive.Props;
	type $$Events = LabelPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<LabelPrimitive.Root
	class={cn(
		"font-mono text-[11px] uppercase tracking-command text-zinc-400 leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
		className
	)}
	{...$$restProps}
	on:mousedown
>
	<slot />
</LabelPrimitive.Root>