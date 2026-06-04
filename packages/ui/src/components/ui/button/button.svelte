<script lang="ts">
	import { Button as ButtonPrimitive } from "bits-ui";
	import { type Props, buttonVariants } from "./index.js";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		variant = "primary",
		size = "md",
		builders = [],
		children,
		onclick = undefined,
		onkeydown = undefined,
		onmousedown = undefined,
		onmouseup = undefined,
		onmouseleave = undefined,
		onblur = undefined,
		...restProps
	}: Props & {
		children?: import("svelte").Snippet;
		onclick?: (e: MouseEvent) => void;
		onkeydown?: (e: KeyboardEvent) => void;
		onmousedown?: (e: MouseEvent) => void;
		onmouseup?: (e: MouseEvent) => void;
		onmouseleave?: (e: MouseEvent) => void;
		onblur?: (e: FocusEvent) => void;
	} = $props();

	let pressed = $state(false);

	function handleMouseDown(event: MouseEvent) {
		if (event.currentTarget instanceof HTMLButtonElement && !event.currentTarget.disabled) {
			pressed = true;
		}
		onmousedown?.(event);
	}

	function handleMouseUp(event: MouseEvent) {
		pressed = false;
		onmouseup?.(event);
	}

	function handleMouseLeave(event: MouseEvent) {
		pressed = false;
		onmouseleave?.(event);
	}

	function handleBlur(event: FocusEvent) {
		pressed = false;
		onblur?.(event);
	}
</script>

<ButtonPrimitive.Root
	{builders}
	class={cn(buttonVariants({ variant, size, className }), pressed && "translate-y-px shadow-inner")}
	type="button"
	{onclick}
	onkeydown={onkeydown}
	onmousedown={handleMouseDown}
	onmouseup={handleMouseUp}
	onmouseleave={handleMouseLeave}
	onblur={handleBlur}
	{...restProps}
>
	{@render children?.()}
</ButtonPrimitive.Root>
