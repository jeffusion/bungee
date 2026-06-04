<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from "bits-ui";
	import Check from "lucide-svelte/icons/check";
	import Minus from "lucide-svelte/icons/minus";
	import { cn } from "$utils";

	type $$Props = CheckboxPrimitive.Props;
	type $$Events = CheckboxPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export let checked: $$Props["checked"] = false;
	export { className as class };
</script>

<CheckboxPrimitive.Root
	class={cn(
		"peer box-content h-4 w-4 shrink-0 border-2 border-carbon-500 bg-carbon-950 text-black transition-colors focus-visible:outline-none focus-visible:border-nexus-500 focus-visible:shadow-glow-orange disabled:cursor-not-allowed disabled:opacity-40 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40 data-[state=checked]:border-nexus-500 data-[state=checked]:bg-nexus-500 data-[state=indeterminate]:border-nexus-500 data-[state=indeterminate]:bg-nexus-500",
		className
	)}
	bind:checked
	{...$$restProps}
	on:click
>
	<CheckboxPrimitive.Indicator
		class={cn("flex h-4 w-4 items-center justify-center text-current")}
		let:isChecked
		let:isIndeterminate
	>
		{#if isChecked}
			<Check class="h-3.5 w-3.5" />
		{:else if isIndeterminate}
			<Minus class="h-3.5 w-3.5" />
		{/if}
	</CheckboxPrimitive.Indicator>
</CheckboxPrimitive.Root>
