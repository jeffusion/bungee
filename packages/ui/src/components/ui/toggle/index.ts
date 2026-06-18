import { type VariantProps, tv } from "tailwind-variants";
import Root from "./toggle.svelte";

export const toggleVariants = tv({
	base: "focus-visible:ring-nexus-500 data-[state=on]:bg-nexus-500/10 data-[state=on]:text-nexus-400 inline-flex items-center justify-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-carbon-950 disabled:pointer-events-none disabled:opacity-50 rounded-none",
	variants: {
		variant: {
			default: "bg-transparent hover:bg-carbon-700 hover:text-zinc-300",
			outline:
				"border-carbon-500 hover:bg-nexus-500/10 hover:text-nexus-400 border bg-transparent",
		},
		size: {
			default: "h-[34px] px-3",
			sm: "h-[28px] px-2.5",
			lg: "h-[40px] px-5",
		},
	},
	defaultVariants: {
		variant: "default",
		size: "default",
	},
});

export type Variant = VariantProps<typeof toggleVariants>["variant"];
export type Size = VariantProps<typeof toggleVariants>["size"];

export {
	Root,
	//
	Root as Toggle,
};