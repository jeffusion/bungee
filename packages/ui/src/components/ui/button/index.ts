import { type VariantProps, tv } from "tailwind-variants";
import type { Button as ButtonPrimitive } from "bits-ui";
import Root from "./button.svelte";

const buttonVariants = tv({
  base: "inline-flex items-center justify-center whitespace-nowrap border-2 rounded-none font-sans text-[11px] font-bold uppercase tracking-command transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-500 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:pointer-events-none disabled:opacity-50",
	variants: {
		variant: {
			default: "border-nexus-400 bg-nexus-500 text-black hover:border-nexus-300 hover:bg-nexus-400",
			destructive: "border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20",
			outline: "border-zinc-300 bg-transparent text-zinc-100 hover:bg-zinc-100/10",
			secondary: "border-carbon-600 bg-carbon-800 text-zinc-100 hover:border-carbon-500 hover:bg-carbon-700",
			ghost: "border-carbon-500 bg-transparent text-zinc-300 hover:border-nexus-500 hover:text-nexus-300",
			link: "border-transparent bg-transparent px-0 text-nexus-400 underline-offset-4 hover:text-nexus-300 hover:underline",
		},
		size: {
		default: "h-[34px] px-3.5",
		sm: "h-[28px] px-2.5 text-[10px]",
		lg: "h-[38px] px-5 text-xs",
		icon: "h-[34px] w-[34px]",
		},
	},
	defaultVariants: {
		variant: "default",
		size: "default",
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
