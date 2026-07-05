<script lang="ts">
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { cn } from "$utils";

	type $$Props = SwitchPrimitive.Props;
	type $$Events = SwitchPrimitive.Events;

	let className: $$Props["class"] = undefined;
	export let checked: $$Props["checked"] = undefined;
	/** When true, renders inner state glyphs (circle for checked, dash for unchecked). The glyphs are positioned in the free-side using fl//ex-centering, so they stay centered regardless of size. When false, pure slider. */
	export let showChildren = false;
	/** Size variant: large, default, or small */
	export let size: "large" | "default" | "small" = "default";
	/** Convenience callback prop mirroring bits-ui's onCheckedChange. Allows Svelte 5 B^ callers to use `onchange={...}` and have it routed through to the underlying SwitchPrimitive.onCheckedChange. Earlier the base only forwarded `on:click`, which is silently dropped when invoked from a Svelte 5 runes consumer via `onchange={fn}`. */
	export let onchange: ((checked: boolean) => void) | undefined = undefined;
	export { className as class };

	$: hasChildren = showChildren;

	// Size scale — each size declares its full pixel contract.
	// inner-space = width - 2 (border 1px each side)
	// checked translate-x = inner-space - thumb - right-gap (symmetric to left-gap)
	$: sizeToken = {
		large: {
			root: "h-[28px] w-[50px]",
			thumb: "h-[22px] w-[22px] data-[state=unchecked]:translate-x-[2px] data-[state=checked]:translate-x-[24px]",
			glyph: "h-[14px] w-[14px]",
		},
		default: {
			root: "h-[22px] w-[40px]",
			thumb: "h-[16px] w-[16px] data-[state=unchecked]:translate-x-[2px] data-[state=checked]:translate-x-[20px]",
			glyph: "h-[10px] w-[10px]",
		},
		small: {
			root: "h-[16px] w-[30px]",
			thumb: "h-[12px] w-[12px] data-[state=unchecked]:translate-x-[1px] data-[state=checked]:translate-x-[15px]",
			glyph: "h-[8px] w-[8px]",
		},
	}[size];
</script>

<SwitchPrimitive.Root
	bind:checked
	onCheckedChange={onchange}
	class={cn(
		"focus-visible:ring-nexus-500 data-[state=checked]:bg-carbon-900 data-[state=checked]:border-nexus-500 data-[state=unchecked]:bg-carbon-900 data-[state=unchecked]:border-carbon-600 peer relative inline-flex shrink-0 cursor-pointer items-center overflow-hidden border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:cursor-not-allowed disabled:opacity-50",
		sizeToken.root,
		className
	)}
	{...$$restProps}
	on:click
	on:keydown
>
	{#if hasChildren}
		<!-- Checked glyph (circle): shown when checked. Lives in left half, so when knob slides right, glyph is revealed. -->
		<div class="pointer-events-none absolute inset-y-0 left-0 flex w-1/2 items-center justify-center">
			<svg
				class={cn(
					"text-nexus-300 opacity-0 transition-opacity [.peer[data-state=checked]_&]:opacity-100",
					sizeToken.glyph
				)}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="4"
			>
				<circle cx="12" cy="12" r="8" />
			</svg>
		</div>
		<!-- Unchecked glyph (dash): shown when unchecked. Lives in right half, so when knob stays left, glyph is revealed. -->
		<div class="pointer-events-none absolute inset-y-0 right-0 flex w-1/2 items-center justify-center">
			<svg
				class={cn(
					"text-zinc-500 opacity-100 transition-opacity [.peer[data-state=checked]_&]:opacity-0",
					sizeToken.glyph
				)}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="4"
				stroke-linecap="round"
			>
				<line x1="3" y1="12" x2="21" y2="12" />
			</svg>
		</div>
	{/if}
	<SwitchPrimitive.Thumb
		class={cn(
			"pointer-events-none z-10 block transition-all data-[state=unchecked]:bg-carbon-500 data-[state=checked]:bg-nexus-500",
			sizeToken.thumb
		)}
	/>
</SwitchPrimitive.Root>
