<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$utils";

	type $$Props = HTMLAttributes<HTMLSpanElement>;

	let className: string | undefined | null = undefined;
	export { className as class };
</script>

<span
	class={cn("text-zinc-500 ml-auto text-xs tracking-widest", className)}
	{...$$restProps}
>
	<slot />
</span>
