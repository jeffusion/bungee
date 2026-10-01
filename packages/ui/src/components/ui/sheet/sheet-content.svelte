<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { Dialog as SheetPrimitive } from 'bits-ui';
	import X from 'lucide-svelte/icons/x';
	import { SheetOverlay, SheetPortal, type Side, sheetTransitions, sheetVariants } from './index.js';
	import { sheetSlide } from './transitions';
	import { cn } from '$utils';

	type Props = SheetPrimitive.ContentProps & {
		side?: Side;
		closeLabel?: string;
		closeClass?: string;
		onClosed?: () => void;
		children?: Snippet;
	};
	let {
		class: className, side = 'right', closeLabel = 'Close', closeClass, onClosed, children,
		inTransition = sheetSlide, inTransitionConfig,
		outTransition = sheetSlide, outTransitionConfig,
		...restProps
	}: Props = $props();
	let element = $state<HTMLElement>();
	const enter = $derived(inTransitionConfig ?? sheetTransitions[side ?? 'right'].in);
	const leave = $derived(outTransitionConfig ?? sheetTransitions[side ?? 'right'].out);

	$effect(() => {
		const node = element;
		if (!node) return;
		// Restore focus or reveal a card only after the primitive unmounts and releases its scroll lock.
		const closed = () => { void tick().then(() => { if (!node.isConnected) onClosed?.(); }); };
		node.addEventListener('outroend', closed);
		return () => node.removeEventListener('outroend', closed);
	});
</script>

<SheetPortal>
	<SheetOverlay />
	<SheetPrimitive.Content
		bind:el={element}
		{inTransition}
		inTransitionConfig={enter}
		{outTransition}
		outTransitionConfig={leave}
		class={cn(sheetVariants({ side }), className)}
		data-sheet-content
		{...restProps}
	>
		{@render children?.()}
		<SheetPrimitive.Close
			class={cn('ring-offset-carbon-900 focus-visible:ring-nexus-500 absolute right-4 top-4 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none', closeClass)}
		>
			<X class="h-4 w-4" />
			<span class="sr-only">{closeLabel}</span>
		</SheetPrimitive.Close>
	</SheetPrimitive.Content>
</SheetPortal>
