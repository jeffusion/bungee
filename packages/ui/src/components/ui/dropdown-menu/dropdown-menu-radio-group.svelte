<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let {
		value = $bindable(undefined),
		children,
		...restProps
	}: DropdownMenuPrimitive.RadioGroupProps & {
		children?: import("svelte").Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.RadioGroup {...restProps} bind:value>
	{@render children?.()}
</DropdownMenuPrimitive.RadioGroup>