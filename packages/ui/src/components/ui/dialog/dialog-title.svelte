<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: DialogPrimitive.TitleProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DialogPrimitive.Title
	class={cn("font-mono text-sm font-bold uppercase tracking-command text-zinc-100", className)}
	{...restProps}
>
	{@render children?.()}
</DialogPrimitive.Title>