<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	type $$Props = HTMLAttributes<HTMLTableSectionElement>;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<tfoot class={cn("bg-carbon-800/50 text-zinc-100 font-medium", className)} {...$$restProps}>
	<slot />
</tfoot>
