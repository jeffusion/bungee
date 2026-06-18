<script lang="ts">
	import type { HTMLOlAttributes } from "svelte/elements";
	import { cn } from "$utils";

	type $$Props = HTMLOlAttributes & {
		el?: HTMLOListElement;
	};

	export let el: $$Props["el"] = undefined;
	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<ol
	bind:this={el}
	class={cn(
		"text-zinc-400 flex flex-wrap items-center gap-1.5 break-words text-sm sm:gap-2.5",
		className
	)}
	{...$$restProps}
>
	<slot />
</ol>
