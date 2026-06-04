<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		children,
		...restProps
	}: HTMLAttributes<HTMLSpanElement> & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<span class={cn("ml-auto text-[10px] font-mono text-zinc-500 uppercase tracking-command", className)} {...restProps}>
	{@render children?.()}
</span>