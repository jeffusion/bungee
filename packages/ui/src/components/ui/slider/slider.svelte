<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SliderPrimitive.Props;

	let className: $$Props["class"] = undefined;
	export let value: $$Props["value"] = [0];
	export { className as class };
</script>

<SliderPrimitive.Root
	bind:value
	class={cn("relative flex w-full touch-none select-none items-center", className)}
	{...$$restProps}
	let:thumbs
>
	<span class="bg-carbon-700 relative h-2 w-full grow overflow-hidden">
		<SliderPrimitive.Range class="bg-nexus-500 absolute h-full" />
	</span>
	{#each thumbs as thumb (thumb)}
		<SliderPrimitive.Thumb
			{thumb}
			class="border-carbon-500 bg-carbon-900 focus-visible:ring-nexus-500 block h-5 w-5 border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:pointer-events-none disabled:opacity-50"
		/>
	{/each}
</SliderPrimitive.Root>