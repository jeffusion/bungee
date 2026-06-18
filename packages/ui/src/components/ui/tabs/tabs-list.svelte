<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = TabsPrimitive.ListProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<TabsPrimitive.List
	class={cn(
		"bg-carbon-800 text-zinc-400 inline-flex h-10 items-center justify-center rounded-none p-1",
		className
	)}
	{...$$restProps}
>
	<slot />
</TabsPrimitive.List>
