<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = MenubarPrimitive.Props;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<MenubarPrimitive.Root
	class={cn("bg-carbon-900 flex h-10 items-center space-x-1 border border-carbon-700 p-1", className)}
	{...$$restProps}
>
	<slot />
</MenubarPrimitive.Root>
