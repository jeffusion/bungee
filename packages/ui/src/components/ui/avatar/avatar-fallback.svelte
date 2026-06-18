<script lang="ts">
	import { Avatar as AvatarPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = AvatarPrimitive.FallbackProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<AvatarPrimitive.Fallback
	class={cn("bg-carbon-800 flex h-full w-full items-center justify-center rounded-none", className)}
	{...$$restProps}
>
	<slot />
</AvatarPrimitive.Fallback>
