<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import X from "lucide-svelte/icons/x";
	import * as Dialog from "./index.js";
	import { cn, flyAndScale } from "$utils";

	type Props = DialogPrimitive.ContentProps & {
		closeDisabled?: boolean;
		closeLabel?: string;
		children?: import('svelte').Snippet;
	};
	let {
		class: className = undefined,
		transition = flyAndScale,
		transitionConfig = { duration: 200 },
		closeDisabled = false,
		closeLabel = 'Close',
		children,
		...restProps
	}: Props = $props();
</script>

<Dialog.Portal>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		{transition}
		{transitionConfig}
		class={cn(
			"bg-carbon-900 fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-lg sm:rounded-none md:w-full",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<DialogPrimitive.Close
			disabled={closeDisabled}
			class="ring-offset-carbon-950 focus:ring-nexus-500 data-[state=open]:bg-nexus-500/10 data-[state=open]:text-zinc-500 absolute right-4 top-4 rounded-none opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none"
		>
			<X class="h-4 w-4" />
			<span class="sr-only">{closeLabel}</span>
		</DialogPrimitive.Close>
	</DialogPrimitive.Content>
</Dialog.Portal>
