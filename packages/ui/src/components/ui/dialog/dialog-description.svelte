<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: DialogPrimitive.DescriptionProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DialogPrimitive.Description
	class={cn("text-xs text-zinc-400", className)}
	{...restProps}
>
	{@render children?.()}
</DialogPrimitive.Description>