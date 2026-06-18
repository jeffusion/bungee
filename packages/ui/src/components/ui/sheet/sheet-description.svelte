<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SheetPrimitive.DescriptionProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<SheetPrimitive.Description class={cn("text-carbon-400 text-sm", className)} {...$$restProps}>
	<slot />
</SheetPrimitive.Description>
