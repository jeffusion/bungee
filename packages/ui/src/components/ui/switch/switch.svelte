<script lang="ts">
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SwitchPrimitive.Props;
	type $$Events = SwitchPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export let checked: $$Props["checked"] = undefined;
	export let checkedChildren = "";
	export let unCheckedChildren = "";
	export let showChildren = false;
	export { className as class };

	$: hasChildren = showChildren && (!!checkedChildren || !!unCheckedChildren);
</script>

<SwitchPrimitive.Root
	bind:checked
	class={cn(
		"focus-visible:ring-nexus-500 data-[state=checked]:bg-carbon-900 data-[state=checked]:border-nexus-500 data-[state=unchecked]:bg-carbon-900 data-[state=unchecked]:border-carbon-600 peer relative inline-flex h-[22px] shrink-0 cursor-pointer items-center overflow-hidden border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:cursor-not-allowed disabled:opacity-50",
		hasChildren ? "w-[46px]" : "w-[38px]",
		className
	)}
	{...$$restProps}
	on:click
	on:keydown
>
	{#if hasChildren}
		<span class="pointer-events-none absolute left-[5px] top-1/2 -translate-y-1/2 font-mono text-[8px] font-bold uppercase tracking-normal text-nexus-300 opacity-0 transition-opacity data-[state=checked]:opacity-100" data-state={checked ? "checked" : "unchecked"}>
			{checkedChildren || "ON"}
		</span>
		<span class="pointer-events-none absolute right-[5px] top-1/2 -translate-y-1/2 font-mono text-[8px] font-bold uppercase tracking-normal text-zinc-500 opacity-100 transition-opacity data-[state=checked]:opacity-0" data-state={checked ? "checked" : "unchecked"}>
			{unCheckedChildren || "OFF"}
		</span>
	{/if}
	<SwitchPrimitive.Thumb
		class={cn(
			"pointer-events-none z-10 block h-[16px] w-[16px] transition-all data-[state=unchecked]:translate-x-[2px] data-[state=checked]:bg-nexus-500 data-[state=unchecked]:bg-carbon-500",
			hasChildren ? "data-[state=checked]:translate-x-[26px]" : "data-[state=checked]:translate-x-[18px]"
		)}
	/>
</SwitchPrimitive.Root>
