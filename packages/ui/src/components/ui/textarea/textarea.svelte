<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import type { TextareaEvents } from "./index.js";
	import { cn } from "$utils";

	type $$Props = HTMLTextareaAttributes;
	type $$Events = TextareaEvents;

	let className: $$Props["class"] = undefined;
	export let value: $$Props["value"] = undefined;
	export { className as class };

	// Workaround for https://github.com/sveltejs/svelte/issues/9305
	// Fixed in Svelte 5, but not backported to 4.x.
	export let readonly: $$Props["readonly"] = undefined;
</script>

<textarea
	class={cn(
		"flex min-h-[96px] w-full border border-carbon-500 bg-carbon-900 px-3 py-2 font-mono text-[12.25px] font-normal text-zinc-200 placeholder:text-zinc-400 placeholder:font-normal focus-visible:border-nexus-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nexus-500 disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	bind:value
	{readonly}
	on:blur
	on:change
	on:click
	on:focus
	on:keydown
	on:keypress
	on:keyup
	on:mouseover
	on:mouseenter
	on:mouseleave
	on:paste
	on:input
	{...$$restProps}
></textarea>
