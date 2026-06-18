<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	type $$Props = HTMLAttributes<HTMLDivElement>;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<div
	class={cn("bg-carbon-900 text-zinc-100 rounded-none border shadow-sm", className)}
	{...$$restProps}
>
	<slot />
</div>
