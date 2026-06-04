<script lang="ts">
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SwitchPrimitive.Props;
	type $$Events = SwitchPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export let checked: $$Props["checked"] = undefined;
	export { className as class };
</script>

<SwitchPrimitive.Root
	bind:checked
	class={cn(
		"peer inline-flex h-6 w-12 shrink-0 cursor-pointer items-center border-2 border-carbon-500 bg-carbon-950 px-0.5 transition-colors focus-visible:outline-none focus-visible:border-nexus-500 focus-visible:shadow-glow-orange disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-nexus-500 data-[state=checked]:bg-nexus-500/20 data-[state=unchecked]:bg-carbon-950",
		className
	)}
	{...$$restProps}
	on:click
	on:keydown
>
	<SwitchPrimitive.Thumb
		class={cn(
			"pointer-events-none block h-4 w-4 bg-zinc-500 ring-0 transition-transform data-[state=checked]:translate-x-6 data-[state=checked]:bg-nexus-500 data-[state=unchecked]:translate-x-0"
		)}
	/>
</SwitchPrimitive.Root>
