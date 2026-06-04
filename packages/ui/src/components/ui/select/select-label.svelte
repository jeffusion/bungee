<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: SelectPrimitive.LabelProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<SelectPrimitive.Label
	class={cn("py-1.5 pl-8 pr-2 text-xs font-mono text-zinc-500 uppercase tracking-command", className)}
	{...restProps}
>
	{@render children?.()}
</SelectPrimitive.Label>