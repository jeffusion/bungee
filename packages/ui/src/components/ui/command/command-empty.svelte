<script lang="ts">
	import { Command as CommandPrimitive } from "cmdk-sv";
	import { cn } from "$utils";

	type $$Props = CommandPrimitive.EmptyProps;
	let className: string | undefined | null = undefined;
	export { className as class };
</script>

<CommandPrimitive.Empty class={cn("py-2 text-center text-sm", className)} {...$$restProps}>
	<slot />
</CommandPrimitive.Empty>
