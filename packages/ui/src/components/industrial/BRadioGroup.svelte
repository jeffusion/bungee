<script lang="ts">
	import * as RadioGroup from "$components/ui/radio-group";
	import * as Label from "$components/ui/label";
	import { cn } from "$utils";

	type RadioOption = { label: string; value: string; description?: string; disabled?: boolean };

	let {
		label = "",
		description = "",
		options = [],
		value = $bindable(""),
		disabled = false,
		onchange,
		class: className = "",
		ariaLabel,
	}: {
		label?: string;
		description?: string;
		options?: RadioOption[];
		value?: string;
		disabled?: boolean;
		onchange?: (value: string) => void;
		class?: string;
		ariaLabel?: string;
	} = $props();

	function handleChange(e: CustomEvent) {
		const detail = (e as any).detail;
		if (detail !== undefined) {
			value = detail;
			onchange?.(detail);
		}
	}
</script>

<div class={cn("space-y-1.5", className)}>
	{#if label}
		<div class="flex items-center justify-between gap-3">
			<Label.Root>{label}</Label.Root>
			{#if value}
				<span class="font-mono text-[10px] uppercase tracking-command text-nexus-300">{value}</span>
			{/if}
		</div>
	{/if}
	{#if description}
		<p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{description}</p>
	{/if}
	<RadioGroup.Root bind:value class="gap-2" aria-label={ariaLabel || label || undefined}>
		{#each options as opt (opt.value)}
			<div class={cn(
				"flex items-center justify-between gap-3 border border-carbon-600 px-3 py-2",
				opt.disabled || disabled ? "bg-carbon-950/60 opacity-60" : "bg-carbon-900/40"
			)}>
				<div class="space-y-0.5">
					<label for={opt.value} class="text-zinc-200 text-sm leading-tight">{opt.label}</label>
					{#if opt.description}
						<p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{opt.description}</p>
					{/if}
				</div>
				<RadioGroup.Item id={opt.value} value={opt.value} disabled={opt.disabled || disabled} />
			</div>
		{/each}
	</RadioGroup.Root>
</div>
