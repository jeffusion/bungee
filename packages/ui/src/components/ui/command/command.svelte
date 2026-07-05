<script lang="ts">
	import { Command as CommandPrimitive } from "cmdk-sv";
	import { cn } from "$utils";

	type $$Props = CommandPrimitive.CommandProps;

	export let value: $$Props["value"] = undefined;

	let className: string | undefined | null = undefined;
	export { className as class };
</script>

<CommandPrimitive.Root
	class={cn(
		"bg-carbon-900 text-zinc-200 flex h-full w-full flex-col overflow-hidden rounded-none",
		className
	)}
	bind:value
	{...$$restProps}
>
	<slot />
</CommandPrimitive.Root>
