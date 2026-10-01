<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { sheetFade } from './transitions';
	import { cn } from "$utils";

	type $$Props = SheetPrimitive.OverlayProps;

	let className: $$Props["class"] = undefined;
	export let transition: $$Props["transition"] = sheetFade;
	export let transitionConfig: $$Props["transitionConfig"] = {
		duration: 200,
	};
	export { className as class };
</script>

<SheetPrimitive.Overlay
	{transition}
	{transitionConfig}
	class={cn("bg-carbon-950/80 fixed inset-0 z-[60]", className)}
	data-sheet-overlay
	{...$$restProps}
/>
