<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		inset = undefined,
		children,
		...restProps
	}: DropdownMenuPrimitive.LabelProps & {
		inset?: boolean;
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.Label
	class={cn("px-2 py-1.5 text-xs font-mono text-zinc-500 uppercase tracking-command", inset && "pl-8", className)}
	{...restProps}
>
	{@render children?.()}
</DropdownMenuPrimitive.Label>