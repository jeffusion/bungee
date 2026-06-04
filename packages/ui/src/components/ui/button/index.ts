import { type VariantProps, tv } from "tailwind-variants";
import type { Button as ButtonPrimitive } from "bits-ui";
import Root from "./button.svelte";

const buttonVariants = tv({
	base: "b-ui-button inline-flex items-center justify-center gap-2 border-2 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-command transition-all duration-150 ease-out cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none",
	variants: {
		variant: {
			primary: "border-nexus-400 bg-nexus-500 text-black hover:bg-nexus-400 hover:shadow-glow-orange",
			ghost: "border-carbon-500 bg-transparent text-zinc-300 hover:border-nexus-500 hover:text-nexus-300",
			outline: "border-zinc-300 bg-transparent text-zinc-100 hover:border-nexus-500 hover:text-nexus-300",
			danger: "border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200",
			warn: "border-amber-500 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200",
			default: "border-nexus-400 bg-nexus-500 text-black hover:bg-nexus-400 hover:shadow-glow-orange",
			secondary: "border-carbon-500 bg-transparent text-zinc-300 hover:border-nexus-500 hover:text-nexus-300",
		},
		size: {
			sm: "px-2.5 py-1 text-[10px]",
			md: "px-3 py-1.5 text-[11px] h-9",
			default: "px-3 py-1.5 text-[11px] h-9",
			lg: "px-4 py-2 text-[12px] h-10",
			icon: "px-1.5 py-1.5 text-[11px] h-9 w-9",
		},
	},
	defaultVariants: {
		variant: "primary",
		size: "md",
	},
});

type Variant = VariantProps<typeof buttonVariants>["variant"];
type Size = VariantProps<typeof buttonVariants>["size"];

type Props = ButtonPrimitive.Props & {
	variant?: Variant;
	size?: Size;
};

type Events = ButtonPrimitive.Events;

export {
	Root,
	type Props,
	type Events,
	//
	Root as Button,
	type Props as ButtonProps,
	type Events as ButtonEvents,
	buttonVariants,
};
