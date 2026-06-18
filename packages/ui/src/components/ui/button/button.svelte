<script lang="ts">
	import { Button as ButtonPrimitive } from "bits-ui";
	import { type Props, buttonVariants } from "./index.js";
	import { cn } from "$utils";

	let {
		class: className = undefined,
		variant = "default",
		size = "default",
		builders = [],
		children,
		onclick,
		onkeydown,
		...restProps
	}: Props & {
		children?: import("svelte").Snippet;
		onclick?: (e: MouseEvent) => void;
		onkeydown?: (e: KeyboardEvent) => void;
	} = $props();

	let isPressed = $state(false);
</script>

<ButtonPrimitive.Root
	{builders}
	class={cn(
		buttonVariants({ variant, size, className }),
		isPressed && "translate-y-px shadow-inner"
	)}
	type="button"
	{...restProps}
	onclick={onclick}
	onkeydown={onkeydown}
	onmousedown={() => isPressed = true}
	onmouseup={() => isPressed = false}
	onmouseleave={() => isPressed = false}
>
	{@render children?.()}
</ButtonPrimitive.Root>
