<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	type $$Props = HTMLAttributes<HTMLTableCaptionElement>;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<caption class={cn("text-zinc-400 mt-4 text-sm", className)} {...$$restProps}>
	<slot />
</caption>
