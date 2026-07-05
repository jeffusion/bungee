<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from "bits-ui";
	import Check from "lucide-svelte/icons/check";
	import Minus from "lucide-svelte/icons/minus";
	import { fly } from "svelte/transition";
	import { cn } from "$utils";

	type $$Props = CheckboxPrimitive.Props;
	type $$Events = CheckboxPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export let checked: $$Props["checked"] = false;
	export { className as class };
</script>

<CheckboxPrimitive.Root
	class={cn(
		"border-carbon-500 focus-visible:ring-nexus-500 data-[state=checked]:border-nexus-500 data-[state=checked]:bg-nexus-500 data-[state=indeterminate]:border-nexus-500 data-[state=indeterminate]:bg-nexus-500 flex items-center justify-center h-[16px] w-[16px] shrink-0 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:cursor-not-allowed disabled:opacity-50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 transition-colors",
		className
	)}
	bind:checked
	{...$$restProps}
	on:click
>
	<CheckboxPrimitive.Indicator
		class={cn("flex items-center justify-center text-current")}
		let:isChecked
		let:isIndeterminate
	>
		{#if isChecked}
			<div transition:fly={{ y: 5, duration: 120 }}>
				<Check class="h-3 w-3 text-carbon-950 stroke-[3]" />
			</div>
		{:else if isIndeterminate}
			<Minus class="h-3 w-3 text-carbon-950 stroke-[3]" />
		{/if}
	</CheckboxPrimitive.Indicator>
</CheckboxPrimitive.Root>