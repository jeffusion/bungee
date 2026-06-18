<script lang="ts">
	import * as FormPrimitive from "formsnap";
	import { cn } from "$utils";

	type $$Props = FormPrimitive.LegendProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<FormPrimitive.Legend
	{...$$restProps}
	class={cn("data-[fs-error]:text-red-400 font-mono text-[11px] uppercase tracking-command text-zinc-400 leading-none", className)}
	let:legendAttrs
>
	<slot {legendAttrs} />
</FormPrimitive.Legend>